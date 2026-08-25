"""SQLite database setup with WAL mode for concurrent reads/writes."""
import sqlite3
import os
from contextlib import contextmanager
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "nifty_snapshots.db")


def _column_exists(conn, table, column):
    """Check if a column exists in a table."""
    cursor = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def _migrate_db(conn):
    """Migrate existing database to latest schema."""
    # Add index_name to snapshots if missing
    if not _column_exists(conn, "snapshots", "index_name"):
        print("[DB] Migrating: adding index_name to snapshots...")
        conn.execute("ALTER TABLE snapshots ADD COLUMN index_name TEXT NOT NULL DEFAULT 'NIFTY'")
        conn.commit()

    # Add index_name to option_snapshots if missing
    if not _column_exists(conn, "option_snapshots", "index_name"):
        print("[DB] Migrating: adding index_name to option_snapshots...")
        conn.execute("ALTER TABLE option_snapshots ADD COLUMN index_name TEXT NOT NULL DEFAULT 'NIFTY'")
        conn.commit()

    # Check if old unique index exists (without index_name) and drop it
    cursor = conn.execute("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_snapshots_timestamp'")
    row = cursor.fetchone()
    if row:
        sql = row[1] or ""
        if "UNIQUE" in sql.upper() and "index_name" not in sql:
            print("[DB] Migrating: dropping old unique index, recreating with index_name...")
            conn.execute("DROP INDEX IF EXISTS idx_snapshots_timestamp")
            conn.commit()


def init_db():
    """Initialize database with WAL mode and schema."""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA mmap_size=30000000000")

    # Check if tables already exist (migration path)
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'")
    tables_exist = cursor.fetchone() is not None

    if tables_exist:
        _migrate_db(conn)

    # Snapshots table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            index_name TEXT NOT NULL DEFAULT 'NIFTY',
            spot REAL,
            futures REAL,
            futures_spread REAL,
            net_gex REAL,
            max_gex_strike INTEGER,
            max_pain INTEGER,
            gamma_flip INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(timestamp, index_name)
        )
    """)

    # Option snapshots table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS option_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id INTEGER NOT NULL,
            index_name TEXT NOT NULL DEFAULT 'NIFTY',
            strike INTEGER NOT NULL,
            option_type TEXT NOT NULL,
            oi INTEGER DEFAULT 0,
            oi_change INTEGER DEFAULT 0,
            volume INTEGER DEFAULT 0,
            ltp REAL DEFAULT 0,
            iv REAL,
            delta REAL,
            gamma REAL,
            theta REAL,
            vega REAL,
            gex REAL,
            FOREIGN KEY (snapshot_id) REFERENCES snapshots(id),
            UNIQUE(snapshot_id, strike, option_type)
        )
    """)

    # Indexes
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots(date(timestamp))")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_index ON snapshots(index_name)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_date_index ON snapshots(date(timestamp), index_name)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_option_snapshots_snapshot ON option_snapshots(snapshot_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_option_snapshots_strike ON option_snapshots(strike)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_option_snapshots_combo ON option_snapshots(snapshot_id, option_type, strike)")

    conn.commit()
    conn.close()
    print(f"[DB] Initialized at {DB_PATH} with WAL mode (multi-index support)")


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
    finally:
        conn.close()


def get_db_connection():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn
