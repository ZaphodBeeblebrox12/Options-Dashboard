"""SQLite schema and OI-baseline regression tests using an isolated temp DB."""
import sqlite3

import database


def test_init_db_creates_expected_tables_and_columns(tmp_path, monkeypatch):
    db_path = tmp_path / "snapshots.sqlite3"
    monkeypatch.setattr(database, "DB_PATH", str(db_path))

    database.init_db()

    conn = sqlite3.connect(db_path)
    try:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {"snapshots", "option_snapshots", "daily_oi_baseline", "candles_1m"} <= tables

        snapshot_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(snapshots)")
        }
        option_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(option_snapshots)")
        }
        assert "futures_oi" in snapshot_columns
        assert "index_name" in snapshot_columns
        assert "oi_change_pct" in option_columns
    finally:
        conn.close()


def test_daily_oi_baseline_can_be_saved_replaced_and_loaded(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "snapshots.sqlite3"))
    database.init_db()

    with database.get_db() as conn:
        database.set_daily_baseline(
            conn, "2026-10-26", "NIFTY", 25000, "CE", 100000
        )
        assert database.get_daily_baseline(
            conn, "2026-10-26", "NIFTY", 25000, "CE"
        ) == 100000

        database.set_daily_baseline(
            conn, "2026-10-26", "NIFTY", 25000, "CE", 105000, source="test"
        )
        assert database.get_daily_baseline(
            conn, "2026-10-26", "NIFTY", 25000, "CE"
        ) == 105000
        assert database.load_all_baselines_for_date(
            conn, "2026-10-26", "NIFTY"
        ) == {(25000, "CE"): 105000}
