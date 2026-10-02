"""Trimmed Database Backup — copy last N days of data into a new DB file.

Creates a NEW SQLite database in the SAME directory as the original,
containing ONLY the last N days of data across ALL tables.
The ORIGINAL database is NEVER modified.

Usage:
  python backup_last_n_days.py                      # last 7 days
  python backup_last_n_days.py --days 3
  python backup_last_n_days.py --days 14 --suffix _weekly
  python backup_last_n_days.py --source nifty_snapshots.db --days 5

Output:
  nifty_snapshots_backup_20260903_20260909.db   (in same directory)
"""
import os
import sys
import sqlite3
import argparse
from datetime import datetime, timedelta

DB_DIR = os.path.dirname(os.path.abspath(__file__))

# ── table configs: (table, date_column, has_index_name) ──
# date_column: the TEXT column holding a timestamp/date
# has_index_name: whether the table has an index_name/symbol column to preserve
TABLES = [
    ("snapshots",            "timestamp",    True),
    ("option_snapshots",     "snapshot_id",  True),   # filtered via JOIN
    ("daily_oi_baseline",    "date",         True),
    ("candles_1m",           "ts_minute",    False),
    ("alert_history",        "timestamp",    True),
    ("alert_rule_state",     None,           True),   # no date — keep all
    ("alert_settings",       None,           False),  # no date — keep all
    ("custom_sounds",        None,           False),  # no date — keep all
]


def get_tables(conn):
    """Return all user tables in the DB."""
    return [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()]


def get_schema(conn, table):
    """Return the CREATE statement for a table."""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row[0] if row else None


def get_indexes(conn, table):
    """Return CREATE statements for all indexes on a table."""
    return [r[0] for r in conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
        (table,)
    ).fetchall()]


def copy_last_n_days(source_path, days, suffix=None):
    """Create a trimmed copy of the source DB with only the last N days."""
    source_path = os.path.abspath(source_path)
    if not os.path.exists(source_path):
        print(f"ERROR: source DB not found: {source_path}")
        return None

    db_dir = os.path.dirname(source_path)
    base = os.path.splitext(os.path.basename(source_path))[0]

    # compute date range
    end_date = datetime.now().date()
    start_date = end_date - timedelta(days=days)
    start_str = start_date.isoformat()
    end_str = end_date.isoformat()

    # output filename
    tag = suffix or f"{start_str.replace('-','')}_{end_str.replace('-','')}"
    out_name = f"{base}_backup_{tag}.db"
    out_path = os.path.join(db_dir, out_name)

    if os.path.exists(out_path):
        os.remove(out_path)
        print(f"removed existing: {out_name}")

    print(f"Source: {source_path}")
    print(f"Output: {out_path}")
    print(f"Date range: {start_str} to {end_str} ({days} days)")

    src = sqlite3.connect(source_path)
    src.row_factory = sqlite3.Row

    # get all tables actually present
    all_tables = get_tables(src)
    print(f"\nTables in source: {all_tables}")

    # create output DB
    out = sqlite3.connect(out_path)

    # ── 1) copy schema for ALL tables ──
    # CRITICAL: use PRAGMA table_info (CURRENT schema) not sqlite_master sql,
    # because ALTER TABLE adds columns that sqlite_master doesn't reflect.
    # Using sqlite_master would create an output DB missing ALTERed columns.
    for table in all_tables:
        cols_info = src.execute(f"PRAGMA table_info({table})").fetchall()
        if not cols_info:
            continue
        col_defs = []
        for cid, name, ctype, notnull, dflt, pk in cols_info:
            parts = [name, ctype or "TEXT"]
            if pk:
                parts.append("PRIMARY KEY")
            if notnull:
                parts.append("NOT NULL")
            if dflt is not None:
                parts.append(f"DEFAULT {dflt}")
            col_defs.append(" ".join(parts))
        schema_sql = f"CREATE TABLE IF NOT EXISTS {table} ({', '.join(col_defs)})"
        out.execute(schema_sql)
        # recreate indexes
        for idx_sql in get_indexes(src, table):
            try:
                out.execute(idx_sql)
            except sqlite3.OperationalError:
                pass  # index may reference columns not in simplified schema
    out.commit()
    print(f"\nSchema copied for {len(all_tables)} tables")

    # ── 2) copy data per table ──
    stats = {}
    for table, date_col, has_sym in TABLES:
        if table not in all_tables:
            continue
        # check table actually exists in source (paranoia)
        if table not in get_tables(src):
            continue
        # defensive: verify date column actually exists before querying
        if date_col and date_col != "snapshot_id":
            cols = [r[1] for r in src.execute(f"PRAGMA table_info({table})").fetchall()]
            if date_col not in cols:
                print(f"  WARNING: {table} has no column '{date_col}' — copying all rows")
                date_col = None

        if date_col is None:
            # no date filter — copy everything
            rows = src.execute(f"SELECT * FROM {table}").fetchall()
            if rows:
                cols = rows[0].keys()
                placeholders = ",".join(["?"] * len(cols))
                col_names = ",".join(cols)
                out.executemany(
                    f"INSERT INTO {table} ({col_names}) VALUES ({placeholders})",
                    [tuple(r) for r in rows]
                )
            stats[table] = len(rows)

        elif table == "option_snapshots":
            # filtered via JOIN on snapshots (date lives in parent)
            try:
                rows = src.execute(f"""
                    SELECT o.* FROM option_snapshots o
                    JOIN snapshots s ON o.snapshot_id = s.id
                    WHERE date(s.timestamp) >= ? AND date(s.timestamp) <= ?
                """, (start_str, end_str)).fetchall()
            except sqlite3.OperationalError as e:
                print(f"  ERROR on option_snapshots JOIN: {e} — copying all")
                rows = src.execute("SELECT * FROM option_snapshots").fetchall()
            if rows:
                cols = rows[0].keys()
                placeholders = ",".join(["?"] * len(cols))
                col_names = ",".join(cols)
                out.executemany(
                    f"INSERT INTO {table} ({col_names}) VALUES ({placeholders})",
                    [tuple(r) for r in rows]
                )
            stats[table] = len(rows)

        elif table == "alert_history":
            try:
                rows = src.execute(f"""
                    SELECT * FROM {table}
                    WHERE date(timestamp) >= ? AND date(timestamp) <= ?
                """, (start_str, end_str)).fetchall()
            except sqlite3.OperationalError as e:
                print(f"  ERROR on {table}: {e} — copying all rows")
                rows = src.execute(f"SELECT * FROM {table}").fetchall()
            if rows:
                cols = rows[0].keys()
                placeholders = ",".join(["?"] * len(cols))
                col_names = ",".join(cols)
                out.executemany(
                    f"INSERT INTO {table} ({col_names}) VALUES ({placeholders})",
                    [tuple(r) for r in rows]
                )
            stats[table] = len(rows)

        else:
            # direct date filter
            try:
                rows = src.execute(f"""
                    SELECT * FROM {table}
                    WHERE date({date_col}) >= ? AND date({date_col}) <= ?
                """, (start_str, end_str)).fetchall()
            except sqlite3.OperationalError as e:
                print(f"  ERROR on {table}: {e} — copying all rows instead")
                rows = src.execute(f"SELECT * FROM {table}").fetchall()
            if rows:
                cols = rows[0].keys()
                placeholders = ",".join(["?"] * len(cols))
                col_names = ",".join(cols)
                out.executemany(
                    f"INSERT INTO {table} ({col_names}) VALUES ({placeholders})",
                    [tuple(r) for r in rows]
                )
            stats[table] = len(rows)

    out.commit()

    # ── 3) copy any tables NOT in TABLES config (full copy, e.g. meta) ──
    known = {t[0] for t in TABLES}
    for table in all_tables:
        if table in known:
            continue
        rows = src.execute(f"SELECT * FROM {table}").fetchall()
        if rows:
            cols = rows[0].keys()
            placeholders = ",".join(["?"] * len(cols))
            col_names = ",".join(cols)
            out.executemany(
                f"INSERT INTO {table} ({col_names}) VALUES ({placeholders})",
                [tuple(r) for r in rows]
            )
            stats[table] = len(rows)
    out.commit()

    # ── 4) vacuum + integrity check ──
    out.execute("VACUUM")
    integrity = out.execute("PRAGMA integrity_check").fetchone()[0]

    out.close()
    src.close()

    # ── summary ──
    src_size = os.path.getsize(source_path) / (1024*1024)
    out_size = os.path.getsize(out_path) / (1024*1024)
    print(f"\n{'='*50}")
    print(f"BACKUP COMPLETE")
    print(f"{'='*50}")
    print(f"  Integrity: {integrity}")
    print(f"  Source size: {src_size:.1f} MB")
    print(f"  Output size: {out_size:.1f} MB  ({out_size/src_size*100:.1f}% of original)")
    print(f"\n  Rows copied per table:")
    for table, count in sorted(stats.items()):
        print(f"    {table}: {count:,}")
    print(f"\n  Output file: {out_path}")
    print(f"  Original DB: UNCHANGED")
    return out_path


def main():
    ap = argparse.ArgumentParser(description="Copy last N days of DB into a new file")
    ap.add_argument("--source", default=os.path.join(DB_DIR, "nifty_snapshots.db"),
                    help="source database path (default: nifty_snapshots.db in script dir)")
    ap.add_argument("--days", type=int, default=7,
                    help="number of days to include (default: 7)")
    ap.add_argument("--suffix", default=None,
                    help="custom suffix for output filename (default: auto date range)")
    args = ap.parse_args()
    copy_last_n_days(args.source, args.days, args.suffix)


if __name__ == "__main__":
    main()
