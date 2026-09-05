"""SQLite database for Alert System v2.2."""
import sqlite3
import json
import os
from datetime import datetime
from typing import List, Optional, Dict, Any
from contextlib import contextmanager

ALERT_DB_PATH = os.path.join(os.path.dirname(__file__), "alert_system.db")


def _get_conn():
    conn = sqlite3.connect(ALERT_DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_alert_db():
    """Initialize alert database schema."""
    conn = _get_conn()

    # Alert history
    conn.execute("""
        CREATE TABLE IF NOT EXISTS alert_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            index_name TEXT NOT NULL DEFAULT 'NIFTY',
            rule_type TEXT NOT NULL,
            rule_name TEXT NOT NULL,
            spot REAL,
            atm_strike INTEGER,
            max_ce_oi_strike INTEGER,
            max_pe_oi_strike INTEGER,
            max_negative_gex_strike INTEGER,
            net_gex REAL,
            futures_spread REAL,
            channels_fired TEXT NOT NULL DEFAULT '[]',
            market_state TEXT NOT NULL DEFAULT '{}',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Rule state tracking (ARMED/DISARMED + last fired + cooldown + rearm debounce)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS alert_rule_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_type TEXT NOT NULL,
            index_name TEXT NOT NULL DEFAULT 'NIFTY',
            state TEXT NOT NULL DEFAULT 'armed',
            last_fired_at TEXT,
            cooldown_seconds INTEGER DEFAULT 300,
            condition_cleared_at TEXT,
            UNIQUE(rule_type, index_name)
        )
    """)

    # v3.4 migration: add rearm-debounce column to existing databases
    try:
        conn.execute("ALTER TABLE alert_rule_state ADD COLUMN condition_cleared_at TEXT")
    except sqlite3.OperationalError:
        pass  # column already exists

    # Settings storage (JSON blob)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS alert_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            settings_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Custom sounds metadata
    conn.execute("""
        CREATE TABLE IF NOT EXISTS custom_sounds (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            filename TEXT NOT NULL,
            content_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Indexes
    conn.execute("CREATE INDEX IF NOT EXISTS idx_history_time ON alert_history(timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_history_date ON alert_history(date(timestamp))")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_history_rule ON alert_history(rule_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_history_index ON alert_history(index_name)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_state_lookup ON alert_rule_state(rule_type, index_name)")

    # Insert default settings row if missing
    conn.execute("""
        INSERT OR IGNORE INTO alert_settings (id, settings_json) VALUES (1, '{}')
    """)

    conn.commit()
    conn.close()
    print(f"[AlertDB] Initialized at {ALERT_DB_PATH}")


@contextmanager
def get_alert_db():
    conn = _get_conn()
    try:
        yield conn
    finally:
        conn.close()


# ── History ────────────────────────────────────────────────────

def save_alert_history(
    timestamp: str,
    index_name: str,
    rule_type: str,
    rule_name: str,
    spot: Optional[float],
    atm_strike: Optional[int],
    max_ce_oi_strike: Optional[int],
    max_pe_oi_strike: Optional[int],
    max_negative_gex_strike: Optional[int],
    net_gex: Optional[float],
    futures_spread: Optional[float],
    channels_fired: List[str],
    market_state: Dict,
) -> int:
    with get_alert_db() as conn:
        cursor = conn.execute("""
            INSERT INTO alert_history
            (timestamp, index_name, rule_type, rule_name, spot, atm_strike,
             max_ce_oi_strike, max_pe_oi_strike, max_negative_gex_strike,
             net_gex, futures_spread, channels_fired, market_state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            timestamp, index_name, rule_type, rule_name, spot, atm_strike,
            max_ce_oi_strike, max_pe_oi_strike, max_negative_gex_strike,
            net_gex, futures_spread,
            json.dumps(channels_fired),
            json.dumps(market_state),
        ))
        conn.commit()
        return cursor.lastrowid


def get_alert_date_counts(index_name: Optional[str] = None) -> List[Dict[str, Any]]:
    """Per-day alert counts for the calendar picker.

    Returns [{"date": "2026-09-04", "count": 7}, ...] newest first.
    `timestamp` is stored as ISO text, so SQLite's date() normalizes both
    'YYYY-MM-DD HH:MM:SS' snapshot stamps and full ISO-8601 stamps.
    """
    with get_alert_db() as conn:
        if index_name:
            rows = conn.execute(
                """SELECT date(timestamp) AS d, COUNT(*) AS c
                   FROM alert_history WHERE index_name = ?
                   GROUP BY d ORDER BY d DESC""",
                (index_name,),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT date(timestamp) AS d, COUNT(*) AS c
                   FROM alert_history GROUP BY d ORDER BY d DESC"""
            ).fetchall()
        return [{"date": r["d"], "count": r["c"]} for r in rows]


def get_alert_history(
    index_name: Optional[str] = None,
    date_str: Optional[str] = None,
    rule_type: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
) -> Dict[str, Any]:
    with get_alert_db() as conn:
        conditions = ["1=1"]
        params = []

        if index_name:
            conditions.append("index_name = ?")
            params.append(index_name)
        if date_str:
            conditions.append("date(timestamp) = ?")
            params.append(date_str)
        if rule_type:
            conditions.append("rule_type = ?")
            params.append(rule_type)

        where_clause = " AND ".join(conditions)

        # Total count
        total_row = conn.execute(
            f"SELECT COUNT(*) as cnt FROM alert_history WHERE {where_clause}",
            params
        ).fetchone()
        total = total_row["cnt"]

        # Paginated results
        offset = (page - 1) * page_size
        rows = conn.execute(
            f"""SELECT * FROM alert_history WHERE {where_clause}
               ORDER BY timestamp DESC LIMIT ? OFFSET ?""",
            params + [page_size, offset]
        ).fetchall()

        return {
            "entries": [dict(r) for r in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
        }


def get_today_firing_count(index_name: Optional[str] = None) -> int:
    today = datetime.now().strftime("%Y-%m-%d")
    with get_alert_db() as conn:
        if index_name:
            row = conn.execute(
                "SELECT COUNT(*) as cnt FROM alert_history WHERE date(timestamp) = ? AND index_name = ?",
                (today, index_name)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT COUNT(*) as cnt FROM alert_history WHERE date(timestamp) = ?",
                (today,)
            ).fetchone()
        return row["cnt"]


# ── Rule State ─────────────────────────────────────────────────

def get_rule_state(rule_type: str, index_name: str = "NIFTY") -> Dict[str, Any]:
    with get_alert_db() as conn:
        row = conn.execute(
            "SELECT * FROM alert_rule_state WHERE rule_type = ? AND index_name = ?",
            (rule_type, index_name)
        ).fetchone()
        if row:
            return dict(row)
        # Default: armed, never fired
        return {"state": "armed", "last_fired_at": None, "cooldown_seconds": 300,
                "condition_cleared_at": None}


def set_rule_state(
    rule_type: str,
    index_name: str,
    state: str,
    last_fired_at: Optional[str] = None,
    cooldown_seconds: int = 300,
    condition_cleared_at: Optional[str] = None,
):
    with get_alert_db() as conn:
        conn.execute("""
            INSERT INTO alert_rule_state
                (rule_type, index_name, state, last_fired_at, cooldown_seconds, condition_cleared_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(rule_type, index_name) DO UPDATE SET
                state = excluded.state,
                last_fired_at = excluded.last_fired_at,
                cooldown_seconds = excluded.cooldown_seconds,
                condition_cleared_at = excluded.condition_cleared_at
        """, (rule_type, index_name, state, last_fired_at, cooldown_seconds, condition_cleared_at))
        conn.commit()


def reset_all_rule_states(index_name: Optional[str] = None):
    with get_alert_db() as conn:
        if index_name:
            conn.execute(
                "UPDATE alert_rule_state SET state = 'armed', last_fired_at = NULL, condition_cleared_at = NULL WHERE index_name = ?",
                (index_name,)
            )
        else:
            conn.execute("UPDATE alert_rule_state SET state = 'armed', last_fired_at = NULL, condition_cleared_at = NULL")
        conn.commit()


# ── Settings ───────────────────────────────────────────────────

def load_settings() -> Dict[str, Any]:
    with get_alert_db() as conn:
        row = conn.execute("SELECT settings_json FROM alert_settings WHERE id = 1").fetchone()
        if row and row["settings_json"]:
            return json.loads(row["settings_json"])
        return {}


def save_settings(settings: Dict[str, Any]):
    with get_alert_db() as conn:
        conn.execute(
            "UPDATE alert_settings SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
            (json.dumps(settings),)
        )
        conn.commit()


# ── Custom Sounds ──────────────────────────────────────────────

def save_custom_sound(sound_id: str, name: str, filename: str, content_type: str, size_bytes: int):
    with get_alert_db() as conn:
        conn.execute("""
            INSERT INTO custom_sounds (id, name, filename, content_type, size_bytes)
            VALUES (?, ?, ?, ?, ?)
        """, (sound_id, name, filename, content_type, size_bytes))
        conn.commit()


def get_custom_sounds() -> List[Dict[str, Any]]:
    with get_alert_db() as conn:
        rows = conn.execute("SELECT * FROM custom_sounds ORDER BY uploaded_at DESC").fetchall()
        return [dict(r) for r in rows]


def delete_custom_sound(sound_id: str):
    with get_alert_db() as conn:
        conn.execute("DELETE FROM custom_sounds WHERE id = ?", (sound_id,))
        conn.commit()


def get_all_index_names() -> List[str]:
    """Return all distinct index names that have rule state entries."""
    with get_alert_db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT index_name FROM alert_rule_state ORDER BY index_name"
        ).fetchall()
        return [r["index_name"] for r in rows]


def get_custom_sound(sound_id: str) -> Optional[Dict[str, Any]]:
    with get_alert_db() as conn:
        row = conn.execute("SELECT * FROM custom_sounds WHERE id = ?", (sound_id,)).fetchone()
        return dict(row) if row else None
