"""Regression coverage for the chart's whole-chain analytics endpoint."""
import asyncio

import database
import main


def _snapshot(conn, timestamp, expiry, *, spot=26000, max_pain=None, gamma_flip=None):
    cur = conn.execute(
        "INSERT INTO snapshots (timestamp, index_name, expiry, spot, max_pain, gamma_flip, "
        "max_gex_strike, net_gex) VALUES (?, 'NIFTY', ?, ?, ?, ?, 26000, 1250)",
        (timestamp, expiry, spot, max_pain, gamma_flip),
    )
    return cur.lastrowid


def _option(conn, snapshot_id, strike, side, oi, gex=0):
    conn.execute(
        "INSERT INTO option_snapshots "
        "(snapshot_id, index_name, strike, option_type, oi, oi_change, oi_change_pct, "
        "volume, volume_valid, source_age_sec, ltp, iv, delta, gamma, theta, vega, gex) "
        "VALUES (?, 'NIFTY', ?, ?, ?, 0, 0, 50, 1, 1.0, 100, 15, 0.5, 0.01, -1, 2, ?)",
        (snapshot_id, strike, side, oi, gex),
    )


def test_chart_chain_returns_expiry_scoped_walls_and_saved_levels(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "chain.sqlite3"))
    database.init_db()
    with database.get_db() as conn:
        chosen = _snapshot(
            conn, "2026-11-26 15:25:00", "26NOV2026",
            spot=26010, max_pain=26000, gamma_flip=25950,
        )
        _option(conn, chosen, 25900, "CE", 100)
        _option(conn, chosen, 25900, "PE", 700, -80)
        _option(conn, chosen, 26000, "CE", 900, 120)
        _option(conn, chosen, 26000, "PE", 200, -15)
        _option(conn, chosen, 26100, "CE", 250)
        _option(conn, chosen, 26100, "PE", 1000)
        # Same date but different expiry must not affect walls or max pain.
        other = _snapshot(conn, "2026-11-26 15:26:00", "03DEC2026")
        _option(conn, other, 26200, "CE", 99999)
        # Same expiry but different date must not leak.
        next_day = _snapshot(conn, "2026-11-27 09:15:00", "26NOV2026")
        _option(conn, next_day, 25800, "PE", 99999)
        conn.commit()

    result = asyncio.run(main.get_chart_option_chain(
        index="NIFTY", expiry="26NOV2026", date_str="2026-11-26"
    ))

    assert result["asof"] == "2026-11-26 15:25:00"
    assert result["spot"] == 26010
    assert [row["strike"] for row in result["strikes"]] == [25900, 26000, 26100]
    assert result["analytics"]["call_wall"] == 26000
    assert result["analytics"]["put_wall"] == 26100
    assert result["analytics"]["max_pain"] == 26000
    assert result["analytics"]["gamma_flip"] == 25950
    assert result["analytics"]["max_pain_source"] == "snapshot"


def test_chart_chain_is_empty_for_missing_expiry_without_cross_expiry_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "chain-empty.sqlite3"))
    database.init_db()
    with database.get_db() as conn:
        row = _snapshot(conn, "2026-11-26 15:25:00", "03DEC2026")
        _option(conn, row, 26000, "CE", 1000)
        conn.commit()

    result = asyncio.run(main.get_chart_option_chain(
        index="NIFTY", expiry="26NOV2026", date_str="2026-11-26"
    ))
    assert result["strikes"] == []
    assert result["analytics"] == {}
    assert result["quality"]["empty"] is True
