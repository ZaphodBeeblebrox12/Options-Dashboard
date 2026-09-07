
import sys, os, time, json, types, threading, tempfile

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

try:
    import requests  # noqa
except ImportError:
    rs = types.ModuleType("requests")
    rs.exceptions = types.SimpleNamespace(RequestException=Exception, Timeout=type("Timeout", (Exception,), {}))
    rs.post = lambda *a, **k: None
    sys.modules["requests"] = rs

import greeks_feed as gf

RESULTS = []
def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL "), name, ("\u2014 " + str(detail) if detail else ""))

class FakeTimeout(Exception):
    pass

class Resp:
    def __init__(self, code, payload):
        self.status_code = code
        self._payload = payload
    def json(self):
        return self._payload

GOOD_ROW = {"strikePrice": "100", "optionType": "CE", "impliedVolatility": "16.0",
            "delta": "0.5", "gamma": "0.001", "theta": "-1", "vega": "2", "expiry": "01OCT2026"}

def make_post(mode, sink, sleep_s=0.0):
    def post(url, headers=None, data=None, timeout=None):
        sink["calls"] += 1
        if sleep_s:
            time.sleep(sleep_s)
        sink["inflight_seen"].append(gf_mgr_ref[0]._inflight)
        if mode == "429":
            return Resp(429, {})
        if mode == "timeout":
            raise FakeTimeout("15s")
        return Resp(200, {"status": True, "data": [GOOD_ROW]})
    return post

def patch_requests(mode="ok", sink=None, sleep_s=0.0):
    gf.requests = types.SimpleNamespace(
        post=make_post(mode, sink if sink is not None else {"calls": 0, "inflight_seen": []}, sleep_s),
        exceptions=types.SimpleNamespace(Timeout=FakeTimeout, ConnectTimeout=FakeTimeout, ReadTimeout=FakeTimeout),
    )

class StubLimiter:
    """No-sleep stand-in for the real limiter (pacing tested separately)."""
    def __init__(self):
        self.base_gap = 1.25
        self.current_gap = 1.25
        self.throttles = 0
        self.dispatched = 0
    def acquire(self, stop_event=None):
        self.dispatched += 1
    def throttle(self):
        self.current_gap = min(self.current_gap * 2, 30.0)
        self.throttles += 1
    def mark_clean(self):
        pass
    def rate_per_sec(self, window_sec=60.0):
        return round(self.dispatched / max(1.0, window_sec), 3)

AUTH = types.SimpleNamespace(api_key="K", get_valid_jwt=lambda: "J")
gf_mgr_ref = [None]

def fresh_manager(n=0, stub=None):
    stub = stub or StubLimiter()
    gf.optiongreek_limiter = stub
    mgr = gf.AngelGreeksFeedManager()
    mgr._stop = threading.Event()
    mgr._auth = AUTH
    mgr._open = lambda e: True          # always-open session for tests
    gf_mgr_ref[0] = mgr
    for i in range(n):
        mgr.register(f"T4{i:02d}", lambda: "01OCT2026", market_hours=((0, 0), (23, 59)))
    return mgr, stub

# ── 1. Healthy 40-stock case ──────────────────────────────────
mgr, stub = fresh_manager(40)
now = time.time()
for i, e in enumerate(mgr._entries.values()):
    e.fetched_at = now - i * 1.2      # staggered ages, max 46.8s <= F=50
mgr._last_full_sweep = 50.0           # simulated completed pass (documented)
h = mgr.health()
check("healthy 40: status HEALTHY", h["status"] == "healthy", h["status"])
check("healthy 40: N=40, F=50, expected cycle=50",
      h["n_active"] == 40 and h["refresh_interval_sec"] == 50 and h["expected_cycle_sec"] == 50,
      f'N={h["n_active"]} F={h["refresh_interval_sec"]} exp={h["expected_cycle_sec"]}')
check("healthy 40: oldest ~47s, ratio <= 1",
      h["oldest_active_age_sec"] is not None and h["oldest_active_age_sec"] <= 50 and h["oldest_ratio"] <= 1.0,
      f'oldest={h["oldest_active_age_sec"]} ratio={h["oldest_ratio"]}')
check("healthy 40: thresholds 50/75/140 (floor max(2F, F+90))",
      h["thresholds"]["warning_age_sec"] == 75 and h["thresholds"]["degraded_age_sec"] == 140,
      json.dumps(h["thresholds"]))

# ── 2. Slow Angel response ────────────────────────────────────
sink = {"calls": 0, "inflight_seen": []}
patch_requests("ok", sink, sleep_s=0.4)
mgr, stub = fresh_manager(3)
mgr._cycle()
h = mgr.health()
check("slow Angel: sweep stretched >= 1.0s for 3 stocks",
      h["actual_cycle_sec"] is not None and h["actual_cycle_sec"] >= 1.0, h["actual_cycle_sec"])
check("slow Angel: p95 latency >= 400ms", h["latency"]["p95_ms"] is not None and h["latency"]["p95_ms"] >= 400,
      h["latency"]["p95_ms"])
check("slow Angel: in-flight reached 1 during calls, 0 after",
      max(sink["inflight_seen"]) == 1 and h["inflight"] == 0, str(sink["inflight_seen"]))
check("slow Angel: sweeps completed counted", h["sweeps_completed"] >= 1, h["sweeps_completed"])

# ── 3. Scheduler/processing backlog, normal API latency ───────
mgr, stub = fresh_manager(40)
now = time.time()
for i, e in enumerate(mgr._entries.values()):
    e.fetched_at = now - 200            # age 200s; F=50 -> degraded floor max(100,140)=140
h = mgr.health()
check("backlog: DEGRADED on age alone (latency normal/no calls)",
      h["status"] == "degraded", f'{h["status"]} oldest={h["oldest_active_age_sec"]}')
check("backlog: no API calls were made (latency None)",
      h["latency"]["p95_ms"] is None and h["latency"]["count"] == 0)
# warning band: age 130 -> between 75 and 140
for e in mgr._entries.values():
    e.fetched_at = now - 130
h = mgr.health()
check("backlog: WARNING band (1.5F < age <= max(2F, F+90))",
      h["status"] == "warning", f'{h["status"]} oldest={h["oldest_active_age_sec"]}')

# ── 4. Repeated 429s ──────────────────────────────────────────
sink = {"calls": 0, "inflight_seen": []}
patch_requests("429", sink)
mgr, stub = fresh_manager(2)
mgr._cycle()
h = mgr.health()
check("429: throttle counter incremented", stub.throttles >= 1 and h["throttles"] >= 1, h["throttles"])
check("429: global gap backed off (>= 2.5s; doubled per throttled call)", stub.current_gap >= 2.5, stub.current_gap)
check("429: entry error recorded", all(e.error == "throttled" for e in mgr._entries.values()))
for e in mgr._entries.values():       # fresh data, only the gap is wrong
    e.fetched_at = time.time()
h = mgr.health()
check("429: backoff lifts HEALTHY to WARNING", h["status"] == "warning", h["status"])
check("429: expected cycle stretches with backed-off gap",
      h["expected_cycle_sec"] == round(2 * stub.current_gap), h["expected_cycle_sec"])

# ── 5. Timeouts ───────────────────────────────────────────────
sink = {"calls": 0, "inflight_seen": []}
patch_requests("timeout", sink)
mgr, stub = fresh_manager(2)
mgr._cycle()
h = mgr.health()
check("timeout: timeout counter split from generic errors",
      mgr.counters.get("timeouts", 0) >= 1 and h["timeouts"] >= 1, h["timeouts"])
check("timeout: entry error tagged 'timeout:'",
      all(str(e.error).startswith("timeout:") for e in mgr._entries.values()),
      str(list(mgr._entries.values())[0].error))
check("timeout: inflight back to 0", h["inflight"] == 0)

# ── 6. N increasing / decreasing, F recalculates ──────────────
patch_requests("ok", {"calls": 0, "inflight_seen": []})
mgr, stub = fresh_manager(10)
f10 = mgr.refresh_interval()
n10 = mgr.health()["n_active"]
for i in range(30):
    mgr.register(f"X{i}", lambda: "01OCT2026", market_hours=((0, 0), (23, 59)))
f40 = mgr.refresh_interval()
for i in range(35):
    mgr.unregister(f"X{i}")
for i in range(30):
    mgr.unregister(f"T4{i:02d}")
f5 = mgr.refresh_interval()
check("N dynamic: 10 -> F=30 (floor), 40 -> F=50, 5 -> F=30",
      f10 == 30 and n10 == 10 and f40 == 50 and f5 == 30, f"F10={f10} F40={f40} F5={f5}")

# ── 7. Zero active Tier-4 instruments ─────────────────────────
mgr, stub = fresh_manager(0)
h = mgr.health()
s = mgr.stats()
check("zero: status idle, N=0, oldest None, no crash",
      h["status"] == "idle" and h["n_active"] == 0 and h["oldest_active_age_sec"] is None
      and h["oldest_ratio"] is None, h["status"])
check("zero: legacy stats keys intact",
      all(k in s for k in ("n_registered", "n_active", "refresh_interval_sec", "predicted_cycle_sec",
                           "current_gap_sec", "rate_target_req_s", "documented_limit_req_s",
                           "throttles", "grade", "counters", "instruments")))

# ── 8. Recovery DEGRADED -> HEALTHY ───────────────────────────
mgr, stub = fresh_manager(40)
for e in mgr._entries.values():
    e.fetched_at = time.time() - 300
h1 = mgr.health()
for e in mgr._entries.values():
    e.fetched_at = time.time()
h2 = mgr.health()
check("recovery: DEGRADED at age 300 -> HEALTHY after refresh",
      h1["status"] == "degraded" and h2["status"] == "healthy", f'{h1["status"]} -> {h2["status"]}')

# ── 9. Trailing request-rate calculation (real limiter) ───────
rl = gf.RateLimiter(1.25)
for _ in range(48):
    rl.note_dispatch()
rate48 = rl.rate_per_sec(60.0)
rl2 = gf.RateLimiter(1.25)
for _ in range(8):
    rl2.note_dispatch()
rate8 = rl2.rate_per_sec(60.0)
check("rate: 48 dispatches/60s ~= 0.8/s", 0.7 <= rate48 <= 0.81, rate48)
check("rate: 8 dispatches/60s ~= 0.133/s", 0.12 <= rate8 <= 0.14, rate8)

# ── 10. In-flight counter behavior ────────────────────────────
sink = {"calls": 0, "inflight_seen": []}
patch_requests("ok", sink, sleep_s=0.05)
mgr, stub = fresh_manager(2)
mgr._cycle()
check("in-flight: exactly 1 concurrent (sequential dispatcher), 0 after",
      sink["inflight_seen"] == [1, 1] and mgr.health()["inflight"] == 0, str(sink["inflight_seen"]))

# ── 11. Tier 1/2/3 regression ─────────────────────────────────
check("regression: rate target unchanged (0.8 req/s, 1.25s gap)",
      abs(gf.RATE_TARGET - 0.8) < 1e-9 and abs(gf.BASE_GAP - 1.25) < 1e-9)
check("regression: limiter floor/cap unchanged (30/600)",
      gf.FLOOR_SEC == 30.0 and gf.CAP_SEC == 600.0)
ok_payload = {"status": True, "data": [GOOD_ROW]}
norm = gf.normalize_greeks_batch(ok_payload["data"])
check("regression: greek normalization still correct (IV% -> decimal)",
      abs(norm[100]["CE"]["iv"] - 0.16) < 1e-9, norm[100]["CE"]["iv"])

print()
failed = [n for n, ok in RESULTS if not ok]
print(f"TOTAL: {len(RESULTS)} checks, {len(RESULTS) - len(failed)} passed, {len(failed)} failed")
for n in failed:
    print("FAILED:", n)
