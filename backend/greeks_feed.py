"""Angel One Option Greeks feed + scheduler for Tier 4 instruments.

Tier 4 consumes Angel-computed IV/Greeks directly — no local Black-Scholes,
no Brent, no IV cache. This module owns the REST polling (the Greeks endpoint
is NOT on the WebSocket), the request scheduler, and the rate limiter.

SCHEDULING MODEL (registry is the sole source of truth)
-------------------------------------------------------
N is NEVER configured. N = number of session-open instruments currently in
the registry (`_entries`). The registry auto-tracks user actions: checking a
stock as Tier 4 registers it (lazy, on first enrich), removing a stock or
demoting 4 -> 3 unregisters it. The user only edits the Tier-4 list.

Per-instrument refresh interval is DERIVED every cycle:

    F = clamp(ceil(N_active / RATE_TARGET), 30s, 600s)      # RATE_TARGET = 0.8 req/s

Dispatch serves earliest-next_due first (provably starvation-free). New
registrations are due immediately. There is no user-configurable stock cap:
MAX_TIER4_REGISTRATIONS (default 500) is a runaway circuit breaker only, and
logs loudly if ever hit.

RATE LIMIT (documented vs chosen)
---------------------------------
Documented Angel One limit: optionGreek = 1 request/sec per client code.
Our CHOSEN target: 0.8 req/s (1.25s gap) — a 20% engineering margin for
window-semantics ambiguity, retry/error calls, clock slop, and the validation
sampler, which shares this exact endpoint and must acquire the same limiter.
On 429/throttle the limiter backs off globally (multiplicative, jittered)
and recovers additively.

Env (optional; defaults are correct — neither a cap nor an interval is a
user requirement):
  TIER4_RATE_GAP_SEC   base gap, default 1.25 (0.8 req/s chosen target)
  TIER4_FLOOR_SEC      min refresh interval, default 30
  TIER4_CAP_SEC        max refresh interval, default 600
"""
import os
import time
import json
import random
import threading
import logging
import requests
import app_settings
from collections import deque
from datetime import datetime, time as dt_time
from typing import Dict, Optional, Callable

logger = logging.getLogger(__name__)

OPTION_GREEKS_URL = ("https://apiconnect.angelone.in/rest/secure/angelbroking/"
                     "marketData/v1/optionGreek")

BASE_GAP = float(os.getenv("TIER4_RATE_GAP_SEC", "1.25"))   # 0.8 req/s CHOSEN target
FLOOR_SEC = float(os.getenv("TIER4_FLOOR_SEC", "30"))
CAP_SEC = float(os.getenv("TIER4_CAP_SEC", "600"))
RATE_TARGET = 1.0 / BASE_GAP                                 # requests/sec (chosen)
BACKOFF_MAX_SEC = 30.0
CIRCUIT_BREAKER = 500        # runaway protection only — NOT a tuning knob

# ── Deterministic auth-failure circuit breaker ──
# A bad/revoked/mismatched API key fails IDENTICALLY on every call ("Invalid
# API Key" — see logs). Retrying each cycle forever only spams one warning
# per instrument per cycle and keeps N registry slots "active" for a feed
# that cannot succeed. Auth-class errors therefore SUSPEND all fetches and
# retest with a single half-open probe after the backoff window.
AUTH_ERR_BACKOFF_SEC = float(os.getenv("TIER4_AUTH_BACKOFF_SEC", "300"))

HEADERS_BASE = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": os.getenv("CLIENT_LOCAL_IP", "192.168.1.1"),
    "X-MACAddress": os.getenv("CLIENT_MAC", "aa:bb:cc:dd:ee:ff"),
    "X-UserType": "USER",
}


def _equity_open() -> bool:
    now = datetime.now()
    if now.weekday() > 4:
        return False
    return dt_time(9, 15) <= now.time() <= dt_time(15, 30)


def normalize_greeks_batch(rows: list) -> Dict[int, Dict[str, dict]]:
    """Angel optionGreek response rows -> {strike_int: {"CE": {...}, "PE": {...}}}.
    IV arrives in PERCENT (e.g. 16.33) — auto-detected per batch (median > 3.0)
    and divided by 100. strikePrice parsed to int. delta/gamma/theta/vega are
    stored EXACTLY as Angel returns them."""
    ivs, parsed = [], []
    for r in rows or []:
        try:
            strike = int(round(float(r.get("strikePrice", 0))))
            ot = str(r.get("optionType", "")).strip().upper()
            iv = float(r.get("impliedVolatility")) if r.get("impliedVolatility") not in (None, "") else None
        except (TypeError, ValueError):
            continue
        if strike <= 0 or ot not in ("CE", "PE"):
            continue
        if iv is not None:
            ivs.append(iv)
        parsed.append((strike, ot, r, iv))
    pct = bool(ivs) and (sorted(ivs)[len(ivs) // 2] > 3.0)
    out: Dict[int, Dict[str, dict]] = {}
    for strike, ot, r, iv in parsed:
        g = {"iv": (iv / 100.0) if (iv is not None and pct) else iv,
             "delta": _f(r.get("delta")), "gamma": _f(r.get("gamma")),
             "theta": _f(r.get("theta")), "vega": _f(r.get("vega")),
             "expiry": str(r.get("expiry", "")).upper()}
        out.setdefault(strike, {})[ot] = g
    return out


def _f(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


class RateLimiter:
    """Single gatekeeper for the optionGreek endpoint budget. Documented limit:
    1 req/s per client code. Chosen target: BASE_GAP (default 1.25s = 0.8 req/s).
    Throttle (429) -> multiplicative backoff with jitter; recovery additive.
    EVERY caller of the endpoint (Tier-4 feed AND validation sampler) must
    acquire() before posting."""

    def __init__(self, base_gap: float):
        self.base_gap = base_gap
        self._lock = threading.Lock()
        self._next_allowed = 0.0
        self._current_gap = base_gap
        self._clean_cycles = 0
        self.throttles = 0
        # Dispatch timestamps for the trailing-window effective request rate
        # (observability only — pacing is unchanged).
        self._dispatch_times = deque(maxlen=5000)

    def acquire(self, stop_event=None):
        while True:
            with self._lock:
                now = time.monotonic()
                if now >= self._next_allowed:
                    self._next_allowed = now + self._current_gap
                    self._note_dispatch_locked()
                    return
                wait = self._next_allowed - now
            if stop_event is not None:
                if stop_event.wait(wait):
                    return
            else:
                time.sleep(wait)

    def _note_dispatch_locked(self):
        self._dispatch_times.append(time.monotonic())

    def note_dispatch(self):
        """Record a dispatch timestamp (used by acquire and tests)."""
        with self._lock:
            self._note_dispatch_locked()

    def rate_per_sec(self, window_sec: float = 60.0) -> float:
        """Effective request rate over the trailing window: dispatches in
        the last window_sec / window_sec. Shared by the feed and the
        validation sampler (both record dispatches here), so it is the TRUE
        combined optionGreek request rate. Observability only."""
        with self._lock:
            now = time.monotonic()
            while self._dispatch_times and now - self._dispatch_times[0] > window_sec:
                self._dispatch_times.popleft()
            return round(len(self._dispatch_times) / window_sec, 3)

    def throttle(self):
        with self._lock:
            self._current_gap = min(self._current_gap * 2, BACKOFF_MAX_SEC)
            self._clean_cycles = 0
            self.throttles += 1
        logger.warning("[GreeksFeed] THROTTLED — global gap now %.2fs", self._current_gap)

    def mark_clean(self):
        with self._lock:
            self._clean_cycles += 1
            if self._clean_cycles >= 3 and self._current_gap > self.base_gap:
                self._current_gap = max(self.base_gap, self._current_gap / 2)
                self._clean_cycles = 0

    @property
    def current_gap(self) -> float:
        with self._lock:
            return self._current_gap


optiongreek_limiter = RateLimiter(BASE_GAP)


class _Entry:
    __slots__ = ("symbol", "expiry_provider", "market_hours", "data", "expiry",
                 "fetched_at", "next_due", "next_retry_at", "error",
                 "fetches", "errors", "last_served")

    def __init__(self, symbol, expiry_provider, market_hours=None):
        self.symbol = symbol
        self.expiry_provider = expiry_provider
        self.market_hours = market_hours
        self.data: Dict[int, Dict[str, dict]] = {}
        self.expiry: Optional[str] = None
        self.fetched_at = 0.0
        self.last_served = 0.0       # monotonic timestamp of last dispatcher serve
        self.next_due = 0.0          # new registrations fetch immediately
        self.next_retry_at = 0.0
        self.error: Optional[str] = None
        self.fetches = 0
        self.errors = 0

    @property
    def age(self) -> float:
        return time.time() - self.fetched_at


class AngelGreeksFeedManager:
    """Sequential dispatcher over the live Tier-4 registry. N (session-open
    registered instruments) is derived each cycle; the per-instrument refresh
    interval F = clamp(ceil(N / RATE_TARGET), FLOOR, CAP) is recomputed on every
    registry change. Earliest-next_due-first dispatch => no starvation."""

    def __init__(self):
        self._lock = threading.Lock()
        self._entries: Dict[str, _Entry] = {}
        self._auth = None
        self._thread: Optional[threading.Thread] = None
        self._stop: Optional[threading.Event] = None
        self.counters = {"fetches": 0, "errors": 0, "auth_errors": 0, "no_data": 0,
                         "throttled": 0, "timeouts": 0}
        # ── Observability (health monitoring) ──
        self._latencies = deque(maxlen=500)      # per-request seconds
        self._inflight = 0                       # dispatched, not yet completed
        self._pass_start = None                  # monotonic; start of current full sweep
        self._unserved = None                    # symbols not yet served this sweep
        self._last_full_sweep = None             # seconds; last completed all-active sweep
        self._sweep_count = 0
        self._gate_off_logged = False            # one-shot log for the Settings OFF gate
        self._auth_error: Optional[str] = None   # circuit breaker: message while tripped
        self._auth_error_until: float = 0.0      # monotonic; probe may retest after this

    # ── lifecycle ──
    def configure(self, auth_manager):
        self._auth = auth_manager

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="tier4-greeks-feed")
        self._thread.start()
        logger.info("[GreeksFeed] started (target=%.2f req/s, floor=%.0fs, cap=%.0fs)",
                    RATE_TARGET, FLOOR_SEC, CAP_SEC)

    def stop(self):
        if self._stop:
            self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        logger.info("[GreeksFeed] stopped")

    # ── registry: THE source of truth for N ──
    def register(self, symbol: str, expiry_provider: Callable, market_hours=None) -> bool:
        """Track a tier-4 symbol for the optionGreek cycle. Registration is
        bookkeeping only — with tier4_greeks_enabled=OFF zero Angel requests
        are made. v3.3: log the registration ONLY when polling is enabled, so
        an OFF feed stays silent at startup (the health panel's N counter
        still reports the tracked count). Also fixes a latent NameError when
        the same symbol registered twice (n was only set on first add)."""
        sym = symbol.strip().upper()
        with self._lock:
            if sym not in self._entries:
                if len(self._entries) >= CIRCUIT_BREAKER:
                    logger.error("[GreeksFeed] %s NOT registered — circuit breaker %d hit "
                                 "(registration runaway? this is NOT a tuning knob)", sym, CIRCUIT_BREAKER)
                    return False
                self._entries[sym] = _Entry(sym, expiry_provider, market_hours)
            n = len(self._entries)
        if app_settings.get_tier4_greeks_enabled():
            logger.info("[GreeksFeed] %s registered (N=%d, F=%.0fs)", sym, n, self.refresh_interval())
        return True

    def unregister(self, symbol: str):
        with self._lock:
            e = self._entries.pop(symbol.strip().upper(), None)
            n = len(self._entries)
        if e:
            logger.info("[GreeksFeed] %s unregistered (N=%d, F=%.0fs)",
                        symbol.strip().upper(), n, self.refresh_interval())

    def get(self, symbol: str) -> Optional[Dict[int, Dict[str, dict]]]:
        e = self._entries.get(symbol.strip().upper())
        return e.data if e else None

    def feed_status(self, symbol: str) -> Optional[dict]:
        e = self._entries.get(symbol.strip().upper())
        if not e:
            return None
        return {"symbol": e.symbol, "expiry": e.expiry, "age_sec": round(e.age),
                "strikes": len(e.data), "error": e.error, "fetches": e.fetches,
                "errors": e.errors, "stale": e.age > self.refresh_interval()}

    def _bump_inflight(self, d: int):
        with self._lock:
            self._inflight = max(0, self._inflight + d)

    def _latency_stats(self) -> dict:
        with self._lock:
            xs = sorted(self._latencies)
        if not xs:
            return {"p50_ms": None, "p95_ms": None, "count": 0, "last_ms": None}
        def _pct(p: float) -> float:
            return xs[min(len(xs) - 1, max(0, int(p * len(xs) + 0.9999) - 1))]
        return {"p50_ms": round(_pct(0.50) * 1000, 1), "p95_ms": round(_pct(0.95) * 1000, 1),
                "count": len(xs), "last_ms": round(xs[-1] * 1000, 1)}

    def health(self) -> dict:
        """Tier-4 Greeks health. Freshness thresholds are RELATIVE to the
        dynamically derived per-stock interval F = clamp(ceil(N/0.8), 30, 600):

          HEALTHY   oldest active age <= F
          WARNING   oldest active age > 1.5 * F   (or rate-limit backoff active)
          DEGRADED  oldest active age > max(2 * F, F + 90s)   (small-N floor)

        Only SESSION-OPEN instruments count. Distinguishes: Angel slow (latency
        up), our scheduler (sweep/age up, latency normal), rate limit (gap up).
        """
        try:
            t4_greeks_enabled = app_settings.get_tier4_greeks_enabled()
        except Exception:
            t4_greeks_enabled = True
        F = self.refresh_interval()
        with self._lock:
            entries = list(self._entries.values())
        now = time.time()
        actives = [e for e in entries if self._open(e)]
        n = len(actives)
        fetched = [e for e in actives if e.fetched_at > 0]
        oldest = round(max(now - e.fetched_at for e in fetched)) if fetched else None
        gap = optiongreek_limiter.current_gap
        base = optiongreek_limiter.base_gap
        warn_age = 1.5 * F
        deg_age = max(2.0 * F, F + 90.0)
        if n == 0:
            status = "idle"
        elif self._auth_error is not None and oldest is None:
            status = "degraded"   # auth circuit breaker tripped — no data can flow
        elif oldest is None:
            status = "warning"            # active instruments, no data yet
        elif oldest > deg_age:
            status = "degraded"
        elif oldest > warn_age:
            status = "warning"
        else:
            status = "healthy"
            if gap > base:                # rate-limit backoff in effect
                status = "warning"
        # Latency-inclusive expected cycle: dispatches are gap-paced, but each
        # request also occupies (p50 latency) of server round-trip time, so a
        # healthy cycle is N x (gap + latency) — reporting N x gap alone makes
        # a healthy feed look 2x slow (the classic "28s expected / 61s actual"
        # false alarm).
        p50_s = (self._latency_stats()["p50_ms"] or 0) / 1000.0
        return {
            "status": status,
            "enabled": t4_greeks_enabled,
            "auth_error": self._auth_error,
            "n_active": n,
            "n_registered": len(entries),
            "refresh_interval_sec": round(F),               # F: per-stock interval
            "expected_cycle_sec": round(n * (gap + p50_s)),  # latency-inclusive
            "actual_cycle_sec": self._last_full_sweep,      # last completed full sweep
            "sweeps_completed": self._sweep_count,
            "oldest_active_age_sec": oldest,
            "oldest_ratio": round(oldest / F, 2) if oldest is not None else None,
            "thresholds": {"healthy_age_sec": round(F),
                           "warning_age_sec": round(warn_age),
                           "degraded_age_sec": round(deg_age)},
            "latency": self._latency_stats(),
            "timeouts": self.counters.get("timeouts", 0),
            "throttles": optiongreek_limiter.throttles,     # 429/rate-limit count
            "current_gap_sec": round(gap, 2),
            "base_gap_sec": base,
            "request_rate_per_sec": optiongreek_limiter.rate_per_sec(60.0),
            "inflight": self._inflight,
        }

    def stats(self) -> dict:
        try:
            t4_greeks_enabled = app_settings.get_tier4_greeks_enabled()
        except Exception:
            t4_greeks_enabled = True
        with self._lock:
            entries = list(self._entries.values())
        n_active = sum(1 for e in entries if self._open(e))
        F = self.refresh_interval()
        cycle = n_active * optiongreek_limiter.current_gap
        grade = "ok" if cycle <= 120 else ("warning" if cycle <= 300 else "degraded")
        now_s = time.time()
        fetched_actives = [e for e in entries if self._open(e) and e.fetched_at > 0]
        oldest = round(max(now_s - e.fetched_at for e in fetched_actives)) if fetched_actives else None
        return {"enabled": t4_greeks_enabled,
                "n_registered": len(entries), "n_active": n_active,
                "refresh_interval_sec": F, "predicted_cycle_sec": round(cycle),
                "current_gap_sec": round(optiongreek_limiter.current_gap, 2),
                "rate_target_req_s": round(RATE_TARGET, 2),
                "documented_limit_req_s": 1.0, "throttles": optiongreek_limiter.throttles,
                "grade": grade,
                "counters": dict(self.counters),
                "instruments": [self.feed_status(e.symbol) for e in entries],
                # ── observability extensions (health monitoring) ──
                "actual_cycle_sec": self._last_full_sweep,
                "sweeps_completed": self._sweep_count,
                "inflight": self._inflight,
                "request_rate_per_sec": optiongreek_limiter.rate_per_sec(60.0),
                "timeouts": self.counters.get("timeouts", 0),
                "latency": self._latency_stats(),
                "oldest_active_age_sec": oldest,
                "health": self.health()}

    # ── auth-failure circuit breaker ──
    @staticmethod
    def _is_auth_error(status_code: int, msg: str) -> bool:
        m = (msg or "").lower()
        return status_code in (401, 403) or "invalid api key" in m or ("invalid" in m and "key" in m)

    def _note_auth_failure(self, e, msg: str):
        if self._auth_error != msg:   # one loud line per failure MODE, not per instrument
            logger.error("[GreeksFeed] AUTH FAILURE (%s) fetching %s — Tier-4 Greeks "
                         "suspended for %.0fs, then one probe retests. Fix: verify/regenerate "
                         "API_KEY in backend/.env (Angel SmartAPI developer portal).",
                         msg, e.symbol, AUTH_ERR_BACKOFF_SEC)
        self._auth_error = msg
        self._auth_error_until = time.monotonic() + AUTH_ERR_BACKOFF_SEC

    # ── derived cadence: F(N) ──
    def refresh_interval(self) -> float:
        with self._lock:
            n = sum(1 for e in self._entries.values() if self._open(e))
        import math
        return min(CAP_SEC, max(FLOOR_SEC, math.ceil(n / RATE_TARGET)))

    # ── dispatcher ──
    def _open(self, e: _Entry) -> bool:
        if e.market_hours is None:
            return _equity_open()
        now = datetime.now()
        if now.weekday() > 4:
            return False
        (h1, m1), (h2, m2) = e.market_hours
        return dt_time(h1, m1) <= now.time() <= dt_time(h2, m2)

    def _loop(self):
        while not self._stop.is_set():
            try:
                self._cycle()
            except Exception as ex:
                logger.error("[GreeksFeed] cycle error: %s", ex)
            self._stop.wait(2)

    def _cycle(self):
        # Tier-4 Greeks master switch (Settings > Analytics): when OFF, no
        # optionGreek REST requests are made and the cached Greeks payload is
        # invalidated so stale values can never merge as fresh data. The
        # registry, scheduling cadence, rate limiter, backoff and ALL Tier-4
        # market-data state (OI/LTP/volume -> snapshots -> DB) are untouched;
        # re-enabling resumes the existing behavior on the next cycle.
        try:
            t4_greeks_enabled = app_settings.get_tier4_greeks_enabled()
        except Exception:
            t4_greeks_enabled = True   # settings unavailable -> fail open
        if not t4_greeks_enabled:
            with self._lock:
                for e in self._entries.values():
                    if e.data:
                        e.data = {}                    # invalidate cached Greeks ONLY
                    if e.error != "disabled (Settings)":
                        e.error = "disabled (Settings)"
            # Visible state logging: a silent OFF gate is indistinguishable
            # from a broken feed in the logs (registrations keep appearing
            # while zero fetches occur). Log the transition once per change.
            if not self._gate_off_logged:
                logger.info("[GreeksFeed] tier4_greeks_enabled=OFF — optionGreek "
                            "polling suspended (%d registered; Tier-4 streaming, "
                            "snapshots & DB writes unaffected)", len(self._entries))
                self._gate_off_logged = True
            return
        if self._gate_off_logged:
            logger.info("[GreeksFeed] tier4_greeks_enabled=ON — optionGreek polling resumed")
            self._gate_off_logged = False
        F = self.refresh_interval()
        now = time.monotonic()
        with self._lock:
            due = [e for e in self._entries.values() if self._open(e) and e.next_due <= now]
            actives = [e for e in self._entries.values() if self._open(e)]
        due.sort(key=lambda e: e.next_due)          # earliest due first: no starvation
        # Sweep bookkeeping: a "full sweep" = every session-open instrument
        # served at least once; duration = first-serve -> coverage-complete.
        active_syms = {e.symbol for e in actives}
        if not actives:
            self._pass_start = None
            self._unserved = None
        elif self._unserved is not None:
            self._unserved &= active_syms           # drop removed/demoted symbols
        served = 0
        sweep_t0 = time.monotonic()
        for e in due:
            if self._stop.is_set():
                return
            if not self._open(e):
                continue
            if time.monotonic() < e.next_retry_at:
                continue
            if self._auth_error is not None:
                # Breaker tripped: everything is suspended except ONE probe
                # entry, and only once the backoff window has elapsed.
                probe = next(iter(self._entries.values()), None)
                if e is not probe or time.monotonic() < self._auth_error_until:
                    continue
            optiongreek_limiter.acquire(self._stop)
            if self._stop.is_set():
                return
            self._fetch(e)
            e.next_due = time.monotonic() + F
            e.last_served = time.monotonic()
            served += 1
            if self._pass_start is None:
                self._pass_start = sweep_t0
                self._unserved = set(active_syms)
            self._unserved.discard(e.symbol)
            if not self._unserved:
                self._last_full_sweep = round(time.monotonic() - self._pass_start, 1)
                self._sweep_count += 1
                self._pass_start = None
        if served:
            optiongreek_limiter.mark_clean()
            logger.debug("[GreeksFeed] cycle: N_active served=%d F=%.0fs gap=%.2fs",
                         served, F, optiongreek_limiter.current_gap)

    # ── fetch (rate-limited by the shared limiter) ──
    def _fetch(self, e: _Entry):
        if self._auth is None:
            e.error = "no-auth"
            return
        expiry = None
        try:
            expiry = e.expiry_provider()
        except Exception as ex:
            e.error = f"expiry-provider:{ex}"
        if not expiry:
            return
        try:
            jwt = self._auth.get_valid_jwt()
        except Exception as ex:
            e.error = f"auth:{ex}"
            self.counters["auth_errors"] += 1
            e.next_retry_at = time.monotonic() + 60
            logger.error("[GreeksFeed] %s auth failure: %s", e.symbol, ex)
            return
        headers = dict(HEADERS_BASE)
        headers["Authorization"] = jwt
        headers["X-PrivateKey"] = self._auth.api_key
        t0 = time.monotonic()
        self._bump_inflight(1)
        try:
            resp = requests.post(OPTION_GREEKS_URL, headers=headers,
                                 data=json.dumps({"name": e.symbol, "expirydate": expiry}), timeout=15)
        except requests.exceptions.Timeout as ex:
            # Timeout is tracked SEPARATELY from generic errors so health can
            # distinguish Angel slowness/unreliability from other failures.
            self.counters["timeouts"] += 1
            self.counters["errors"] += 1
            e.errors += 1
            e.error = f"timeout:{ex}"
            e.next_retry_at = time.monotonic() + 30
            logger.error("[GreeksFeed] %s TIMEOUT: %s", e.symbol, ex)
            return
        except Exception as ex:
            self.counters["errors"] += 1
            e.errors += 1
            e.error = f"http:{ex}"
            e.next_retry_at = time.monotonic() + 30
            logger.error("[GreeksFeed] %s HTTP error: %s", e.symbol, ex)
            return
        finally:
            self._bump_inflight(-1)
            self._latencies.append(time.monotonic() - t0)
        # throttle detection: HTTP 429 or rate-limit messaging -> global backoff
        msg_low = ""
        try:
            data = resp.json()
            msg_low = str(data.get("message", "")).lower()
        except Exception:
            data = {}
        if resp.status_code == 429 or "too many" in msg_low or "rate limit" in msg_low \
                or data.get("errorcode") in ("AB1004", "AB1005"):
            self.counters["throttled"] += 1
            optiongreek_limiter.throttle()
            e.error = "throttled"
            e.next_retry_at = time.monotonic() + optiongreek_limiter.current_gap
            return
        e.fetches += 1
        self.counters["fetches"] += 1
        if not data.get("status"):
            msg = str(data.get("message", data.get("errorcode", "unknown")))
            e.error = msg
            e.errors += 1
            self.counters["errors"] += 1
            if self._is_auth_error(resp.status_code, msg):
                # Deterministic credential rejection: trip the breaker instead
                # of hammering every instrument every cycle.
                self._note_auth_failure(e, msg)
                e.next_retry_at = time.monotonic() + AUTH_ERR_BACKOFF_SEC
                return
            if "AB9019" in msg or "No Data" in msg:
                self.counters["no_data"] += 1
                e.next_retry_at = time.monotonic() + 300
            else:
                e.next_retry_at = time.monotonic() + 60
            logger.warning("[GreeksFeed] %s %s (%s) expiry=%s", e.symbol,
                           data.get("errorcode", ""), msg, expiry)
            return
        norm = normalize_greeks_batch(data.get("data") or [])
        if not norm:
            e.error = "malformed"
            e.errors += 1
            self.counters["errors"] += 1
            e.next_retry_at = time.monotonic() + 60
            logger.warning("[GreeksFeed] %s empty/malformed batch", e.symbol)
            return
        e.data = norm
        e.expiry = expiry
        e.fetched_at = time.time()
        e.error = None
        if self._auth_error is not None:
            logger.info("[GreeksFeed] auth probe OK — Tier-4 Greeks resumed")
            self._auth_error = None
        logger.info("[GreeksFeed] %s fetched %d strikes, expiry %s (F=%.0fs)",
                    e.symbol, len(norm), expiry, self.refresh_interval())


greeks_feed_manager = AngelGreeksFeedManager()
