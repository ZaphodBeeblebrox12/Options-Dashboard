"""Regression tests: T1/T2 snapshot → alert-engine integration (backend/).

Hermetic — no Angel One, no network, no real DBs:
  * database.DB_PATH is redirected to a temp file BEFORE main is imported
    (main instantiates SnapshotEngine at module level).
  * alert_engine's DB accessors and app_settings tier/rearm lookups are
    patched with in-memory implementations.
Runnable with either:
    cd backend && python -m unittest tests.test_snapshot_alerts -v
    cd backend && python -m pytest tests/test_snapshot_alerts.py -v
"""
import datetime as dt
import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest import mock

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)

import database
database.DB_PATH = os.path.join(tempfile.mkdtemp(prefix="t1t2test_"), "snap.db")

import app_settings
import calculations
import alert_engine as ae_mod
from alert_models import AlertRuleType
import main
import snapshot_engine as se_mod
from snapshot_engine import SnapshotEngine
from stock_streamer import InstrumentStreamer
from telegram_notifier import resolve_telegram_destination


# ── fixtures ────────────────────────────────────────────────────────────────

def firing_snapshot(index_name="NIFTY", tier=None):
    """spot 150, strikes 100/200. ATM=100; neg-GEX wall=100; CE wall=100;
    PE wall=200 → Rule 1 AND Rule 2 conditions both satisfied."""
    options = [
        {"strike": 100, "option_type": "CE", "oi": 1000, "oi_change": 0, "volume": 0, "ltp": 1.0, "gex": 5.0},
        {"strike": 100, "option_type": "PE", "oi": 100,   "oi_change": 0, "volume": 0, "ltp": 1.0, "gex": -50.0},
        {"strike": 200, "option_type": "CE", "oi": 200,   "oi_change": 0, "volume": 0, "ltp": 1.0, "gex": 20.0},
        {"strike": 200, "option_type": "PE", "oi": 900,   "oi_change": 0, "volume": 0, "ltp": 1.0, "gex": -5.0},
    ]
    snap = {"timestamp": "2026-09-06 10:00:00", "index_name": index_name,
            "spot": 150.0, "futures": None, "futures_spread": None,
            "net_gex": -30.0, "options": options}
    if tier is not None:
        snap["tier"] = tier
    return snap


def base_settings():
    rule = lambda rt: {   # noqa: E731
        "rule_type": rt, "enabled": True, "cooldown_seconds": 300,
        "channels": ["toast"], "sound_enabled": False, "sound_choice": "alert",
        "custom_sound_id": None, "telegram_enabled": False,
    }
    return {
        "rules": [rule("atm_negative_gex_oi_wall"), rule("atm_max_ce_pe_wall")],
        "telegram": {"enabled": False, "bot_token": "", "chat_id": ""},
        "sound": {"master_enabled": True, "volume_percent": 80},
        "custom_sounds": [],
        "tier4_channels": ["telegram"],
        "tier4": {"enabled": True, "channels": ["telegram"], "cooldown_seconds": 300,
                  "telegram": {"enabled": False, "bot_token": "", "chat_id": ""}},
    }


class AlertEnv:
    """In-memory replacements for the alert engine's DB-facing functions."""

    def __init__(self, tier=1, settings=None, armed=True):
        self.tier = tier
        self.armed = armed
        self.settings = settings or base_settings()
        self.dispatched = []     # lists passed to _dispatch_fired_alerts
        self.history = []        # save_alert_history kwargs
        self.state_writes = []

    def patches(self):
        eng = ae_mod.alert_engine
        return [
            mock.patch.object(ae_mod, "load_settings", lambda: self.settings),
            mock.patch.object(ae_mod, "save_settings", lambda s: None),
            mock.patch.object(ae_mod, "get_rule_state",
                              lambda rt, idx="NIFTY": {"state": "armed", "last_fired_at": None,
                                                       "cooldown_seconds": 300,
                                                       "condition_cleared_at": None}),
            mock.patch.object(ae_mod, "set_rule_state",
                              lambda rt, idx, state, **kw: self.state_writes.append((rt, idx, state))),
            mock.patch.object(ae_mod, "save_alert_history", lambda **kw: self.history.append(kw)),
            mock.patch.object(app_settings, "get_instrument_tier", lambda sym: self.tier),
            mock.patch.object(app_settings, "get_alert_rearm_seconds", lambda: 60),
            mock.patch.object(app_settings, "get_alerts_armed", lambda: self.armed),
            mock.patch.object(main, "_dispatch_fired_alerts", lambda fired: self.dispatched.append(list(fired))),
            mock.patch.object(eng, "_initialized", True),
        ]

    def __enter__(self):
        self._stack = ExitStack()
        for p in self.patches():
            self._stack.enter_context(p)
        return self

    def __exit__(self, *args):
        self._stack.close()


# ── T1 / T2 integration ─────────────────────────────────────────────────────

class TestT1T2SnapshotAlerts(unittest.TestCase):

    def test_t1_snapshot_evaluates_and_dispatches(self):
        with AlertEnv(tier=1) as env:
            main._evaluate_snapshot_alerts(firing_snapshot("NIFTY"), "NIFTY")
        self.assertEqual(len(env.dispatched), 1, "exactly one dispatch pass")
        fired = env.dispatched[0]
        rule_types = {p.rule_type for p in fired}
        self.assertIn(AlertRuleType.RULE_1, rule_types)
        self.assertIn(AlertRuleType.RULE_2, rule_types)
        self.assertTrue(all(p.instrument_tier == 1 for p in fired))
        self.assertTrue(all("TIER 4" not in p.rule_name for p in fired))
        self.assertEqual(len(env.history), 2, "both firings recorded in history")

    def test_t2_snapshot_evaluates_and_dispatches(self):
        with AlertEnv(tier=2) as env:
            main._evaluate_snapshot_alerts(firing_snapshot("RELIANCE"), "RELIANCE")
        self.assertEqual(len(env.dispatched), 1)
        fired = env.dispatched[0]
        self.assertIn(AlertRuleType.RULE_1, {p.rule_type for p in fired})
        self.assertTrue(all(p.instrument_tier == 2 for p in fired))
        self.assertEqual(len(env.history), 2)

    def test_no_duplicate_dispatch_for_one_snapshot(self):
        with AlertEnv(tier=1) as env:
            main._evaluate_snapshot_alerts(firing_snapshot("NIFTY"), "NIFTY")
        self.assertEqual(len(env.dispatched), 1, "one snapshot → one dispatch call")
        self.assertEqual(len(env.dispatched[0]), 2, "both alerts travel in the single pass")

    def test_nonfiring_snapshot_dispatches_nothing(self):
        quiet = firing_snapshot("NIFTY")   # spot 150 → ATM 100
        for o in quiet["options"]:
            o["oi"] = 100 if o["strike"] == 200 else 50   # both walls at 200
        quiet["options"][0]["gex"], quiet["options"][1]["gex"] = 20.0, 10.0   # strike100 net +30
        quiet["options"][2]["gex"], quiet["options"][3]["gex"] = 5.0, -10.0   # neg wall 200 ≠ ATM
        with AlertEnv(tier=1) as env:
            main._evaluate_snapshot_alerts(quiet, "NIFTY")
        self.assertEqual(env.dispatched, [])
        self.assertEqual(env.history, [])


# ── capture_snapshot → hook contract ────────────────────────────────────────

class FakeStore:
    def __init__(self, data):
        self._data = data
        self.msg_count = 10
        self.iv_cache = None
    def get_snapshot(self):
        return self._data, {}
    def get_data(self):
        return self._data
    def compute_oi_change(self, strike, option_type, current_oi):
        return 0, 0.0


class FakePoller:
    def __init__(self, spot):
        self._spot = spot
    def get_spot(self):
        return self._spot
    def get_futures(self):
        return None


DATA = {100: {"CE": {"oi": 10, "ltp": 1.0, "volume": 0}, "PE": {"oi": 10, "ltp": 1.0, "volume": 0}}}


def ok_analytics(d, s, f):
    return {"futures_spread": None, "net_gex": 0.0, "max_gex_strike": None,
            "max_pain": 100, "gamma_flip": None}


def make_engine(tmp_db):
    database.DB_PATH = tmp_db
    database.init_db()
    return SnapshotEngine()


class TestCaptureSnapshotHook(unittest.TestCase):
    def setUp(self):
        self.patcher = mock.patch.object(se_mod, "market_open_for", lambda h: True)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_successful_capture_invokes_hook_exactly_once(self):
        eng = make_engine(os.path.join(tempfile.mkdtemp(), "s.db"))
        calls = []
        eng.capture_snapshot(FakeStore(DATA), FakePoller(100.0), index_name="TESTIDX",
                             analytics_fn=ok_analytics, on_snapshot=calls.append)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["index_name"], "TESTIDX")
        self.assertEqual(len(calls[0]["options"]), 2)

    def test_no_data_never_invokes_hook(self):
        eng = make_engine(os.path.join(tempfile.mkdtemp(), "s.db"))
        calls = []
        eng.capture_snapshot(FakeStore({}), FakePoller(100.0), index_name="TESTIDX",
                             analytics_fn=ok_analytics, on_snapshot=calls.append)
        self.assertEqual(calls, [])

    def test_missing_spot_never_invokes_hook(self):
        eng = make_engine(os.path.join(tempfile.mkdtemp(), "s.db"))
        calls = []
        eng.capture_snapshot(FakeStore(DATA), FakePoller(None), index_name="TESTIDX",
                             analytics_fn=ok_analytics, on_snapshot=calls.append)
        self.assertEqual(calls, [])

    def test_analytics_failure_never_invokes_hook(self):
        eng = make_engine(os.path.join(tempfile.mkdtemp(), "s.db"))
        calls = []
        def boom(d, s, f):
            raise RuntimeError("analytics timeout")
        eng.capture_snapshot(FakeStore(DATA), FakePoller(100.0), index_name="TESTIDX",
                             analytics_fn=boom, on_snapshot=calls.append)
        self.assertEqual(calls, [])

    def test_hook_error_does_not_fail_capture(self):
        eng = make_engine(os.path.join(tempfile.mkdtemp(), "s.db"))
        calls = []
        def bad_hook(snap):
            calls.append(snap)
            raise RuntimeError("dispatch exploded")
        eng.capture_snapshot(FakeStore(DATA), FakePoller(100.0), index_name="TESTIDX",
                             analytics_fn=ok_analytics, on_snapshot=bad_hook)
        self.assertEqual(len(calls), 1)
        self.assertIsNotNone(eng.get_latest_snapshot("TESTIDX"))


# ── T3 path untouched ───────────────────────────────────────────────────────

class TestT3PathIntact(unittest.TestCase):

    def test_scanner_evaluates_rule1_only(self):
        s = object.__new__(InstrumentStreamer)
        s.symbol = "TESTSTK"
        s.tier = 3
        s.expiry_datetime = dt.datetime.now() + dt.timedelta(days=7)
        s.expiry_str = "11SEP2026"
        s.contract_multiplier = 1
        s.data_store = FakeStore(DATA)
        s.spot_poller = FakePoller(100.0)
        s.on_alerts_fired = None

        seen = {}
        def fake_eval(snapshot, index_name, rule_types=None, state_map=None):
            seen["rule_types"] = rule_types
            seen["index_name"] = index_name
            return []
        def fake_analytics(*a, **kw):
            return {"strikes_data": {}, "futures_spread": None}

        eng = ae_mod.alert_engine
        with mock.patch.object(calculations, "calculate_analytics", fake_analytics), \
             mock.patch.object(eng, "evaluate_rules", fake_eval):
            s._run_triggered_analytics(100)

        self.assertEqual(seen.get("rule_types"), [AlertRuleType.RULE_1],
                         "T3 still evaluates Rule 1 only")
        self.assertEqual(seen.get("index_name"), "TESTSTK")


# ── Tier-4 gating / routing unchanged ───────────────────────────────────────

class TestTier4Unchanged(unittest.TestCase):

    def test_disabled_tier4_profile_suppresses_everything(self):
        st = base_settings()
        st["tier4"]["enabled"] = False
        with AlertEnv(tier=4, settings=st) as env:
            main._evaluate_snapshot_alerts(firing_snapshot("GOLD", tier=4), "GOLD")
        self.assertEqual(env.dispatched, [])
        self.assertEqual(env.history, [])
        self.assertEqual(env.state_writes, [], "no rule-state residue from a gated tier")

    def test_tier4_routing_uses_dedicated_destination(self):
        st = base_settings()
        st["tier4"]["telegram"] = {"enabled": True, "bot_token": "T4TOKEN", "chat_id": "T4CHAT"}
        with AlertEnv(tier=4, settings=st) as env:
            main._evaluate_snapshot_alerts(firing_snapshot("GOLD", tier=4), "GOLD")
        self.assertEqual(len(env.dispatched), 1)
        fired = env.dispatched[0]
        self.assertTrue(all(p.instrument_tier == 4 for p in fired))
        self.assertTrue(all("TIER 4" in p.rule_name for p in fired))
        # Destination resolution: dedicated Tier-4 bot wins; shared for others.
        dest4 = resolve_telegram_destination(st, 4)
        self.assertEqual(dest4.get("bot_token"), "T4TOKEN")
        dest_shared = resolve_telegram_destination(st, 1)
        self.assertNotEqual(dest_shared.get("bot_token"), "T4TOKEN")


# ── A1: alerts_armed master switch ──────────────────────────────────────────

class TestAlertsArmedGate(unittest.TestCase):

    def test_disarmed_suppresses_all_firing_and_dispatch(self):
        with AlertEnv(tier=1, armed=False) as env:
            main._evaluate_snapshot_alerts(firing_snapshot("NIFTY"), "NIFTY")
        self.assertEqual(env.dispatched, [], "no dispatch while disarmed")
        self.assertEqual(env.history, [], "no history while disarmed")
        self.assertEqual(env.state_writes, [], "no rule-state transitions while disarmed")

    def test_disarmed_then_rearmed_resumes_normal_firing(self):
        with AlertEnv(tier=1, armed=False) as env:
            main._evaluate_snapshot_alerts(firing_snapshot("NIFTY"), "NIFTY")
        self.assertEqual(env.dispatched, [])
        with AlertEnv(tier=1, armed=True) as env:
            main._evaluate_snapshot_alerts(firing_snapshot("NIFTY"), "NIFTY")
        self.assertEqual(len(env.dispatched), 1, "re-armed evaluation fires normally")
        self.assertEqual(len(env.history), 2)

    def test_backtests_are_not_gated_by_master_switch(self):
        """Backtests pass state_map and must keep working while disarmed —
        disarming live alerts must never block historical analysis."""
        import alert_engine as _ae
        with AlertEnv(tier=1, armed=False) as env:
            bt_state: dict = {}
            eng = _ae.alert_engine
            orig = eng.evaluate_rules.__wrapped__ if hasattr(eng.evaluate_rules, "__wrapped__") else None
            fired = eng.evaluate_rules(firing_snapshot("NIFTY"), "NIFTY", state_map=bt_state)
        self.assertTrue(fired, "backtest evaluation ignores the master switch")
        self.assertEqual(env.dispatched, [], "backtest results are never dispatched")


# ── A2: snapshot replacement leaves no orphan option rows ───────────────────

class TestSnapshotReplacementNoOrphans(unittest.TestCase):

    def _snap(self, index_name="NIFTY", timestamp="2026-09-06 10:00:00"):
        return {
            "timestamp": timestamp, "index_name": index_name,
            "spot": 100.0, "futures": None, "futures_spread": None,
            "net_gex": 1.0, "max_gex_strike": 100, "max_pain": 100, "gamma_flip": None,
            "options": [
                {"index_name": index_name, "strike": 100, "option_type": "CE",
                 "oi": 10, "oi_change": 0, "oi_change_pct": 0.0, "volume": 0,
                 "ltp": 1.0, "iv": None, "delta": None, "gamma": None,
                 "theta": None, "vega": None, "gex": None},
                {"index_name": index_name, "strike": 100, "option_type": "PE",
                 "oi": 20, "oi_change": 0, "oi_change_pct": 0.0, "volume": 0,
                 "ltp": 1.0, "iv": None, "delta": None, "gamma": None,
                 "theta": None, "vega": None, "gex": None},
            ],
        }

    def test_replace_does_not_orphan_option_rows(self):
        tmp_db = os.path.join(tempfile.mkdtemp(prefix="a2test_"), "snap.db")
        database.DB_PATH = tmp_db
        database.init_db()
        eng = object.__new__(SnapshotEngine)   # method only — no writer thread
        conn = database.get_db_connection()
        try:
            eng._write_snapshot_to_db(conn, self._snap())
            eng._write_snapshot_to_db(conn, self._snap())      # same (timestamp, index_name)
            eng._write_snapshot_to_db(conn, self._snap(index_name="SENSEX"))  # other index untouched

            snap_rows = conn.execute("SELECT COUNT(*) c FROM snapshots WHERE index_name='NIFTY'").fetchone()["c"]
            opt_rows = conn.execute("""SELECT COUNT(*) c FROM option_snapshots o
                JOIN snapshots s ON o.snapshot_id = s.id
                WHERE s.index_name='NIFTY'""").fetchone()["c"]
            self.assertEqual(snap_rows, 1, "exactly one NIFTY snapshot row after replace")
            self.assertEqual(opt_rows, 2, "exactly the fresh 2 option rows — zero orphans")
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
