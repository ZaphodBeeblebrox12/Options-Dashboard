"""Part 1 — Greek validation/comparison sampler (NIFTY & SENSEX).

COMPLETELY ISOLATED from Tier 1/2/3 production analytics: it only READS live
streamer state (via the public get_current_state) and makes its own Angel One
optionGreek REST calls. Nothing here writes to nifty_snapshots.db,
LiveDataStore, SnapshotEngine or the alert path.

What it does, per config:
  - during equity market hours only (09:15-15:30 IST, Mon-Fri)
  - every VALIDATION_SAMPLE_SEC (default 120), per index SEQUENTIALLY:
      resolve the SAME expiry the Tier-1 streamer uses
      call Angel optionGreek(name, expiry)
      immediately snapshot our local values for the same (expiry, strike, CE/PE)
      store BOTH sides raw + market-state context + flags
  - first live SENSEX call is an explicit support probe: the outcome is
    recorded in meta and the report — never fabricate/substitute values.

DB: backend/greeks_compare.db (separate file, WAL).

Env:
  VALIDATION_ENABLE        "1" to enable (default "0" — fully off)
  VALIDATION_SAMPLE_SEC    default 120
  VALIDATION_INDICES       default "NIFTY,SENSEX"
"""
import os
import json
import time
import sqlite3
import threading
import logging
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

DB_PATH = os.path.join(os.path.dirname(__file__), "greeks_compare.db")
ENABLED = os.getenv("VALIDATION_ENABLE", "0") == "1"
SAMPLE_SEC = int(os.getenv("VALIDATION_SAMPLE_SEC", "120"))
INDICES = [s.strip().upper() for s in os.getenv("VALIDATION_INDICES", "NIFTY,SENSEX").split(",") if s.strip()]
STALE_LOCAL_TICK_SEC = 15.0

OPTION_GREEKS_URL = ("https://apiconnect.angelone.in/rest/secure/angelbroking/"
                     "marketData/v1/optionGreek")

SCHEMA = """
CREATE TABLE IF NOT EXISTS greek_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  index_name TEXT NOT NULL,
  expiry TEXT NOT NULL,
  angel_expiry TEXT,
  strike INTEGER NOT NULL,
  option_type TEXT NOT NULL,
  spot REAL,
  local_ltp REAL,
  local_tick_age_sec REAL,
  local_calc_age_sec REAL,
  risk_free_rate REAL,
  t_years REAL,
  angel_iv REAL, angel_delta REAL, angel_gamma REAL, angel_theta REAL, angel_vega REAL,
  angel_volume REAL,
  local_iv REAL, local_delta REAL, local_gamma REAL, local_theta REAL, local_vega REAL,
  flags TEXT NOT NULL DEFAULT '[]',
  UNIQUE(index_name, sample_id, strike, option_type)
);
CREATE INDEX IF NOT EXISTS idx_gs_contract ON greek_samples(index_name, expiry, strike, option_type, ts);
CREATE INDEX IF NOT EXISTS idx_gs_ts ON greek_samples(ts);

CREATE TABLE IF NOT EXISTS api_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  index_name TEXT NOT NULL,
  code TEXT,
  message TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""


def init_db(path=DB_PATH):
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


class ValidationSampler:
    def __init__(self):
        self.enabled = ENABLED
        self._conn = None
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop: Optional[threading.Event] = None
        self._adapter = None
        self._sample_seq = 0
        self.counters = {"samples": 0, "rows": 0, "errors": 0, "sensex_supported": None}

    # ── lifecycle ──
    def configure(self, adapter):
        self._adapter = adapter

    def start(self):
        if not self.enabled:
            logger.info("[Validation] disabled (VALIDATION_ENABLE=%s)", os.getenv("VALIDATION_ENABLE", "0"))
            return
        if self._adapter is None or getattr(self._adapter, "mode", "") != "real" \
                or getattr(self._adapter, "auth_manager", None) is None:
            logger.warning("[Validation] not started — live streaming/auth unavailable")
            return
        self._conn = init_db()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="greeks-validation")
        self._thread.start()
        logger.info("[Validation] started: indices=%s every %ds -> %s", INDICES, SAMPLE_SEC, DB_PATH)

    def stop(self):
        if self._stop:
            self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        if self._conn:
            self._conn.close()
        logger.info("[Validation] stopped")

    # ── main loop ──
    def _equity_open(self) -> bool:
        now = datetime.now()
        if now.weekday() > 4:
            return False
        from datetime import time as dt_time
        return dt_time(9, 15) <= now.time() <= dt_time(15, 30)

    def _loop(self):
        # warm-up probe of SENSEX support on the very first market-hours tick
        probed = False
        while not self._stop.is_set():
            try:
                if self._equity_open():
                    if not probed:
                        probed = True
                        self._probe_sensex()
                    self._sample_cycle()
            except Exception as e:
                logger.error("[Validation] cycle error: %s", e)
            self._stop.wait(SAMPLE_SEC)

    def _probe_sensex(self):
        if "SENSEX" not in INDICES:
            return
        try:
            from scrip_master import scrip_master
            exp = scrip_master.get_nearest_weekly_expiry("SENSEX")
            rows, err = self._call_angel("SENSEX", exp)
            supported = bool(rows) and err is None
            note = "OK" if supported else f"NO USABLE DATA: {err or 'empty batch'}"
            with self._lock:
                self._conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                                   ("sensex_supported", json.dumps({"at": datetime.now().isoformat(),
                                                                    "expiry": exp, "supported": supported,
                                                                    "note": note})))
                self._conn.commit()
            self.counters["sensex_supported"] = supported
            logger.info("[Validation] SENSEX probe: %s (expiry=%s)", note, exp)
        except Exception as e:
            logger.error("[Validation] SENSEX probe failed: %s", e)

    # ── one sampling cycle: sequential per index ──
    def _sample_cycle(self):
        self._sample_seq += 1
        sid = self._sample_seq
        for index in INDICES:
            if self._stop.is_set():
                return
            streamer = self._adapter.streamers.get(index)
            if streamer is None:
                continue
            expiry = getattr(streamer, "expiry_str", None)
            if not expiry:
                continue
            # local state FIRST (fresh anchor), Angel call immediately after
            local_state = None
            try:
                local_state = streamer.get_current_state().get("data", {})
            except Exception as e:
                logger.warning("[Validation] %s local state error: %s", index, e)
            rows, err = self._call_angel(index, expiry)
            if err is not None:
                self._record_error(index, err)
                continue
            self._store_sample(sid, index, expiry, rows or [], local_state, streamer)
            self.counters["samples"] += 1

    # ── Angel call (raw requests; SDK has no first-class method) ──
    def _call_angel(self, index, expiry):
        auth = self._adapter.auth_manager
        headers = {
            "Content-Type": "application/json", "Accept": "application/json",
            "X-SourceID": "WEB", "X-ClientLocalIP": os.getenv("CLIENT_LOCAL_IP", "192.168.1.1"),
            "X-MACAddress": os.getenv("CLIENT_MAC", "aa:bb:cc:dd:ee:ff"),
            "X-UserType": "USER",
            "Authorization": auth.get_valid_jwt(),
            "X-PrivateKey": auth.api_key,
        }
        try:
            import requests
            from greeks_feed import optiongreek_limiter
            optiongreek_limiter.acquire()   # same documented 1 req/s optionGreek budget
            resp = requests.post(OPTION_GREEKS_URL, headers=headers,
                                 data=json.dumps({"name": index, "expirydate": expiry}), timeout=15)
            msg_low = ""
            try:
                msg_low = str(resp.json().get("message", "")).lower()
            except Exception:
                pass
            if resp.status_code == 429 or "too many" in msg_low or "rate limit" in msg_low:
                optiongreek_limiter.throttle()
                return None, "throttled:shared-optiongreek-budget"
            data = resp.json()
        except Exception as e:
            return None, f"http:{e}"
        if not data.get("status"):
            return None, f"{data.get('errorcode', '')}:{data.get('message', 'unknown')}"
        return data.get("data") or [], None

    def _record_error(self, index, err):
        self.counters["errors"] += 1
        code, _, msg = err.partition(":")
        with self._lock:
            self._conn.execute("INSERT INTO api_errors (ts, index_name, code, message) VALUES (?,?,?,?)",
                               (datetime.now().isoformat(), index, code, msg))
            self._conn.commit()
        logger.warning("[Validation] %s API error: %s", index, err)

    # ── row construction & storage ──
    def _store_sample(self, sid, index, expiry, rows, local_state, streamer):
        from calculations import get_risk_free_rate
        now = datetime.now()
        ts = now.isoformat()
        spot = local_state.get("spot") if local_state else None
        state_ts = local_state.get("timestamp") if local_state else None
        calc_age = None
        if state_ts:
            try:
                calc_age = (now - datetime.fromisoformat(state_ts)).total_seconds()
            except Exception:
                calc_age = None
        try:
            tick_age = streamer.spot_poller.spot_age_sec()
        except Exception:
            tick_age = None
        try:
            from datetime import datetime as _dt
            exp_dt = getattr(streamer, "expiry_datetime", None)
            t_years = max((exp_dt - now).total_seconds() / (365.25 * 24 * 3600), 0.0001) if exp_dt else None
        except Exception:
            t_years = None
        r = get_risk_free_rate()

        local_opts = {}
        for o in (local_state or {}).get("options", []):
            local_opts[(int(o["strike"]), o["option_type"])] = o

        n_rows = 0
        for raw in rows:
            try:
                strike = int(round(float(raw.get("strikePrice", 0))))
                ot = str(raw.get("optionType", "")).strip().upper()
            except (TypeError, ValueError):
                continue
            if strike <= 0 or ot not in ("CE", "PE"):
                continue
            flags = []
            angel_expiry = str(raw.get("expiry", "") or "").upper()
            if angel_expiry and expiry and angel_expiry != str(expiry).upper():
                flags.append("expiry_mismatch")     # weekly/monthly bug guard
            loc = local_opts.get((strike, ot))
            if loc is None:
                flags.append("missing_local")
            elif tick_age is not None and tick_age > STALE_LOCAL_TICK_SEC:
                flags.append("stale_local")
            def af(field):
                try:
                    v = raw.get(field)
                    return float(v) if v not in (None, "") else None
                except (TypeError, ValueError):
                    flags.append("malformed_angel")
                    return None
            a_iv, a_delta, a_gamma, a_theta, a_vega = (af("impliedVolatility"), af("delta"),
                                                       af("gamma"), af("theta"), af("vega"))
            a_vol = af("tradeVolume")
            if a_iv is None or a_delta is None:
                flags.append("missing_angel")
            l_iv = loc.get("iv") if loc else None
            l_delta = loc.get("delta") if loc else None
            l_gamma = loc.get("gamma") if loc else None
            l_theta = loc.get("theta") if loc else None
            l_vega = loc.get("vega") if loc else None
            if loc is not None and l_iv is None and loc.get("ltp", 0) > 0:
                flags.append("sanity_reject")
            ltp = loc.get("ltp") if loc else None
            with self._lock:
                self._conn.execute(
                    """INSERT OR IGNORE INTO greek_samples
                       (sample_id, ts, index_name, expiry, angel_expiry, strike, option_type,
                        spot, local_ltp, local_tick_age_sec, local_calc_age_sec, risk_free_rate, t_years,
                        angel_iv, angel_delta, angel_gamma, angel_theta, angel_vega, angel_volume,
                        local_iv, local_delta, local_gamma, local_theta, local_vega, flags)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (sid, ts, index, str(expiry).upper(), angel_expiry or None, strike, ot,
                     spot, ltp, tick_age, calc_age, r, t_years,
                     a_iv, a_delta, a_gamma, a_theta, a_vega, a_vol,
                     l_iv, l_delta, l_gamma, l_theta, l_vega, json.dumps(flags)))
            n_rows += 1
        with self._lock:
            self._conn.commit()
        self.counters["rows"] += n_rows
        logger.info("[Validation] sample #%d %s: %d rows (expiry %s)", sid, index, n_rows, expiry)


validation_sampler = ValidationSampler()
