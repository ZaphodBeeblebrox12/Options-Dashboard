"""App-level settings: server-side source of truth for user configuration.

Persists to app_settings.db (SQLite, single JSON row). Seeded from .env on
first run so existing deployments migrate transparently:
  TIER2_STOCKS         -> stocks
  RISK_FREE_RATE       -> risk_free_rate
  WS_TIER2_WINDOW_SIZE -> window_half_width
After first run, the DB is authoritative — the UI reads/writes this store.
"""
import os
import json
import sqlite3
import threading
from typing import List, Dict, Any, Callable

DB_PATH = os.path.join(os.path.dirname(__file__), "app_settings.db")

DEFAULTS: Dict[str, Any] = {
    "stocks": [],
    "risk_free_rate": 6.5,
    "window_half_width": 20,
    "tier3_window_half_width": 8,      # Tier-3 scanner strike window (ATM ±N)
    "alerts_armed": True,
    "alert_scope": "viewed",           # "viewed" | "all" — notifications for watched symbol only, or every symbol
    "snapshot_interval_seconds": 30,   # snapshot capture cadence (5–300, internal)
    "alert_rearm_seconds": 60,         # debounce AFTER the condition clears, before re-arming (0 = immediate)
    "instrument_kinds": {},            # SYMBOL -> INDEX | STOCK | COMMODITY
    "instrument_tiers": {},            # SYMBOL -> 1 | 2 (Tier 1 = capacity priority + 5s broadcast)
}

_lock = threading.RLock()
_cache: Dict[str, Any] = {}
_callbacks: List[Callable[[Dict[str, Any], Dict[str, Any]], None]] = []
_initialized = False


def _conn():
    return sqlite3.connect(DB_PATH, check_same_thread=False)


def init_settings():
    global _initialized
    with _lock:
        if _initialized:
            return
        conn = _conn()
        conn.execute("""CREATE TABLE IF NOT EXISTS app_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            settings_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP)""")
        conn.execute("INSERT OR IGNORE INTO app_settings (id, settings_json) VALUES (1, '{}')")
        conn.commit()
        row = conn.execute("SELECT settings_json FROM app_settings WHERE id = 1").fetchone()
        data = json.loads(row[0]) if row and row[0] else {}
        merged = dict(DEFAULTS)
        merged.update({k: v for k, v in data.items() if k in DEFAULTS})

        if not data:
            # First run — seed from .env so nothing breaks for existing users
            env_stocks = [s.strip().upper() for s in os.getenv("TIER2_STOCKS", "").split(",") if s.strip()]
            if env_stocks:
                merged["stocks"] = env_stocks
            env_rate = os.getenv("RISK_FREE_RATE", "").strip()
            if env_rate:
                try:
                    merged["risk_free_rate"] = float(env_rate)
                except ValueError:
                    pass
            env_win = os.getenv("WS_TIER2_WINDOW_SIZE", "").strip()
            if env_win:
                try:
                    merged["window_half_width"] = int(env_win)
                except ValueError:
                    pass
            conn.execute("UPDATE app_settings SET settings_json = ? WHERE id = 1", (json.dumps(merged),))
            conn.commit()
            print(f"[AppSettings] First run — seeded from .env: {merged}")

        conn.close()
        _cache.clear()
        _cache.update(merged)
        _initialized = True
        print(f"[AppSettings] stocks={_cache['stocks']} rate={_cache['risk_free_rate']}% "
              f"window=±{_cache['window_half_width']} alerts_armed={_cache['alerts_armed']}")


def get_all() -> Dict[str, Any]:
    init_settings()
    with _lock:
        return dict(_cache)


def get_stocks() -> List[str]:
    return list(get_all()["stocks"])


def get_risk_free_rate() -> float:
    return float(get_all()["risk_free_rate"])


def get_window_half_width() -> int:
    return int(get_all()["window_half_width"])


def get_tier3_window_half_width() -> int:
    """Tier-3 scanner strike window (ATM ±N). Adjustable at runtime from
    Settings > Analytics; window rebuilds pick it up immediately."""
    return int(get_all().get("tier3_window_half_width", 8))


def get_alerts_armed() -> bool:
    return bool(get_all()["alerts_armed"])


def get_alert_rearm_seconds() -> int:
    """Debounce after the condition clears, before the rule re-arms.
    0 = re-arm immediately on clear (original v2.2 behavior). While the
    condition still holds, the rule never re-fires regardless of this value."""
    return int(get_all()["alert_rearm_seconds"])


def get_alert_scope() -> str:
    """'viewed' = notify only for the symbol on screen; 'all' = every symbol."""
    return str(get_all()["alert_scope"])


def get_snapshot_interval() -> int:
    """Snapshot timer rearm interval in seconds (5–300)."""
    return int(get_all()["snapshot_interval_seconds"])


# ── Instrument registry: kinds + tiers ─────────────────────────

def add_instrument(symbol: str, kind: str = "STOCK"):
    """Register a tracked instrument (keeps the stocks list for legacy paths)."""
    sym = symbol.strip().upper()
    kind = kind.strip().upper()
    if kind not in ("INDEX", "STOCK", "COMMODITY"):
        kind = "STOCK"
    stocks = get_stocks()
    kinds = dict(get_all()["instrument_kinds"])
    if sym and sym not in stocks:
        stocks.append(sym)
        kinds[sym] = kind
        update({"stocks": stocks, "instrument_kinds": kinds})


def remove_instrument(symbol: str):
    sym = symbol.strip().upper()
    stocks = get_stocks()
    if sym in stocks:
        stocks.remove(sym)
    kinds = dict(get_all()["instrument_kinds"])
    kinds.pop(sym, None)
    tiers = dict(get_all()["instrument_tiers"])
    tiers.pop(sym, None)
    update({"stocks": stocks, "instrument_kinds": kinds, "instrument_tiers": tiers})


def get_instrument_kind(symbol: str) -> str:
    sym = symbol.strip().upper()
    return str(get_all()["instrument_kinds"].get(sym, "STOCK"))


def set_instrument_tier(symbol: str, tier: int):
    sym = symbol.strip().upper()
    tiers = dict(get_all()["instrument_tiers"])
    tier = int(tier)
    if tier not in (1, 2, 3):
        tier = 3
    if tier != 1 and sym in ("NIFTY", "SENSEX"):
        return  # fixed Tier-1 indices are never demoted
    tiers[sym] = tier
    update({"instrument_tiers": tiers})


def get_instrument_tier(symbol: str) -> int:
    """Tier for an instrument. NIFTY/SENSEX are always Tier 1; everything else
    defaults to Tier 3 (scanner) unless promoted to 2 or 1."""
    sym = symbol.strip().upper()
    if sym in ("NIFTY", "SENSEX"):
        return 1
    return int(get_all()["instrument_tiers"].get(sym, 3))


def update(patch: Dict[str, Any]) -> Dict[str, Any]:
    init_settings()
    with _lock:
        old = dict(_cache)
        for k, v in patch.items():
            if k not in DEFAULTS:
                continue
            if k == "stocks":
                v = [str(s).strip().upper() for s in v if str(s).strip()]
            elif k == "risk_free_rate":
                v = max(0.0, min(20.0, float(v)))
            elif k == "window_half_width":
                v = max(5, min(40, int(v)))
            elif k == "alerts_armed":
                v = bool(v)
            elif k == "alert_scope":
                v = "all" if str(v).lower() == "all" else "viewed"
            elif k == "snapshot_interval_seconds":
                v = max(5, min(300, int(v)))
            elif k == "alert_rearm_seconds":
                v = max(0, min(3600, int(v)))
            elif k in ("instrument_kinds", "instrument_tiers"):
                v = dict(v) if isinstance(v, dict) else {}
            _cache[k] = v
        conn = _conn()
        conn.execute("UPDATE app_settings SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
                     (json.dumps(_cache),))
        conn.commit()
        conn.close()
        new = dict(_cache)

    for cb in list(_callbacks):
        try:
            cb(old, new)
        except Exception as e:
            print(f"[AppSettings] callback error: {e}")
    return new


def add_stock(symbol: str):
    stocks = get_stocks()
    sym = symbol.strip().upper()
    if sym and sym not in stocks:
        stocks.append(sym)
        update({"stocks": stocks})


def remove_stock(symbol: str):
    stocks = get_stocks()
    sym = symbol.strip().upper()
    if sym in stocks:
        stocks.remove(sym)
        update({"stocks": stocks})


def on_change(cb: Callable[[Dict[str, Any], Dict[str, Any]], None]):
    _callbacks.append(cb)
