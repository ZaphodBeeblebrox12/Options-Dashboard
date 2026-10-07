#!/usr/bin/env python3
"""PE-Wall Break Scanner — list every session where spot (ATM) traded BELOW
the PE wall at any point during the day. NIFTY/SENSEX, entire DB.

For each (index, trading day):
  1. PE wall per 30s snapshot = strike with MAX PE open interest
     (ties -> lower strike, same convention as the rest of the app).
  2. If ANY snapshot has spot < PE wall -> the day matches.
  3. Report: date, index, FIRST break time, number of snapshots below the
     wall, time below, lowest spot vs wall, wall at break, wall at close,
     and whether the wall ever shifted LOWER after the break (held/chased).

Usage:
  python pe_wall_break_scanner.py                 # full DB, NIFTY + SENSEX
  python pe_wall_break_scanner.py --index NIFTY
  python pe_wall_break_scanner.py --min-cross 0   # drop the 0.15% noise filter
  python pe_wall_break_scanner.py --csv out.csv   # also write a CSV
"""
import argparse
import csv
import os
import sqlite3
import sys

INDICES = ("NIFTY", "SENSEX")


def find_db(explicit):
    if explicit:
        if not os.path.exists(explicit):
            sys.exit(f"[scan] DB not found: {explicit}")
        return explicit
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "nifty_snapshots.db"),
        os.path.join(here, "options.db"),
        os.path.join(here, "backend", "nifty_snapshots.db"),
        os.path.join(os.getcwd(), "nifty_snapshots.db"),
        os.path.join(os.getcwd(), "backend", "nifty_snapshots.db"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    sys.exit("[scan] could not locate the DB. Pass it explicitly: --db /path/to/nifty_snapshots.db")


def load_day(conn, day, index):
    """PE wall + spot for every snapshot of one (date, index), chronological."""
    rows = conn.execute(
        """SELECT s.id, s.timestamp, s.spot, o.strike, o.oi
           FROM snapshots s
           JOIN option_snapshots o ON o.snapshot_id = s.id
           WHERE s.index_name = ? AND date(s.timestamp) = ? AND o.option_type = 'PE'
             AND s.spot IS NOT NULL AND s.spot > 0
           ORDER BY s.timestamp, o.strike""",
        (index, day)).fetchall()
    snaps = {}
    for sid, ts, spot, strike, oi in rows:
        e = snaps.setdefault(sid, [ts, spot, {}])
        e[2][strike] = oi
    timeline = []
    for sid in sorted(snaps, key=lambda k: snaps[k][0]):
        ts, spot, oimap = snaps[sid]
        if not oimap:
            continue
        wall = min(s for s, o in oimap.items() if o == max(oimap.values()))
        timeline.append((ts, spot, wall))
    return timeline


def scan_day(timeline, min_cross):
    """Return a match dict if spot ever went below the PE wall, else None."""
    if len(timeline) < 5:
        return None
    below = [(i, ts, spot, wall) for i, (ts, spot, wall) in enumerate(timeline)
             if spot < wall and (wall - spot) / wall >= min_cross]
    if not below:
        return None
    bi, b_ts, b_spot, b_wall = below[0]
    last_ts = timeline[-1][0]
    # time below wall (first break -> last snapshot that was still below)
    still = [x for x in below]
    last_below_ts = still[-1][1]
    min_spot = min(x[2] for x in below)
    max_gap = max((x[3] - x[2]) / x[3] for x in below)     # deepest % below wall
    # did the wall chase spot lower after the break?
    wall_chased_lower = any(timeline[i][2] < b_wall for i in range(bi + 1, len(timeline)))
    return {
        "break_ts": b_ts, "wall": b_wall, "spot_at_break": b_spot,
        "bars_below": len(below), "bars_total": len(timeline),
        "first_break": b_ts[11:19], "last_below": last_below_ts[11:19],
        "session_end": last_ts[11:19],
        "min_spot": min_spot,
        "deepest_pct_below": round(max_gap * 100, 2),
        "wall_at_close": timeline[-1][2],
        "wall_held": not wall_chased_lower,
    }


def main():
    ap = argparse.ArgumentParser(description="List every day spot traded below the PE wall.")
    ap.add_argument("--db", default=None)
    ap.add_argument("--index", default=None, choices=["NIFTY", "SENSEX"])
    ap.add_argument("--min-cross", type=float, default=0.0015,
                    help="min %% spot must be below wall to count (default 0.15%%)")
    ap.add_argument("--csv", default=None, help="optional CSV output path")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    db = find_db(args.db)
    indices = (args.index,) if args.index else INDICES
    conn = sqlite3.connect(db)
    conn.execute("PRAGMA busy_timeout=30000")

    matches = []
    for idx in indices:
        days = [r[0] for r in conn.execute(
            "SELECT DISTINCT date(timestamp) FROM snapshots WHERE index_name = ? ORDER BY 1",
            (idx,)).fetchall()]
        for n, day in enumerate(days, 1):
            if args.verbose:
                print(f"\r[scan] {idx} {day} ({n}/{len(days)})", end="", flush=True)
            m = scan_day(load_day(conn, day, idx), args.min_cross)
            if m:
                matches.append({"index": idx, "date": day, **m})
    conn.close()
    if args.verbose:
        print()

    print()
    print("=" * 100)
    print(f"  PE-WALL BREAK SCAN — spot below PE wall — {db}")
    print("=" * 100)
    if not matches:
        print("  No sessions matched.")
        return

    print(f"  {len(matches)} session(s) where spot traded below the PE wall:\n")
    print(f"  {'DATE':<12}{'INDEX':<8}{'BREAK':<10}{'WALL':>9}{'SPOT@BRK':>12}"
          f"{'MIN SPOT':>12}{'DEEP%%':>8}{'BELOW UNTIL':>14}{'HELD?':>7}")
    print("  " + "-" * 96)
    for m in matches:
        print(f"  {m['date']:<12}{m['index']:<8}{m['first_break']:<10}{m['wall']:>9,}"
              f"{m['spot_at_break']:>12,.2f}{m['min_spot']:>12,.2f}"
              f"{m['deepest_pct_below']:>7.2f}%{m['last_below']:>14}"
              f"{'HELD' if m['wall_held'] else 'chased':>7}")
    print()
    print("  HELD  = wall never shifted lower after the break")
    print("  chased = wall moved lower later (Wall followed spot down)")

    if args.csv:
        with open(args.csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(matches[0].keys()))
            w.writeheader()
            w.writerows(matches)
        print(f"\n  CSV written: {os.path.abspath(args.csv)}")


if __name__ == "__main__":
    main()
