"""CASH Wall Reversal Scanner (Drop 1 backend).

Consumes completed 1-minute candles from candle_builder (candles_1m is the
persistent source of truth), derives higher timeframes by market-open
anchored aggregation (15m/30m/1H anchored at 09:15; 5m clock-aligned because
09:15 already aligns to 5-minute boundaries), and evaluates the locked
CE-bearish / PE-bullish wall reversal pattern on FULLY CLOSED candles only.

Locked parameters (tunable via module constants / env overrides):
  C1_MIN_RANGE_X_INTERVAL   0.25   (C1 range >= 0.25 x local strike interval)
  C2_MAX_RATIO_OF_C1      0.70   (C2 range <= 0.70 x C1 range)
  C2_CLOSE_TOLERANCE_X_INTERVAL 0.5 (|C2.close - frozen wall| <= tol x interval)
  INDEX_CLUSTER_X_INTERVAL  2      (NIFTY/SENSEX: ATM+wall+negGEX within 2 intervals)
  RE_ALERT_MIN_DIFF_X_INTERVAL 0.5 (same-wall re-alert needs C2 level diff > 0.5 x interval)
  ALERT_COOLDOWN_SEC      300    (existing-cooldown analogue per symbol+direction+tf)

Walls: window-wide max-OI strike from the streamer's own data store
(Tier 3 = its existing +/-8 window-local wall by architecture; see Drop 1
spec section 18). Max Negative Gamma for NIFTY/SENSEX comes from the Tier-1
analytics cache (<=30s freshness) — no new feed (spec section 16).

Event ordering (spec section 24): when a 1m close coincides with both an HTF
bucket close and a 5m bucket close, HTF finalization (C3 confirm/expire +
new setup detection) is processed BEFORE the 5m Setup-Forming check, so a
5m warning can never fire after the HTF confirmation it preceded.

Commodities are excluded (spec section 30). Pending setups are ephemeral and
die at session end (15:30) or when C3 closes either way (spec section 20).
"""
import os
import time
import threading
import logging
from dataclasses import dataclass, field
from datetime import datetime, time as dt_time
from typing import Callable, Dict, List, Optional

import app_settings

logger = logging.getLogger(__name__)

RULE_TYPE = "wall_reversal"

# ── locked tunables (env-overridable, defaults per spec) ─────
C1_MIN_RANGE_X_INTERVAL = float(os.getenv("WS_C1_MIN_X", "0.25"))
C2_MAX_RATIO_OF_C1 = float(os.getenv("WS_C2_RATIO", "0.70"))
C2_CLOSE_TOLERANCE_X_INTERVAL = float(os.getenv("WS_C2_TOL_X", "0.5"))
INDEX_CLUSTER_X_INTERVAL = float(os.getenv("WS_CLUSTER_X", "2"))
RE_ALERT_MIN_DIFF_X_INTERVAL = float(os.getenv("WS_REALERT_X", "0.5"))
ALERT_COOLDOWN_SEC = int(os.getenv("WS_COOLDOWN_SEC", "300"))

TF_MINUTES = {"15m": 15, "30m": 30, "1H": 60}
HTF_TFS = ("15m", "30m", "1H")
FIVE_M = 5
ANCHOR_MIN = 9 * 60 + 15        # market-open anchor 09:15
SESSION_END_MIN = 15 * 60 + 30  # 15:30
INDEX_SYMBOLS = ("NIFTY", "SENSEX")


# ── time helpers ─────────────────────────────────────────────
def _minutes_of(ts_minute: str) -> int:
    hh = int(ts_minute[11:13]); mm = int(ts_minute[14:16])
    return hh * 60 + mm


def htf_bucket_minutes(tf_key: str, ts_minute: str) -> Optional[int]:
    """Market-open-anchored bucket start (minutes since midnight).
    15m/30m/1H anchored at 09:15 -> 09:15+k*tf. Final truncated bucket
    (30m/1H stub 15:15-15:30) is valid by spec section 6."""
    m = _minutes_of(ts_minute)
    if m < ANCHOR_MIN or m > SESSION_END_MIN:
        return None
    off = m - ANCHOR_MIN
    return ANCHOR_MIN + (off // TF_MINUTES[tf_key]) * TF_MINUTES[tf_key]


def five_m_bucket_minutes(ts_minute: str) -> int:
    m = _minutes_of(ts_minute)
    return m - (m % FIVE_M)


def _label(date_part: str, minutes: int) -> str:
    return f"{date_part} {minutes // 60:02d}:{minutes % 60:02d}:00"


def _aggregate(symbol: str, ones: List[dict]) -> dict:
    vols = [c["volume"] for c in ones if c.get("volume") is not None]
    return {
        "symbol": symbol,
        "ts_minute": ones[0]["ts_minute"],
        "open": ones[0]["open"], "high": max(c["high"] for c in ones),
        "low": min(c["low"] for c in ones), "close": ones[-1]["close"],
        "volume": sum(vols) if vols else None,
        "tick_count": sum(c.get("tick_count", 0) for c in ones),
        "minutes_present": len(ones),
    }


def local_interval(strikes: List[float], wall: float) -> Optional[float]:
    """Median of the two gaps adjacent to the wall in the sorted strike list
    (spec section 9); falls back to the single available gap."""
    try:
        i = strikes.index(wall)
    except ValueError:
        near = min(range(len(strikes)), key=lambda k: abs(strikes[k] - wall))
        i = near
    gaps = []
    if i > 0:
        gaps.append(strikes[i] - strikes[i - 1])
    if i < len(strikes) - 1:
        gaps.append(strikes[i + 1] - strikes[i])
    gaps = [g for g in gaps if g > 0]
    if not gaps:
        return None
    return sorted(gaps)[len(gaps) // 2] if len(gaps) == 2 else gaps[0]


@dataclass
class Setup:
    symbol: str
    direction: str          # "CE" (bearish) | "PE" (bullish)
    tf: str                 # "15m" | "30m" | "1H"
    wall: float
    interval: float
    c1: dict
    c2: dict
    atm: Optional[float] = None
    neg_gex: Optional[float] = None
    fired_5m: bool = False
    fired_at: float = 0.0
    alert_id: Optional[int] = None

    @property
    def confirm_level(self) -> float:
        return self.c2["low"] if self.direction == "CE" else self.c2["high"]


class WallScanner:
    def __init__(self):
        self._lock = threading.Lock()
        self._providers: Dict[str, dict] = {}
        self._htf: Dict[str, Dict[str, dict]] = {}
        self._setups: List[Setup] = []
        self._last_fire: Dict[tuple, float] = {}
        self._last_c2_level: Dict[tuple, float] = {}
        self.on_alert: Optional[Callable[[dict], None]] = None
        self._subscribed_logged = False   # one-shot startup confirmation
        self._stop: Optional[threading.Event] = None
        self._thread: Optional[threading.Thread] = None

    # ── provider registration ────────────────────────────────
    def register(self, symbol: str, kind: str, tier: int,
                 get_data: Callable, get_strikes: Callable,
                 get_spot: Callable, get_neggex: Optional[Callable] = None):
        if kind == "COMMODITY":
            return  # spec section 30
        with self._lock:
            self._providers[symbol] = {
                "tier": tier, "get_data": get_data, "get_strikes": get_strikes,
                "get_spot": get_spot, "get_neggex": get_neggex,
            }

    def unregister(self, symbol: str):
        with self._lock:
            self._providers.pop(symbol, None)
            self._htf.pop(symbol, None)
            self._setups = [s for s in self._setups if s.symbol != symbol]

    # ── lifecycle ────────────────────────────────────────────
    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._watchdog, daemon=True,
                                        name="wall-scanner")
        self._thread.start()
        logger.info("[WallScanner] started (tunables: c1>=%.2fx c2<=%.2f tol=%.2fx "
                    "cluster=%.0fx realert=%.2fx cd=%ds)",
                    C1_MIN_RANGE_X_INTERVAL, C2_MAX_RATIO_OF_C1,
                    C2_CLOSE_TOLERANCE_X_INTERVAL, INDEX_CLUSTER_X_INTERVAL,
                    RE_ALERT_MIN_DIFF_X_INTERVAL, ALERT_COOLDOWN_SEC)
        self._subscribed_logged = False

    def stop(self):
        if self._stop:
            self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _watchdog(self):
        while self._stop and not self._stop.wait(15):
            now = datetime.now()
            if now.weekday() > 4 or now.time() > dt_time(15, 30):
                with self._lock:
                    if self._setups:
                        logger.info("[WallScanner] session end — expiring %d pending setup(s)",
                                    len(self._setups))
                        self._setups.clear()

    # ── 1m close entry point (subscribed from candle_builder) ──
    def on_1m_close(self, candle: dict):
        try:
            if not self._subscribed_logged:
                logger.info("[WallScanner] subscribed to candle_builder (%d providers)",
                            len(self._providers))
                self._subscribed_logged = True
            self._process(candle)
        except Exception as e:
            logger.error("[WallScanner] process error %s: %s", candle.get("symbol"), e)

    def _process(self, c1m: dict):
        symbol = c1m["symbol"]
        with self._lock:
            prov = self._providers.get(symbol)
            if not prov:
                return
            htf = self._htf.setdefault(symbol, {"tf": {}, "five": None, "five_part": [],
                                                "last_closed": {}})
            date_part = c1m["ts_minute"][:10]

            # 1) HTF finalizations FIRST (deterministic ordering, spec 24)
            for tf in HTF_TFS:
                b = htf_bucket_minutes(tf, c1m["ts_minute"])
                if b is None:
                    continue
                cur = htf["tf"].get(tf)
                if cur is None:
                    htf["tf"][tf] = {"bucket": b, "part": [c1m]}
                elif b == cur["bucket"]:
                    cur["part"].append(c1m)
                else:
                    closed = _aggregate(symbol, cur["part"])
                    closed["ts_minute"] = _label(date_part, cur["bucket"])
                    self._on_htf_close(symbol, tf, closed, htf)
                    htf["tf"][tf] = {"bucket": b, "part": [c1m]}

            # 2) 5m close (clock-aligned)
            fb = five_m_bucket_minutes(c1m["ts_minute"])
            if htf["five"] is None:
                htf["five"] = fb; htf["five_part"] = [c1m]
            elif fb == htf["five"]:
                htf["five_part"].append(c1m)
            else:
                closed5 = _aggregate(symbol, htf["five_part"])
                closed5["ts_minute"] = _label(date_part, htf["five"])
                self._on_5m_close(symbol, closed5)
                htf["five"] = fb; htf["five_part"] = [c1m]

    # ── HTF close: C3 resolution, then new-setup detection ────
    def _on_htf_close(self, symbol: str, tf: str, htf_c: dict, htf_state: dict):
        # a) pending setups on this (symbol, tf): this candle is C3
        for s in [s for s in self._setups if s.symbol == symbol and s.tf == tf]:
            confirmed = (htf_c["close"] < s.c2["low"] if s.direction == "CE"
                         else htf_c["close"] > s.c2["high"])
            if confirmed:
                self._fire(s, "CONFIRMED", htf_c=htf_c)
            else:
                logger.info("[WallScanner] %s %s %s setup expired (C3 close=%.2f vs level=%.2f)",
                            symbol, tf, s.direction, htf_c["close"], s.confirm_level)
            self._setups.remove(s)

        # b) pattern detection: C1 = previously closed HTF candle, C2 = this one
        prev = htf_state["last_closed"].get(tf)
        htf_state["last_closed"][tf] = htf_c
        if prev is None:
            return
        for direction in ("CE", "PE"):
            self._try_form(symbol, tf, direction, prev, htf_c)

    def _walls(self, prov: dict):
        """Window-wide max-OI strikes from the streamer's own store
        (spec 18: Tier 3 window-local by architecture)."""
        data = prov["get_data"]() or {}
        ce_w = pe_w = None
        ce_oi = pe_oi = -1
        for strike, d in data.items():
            ce = (d.get("CE") or {}).get("oi", 0)
            pe = (d.get("PE") or {}).get("oi", 0)
            if ce > ce_oi:
                ce_oi, ce_w = ce, strike
            if pe > pe_oi:
                pe_oi, pe_w = pe, strike
        return ce_w, pe_w

    def _try_form(self, symbol: str, tf: str, direction: str, c1: dict, c2: dict):
        prov = self._providers[symbol]
        ce_w, pe_w = self._walls(prov)
        wall = ce_w if direction == "CE" else pe_w
        if wall is None:
            return
        strikes = prov["get_strikes"]() or []
        interval = local_interval(strikes, wall)
        if not interval:
            return

        r1 = c1["high"] - c1["low"]
        r2 = c2["high"] - c2["low"]
        # §8: sizes
        if r1 < C1_MIN_RANGE_X_INTERVAL * interval:
            return
        if r2 > C2_MAX_RATIO_OF_C1 * r1:
            return
        # §10/12: wick touch on C1 OR C2
        if direction == "CE":
            if not (c1["high"] >= wall or c2["high"] >= wall):
                return
        else:
            if not (c1["low"] <= wall or c2["low"] <= wall):
                return
        # §11: C2 close within tolerance of wall
        if abs(c2["close"] - wall) > C2_CLOSE_TOLERANCE_X_INTERVAL * interval:
            return

        atm = prov["get_spot"]()
        neg_gex = None
        if symbol in INDEX_SYMBOLS:
            neg_gex = prov["get_neggex"]() if prov["get_neggex"] else None
            if neg_gex is None:
                return  # index condition requires the gamma level (spec 16)
            levels = [atm, wall, neg_gex]
            idxs = [min(range(len(strikes)), key=lambda k: abs(strikes[k] - lv))
                    for lv in levels if lv is not None]
            if len(idxs) == 3 and (max(idxs) - min(idxs)) > INDEX_CLUSTER_X_INTERVAL:
                return

        # §20: one pending setup per symbol+direction+tf+wall
        if any(s.symbol == symbol and s.direction == direction and s.tf == tf
               and s.wall == wall for s in self._setups):
            return
        # §21: same-wall re-alert threshold
        key = (symbol, direction, tf, wall)
        prev_level = self._last_c2_level.get(key)
        level = c2["low"] if direction == "CE" else c2["high"]
        if prev_level is not None and abs(level - prev_level) <= RE_ALERT_MIN_DIFF_X_INTERVAL * interval:
            return
        # cooldown analogue (spec 21/27)
        ck = (symbol, direction, tf)
        if time.time() - self._last_fire.get(ck, 0) < ALERT_COOLDOWN_SEC and prev_level is not None:
            return

        s = Setup(symbol=symbol, direction=direction, tf=tf, wall=float(wall),
                  interval=float(interval), c1=dict(c1), c2=dict(c2),
                  atm=atm, neg_gex=neg_gex)
        self._setups.append(s)
        self._last_c2_level[key] = level
        logger.info("[WallScanner] SETUP %s %s %s wall=%s c2_level=%.2f interval=%.2f",
                    symbol, tf, direction, wall, level, interval)

    # ── 5m close: Setup Forming (once per setup, spec 23) ─────
    def _on_5m_close(self, symbol: str, c5: dict):
        for s in [s for s in self._setups if s.symbol == symbol and not s.fired_5m]:
            breach = (c5["close"] < s.c2["low"] if s.direction == "CE"
                      else c5["close"] > s.c2["high"])
            if breach:
                s.fired_5m = True
                self._fire(s, "SETUP_FORMING", c5=c5)

    # ── alert persistence + dispatch ─────────────────────────
    def _armed(self) -> bool:
        try:
            return app_settings.get_alerts_armed()
        except Exception:
            return True  # fail open, mirrors alert_engine

    def _fire(self, s: Setup, kind: str, htf_c: dict = None, c5: dict = None):
        if not self._armed():
            return
        # Read enabled/cooldown/channels from the shared alert settings
        # (registered as AlertRuleType.WALL_REVERSAL) — no hardcoded config.
        from alert_engine import alert_engine as _ae
        from alert_models import AlertRuleType, NotificationChannel
        _settings = _ae.get_settings()
        _cfg = next(
            (r for r in _settings.get("rules", [])
             if r.get("rule_type") == AlertRuleType.WALL_REVERSAL.value),
            None,
        )
        if not _cfg or not _cfg.get("enabled", True):
            return                                   # Wall Reversal disabled in Settings
        _cooldown = int(_cfg.get("cooldown_seconds", 300) or 300)
        ck = (s.symbol, s.direction, s.tf)
        if time.time() - self._last_fire.get(ck, 0) < _cooldown:
            return
        self._last_fire[ck] = time.time()
        # ── Channel decision ─────────────────────────────────────────
        # T1/T2/T3 (unchanged): per-rule flags + shared telegram toggle.
        # Tier 4: the dedicated Tier-4 profile owns routing — same semantics as
        # the engine path (evaluate_rules): profile channels decide, and the
        # destination is the dedicated config when fully configured, else the
        # shared destination.
        _ch = list(_cfg.get("channels") or [NotificationChannel.TOAST.value])
        if (_cfg.get("sound_enabled")
                and _settings.get("sound", {}).get("master_enabled", True)
                and NotificationChannel.SOUND.value not in _ch):
            _ch.append(NotificationChannel.SOUND.value)
        _tier = self._providers.get(s.symbol, {}).get("tier")
        _t4 = _settings.get("tier4") or {}
        _t4tg = _t4.get("telegram") or {}
        _t4_dedicated = bool(_t4tg.get("enabled") and _t4tg.get("bot_token") and _t4tg.get("chat_id"))
        _shared_tg = _settings.get("telegram") or {}
        if _tier == 4:
            if (NotificationChannel.TELEGRAM.value in (_t4.get("channels") or ["telegram"])
                    and (_t4_dedicated or _shared_tg.get("enabled", False))
                    and NotificationChannel.TELEGRAM.value not in _ch):
                _ch.append(NotificationChannel.TELEGRAM.value)
        else:
            if (_cfg.get("telegram_enabled")
                    and _shared_tg.get("enabled", False)
                    and NotificationChannel.TELEGRAM.value not in _ch):
                _ch.append(NotificationChannel.TELEGRAM.value)

        # ── Enrichment at fire time ──────────────────────────────────
        # All values come from the SAME data store / providers the detection
        # used — snapshotted now, never recalculated later.
        prov = self._providers.get(s.symbol) or {}
        _spot = None
        _strikes = []
        try:
            if prov.get("get_spot"):
                _spot = prov["get_spot"]()
        except Exception:
            _spot = None
        try:
            if prov.get("get_strikes"):
                _strikes = list(prov["get_strikes"]() or [])
        except Exception:
            _strikes = []
        _ce_w = _pe_w = None
        if prov:
            try:
                _ce_w, _pe_w = self._walls(prov)
            except Exception:
                _ce_w = _pe_w = None
        _atm_strike = min(sorted(_strikes), key=lambda x: abs(x - _spot)) if (_spot is not None and _strikes) else None
        if _spot is None:
            _spot = s.atm  # Setup.atm holds the spot price captured at detection

        tf_min = TF_MINUTES[s.tf]
        side = "CE Wall" if s.direction == "CE" else "PE Wall"
        rule_name = (f"SETUP FORMING — {s.tf} {side}" if kind == "SETUP_FORMING"
                     else f"CONFIRMED — {s.tf} {side} Reversal")
        now = datetime.now()
        scanner_meta = {
            "scanner": RULE_TYPE, "kind": kind, "direction": s.direction,
            "timeframe": s.tf, "symbol": s.symbol,
            "wall": s.wall, "wall_ce": _ce_w, "wall_pe": _pe_w, "atm": s.atm,
            "neg_gex": s.neg_gex, "strike_interval": s.interval,
            "c1_ts": s.c1["ts_minute"], "c2_ts": s.c2["ts_minute"],
            "c2_high": s.c2["high"], "c2_low": s.c2["low"],
            "c1_range": s.c1["high"] - s.c1["low"],
            "c2_range": s.c2["high"] - s.c2["low"],
            "fired_at": now.isoformat(),
            "c3_ts": htf_c["ts_minute"] if htf_c else None,
            "c3_close": htf_c["close"] if htf_c else None,
            "five_m_ts": c5["ts_minute"] if c5 else None,
            "five_m_close": c5["close"] if c5 else None,
        }
        # Normalized payload: AlertTriggerPayload-compatible top level so every
        # downstream consumer — toast, mobile feed, Telegram template, history
        # API — reads ONE schema. Scanner specifics remain in market_state AND
        # as top-level extras (direction/timeframe/wall).
        metadata = {
            "timestamp": now.isoformat(),
            "index_name": s.symbol,
            "rule_type": RULE_TYPE,
            "rule_name": rule_name,
            "instrument_tier": _tier,
            "spot": _spot,
            "atm_strike": _atm_strike,
            "max_ce_oi_strike": int(_ce_w) if _ce_w is not None else None,
            "max_pe_oi_strike": int(_pe_w) if _pe_w is not None else None,
            "max_negative_gex_strike": (int(s.neg_gex) if s.neg_gex else None),
            "net_gex": None,
            "futures_spread": None,
            "channels_fired": _ch,
            "market_state": scanner_meta,
            "direction": s.direction,
            "timeframe": s.tf,
            "wall": s.wall,
        }
        try:
            from alert_db import save_alert_history
            aid = save_alert_history(
                timestamp=now.strftime("%Y-%m-%d %H:%M:%S"),
                index_name=s.symbol, rule_type=RULE_TYPE, rule_name=rule_name,
                spot=_spot, atm_strike=_atm_strike,
                max_ce_oi_strike=int(_ce_w) if _ce_w is not None else None,
                max_pe_oi_strike=int(_pe_w) if _pe_w is not None else None,
                max_negative_gex_strike=(int(s.neg_gex) if s.neg_gex else None),
                net_gex=None, futures_spread=None,
                channels_fired=_ch,
                market_state=scanner_meta,
                instrument_tier=_tier,
            )
            s.alert_id = aid
        except Exception as e:
            logger.error("[WallScanner] history write failed: %s", e)
        logger.info("[WallScanner] ALERT %s | %s | channels=%s", rule_name, s.symbol, _ch)
        if self.on_alert:
            try:
                self.on_alert(metadata)
            except Exception as e:
                logger.error("[WallScanner] dispatch hook: %s", e)

    # ── status ───────────────────────────────────────────────
    def status(self) -> dict:
        with self._lock:
            return {"pending_setups": [
                {"symbol": s.symbol, "direction": s.direction, "tf": s.tf,
                 "wall": s.wall, "c2_level": s.confirm_level, "fired_5m": s.fired_5m}
                for s in self._setups]}


wall_scanner = WallScanner()
