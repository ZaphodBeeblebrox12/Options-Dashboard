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
        assert {"volume_valid", "source_age_sec"} <= option_columns

        # New schema defaults legacy/unknown volume provenance to invalid.
        conn.execute(
            "INSERT INTO snapshots (timestamp, index_name) VALUES (?, ?)",
            ("2026-11-20 09:15:00", "SENSEX"),
        )
        snapshot_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute(
            "INSERT INTO option_snapshots (snapshot_id, index_name, strike, option_type) "
            "VALUES (?, ?, ?, ?)",
            (snapshot_id, "SENSEX", 88300, "PE"),
        )
        row = conn.execute(
            "SELECT volume_valid FROM option_snapshots WHERE snapshot_id = ?",
            (snapshot_id,),
        ).fetchone()
        assert row[0] == 0
    finally:
        conn.close()


def test_legacy_option_rows_migrate_as_unverified_volume(tmp_path, monkeypatch):
    db_path = tmp_path / "legacy.sqlite3"
    monkeypatch.setattr(database, "DB_PATH", str(db_path))

    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL)"
    )
    conn.execute(
        """CREATE TABLE option_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id INTEGER NOT NULL,
            strike INTEGER NOT NULL,
            option_type TEXT NOT NULL,
            oi INTEGER DEFAULT 0,
            oi_change INTEGER DEFAULT 0,
            volume INTEGER DEFAULT 0,
            ltp REAL DEFAULT 0,
            iv REAL, delta REAL, gamma REAL, theta REAL, vega REAL, gex REAL
        )"""
    )
    conn.execute(
        "INSERT INTO snapshots (timestamp) VALUES (?)",
        ("2026-11-20 09:15:00",),
    )
    snapshot_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO option_snapshots (snapshot_id, strike, option_type, volume) "
        "VALUES (?, ?, ?, ?)",
        (snapshot_id, 88300, "PE", 0),
    )
    conn.commit()
    conn.close()

    database.init_db()

    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT volume, volume_valid, source_age_sec "
            "FROM option_snapshots WHERE snapshot_id = ?",
            (snapshot_id,),
        ).fetchone()
        assert row == (0, 0, None)
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
