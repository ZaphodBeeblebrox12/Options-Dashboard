"""1-minute CASH candle builder (v1).

Consumes the CASH ticks that already flow through InstrumentStreamer.
_hook (STOCK kind only) and persists finalized 1-minute candles to the
existing SQLite store. Design constraints (approved):

- Tick path is O(1): parse tick -> update the ONE open candle per symbol ->
  return. NO raw tick history is ever retained.
- DB I/O is fully off the tick path: finalized candles go on a small queue
  drained by a single background writer thread (same queue+daemon pattern as
  SnapshotEngine._db_writer_loop, separate queue/lifecycle).
- Writes are idempotent: UNIQUE(symbol, ts_minute) + INSERT OR REPLACE.
- 1m candles are the single source of truth. 15m candles are DERIVED (never
  persisted): a live on_15m_close event fires when a 15m bucket completes.
- Sweeper finalizes open candles that see no rollover tick (illiquid minutes,
  WS stalls); pause()/stop()/shutdown flush the open candle.

Timestamp policy: the Angel tick's `exchange_timestamp` (epoch seconds) is
the candle clock; local time is the fallback when it is missing/invalid.
"""

import logging
import threading
import time
import sqlite3
from datetime import datetime
from queue import Queue, Empty, Full

from database import DB_PATH

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_SEC = float(__import__("os").environ.get("CANDLE_SWEEP_SEC", "10"))
# An open candle is sweep-finalized when its bucket ended this long ago and
# no rollover tick arrived to close it naturally.
STALE_AFTER_SEC = float(__import__("os").environ.get("CANDLE_STALE_SEC", "90"))
# Sane-window validation for exchange timestamps: reject if more than 5 min
# in the future or more than a day in the past, then fall back to local time.
_TS_FUTURE_SLACK = 300.0
_TS_PAST_SLACK = 86400.0

CREATE_CANDLES_SQL = """
    CREATE TABLE IF NOT EXISTS candles_1m (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        ts_minute TEXT NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume INTEGER,
        tick_count INTEGER DEFAULT 0,
        finalized_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, ts_minute)
    )
"""
CREATE_CANDLES_INDEXES_SQL = (
    "CREATE INDEX IF NOT EXISTS idx_c1m_symbol_ts ON candles_1m(symbol, ts_minute)",
    "CREATE INDEX IF NOT EXISTS idx_c1m_date ON candles_1m(date(ts_minute))",
)

UPSERT_CANDLE_SQL = """
    INSERT OR REPLACE INTO candles_1m
        (symbol, ts_minute, open, high, low, close, volume, tick_count, finalized_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def _minute_key(ts: float) -> str:
    """Epoch seconds -> 'YYYY-MM-DD HH:MM:00' bucket label (local/IST time,
    matching the format used by snapshot timestamps)."""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:00")


def _minute_epoch(ts: float) -> float:
    """Epoch seconds -> epoch of the containing minute bucket start."""
    return ts - (ts % 60.0)


def _parse_tick_ts(message: dict) -> float:
    """Extract the candle clock from a raw Angel tick.

    Prefers exchange_timestamp (epoch seconds; ms inputs > 1e12 are divided
    by 1000). Returns None when missing/out of sane window so the caller can
    fall back to local time."""
    raw = message.get("exchange_timestamp")
    if raw in (None, ""):
        return None
    try:
        ts = float(raw)
    except (TypeError, ValueError):
        return None
    if ts > 1e12:            # milliseconds, not seconds
        ts /= 1000.0
    now = time.time()
    if ts > now + _TS_FUTURE_SLACK or ts < now - _TS_PAST_SLACK:
        return None
    return ts


class CandleBuilder:
    """Build, finalize, persist, and publish 1m CASH candles.

    Threading model:
    - on_tick: called from the WS handler thread; only touches the in-memory
      state dict under a short lock and the (bounded) finalize queue.
    - _sweeper_loop / _writer_loop: daemon threads started by start().
    """

    def __init__(self, db_path: str = DB_PATH, queue_size: int = 5000):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._state = {}                 # symbol -> open candle dict
        self._sealed = {}                # symbol -> epoch of last FINALIZED minute
                                         # (late ticks for sealed minutes are dropped)
        self._queue = Queue(maxsize=queue_size)
        self._stop = threading.Event()
        self._sweeper: threading.Thread | None = None
        self._writer: threading.Thread | None = None
        self._started = False
        # event subscribers (called from the WRITER thread after DB write)
        self._subs_1m = []

    # ── lifecycle ────────────────────────────────────────────
    def start(self):
        if self._started:
            return
        self._init_db()
        self._stop.clear()
        self._sweeper = threading.Thread(target=self._sweeper_loop,
                                         daemon=True, name="candle-sweeper")
        self._writer = threading.Thread(target=self._writer_loop,
                                        daemon=True, name="candle-writer")
        self._sweeper.start()
        self._writer.start()
        self._started = True
        logger.info("[Candles] builder started (sweep %.0fs, stale %.0fs)",
                    SWEEP_INTERVAL_SEC, STALE_AFTER_SEC)

    def stop(self):
        """Flush everything and shut down. Drains the queue so no finalized
        candle is lost on normal shutdown."""
        if not self._started:
            return
        self._stop.set()
        self.flush_all()                 # finalize open candles -> queue
        if self._sweeper:
            self._sweeper.join(timeout=5)
        if self._writer:
            self._writer.join(timeout=10)
        self._started = False
        logger.info("[Candles] builder stopped")

    # ── tick path (must stay O(1) and never block) ───────────
    def _session_open(self) -> bool:
        """Equity/index session gate (09:15–15:30 IST, Mon–Fri). Pre-open ticks
        (09:00–09:08) must never form candles (Drop 1 §3); commodities are not
        hooked at all."""
        now = datetime.now()
        if now.weekday() > 4:
            return False
        from datetime import time as _dt_time
        return _dt_time(9, 15) <= now.time() <= _dt_time(15, 30)

    def on_tick(self, symbol: str, message: dict):
        try:
            if not self._session_open():
                return
            raw = message.get("last_traded_price", 0) or 0
            ltp = float(raw) / 100.0
        except (TypeError, ValueError):
            return                            # garbage price: skip quietly
        try:
            if ltp <= 0:
                return
            ts = _parse_tick_ts(message)
            if ts is None:
                ts = time.time()
            self._update(symbol.strip().upper(), ltp, ts)
        except Exception as e:
            logger.error("[Candles] tick error %s: %s", symbol, e)

    def _update(self, symbol: str, ltp: float, ts: float):
        minute_epoch = _minute_epoch(ts)
        with self._lock:
            cur = self._state.get(symbol)
            if cur is None:
                # Late tick for an already-FINALIZED minute must not reopen a
                # candle for that old bucket (its UPSERT would overwrite the
                # sealed row). Only open when the tick is newer than the
                # sealed watermark.
                if minute_epoch <= self._sealed.get(symbol, -1.0):
                    return
                self._open_candle(symbol, minute_epoch, ltp, ts)
                return
            if minute_epoch < cur["minute_epoch"]:
                return                       # late tick for a sealed minute -> drop
            if minute_epoch > cur["minute_epoch"]:
                self._finalize_locked(symbol)   # natural rollover
                self._open_candle(symbol, minute_epoch, ltp, ts)
                return
            # same minute: high/low always; open/close owned by extremes
            if ltp > cur["high"]:
                cur["high"] = ltp
            if ltp < cur["low"]:
                cur["low"] = ltp
            if ts < cur["first_ts"]:        # earlier tick owns the open
                cur["open"], cur["first_ts"] = ltp, ts
            if ts >= cur["last_ts"]:        # latest tick owns the close
                cur["close"], cur["last_ts"] = ltp, ts
            cur["ticks"] += 1

    def _open_candle(self, symbol: str, minute_epoch: float, ltp: float, ts: float):
        self._state[symbol] = {
            "symbol": symbol,
            "minute_epoch": minute_epoch,
            "ts_minute": _minute_key(minute_epoch),
            "open": ltp, "high": ltp, "low": ltp, "close": ltp,
            "first_ts": ts, "last_ts": ts, "ticks": 1,
        }

    def _finalize_locked(self, symbol: str):
        """Finalize the symbol's open candle, if any. Must hold self._lock.
        Idempotent: a symbol with no open candle is a no-op."""
        cur = self._state.pop(symbol, None)
        if cur is None:
            return
        self._sealed[symbol] = cur["minute_epoch"]
        candle = {
            "symbol": symbol,
            "ts_minute": cur["ts_minute"],
            "open": cur["open"], "high": cur["high"],
            "low": cur["low"], "close": cur["close"],
            "volume": None,              # mode-1 CASH ticks carry no LTQ
            "tick_count": cur["ticks"],
        }
        try:
            self._queue.put_nowait(candle)
        except Full:
            logger.error("[Candles] queue FULL — dropping finalized candle %s %s",
                         symbol, candle["ts_minute"])

    # ── flush entry points (pause / stop / shutdown) ─────────
    def flush_symbol(self, symbol: str):
        with self._lock:
            self._finalize_locked(symbol.strip().upper())

    def flush_all(self):
        with self._lock:
            for symbol in list(self._state.keys()):
                self._finalize_locked(symbol)

    # ── sweeper ──────────────────────────────────────────────
    def _sweeper_loop(self):
        while not self._stop.wait(SWEEP_INTERVAL_SEC):
            try:
                self._sweep_once()
            except Exception as e:
                logger.error("[Candles] sweeper error: %s", e)

    def _sweep_once(self):
        now = time.time()
        with self._lock:
            for symbol, cur in list(self._state.items()):
                if now - (cur["minute_epoch"] + 60.0) > STALE_AFTER_SEC:
                    logger.info("[Candles] sweeper finalizing stale candle %s %s",
                                symbol, cur["ts_minute"])
                    self._finalize_locked(symbol)

    # ── writer (DB + events) ─────────────────────────────────
    def _writer_loop(self):
        conn = self._connect()
        pending = []
        while True:
            try:
                candle = self._queue.get(timeout=1.0)
                pending.append(candle)
                # drain whatever else is immediately available (batch)
                while len(pending) < 200:
                    try:
                        pending.append(self._queue.get_nowait())
                    except Empty:
                        break
            except Empty:
                if self._stop.is_set():
                    break
                continue
            try:
                self._write_batch(conn, pending)
            except Exception as e:
                logger.error("[Candles] batch write failed (%s), retrying individually", e)
                conn = self._reconnect(conn)
                for c in pending:
                    try:
                        self._write_batch(conn, [c])
                    except Exception as e2:
                        logger.error("[Candles] dropping unwritable candle %s %s: %s",
                                     c["symbol"], c["ts_minute"], e2)
            for candle in pending:
                self._publish(candle)
            pending = []
        # drain-on-shutdown: anything still queued after the stop signal
        while True:
            try:
                pending.append(self._queue.get_nowait())
            except Empty:
                break
        if pending:
            try:
                self._write_batch(conn, pending)
                for candle in pending:
                    self._publish(candle)
            except Exception as e:
                logger.error("[Candles] shutdown drain lost %d candles: %s", len(pending), e)
        try:
            conn.close()
        except Exception:
            pass
        logger.info("[Candles] writer exited")

    def _publish(self, candle: dict):
        for fn in list(self._subs_1m):
            try:
                fn(candle)
            except Exception as e:
                logger.error("[Candles] 1m subscriber error: %s", e)

    # ── 15m derivation (live) ────────────────────────────────
    # ── DB ───────────────────────────────────────────────────
    def _init_db(self):
        conn = self._connect()
        try:
            conn.execute(CREATE_CANDLES_SQL)
            for sql in CREATE_CANDLES_INDEXES_SQL:
                conn.execute(sql)
            conn.commit()
        finally:
            conn.close()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def _reconnect(self, conn) -> sqlite3.Connection:
        try:
            conn.close()
        except Exception:
            pass
        return self._connect()

    def _write_batch(self, conn, candles: list):
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn.executemany(UPSERT_CANDLE_SQL,
                         [(c["symbol"], c["ts_minute"], c["open"], c["high"],
                           c["low"], c["close"], c["volume"], c["tick_count"], now)
                          for c in candles])
        conn.commit()

    # ── historical queries (future scanner bootstrap) ────────
    def load_1m(self, symbol: str, limit: int = 500,
                since_ts_minute: str | None = None) -> list:
        """Chronological 1m candles for a symbol (newest `limit` when since is
        None; forward from `since` otherwise). Read from the DB — the single
        source of truth — so live + restarted aggregations agree."""
        conn = self._connect()
        try:
            if since_ts_minute:
                rows = conn.execute(
                    "SELECT symbol, ts_minute, open, high, low, close, volume, tick_count"
                    " FROM candles_1m WHERE symbol = ? AND ts_minute >= ?"
                    " ORDER BY ts_minute", (symbol.upper(), since_ts_minute)).fetchall()
            else:
                rows = conn.execute(
                    "SELECT symbol, ts_minute, open, high, low, close, volume, tick_count"
                    " FROM candles_1m WHERE symbol = ?"
                    " ORDER BY ts_minute DESC LIMIT ?", (symbol.upper(), limit)).fetchall()
                rows = list(reversed(rows))
        finally:
            conn.close()
        return [{"symbol": r[0], "ts_minute": r[1], "open": r[2], "high": r[3],
                 "low": r[4], "close": r[5], "volume": r[6], "tick_count": r[7]}
                for r in rows]

    # ── event subscription ───────────────────────────────────
    def subscribe_1m(self, fn):
        self._subs_1m.append(fn)



candle_builder = CandleBuilder()
