"""Snapshot writer contract tests for expiry-aware chart history."""
import sqlite3

import database
from snapshot_engine import SnapshotEngine


def test_snapshot_writer_persists_resolved_expiry(tmp_path, monkeypatch):
    db_path = tmp_path / "snapshots.sqlite3"
    monkeypatch.setattr(database, "DB_PATH", str(db_path))
    database.init_db()

    snapshot = {
        "timestamp": "2026-11-26 10:00:00",
        "index_name": "NIFTY",
        "expiry": "26NOV2026",
        "spot": 26250.0,
        "futures": 26260.0,
        "futures_oi": 100000,
        "futures_spread": 10.0,
        "net_gex": 120000.0,
        "max_gex_strike": 26200,
        "max_pain": 26200,
        "gamma_flip": 26150,
        "options": [],
    }

    # The writer method does not access instance state. Avoid constructing
    # SnapshotEngine here because its initializer starts the background writer.
    writer = SnapshotEngine.__new__(SnapshotEngine)
    with database.get_db() as conn:
        writer._write_snapshot_to_db(conn, snapshot)
        row = conn.execute(
            "SELECT expiry FROM snapshots WHERE timestamp = ? AND index_name = ?",
            (snapshot["timestamp"], snapshot["index_name"]),
        ).fetchone()

    assert row["expiry"] == "26NOV2026"


def test_snapshot_writer_keeps_missing_expiry_null(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "snapshots.sqlite3"))
    database.init_db()

    snapshot = {
        "timestamp": "2026-11-26 10:00:30",
        "index_name": "SENSEX",
        "expiry": None,
        "spot": 84000.0,
        "futures": 84020.0,
        "futures_oi": None,
        "futures_spread": 20.0,
        "net_gex": None,
        "max_gex_strike": None,
        "max_pain": None,
        "gamma_flip": None,
        "options": [],
    }

    writer = SnapshotEngine.__new__(SnapshotEngine)
    with database.get_db() as conn:
        writer._write_snapshot_to_db(conn, snapshot)
        row = conn.execute(
            "SELECT expiry FROM snapshots WHERE timestamp = ? AND index_name = ?",
            (snapshot["timestamp"], snapshot["index_name"]),
        ).fetchone()

    assert row["expiry"] is None
