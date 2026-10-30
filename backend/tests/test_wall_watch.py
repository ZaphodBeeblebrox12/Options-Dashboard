from wall_watch import calculate_wall_strikes, normalize_wall_options


def test_walls_use_highest_oi_per_side_across_loaded_expiry_chain():
    options = [
        {"strike": 24500, "option_type": "CE", "oi": 1200},
        {"strike": 24900, "option_type": "CE", "oi": 900},
        {"strike": 25000, "option_type": "CE", "oi": 400},
        {"strike": 25100, "option_type": "CE", "oi": 700},
        {"strike": 25200, "option_type": "CE", "oi": 600},
        {"strike": 24800, "option_type": "PE", "oi": 500},
        {"strike": 25000, "option_type": "PE", "oi": 800},
        {"strike": 25050, "option_type": "PE", "oi": 900},
        {"strike": 25500, "option_type": "PE", "oi": 1100},
    ]
    walls = calculate_wall_strikes(options, 25000)
    assert walls["CE"] == (24500, True)
    assert walls["PE"] == (25500, True)


def test_crossing_call_wall_does_not_move_it_when_oi_is_unchanged():
    options = [
        {"strike": 24900, "option_type": "CE", "oi": 900},
        {"strike": 25000, "option_type": "CE", "oi": 400},
        {"strike": 25100, "option_type": "CE", "oi": 700},
    ]

    # Spot starts below the wall, moves above it, then returns below it.
    # Even a larger move cannot change the wall without a change in OI.
    assert calculate_wall_strikes(options, 24800)["CE"] == (24900, True)
    assert calculate_wall_strikes(options, 25050)["CE"] == (24900, True)
    assert calculate_wall_strikes(options, 27000)["CE"] == (24900, True)
    assert calculate_wall_strikes(options, 24850)["CE"] == (24900, True)


def test_crossing_put_wall_does_not_move_it_when_oi_is_unchanged():
    options = [
        {"strike": 24900, "option_type": "PE", "oi": 500},
        {"strike": 25000, "option_type": "PE", "oi": 800},
        {"strike": 25100, "option_type": "PE", "oi": 700},
    ]

    # Spot moves from above the Put Wall to below it and then back.
    assert calculate_wall_strikes(options, 25200)["PE"] == (25000, True)
    assert calculate_wall_strikes(options, 24950)["PE"] == (25000, True)
    assert calculate_wall_strikes(options, 22000)["PE"] == (25000, True)
    assert calculate_wall_strikes(options, 25250)["PE"] == (25000, True)


def test_changed_oi_can_move_a_wall():
    before = [
        {"strike": 24900, "option_type": "CE", "oi": 900},
        {"strike": 25000, "option_type": "CE", "oi": 400},
        {"strike": 25100, "option_type": "CE", "oi": 700},
    ]
    after = [
        {"strike": 24900, "option_type": "CE", "oi": 600},
        {"strike": 25000, "option_type": "CE", "oi": 400},
        {"strike": 25100, "option_type": "CE", "oi": 1000},
    ]
    assert calculate_wall_strikes(before, 25050)["CE"] == (24900, True)
    assert calculate_wall_strikes(after, 27000)["CE"] == (25100, True)


def test_missing_side_is_incomplete_data_and_does_not_create_a_wall():
    options = [{"strike": 25000, "option_type": "CE", "oi": 100}]
    walls = calculate_wall_strikes(options, 25050)
    assert walls["CE"] == (25000, True)
    assert walls["PE"] == (None, False)


def test_accepts_strike_keyed_live_chain_shape():
    options = {
        "25000": {"CE": {"oi": 100}, "PE": {"oi": 250}},
        "25100": {"CE": {"oi": 500}, "PE": {"oi": 50}},
    }
    rows = normalize_wall_options(options)
    assert len(rows) == 4
    walls = calculate_wall_strikes(options, 25000)
    assert walls["CE"] == (25100, True)
    assert walls["PE"] == (25000, True)


def test_equal_oi_ties_choose_lowest_strike_deterministically():
    options = [
        {"strike": 25100, "option_type": "CE", "oi": 500},
        {"strike": 25200, "option_type": "CE", "oi": 500},
    ]
    assert calculate_wall_strikes(options, 25000)["CE"] == (25100, True)



def _wall_watch_manager_with_test_db(monkeypatch):
    """Create an isolated manager whose state survives its DB context calls."""
    import sqlite3
    from contextlib import contextmanager

    import wall_watch

    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """CREATE TABLE wall_watch_state (
            symbol TEXT NOT NULL,
            side TEXT NOT NULL,
            armed INTEGER NOT NULL DEFAULT 0,
            watched_strike REAL,
            last_wall_strike REAL,
            new_wall_strike REAL,
            last_event TEXT,
            last_triggered_at TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(symbol, side)
        )"""
    )
    conn.commit()

    @contextmanager
    def fake_get_alert_db():
        yield conn

    monkeypatch.setattr(wall_watch, "get_alert_db", fake_get_alert_db)
    monkeypatch.setattr(wall_watch, "save_alert_history", lambda **kwargs: None)
    monkeypatch.setattr(
        wall_watch.alert_engine,
        "get_settings",
        lambda: {
            "rules": [{
                "rule_type": "wall_vacated",
                "enabled": False,
                "channels": ["toast"],
                "sound_enabled": False,
                "telegram_enabled": False,
            }],
            "sound": {"master_enabled": True},
            "telegram": {"enabled": False},
        },
    )
    monkeypatch.setattr(wall_watch.app_settings, "get_alerts_armed", lambda: False)
    monkeypatch.setattr(wall_watch.app_settings, "get_instrument_tier", lambda symbol: 1)
    monkeypatch.setattr(
        wall_watch,
        "resolve_telegram_destination",
        lambda settings, tier: {"enabled": False, "bot_token": "", "chat_id": ""},
    )
    return wall_watch.WallWatchManager(), conn


def test_manual_watch_fires_even_when_automatic_alert_switch_and_rule_are_off(monkeypatch):
    manager, conn = _wall_watch_manager_with_test_db(monkeypatch)
    try:
        manager.arm("NIFTY", "CE", 25000)

        # OI migrates the Call Wall from 25,000 to 25,100. The global automatic
        # alerts switch and WALL_VACATED rule are both deliberately disabled;
        # the explicit bell arm must still be honored.
        fired = manager.evaluate_snapshot(
            {
                "timestamp": "2026-10-30T10:00:00",
                "spot": 25050,
                "options": [
                    {"strike": 25000, "option_type": "CE", "oi": 900},
                    {"strike": 25100, "option_type": "CE", "oi": 1200},
                ],
            },
            "NIFTY",
        )

        assert len(fired) == 1
        assert fired[0].wall_side == "CE"
        assert fired[0].watched_strike == 25000
        assert fired[0].new_wall_strike == 25100
        assert fired[0].wall_event == "moved"
        assert fired[0].channels_fired
        assert manager.get_watches("NIFTY")["CE"]["armed"] is False
        assert manager.get_watches("NIFTY")["CE"]["last_event"] == "moved"
    finally:
        conn.close()


def test_armed_symbol_index_only_includes_active_manual_watches(monkeypatch):
    manager, conn = _wall_watch_manager_with_test_db(monkeypatch)
    try:
        manager.arm("NIFTY", "CE", 25000)
        manager.arm("SENSEX", "PE", 81000)
        assert manager.get_armed_symbols() == ["NIFTY", "SENSEX"]

        manager.disarm("NIFTY", "CE")
        assert manager.get_armed_symbols() == ["SENSEX"]
    finally:
        conn.close()



def _raw_option_store(now):
    stamp = now.isoformat()
    return {
        25000: {
            "CE": {"oi": 900, "ltp": 100, "last_update": stamp},
            "PE": {"oi": 500, "ltp": 100, "last_update": stamp},
        },
        25100: {
            "CE": {"oi": 1200, "ltp": 90, "last_update": stamp},
            "PE": {"oi": 700, "ltp": 110, "last_update": stamp},
        },
    }


def test_build_live_wall_watch_snapshot_uses_raw_oi_without_analytics():
    from datetime import datetime
    from wall_watch import build_live_wall_watch_snapshot

    now = datetime.now()

    class Store:
        def get_data(self):
            return _raw_option_store(now)

        def age_sec(self):
            return 2.0

    class Spot:
        def get_spot(self):
            return 25050.0

    class Streamer:
        tier = 1
        data_store = Store()
        spot_poller = Spot()

        def get_current_state(self):
            raise AssertionError("wall watch must not call the full analytics path")

    snapshot = build_live_wall_watch_snapshot(Streamer(), "NIFTY", lambda: True, now=now)

    assert snapshot is not None
    assert snapshot["option_age_sec"] == 2.0
    assert snapshot["_side_freshness"] == {"CE": True, "PE": True}
    assert snapshot["spot"] == 25050.0


def test_build_live_wall_watch_snapshot_rejects_stale_paused_and_inactive_windows():
    from datetime import datetime
    from wall_watch import build_live_wall_watch_snapshot

    now = datetime.now()
    raw = _raw_option_store(now)

    class Store:
        def __init__(self, age):
            self.age = age

        def get_data(self):
            return raw

        def age_sec(self):
            return self.age

    class Streamer:
        tier = 3
        spot_poller = None

        def __init__(self, age=2.0, paused=False, state="WINDOW_ACTIVE"):
            self.data_store = Store(age)
            self.paused = paused
            self.state = state

    assert build_live_wall_watch_snapshot(Streamer(age=91), "ABC", lambda: True, now) is None
    assert build_live_wall_watch_snapshot(Streamer(paused=True), "ABC", lambda: True, now) is None
    assert build_live_wall_watch_snapshot(Streamer(state="WINDOW_PENDING"), "ABC", lambda: True, now) is None
    assert build_live_wall_watch_snapshot(Streamer(), "ABC", lambda: False, now) is None


def test_build_live_wall_watch_snapshot_reports_side_freshness_independently():
    from datetime import datetime, timedelta
    from wall_watch import build_live_wall_watch_snapshot

    now = datetime.now()
    options = _raw_option_store(now)
    old = (now - timedelta(seconds=120)).isoformat()
    for contracts in options.values():
        contracts["PE"]["last_update"] = old

    class Store:
        def get_data(self):
            return options

        def age_sec(self):
            return 1.0

    class Streamer:
        data_store = Store()
        spot_poller = None
        tier = 1

    snapshot = build_live_wall_watch_snapshot(Streamer(), "NIFTY", lambda: True, now)
    assert snapshot is not None
    assert snapshot["_side_freshness"] == {"CE": True, "PE": False}


def test_wall_watch_waits_for_fresh_ticks_on_the_watched_side(monkeypatch):
    manager, conn = _wall_watch_manager_with_test_db(monkeypatch)
    try:
        manager.arm("NIFTY", "CE", 25000)
        snapshot = {
            "timestamp": "2026-10-30T10:00:00",
            "spot": 25050,
            "option_age_sec": 2,
            "_side_freshness": {"CE": False, "PE": True},
            "options": [
                {"strike": 25000, "option_type": "CE", "oi": 900},
                {"strike": 25100, "option_type": "CE", "oi": 1200},
            ],
        }
        assert manager.evaluate_snapshot(snapshot, "NIFTY") == []
        assert manager.get_watches("NIFTY")["CE"]["armed"] is True

        snapshot["_side_freshness"]["CE"] = True
        fired = manager.evaluate_snapshot(snapshot, "NIFTY")
        assert len(fired) == 1
        assert fired[0].new_wall_strike == 25100
        assert manager.get_watches("NIFTY")["CE"]["armed"] is False
    finally:
        conn.close()
