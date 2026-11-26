"""Read-path regression tests for chart expiry and sampled option history APIs."""
import asyncio

import database
import main


def _insert_option_snapshot(
    conn,
    timestamp,
    expiry,
    strike,
    option_type,
    ltp,
    *,
    index="NIFTY",
    spot=26000.0,
    oi=1000,
    volume=500,
    volume_valid=1,
    source_age_sec=1.2,
):
    cursor = conn.execute(
        "INSERT INTO snapshots (timestamp, index_name, expiry, spot) VALUES (?, ?, ?, ?)",
        (timestamp, index, expiry, spot),
    )
    snapshot_id = cursor.lastrowid
    conn.execute(
        "INSERT INTO option_snapshots "
        "(snapshot_id, index_name, strike, option_type, ltp, oi, oi_change, "
        "oi_change_pct, volume, volume_valid, source_age_sec, iv, delta, gamma, theta, vega, gex) "
        "VALUES (?, ?, ?, ?, ?, ?, 25, 2.5, ?, ?, ?, 14.2, 0.51, 0.0004, -3.2, 5.1, 100)",
        (
            snapshot_id, index, strike, option_type, ltp, oi,
            volume, volume_valid, source_age_sec,
        ),
    )
    return snapshot_id


def test_chart_expiries_and_option_history_are_date_expiry_and_side_scoped(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "chart-history.sqlite3"))
    database.init_db()

    with database.get_db() as conn:
        _insert_option_snapshot(
            conn, "2026-11-26 09:15:00", "26NOV2026", 26000, "CE", 100,
            volume=500, source_age_sec=1.1,
        )
        _insert_option_snapshot(
            conn, "2026-11-26 09:15:00", "26NOV2026", 26000, "PE", 90,
        )
        _insert_option_snapshot(
            conn, "2026-11-26 09:17:00", "26NOV2026", 26000, "CE", 105,
            volume=600, source_age_sec=2.2,
        )
        # Same strike on a different expiry must not leak into the selected series.
        _insert_option_snapshot(
            conn, "2026-11-26 09:17:30", "03DEC2026", 26000, "CE", 777,
        )
        # Legacy snapshots remain explicitly unknown rather than backfilled.
        _insert_option_snapshot(
            conn, "2026-11-26 09:18:00", None, 26000, "CE", 888,
        )
        # The same expiry on the next date must not leak into 26 November.
        _insert_option_snapshot(
            conn, "2026-11-27 09:15:00", "26NOV2026", 26000, "CE", 999,
        )
        conn.commit()

    expiries = asyncio.run(main.get_chart_option_expiries(
        index="NIFTY", date_str="2026-11-26"
    ))
    selected_ce = asyncio.run(main.get_chart_option_history(
        index="NIFTY", expiry="26NOV2026", strike=26000,
        option_type="CE", date_str="2026-11-26",
    ))
    selected_pe = asyncio.run(main.get_chart_option_history(
        index="NIFTY", expiry="26NOV2026", strike=26000,
        option_type="PE", date_str="2026-11-26",
    ))
    legacy = asyncio.run(main.get_chart_option_history(
        index="NIFTY", expiry="UNKNOWN", strike=26000,
        option_type="CE", date_str="2026-11-26",
    ))

    assert expiries["expiries"] == ["03DEC2026", "26NOV2026"]
    assert expiries["unknown_snapshot_count"] == 1

    assert [point["ltp"] for point in selected_ce["points"]] == [100, 105]
    assert selected_ce["instrument"]["expiry"] == "26NOV2026"
    assert selected_ce["instrument"]["expiry_known"] is True
    assert selected_ce["sampling"]["expected_seconds"] == 30
    assert selected_ce["sampling"]["bar_semantics"] == "sampled_observations"
    assert selected_ce["quality"]["gaps_detected"] is True
    assert selected_ce["quality"]["last_timestamp"] == "2026-11-26 09:17:00"
    assert selected_ce["points"][0]["source_age_sec"] == 1.1
    assert len(selected_pe["points"]) == 1
    assert selected_pe["points"][0]["ltp"] == 90

    assert len(legacy["points"]) == 1
    assert legacy["points"][0]["ltp"] == 888
    assert legacy["instrument"]["expiry"] is None
    assert legacy["instrument"]["expiry_known"] is False
    assert legacy["quality"]["missing_expiry_rows"] == 1
