"""One-time performance-index builder — run BEFORE MARKET HOURS.

Creates idx_option_snapshots_strike_snap (strike, snapshot_id) on
option_snapshots. This index backs the two-step /api/history/{strike} query.
It is deliberately NOT built inside init_db()/FastAPI startup: on a large
production DB the build takes minutes and would recreate the market-open
startup blocking problem.

SELF-CONTAINED: does not import database.py — safe to run before or after
deploying the patched files, from the backend/ directory (the DB lives here).

Usage (backend/ directory):
    python build_perf_index.py

Idempotent: exits immediately if the index already exists. On failure the
database is left untouched (single-statement CREATE INDEX; nothing else is
written). Safe to re-run.
"""
import os
import sqlite3
import sys
import time

# Same resolution as database.py: DB lives next to this script.
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nifty_snapshots.db")
PERF_INDEX_NAME = "idx_option_snapshots_strike_snap"
PERF_INDEX_SQL = ("CREATE INDEX IF NOT EXISTS idx_option_snapshots_strike_snap "
                  "ON option_snapshots(strike, snapshot_id)")


def perf_index_exists(conn) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?",
        (PERF_INDEX_NAME,)).fetchone() is not None


def main():
    if not os.path.exists(DB_PATH):
        sys.exit(f"database not found: {DB_PATH}")
    size_mb = os.path.getsize(DB_PATH) / 1e6
    conn = sqlite3.connect(DB_PATH)
    try:
        if perf_index_exists(conn):
            print(f"[{PERF_INDEX_NAME}] already exists - nothing to do.")
            return 0
        rows = conn.execute("SELECT COUNT(*) FROM option_snapshots").fetchone()[0]
        print(f"database: {DB_PATH}")
        print(f"size: {size_mb:.0f} MB | option_snapshots rows: {rows:,}")
        print(f"building {PERF_INDEX_NAME} ...")
        t0 = time.time()
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute(PERF_INDEX_SQL)   # single statement; its own transaction
        conn.commit()
        dt = time.time() - t0
        print(f"DONE in {dt:.1f}s ({rows / max(dt, 1e-9) / 1e6:.2f} M rows/s)")
        print("next: python verify_history_patch.py")
        return 0
    except sqlite3.Error as e:
        print(f"FAILED: {e}")
        print("database left unchanged (index not created). Retry before market hours.")
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
