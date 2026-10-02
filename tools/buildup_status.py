#!/usr/bin/env python3
"""Index buildup status for NIFTY / SENSEX — the four-quadrant F&O screener
(Long Buildup / Short Covering / Short Buildup / Long Unwinding).

Classification (standard futures/OI logic):
    price up + OI up   -> Long Buildup
    price up + OI down -> Short Covering
    price down + OI up -> Short Buildup
    price down + OI down -> Long Unwinding

Price: snapshot spot (use --futures for the futures price instead).
OI:    futures OI (true buildup OI, v3.15+) — falls back to SUM of option OI
       for dates recorded before futures OI was stored
       options dominate, which is what your streamers capture).

Baseline = FIRST snapshot of the day; reading = LAST snapshot of the day
(intraday: the latest one). Run it any time — reads only.

Usage:
  python buildup_status.py                  # today, NIFTY + SENSEX
  python buildup_status.py --date 2026-10-01
  python buildup_status.py --index NIFTY --futures
  python buildup_status.py --db C:/path/nifty_snapshots.db
"""
import argparse
import os
import sqlite3
import sys
from datetime import datetime

INDICES = ["NIFTY", "SENSEX"]


def find_db(explicit):
    if explicit:
        if not os.path.exists(explicit):
            sys.exit(f"[buildup] DB not found: {explicit}")
        return explicit
    for c in ("nifty_snapshots.db", os.path.join("backend", "nifty_snapshots.db")):
        if os.path.exists(c):
            return c
    sys.exit("[buildup] nifty_snapshots.db not found here — pass --db")


def _col_exists(conn, table, column):
    return any(r[1] == column for r in conn.execute(f"PRAGMA table_info({table})"))


def day_snapshots(conn, index, day):
    # v3.15: futures_oi (TRUE buildup OI). Column missing -> old-schema DB:
    # fall back to NULL so the report uses option-OI summation.
    oi_col = "futures_oi" if _col_exists(conn, "snapshots", "futures_oi") else "NULL"
    return conn.execute(
        f"SELECT id, timestamp, spot, futures, {oi_col} AS futures_oi FROM snapshots "
        "WHERE index_name = ? AND date(timestamp) = ? ORDER BY timestamp",
        (index, day)).fetchall()


def total_oi(conn, snapshot_id):
    r = conn.execute(
        "SELECT COALESCE(SUM(oi),0), COALESCE(SUM(oi_change),0) "
        "FROM option_snapshots WHERE snapshot_id = ?", (snapshot_id,)).fetchone()
    return r[0], r[1]


def classify(px_chg, oi_chg):
    if px_chg >= 0 and oi_chg >= 0:
        return "LONG BUILDUP"
    if px_chg >= 0 and oi_chg < 0:
        return "SHORT COVERING"
    if px_chg < 0 and oi_chg >= 0:
        return "SHORT BUILDUP"
    return "LONG UNWINDING"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.now().strftime("%Y-%m-%d"))
    ap.add_argument("--index", default=None, help="one index only (default: all)")
    ap.add_argument("--futures", action="store_true", help="use futures price instead of spot")
    ap.add_argument("--db", default=None)
    args = ap.parse_args()

    db = find_db(args.db)
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    px_col = "futures" if args.futures else "spot"
    targets = [args.index.upper()] if args.index else INDICES

    print(f"[buildup] DB: {db}   date: {args.date}   price: {px_col}\n")
    for idx in targets:
        snaps = day_snapshots(conn, idx, args.date)
        if len(snaps) < 2:
            print(f"{idx:8s}  insufficient data ({len(snaps)} snapshot(s)) for {args.date}")
            continue
        first, last = snaps[0], snaps[-1]
        oi_src = "futures"
        if first["futures_oi"] is not None and last["futures_oi"] is not None:
            oi0, oi1 = first["futures_oi"], last["futures_oi"]
        else:
            # pre-v3.15 rows: futures OI not stored — option OI sum as proxy
            oi_src = "options(proxy)"
            oi0, _ = total_oi(conn, first["id"])
            oi1, _ = total_oi(conn, last["id"])
        px0, px1 = first[px_col], last[px_col]
        if not px0 or not oi0:
            print(f"{idx:8s}  zero baseline (px={px0}, oi={oi0}) — cannot classify")
            continue
        px_chg = (px1 - px0) / px0 * 100
        oi_chg = (oi1 - oi0) / oi0 * 100
        label = classify(px_chg, oi_chg)
        arrow_up = "\u25b2" if px_chg >= 0 else "\u25bc"
        oi_up = "\u25b2" if oi_chg >= 0 else "\u25bc"
        print(f"{idx:8s}  {label:16s}  {px1:>9.2f} ({px_chg:+.2f}%) {arrow_up}   "
              f"OI {oi_chg:+.2f}% {oi_up}  <{oi_src}>   [{first['timestamp'][11:]} -> {last['timestamp'][11:]}]")
    conn.close()


if __name__ == "__main__":
    main()
