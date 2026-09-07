
import sys, os, json, tempfile, importlib

# Resolve the backend dir relative to this test file (backend/tests/ -> backend/)
BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

# requests stub (offline test env may lack it; telegram send is not exercised)
try:
    import requests  # noqa
except ImportError:
    import types
    rs = types.ModuleType("requests")
    rs.exceptions = types.SimpleNamespace(RequestException=Exception)
    rs.post = lambda *a, **k: None
    sys.modules["requests"] = rs

import app_settings
# Seed settings cache WITHOUT touching disk (upload dir is read-only)
app_settings._initialized = True
app_settings._cache = {
    "stocks": [], "risk_free_rate": 6.5, "window_half_width": 20,
    "tier3_window_half_width": 8, "alerts_armed": True, "alert_scope": "viewed",
    "snapshot_interval_seconds": 30, "alert_rearm_seconds": 60,
    "instrument_kinds": {}, "instrument_tiers": {},
}

import alert_db
_tmp = tempfile.mkdtemp()
alert_db.ALERT_DB_PATH = os.path.join(_tmp, "alert_system.db")
alert_db.init_alert_db()

TIER_STATE = {"T3": 3}
app_settings.get_instrument_tier = lambda sym: TIER_STATE.get(sym.upper(), 2)

from alert_engine import AlertEngine
from alert_models import AlertRuleType
from telegram_notifier import resolve_telegram_destination, build_telegram_message

BASE_SETTINGS = {
    "rules": [
        {"rule_type": "atm_negative_gex_oi_wall", "enabled": True, "cooldown_seconds": 300,
         "channels": ["toast"], "sound_enabled": True, "sound_choice": "alert",
         "custom_sound_id": None, "telegram_enabled": True},
        {"rule_type": "atm_max_ce_pe_wall", "enabled": False, "cooldown_seconds": 300,
         "channels": ["toast"], "sound_enabled": False, "sound_choice": "bell",
         "custom_sound_id": None, "telegram_enabled": False},
    ],
    "telegram": {"enabled": True, "bot_token": "SHARED", "chat_id": "SHAREDCHAT"},
    "sound": {"master_enabled": True, "volume_percent": 80},
    "custom_sounds": [],
    "toast_duration_ms": 6000,
    "tier4_channels": ["telegram"],
    "tier4": {"enabled": True, "channels": ["telegram"], "cooldown_seconds": 300,
              "telegram": {"enabled": False, "bot_token": "", "chat_id": ""}},
}

def make_snapshot(sym):
    return {
        "timestamp": "2026-09-07 09:30:00", "index_name": sym, "spot": 100.0,
        "net_gex": -40.0, "futures_spread": 1.0,
        "options": [
            {"strike": 95,  "option_type": "CE", "oi": 1000, "gex": 30.0},
            {"strike": 95,  "option_type": "PE", "oi": 500,  "gex": 20.0},
            {"strike": 100, "option_type": "CE", "oi": 5000, "gex": -50.0},
            {"strike": 100, "option_type": "PE", "oi": 800,  "gex": 10.0},
            {"strike": 105, "option_type": "CE", "oi": 700,  "gex": 25.0},
            {"strike": 105, "option_type": "PE", "oi": 400,  "gex": 15.0},
        ],
    }

def fresh_engine(settings=None):
    eng = AlertEngine()
    eng._initialized = True
    eng.update_settings(json.loads(json.dumps(settings or BASE_SETTINGS)))
    return eng

def channels_of(fired):
    return sorted([c.value for c in fired[0].channels_fired]) if fired else []

def rule_name_of(fired):
    return fired[0].rule_name if fired else None

RESULTS = []
def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL "), name, ("— " + detail if detail else ""))

# ── 1. Tier 3 fires → normal routing ──────────────────────────
eng = fresh_engine()
fired = eng.evaluate_rules(make_snapshot("T3"), "T3")
ch = channels_of(fired)
check("T3 normal routing: toast+sound+telegram",
      ch == ["sound", "telegram", "toast"] and fired[0].instrument_tier == 3, str(ch))

# ── 2. Tier 4 telegram-only → telegram fires, no toast/sound ──
TIER_STATE["T4A"] = 4
eng = fresh_engine()
fired = eng.evaluate_rules(make_snapshot("T4A"), "T4A")
ch = channels_of(fired)
check("T4 telegram-only: channels == [telegram]",
      ch == ["telegram"] and fired[0].instrument_tier == 4, str(ch))
check("T4 telegram-only: toast/sound absent", "toast" not in ch and "sound" not in ch)
check("T4 rule name prefixed", rule_name_of(fired) == "TIER 4 | ATM + Negative GEX + OI Wall",
      str(rule_name_of(fired)))

# ── 3. Tier 4 telegram+toast; sound only if selected ──────────
st = json.loads(json.dumps(BASE_SETTINGS)); st["tier4"]["channels"] = ["telegram", "toast"]
TIER_STATE["T4B"] = 4
eng = fresh_engine(st)
fired = eng.evaluate_rules(make_snapshot("T4B"), "T4B")
ch = channels_of(fired)
check("T4 tg+toast, sound unselected → no sound", ch == ["telegram", "toast"], str(ch))
st["tier4"]["channels"] = ["telegram", "toast", "sound"]
eng = fresh_engine(st)
alert_db.reset_all_rule_states("T4B")
fired = eng.evaluate_rules(make_snapshot("T4B"), "T4B")
check("T4 tg+toast+sound selected → all three", channels_of(fired) == ["sound", "telegram", "toast"],
      str(channels_of(fired)))

# ── 4. Tier 4 disabled → no delivery, no history, no state ────
st = json.loads(json.dumps(BASE_SETTINGS)); st["tier4"]["enabled"] = False
TIER_STATE["T4D"] = 4
eng = fresh_engine(st)
fired = eng.evaluate_rules(make_snapshot("T4D"), "T4D")
hist = alert_db.get_alert_history("T4D")
rs = alert_db.get_rule_state(AlertRuleType.RULE_1.value, "T4D")
check("T4 disabled: no fire", fired == [])
check("T4 disabled: no history", hist["total"] == 0)
check("T4 disabled: rule state untouched (armed, never fired)",
      rs["state"] == "armed" and rs["last_fired_at"] is None, str(rs))

# ── 5 & 6. Tier transitions 3→4 and 4→3 driven by registry ────
TIER_STATE["TRX"] = 3
eng = fresh_engine()
fired3 = eng.evaluate_rules(make_snapshot("TRX"), "TRX")
alert_db.reset_all_rule_states("TRX")   # simulate condition clear + rearm
TIER_STATE["TRX"] = 4
fired4 = eng.evaluate_rules(make_snapshot("TRX"), "TRX")
c3, c4 = channels_of(fired3), channels_of(fired4)
check("3→4: same engine flips to tier-4 profile",
      "toast" in c3 and c4 == ["telegram"], f"t3={c3} t4={c4}")
alert_db.reset_all_rule_states("TRX")
TIER_STATE["TRX"] = 3
fired3b = eng.evaluate_rules(make_snapshot("TRX"), "TRX")
check("4→3: back to normal routing", "toast" in channels_of(fired3b), str(channels_of(fired3b)))

# ── 7 & 8. Dedicated Telegram destination + fallback ──────────
st = json.loads(json.dumps(BASE_SETTINGS))
st["tier4"]["telegram"] = {"enabled": True, "bot_token": "T4BOT", "chat_id": "T4CHAT"}
d = resolve_telegram_destination(st, 4)
check("T4 dedicated destination selected", d.get("bot_token") == "T4BOT" and d.get("chat_id") == "T4CHAT", str(d))
d2 = resolve_telegram_destination(BASE_SETTINGS, 4)
check("T4 unconfigured → shared fallback", d2.get("bot_token") == "SHARED", str(d2))
d3 = resolve_telegram_destination(st, 3)
check("T3 always shared destination even if T4 dest configured", d3.get("bot_token") == "SHARED", str(d3))
st["tier4"]["telegram"] = {"enabled": False, "bot_token": "X", "chat_id": "Y"}
check("T4 disabled dest (token present, enabled=false) → shared fallback",
      resolve_telegram_destination(st, 4).get("bot_token") == "SHARED")

# ── 9. Tier-4 Telegram formatting ─────────────────────────────
msg4 = build_telegram_message({"instrument_tier": 4, "index_name": "RELIANCE",
                               "rule_name": "TIER 4 | ATM + Negative GEX + OI Wall",
                               "timestamp": "2026-09-07 09:30:00", "spot": 100.5,
                               "atm_strike": 100, "max_ce_oi_strike": 100,
                               "max_pe_oi_strike": 95, "max_negative_gex_strike": 100,
                               "net_gex": -40})
msgn = build_telegram_message({"instrument_tier": None, "index_name": "NIFTY",
                               "rule_name": "ATM + Negative GEX + OI Wall", "timestamp": "t",
                               "spot": 100, "atm_strike": 100, "net_gex": -40})
check("T4 template: distinct headline", "TIER 4 ALERT" in msg4 and "🔷" in msg4)
check("T4 template: no doubled prefix", msg4.count("TIER 4") == 1, msg4.splitlines()[0])
check("T4 template: source attribution", "Angel One Greeks feed" in msg4)
check("Normal template unchanged", "🚨 <b>NIFTY ALERT</b>" in msgn and "TIER 4" not in msgn)

# ── 10. Tier-4 cooldown overrides shared rule cooldown ────────
st = json.loads(json.dumps(BASE_SETTINGS)); st["tier4"]["cooldown_seconds"] = 0
TIER_STATE["TCOOL"] = 4
eng = fresh_engine(st)
eng.evaluate_rules(make_snapshot("TCOOL"), "TCOOL")  # fire #1 (disarms)
from datetime import datetime
alert_db.set_rule_state(AlertRuleType.RULE_1.value, "TCOOL", "armed",
                        last_fired_at=datetime.now().isoformat(), cooldown_seconds=300)
fired = eng.evaluate_rules(make_snapshot("TCOOL"), "TCOOL")
check("T4 cooldown=0 refires immediately", len(fired) == 1)
st["tier4"]["cooldown_seconds"] = 300
eng = fresh_engine(st)
alert_db.reset_all_rule_states("TCOL2"); TIER_STATE["TCOL2"] = 4
eng.evaluate_rules(make_snapshot("TCOL2"), "TCOL2")  # fire #1
alert_db.set_rule_state(AlertRuleType.RULE_1.value, "TCOL2", "armed",
                        last_fired_at=datetime.now().isoformat(), cooldown_seconds=300)
fired = eng.evaluate_rules(make_snapshot("TCOL2"), "TCOL2")
check("T4 cooldown=300 suppresses immediate refire", len(fired) == 0)

# ── 10b. Sound-gate authority cases ───────────────────────────
# Case 2: T4 profile includes sound, shared RULE sound_enabled OFF → sound fires
st = json.loads(json.dumps(BASE_SETTINGS))
st["rules"][0]["sound_enabled"] = False          # shared rule sound OFF
st["tier4"]["channels"] = ["sound", "telegram"]  # Tier-4 profile selects sound
TIER_STATE["TSND"] = 4
eng = fresh_engine(st)
fired = eng.evaluate_rules(make_snapshot("TSND"), "TSND")
check("CASE 2: T4 profile sound + rule sound OFF → sound in channels",
      "sound" in channels_of(fired), str(channels_of(fired)))
# Case 1: T4 telegram-only → no sound
st1 = json.loads(json.dumps(BASE_SETTINGS)); st1["tier4"]["channels"] = ["telegram"]
eng = fresh_engine(st1)
alert_db.reset_all_rule_states("TSND")
fired = eng.evaluate_rules(make_snapshot("TSND"), "TSND")
check("CASE 1: T4 telegram-only → no sound", "sound" not in channels_of(fired), str(channels_of(fired)))
# Case 3: T4 profile sound + global master OFF → no sound
st3 = json.loads(json.dumps(st)); st3["sound"]["master_enabled"] = False
eng = fresh_engine(st3)
alert_db.reset_all_rule_states("TSND")
fired = eng.evaluate_rules(make_snapshot("TSND"), "TSND")
check("CASE 3: T4 profile sound + master OFF → no sound", "sound" not in channels_of(fired), str(channels_of(fired)))
# Case 4/5: T3 rule sound ON → sound; OFF → none (existing behavior preserved)
st4 = json.loads(json.dumps(BASE_SETTINGS)); TIER_STATE["TS3"] = 3
eng = fresh_engine(st4)
fired = eng.evaluate_rules(make_snapshot("TS3"), "TS3")
check("CASE 4: T3 rule sound ON → sound", "sound" in channels_of(fired), str(channels_of(fired)))
st5 = json.loads(json.dumps(BASE_SETTINGS)); st5["rules"][0]["sound_enabled"] = False
eng = fresh_engine(st5)
alert_db.reset_all_rule_states("TS3")
fired = eng.evaluate_rules(make_snapshot("TS3"), "TS3")
check("CASE 5: T3 rule sound OFF → no sound", "sound" not in channels_of(fired), str(channels_of(fired)))

# ── 11. History records instrument_tier ───────────────────────
TIER_STATE["THIST"] = 4
eng = fresh_engine()
eng.evaluate_rules(make_snapshot("THIST"), "THIST")
row = alert_db.get_alert_history("THIST")["entries"][0]
check("history row stamped instrument_tier=4", row.get("instrument_tier") == 4, str(row.get("instrument_tier")))
TIER_STATE["THIST3"] = 3
eng.evaluate_rules(make_snapshot("THIST3"), "THIST3")
row3 = alert_db.get_alert_history("THIST3")["entries"][0]
check("history row stamped instrument_tier=3", row3.get("instrument_tier") == 3, str(row3.get("instrument_tier")))

# ── 12. Legacy tier4_channels migration ───────────────────────
# Simulate production: DB holds a FULL old-shape settings blob (tier4_channels, no tier4)
eng0 = AlertEngine(); eng0._initialized = True
old_shape = {k: v for k, v in json.loads(json.dumps(BASE_SETTINGS)).items() if k != "tier4"}
eng0.update_settings(old_shape)
eng = AlertEngine()  # fresh engine, uninitialized → _ensure_default_settings migrates on read
migrated = eng.get_settings()
t4 = migrated.get("tier4") or {}
check("legacy tier4_channels migrates into tier4 profile",
      t4.get("channels") == ["telegram"] and t4.get("enabled") is True
      and t4.get("cooldown_seconds") == 300 and "bot_token" in t4.get("telegram", {}),
      json.dumps(t4))
# mirror check: new client saves profile → legacy key stays in sync
st2 = json.loads(json.dumps(migrated)); st2["tier4"]["channels"] = ["toast", "telegram"]
eng.update_settings(st2)
check("legacy key mirrored on save",
      eng.get_settings().get("tier4_channels") == ["toast", "telegram"])

print()
failed = [r for r in RESULTS if not r[1]]
print(f"TOTAL: {len(RESULTS)} checks, {len(RESULTS)-len(failed)} passed, {len(failed)} failed")
if failed:
    for n, _, d in failed: print("FAILED:", n, d)
