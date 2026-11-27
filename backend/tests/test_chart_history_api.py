"""Chart API regressions for date-scoped candles and expiry-scoped strikes."""
import asyncio
import sqlite3

import database
import main
from candle_builder import CandleBuilder


def _insert_candle(conn, symbol, ts_minute, price):
    conn.execute(
        "INSERT INTO candles_1m "
        "(symbol, ts_minute, open, high, low, close, volume, tick_count) "
        "VALUES (?, ?, ?, ?, ?, ?, NULL, 1)",
        (symbol, ts_minute, price, price, price, price),
    )


def test_load_1m_honours_exclusive_end_timestamp(tmp_path):
    db_path = tmp_path / "candles.sqlite3"
    builder = CandleBuilder(db_path=str(db_path))
    builder._init_db()

    conn = sqlite3.connect(db_path)
    try:
        _insert_candle(conn, "NIFTY", "2026-11-26 09:15:00", 25800)
        _insert_candle(conn, "NIFTY", "2026-11-26 15:29:00", 25850)
        _insert_candle(conn, "NIFTY", "2026-11-27 09:15:00", 25900)
        conn.commit()
    finally:
        conn.close()

    rows = builder.load_1m(
        "NIFTY",
        since_ts_minute="2026-11-26 00:00:00",
        until_ts_minute="2026-11-27 00:00:00",
    )

    assert [row["ts_minute"] for row in rows] == [
        "2026-11-26 09:15:00",
        "2026-11-26 15:29:00",
    ]


def test_scanner_candles_passes_selected_day_as_half_open_range(monkeypatch):
    captured = {}

    def fake_load_1m(symbol, **kwargs):
        captured["symbol"] = symbol
        captured.update(kwargs)
        return []

    monkeypatch.setattr(main.candle_builder, "load_1m", fake_load_1m)
    monkeypatch.setattr(main.app_settings, "get_instrument_kind", lambda symbol: "INDEX")

    response = asyncio.run(main.scanner_candles(
        symbol="NIFTY",
        tf="15m",
        date="2026-11-26",
    ))

    assert captured == {
        "symbol": "NIFTY",
        "since_ts_minute": "2026-11-26 00:00:00",
        "until_ts_minute": "2026-11-27 00:00:00",
    }
    assert response["candles"] == []


def _insert_snapshot(conn, timestamp, expiry, strike, index="NIFTY"):
    cursor = conn.execute(
        "INSERT INTO snapshots (timestamp, index_name, expiry) VALUES (?, ?, ?)",
        (timestamp, index, expiry),
    )
    snapshot_id = cursor.lastrowid
    conn.execute(
        "INSERT INTO option_snapshots (snapshot_id, index_name, strike, option_type) "
        "VALUES (?, ?, ?, 'CE')",
        (snapshot_id, index, strike),
    )


def test_chart_strikes_are_filtered_by_expiry_and_legacy_unknown(tmp_path, monkeypatch):
    db_path = tmp_path / "chart-api.sqlite3"
    monkeypatch.setattr(database, "DB_PATH", str(db_path))
    database.init_db()

    with database.get_db() as conn:
        _insert_snapshot(conn, "2026-11-26 09:15:00", "26NOV2026", 26000)
        _insert_snapshot(conn, "2026-11-26 09:15:30", "03DEC2026", 26100)
        _insert_snapshot(conn, "2026-11-26 09:16:00", None, 26200)
        _insert_snapshot(conn, "2026-11-26 09:16:30", "26NOV2026", 26050)
        # Same expiry and strike on another date must not leak into this day.
        _insert_snapshot(conn, "2026-11-27 09:15:00", "26NOV2026", 26300)
        conn.commit()

    selected = asyncio.run(main.get_chart_option_strikes(
        index="NIFTY", expiry="26NOV2026", date_str="2026-11-26"
    ))
    legacy = asyncio.run(main.get_chart_option_strikes(
        index="NIFTY", expiry="UNKNOWN", date_str="2026-11-26"
    ))

    assert selected["strikes"] == [26000, 26050]
    assert selected["expiry_known"] is True
    assert legacy["strikes"] == [26200]
    assert legacy["expiry_known"] is False
