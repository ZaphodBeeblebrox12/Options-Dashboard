#!/usr/bin/env python3
"""Purge one day's data from the Options Dashboard SQLite DB.

Removes every row belonging to a given trading date from:
  snapshots, option_snapshots, daily_oi_baseline, candles_1m
and (optionally, --alerts) alert_history.

Defaults to TODAY, makes a backup copy of the DB first, supports --dry-run,
and auto-locates the DB (options.db next to this script / in ./backend /
cwd), or take an explicit path with --db.

Usage:
  python purge_today.py                    # purge today, after backup
  python purge_today.py --dry-run          # show counts only, change nothing
  python purge_today.py --date 2026-10-02  # purge a specific day
  python purge_today.py --alerts           # also purge alert_history rows
  python purge_today.py --db /path/to/options.db
"""
import argparse
import os
import shutil
import sqlite3
import sys
from datetime import datetime

TABLES = [
    # (table, date column expression, description)
    # option_snapshots first: it is the child of snapshots (snapshot_id FK).
    ("option_snapshots",
     "snapshot_id IN (SELECT id FROM snapshots WHERE date(timestamp)=?)",
     "option rows (via parent snapshot date)"),
    ("snapshots", "date(timestamp)=?", "snapshots"),
    ("daily_oi_baseline", "date=?", "OI baselines"),
    ("candles_1m", "date(ts_minute)=?", "1m candles"),
]
ALERT_TABLE = ("alert_history", "date(timestamp)=?", "alert history")


def find_db(explicit: str | None) -> str:
    if explicit:
        if not os.path.exists(explicit):
            sys.exit(f"[purge] DB not found: {explicit}")
        return explicit
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "options.db"),
        os.path.join(here, "backend", "options.db"),
        os.path.join(os.getcwd(), "options.db"),
        os.path.join(os.getcwd(), "backend", "options.db"),
    ]
    # Fall back to whatever DB_PATH database.py declares.
    db_py = None
    for c in candidates[:-2]:
        if os.path.exists(os.path.join(os.path.dirname(c), "database.py")):
            db_py = os.path.join(os.path.dirname(c), "database.py")
            break
    if db_py is None and os.path.exists("database.py"):
        db_py = os.path.abspath("database.py")
    if db_py:
        import re
        src = open(db_py, encoding="utf-8").read()
        m = re.search(r"DB_PATH\s*=\s*[^\n]*?['\"]([^'\"]+\.db)['\"]", src)
        if m:
            p = m.group(1)
            if not os.path.isabs(p):
                p = os.path.join(os.path.dirname(db_py), p)
            candidates.insert(0, p)
    for c in candidates:
        if os.path.exists(c):
            return c
    sys.exit("[purge] could not locate the DB. Pass it explicitly: --db /path/to/options.db")


def count(cur, table, where, day):
    return cur.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", (day,)).fetchone()[0]


def main():
    ap = argparse.ArgumentParser(description="Purge one day's data from the options DB.")
    ap.add_argument("--date", default=datetime.now().strftime("%Y-%m-%d"),
                    help="trading date to purge (default: today)")
    ap.add_argument("--db", default=None, help="explicit path to the SQLite DB")
    ap.add_argument("--alerts", action="store_true",
                    help="also purge alert_history rows for the date")
    ap.add_argument("--dry-run", action="store_true",
                    help="report row counts only; make no changes")
    ap.add_argument("--no-backup", action="store_true",
                    help="skip the pre-purge DB backup copy")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args()

    day = args.date
    db = find_db(args.db)
    print(f"[purge] DB: {db}")
    print(f"[purge] date: {day}")

    conn = sqlite3.connect(db)
    try:
        cur = conn.cursor()
        tables = TABLES + ([ALERT_TABLE] if args.alerts else [])
        plan = [(t, w, d, count(cur, t, w, day)) for t, w, d in tables]
        total = sum(n for _, _, _, n in plan)
        for t, _, d, n in plan:
            print(f"  {t:22s} {d:34s} {n:>8d} rows")
        if total == 0:
            print("[purge] nothing to delete.")
            return
        if args.dry_run:
            print(f"[purge] dry-run: would delete {total} rows. No changes made.")
            return

        if not args.yes:
            ans = input(f"Delete {total} rows for {day}? [y/N] ").strip().lower()
            if ans not in ("y", "yes"):
                print("[purge] aborted.")
                return

        if not args.no_backup:
            backup = f"{db}.bak-{datetime.now():%Y%m%d-%H%M%S}"
            conn.close()  # release any lock before copying the file
            shutil.copy2(db, backup)
            print(f"[purge] backup written: {backup}")
            conn = sqlite3.connect(db)
            cur = conn.cursor()

        with conn:
            for t, w, _, n in plan:
                if n:
                    cur.execute(f"DELETE FROM {t} WHERE {w}", (day,))
                    print(f"[purge] deleted {cur.rowcount} rows from {t}")
        print(f"[purge] done. VACUUM not run (optional: sqlite3 {db} 'VACUUM;' to reclaim space).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
