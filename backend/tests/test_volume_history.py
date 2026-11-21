import sqlite3

from volume_history import build_volume_history, load_volume_leader_rows


def _snapshot(conn, snapshot_id, timestamp, spot, options):
    conn.execute(
        "INSERT INTO snapshots (id, timestamp, index_name, spot) VALUES (?, ?, 'NIFTY', ?)",
        (snapshot_id, timestamp, spot),
    )
    conn.executemany(
        """INSERT INTO option_snapshots
           (snapshot_id, index_name, strike, option_type, volume)
           VALUES (?, 'NIFTY', ?, ?, ?)""",
        [(snapshot_id, strike, side, volume) for strike, side, volume in options],
    )


def test_volume_history_tracks_leader_changes_with_live_spot_window_and_fallback():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(
            """
            CREATE TABLE snapshots (
                id INTEGER PRIMARY KEY,
                timestamp TEXT NOT NULL,
                index_name TEXT NOT NULL,
                spot REAL
            );
            CREATE TABLE option_snapshots (
                snapshot_id INTEGER NOT NULL,
                index_name TEXT NOT NULL,
                strike REAL NOT NULL,
                option_type TEXT NOT NULL,
                volume INTEGER DEFAULT 0
            );
            """
        )

        _snapshot(conn, 1, "2026-11-22T09:15:00", 25000, [
            (24900, "CE", 1300),
            (25100, "CE", 1300),  # Equal volume: lower strike wins.
            (23000, "CE", 9900),  # Outside ±5%: must not win.
            (25100, "PE", 950),
            (24900, "PE", 900),
        ])
        _snapshot(conn, 2, "2026-11-22T09:30:00", 25000, [
            (25200, "CE", 1700),
            (25000, "CE", 1650),
            (23000, "CE", 12000),  # Still outside the spot window.
            (24900, "PE", 1000),
            (25100, "PE", 999),
        ])
        _snapshot(conn, 3, "2026-11-22T09:45:00", 80000, [
            (25000, "CE", 15000),
            (23000, "CE", 12000),
            (24900, "PE", 3000),
            (25100, "PE", 3000),
        ])
        conn.commit()

        rows = load_volume_leader_rows(conn, "NIFTY", "2026-11-22")
        history = build_volume_history(rows)

        assert history["volume_points"] == [
            {
                "timestamp": "2026-11-22T09:15:00",
                "ce_volume_strike": 24900,
                "ce_volume": 1300,
                "pe_volume_strike": 25100,
                "pe_volume": 950,
            },
            {
                "timestamp": "2026-11-22T09:30:00",
                "ce_volume_strike": 25200,
                "ce_volume": 1700,
                "pe_volume_strike": 24900,
                "pe_volume": 1000,
            },
            {
                "timestamp": "2026-11-22T09:45:00",
                "ce_volume_strike": 25000,
                "ce_volume": 15000,
                "pe_volume_strike": 24900,
                "pe_volume": 3000,
            },
        ]
        assert history["volume_events"] == [
            {
                "side": "CE",
                "timestamp": "2026-11-22T09:30:00",
                "from_strike": 24900,
                "to_strike": 25200,
                "from_volume": 1300,
                "to_volume": 1700,
            },
            {
                "side": "PE",
                "timestamp": "2026-11-22T09:30:00",
                "from_strike": 25100,
                "to_strike": 24900,
                "from_volume": 950,
                "to_volume": 1000,
            },
            {
                "side": "CE",
                "timestamp": "2026-11-22T09:45:00",
                "from_strike": 25200,
                "to_strike": 25000,
                "from_volume": 1700,
                "to_volume": 15000,
            },
        ]
    finally:
        conn.close()
