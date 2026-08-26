"""Snapshot engine: captures market state every 30s during market hours and queues for DB write."""
import queue
import time
import threading
import sqlite3
from datetime import datetime, time as dt_time
from database import get_db_connection
from calculations import calculate_analytics


def is_market_open() -> bool:
    """Check if Indian equity markets are currently open."""
    now = datetime.now()
    if now.weekday() > 4:
        return False
    current_time = now.time()
    return dt_time(9, 15, 0) <= current_time <= dt_time(15, 30, 0)


class SnapshotEngine:
    """Captures snapshots every 30 seconds during market hours and writes to SQLite in background."""

    def __init__(self):
        self.snapshot_queue = queue.Queue(maxsize=1000)
        self.latest_snapshots = {}
        self.latest_timestamps = {}
        self.lock = threading.Lock()
        self.running = True
        self.writer_thread = threading.Thread(target=self._db_writer_loop, daemon=True)
        self.writer_thread.start()
        self.market_was_open = False

    def capture_snapshot(self, data_store, spot_poller, index_name="NIFTY",
                        contract_multiplier=50, expiry_datetime=None):
        """Create a snapshot from current market state and queue it."""
        if not is_market_open():
            if self.market_was_open:
                print(f"[SnapshotEngine] Market closed at {datetime.now().strftime('%H:%M:%S IST')}. Snapshot capture paused.")
                self.market_was_open = False
            return

        self.market_was_open = True

        try:
            data, prev_oi = data_store.get_snapshot()
            spot = spot_poller.get_spot()
            msg_count = getattr(data_store, 'msg_count', 0)

            # DEBUG: Log what we see for each index
            print(f"[SnapshotEngine] {index_name}: msg_count={msg_count}, strikes={len(data)}, spot={spot}")

            if not data:
                print(f"[SnapshotEngine] {index_name}: SKIPPED — no data received from WebSocket yet")
                return

            if spot is None:
                print(f"[SnapshotEngine] {index_name}: SKIPPED — spot price not available yet")
                return

            futures = spot_poller.get_futures()
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            analytics = calculate_analytics(
                data, spot, futures, expiry_datetime, contract_multiplier
            )

            snapshot = {
                "timestamp": timestamp,
                "index_name": index_name,
                "spot": spot,
                "futures": futures,
                "futures_spread": analytics["futures_spread"],
                "net_gex": analytics["net_gex"],
                "max_gex_strike": analytics["max_gex_strike"],
                "max_pain": analytics["max_pain"],
                "gamma_flip": analytics["gamma_flip"],
                "options": []
            }

            for strike in sorted(data.keys()):
                for opt_type in ["CE", "PE"]:
                    opt = data[strike].get(opt_type, {})
                    prev = prev_oi.get(strike, {}).get(opt_type, opt.get("oi", 0))
                    oi_change = opt.get("oi", 0) - prev

                    opt_snapshot = {
                        "index_name": index_name,
                        "strike": strike,
                        "option_type": opt_type,
                        "oi": opt.get("oi", 0),
                        "oi_change": oi_change,
                        "volume": opt.get("volume", 0),
                        "ltp": opt.get("ltp", 0),
                        "iv": opt.get("iv"),
                        "delta": opt.get("delta"),
                        "gamma": opt.get("gamma"),
                        "theta": opt.get("theta"),
                        "vega": opt.get("vega"),
                        "gex": opt.get("gex"),
                    }
                    snapshot["options"].append(opt_snapshot)

            with self.lock:
                self.latest_snapshots[index_name] = snapshot
                self.latest_timestamps[index_name] = timestamp

            print(f"[SnapshotEngine] {index_name}: QUEUED snapshot at {timestamp} — spot={spot}, strikes={len(data)}, options={len(snapshot['options'])}")

            try:
                self.snapshot_queue.put_nowait(snapshot)
            except queue.Full:
                try:
                    self.snapshot_queue.get_nowait()
                    self.snapshot_queue.put_nowait(snapshot)
                except queue.Empty:
                    pass

        except Exception as e:
            print(f"[SnapshotEngine] Error capturing snapshot: {e}")

    def _db_writer_loop(self):
        print("[SnapshotEngine] DB writer started")
        conn = get_db_connection()

        while self.running:
            try:
                snapshot = self.snapshot_queue.get(timeout=1)
                self._write_snapshot_to_db(conn, snapshot)
            except queue.Empty:
                continue
            except Exception as e:
                print(f"[SnapshotEngine] DB write error: {e}")
                try:
                    conn.close()
                except:
                    pass
                conn = get_db_connection()

        conn.close()
        print("[SnapshotEngine] DB writer stopped")

    def _write_snapshot_to_db(self, conn, snapshot):
        print(f"[SnapshotEngine] DB WRITE: {snapshot['index_name']} at {snapshot['timestamp']} — spot={snapshot['spot']}, options={len(snapshot['options'])}")
        cursor = conn.cursor()

        cursor.execute("""
            INSERT OR REPLACE INTO snapshots
            (timestamp, index_name, spot, futures, futures_spread, net_gex, max_gex_strike, max_pain, gamma_flip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            snapshot["timestamp"],
            snapshot["index_name"],
            snapshot["spot"],
            snapshot["futures"],
            snapshot["futures_spread"],
            snapshot["net_gex"],
            snapshot["max_gex_strike"],
            snapshot["max_pain"],
            snapshot["gamma_flip"],
        ))

        snapshot_id = cursor.lastrowid

        for opt in snapshot["options"]:
            cursor.execute("""
                INSERT OR REPLACE INTO option_snapshots
                (snapshot_id, index_name, strike, option_type, oi, oi_change, volume, ltp, iv, delta, gamma, theta, vega, gex)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                snapshot_id,
                opt["index_name"],
                opt["strike"],
                opt["option_type"],
                opt["oi"],
                opt["oi_change"],
                opt["volume"],
                opt["ltp"],
                opt["iv"],
                opt["delta"],
                opt["gamma"],
                opt["theta"],
                opt["vega"],
                opt["gex"],
            ))

        conn.commit()

    def get_latest_snapshot(self, index_name="NIFTY"):
        with self.lock:
            return self.latest_snapshots.get(index_name)

    def get_latest_timestamp(self, index_name="NIFTY"):
        with self.lock:
            return self.latest_timestamps.get(index_name)

    def start_snapshot_timer(self, data_store, spot_poller, index_name="NIFTY",
                            contract_multiplier=50, expiry_datetime=None):
        def timer_loop():
            if is_market_open():
                print(f"[SnapshotEngine] Market is OPEN. {index_name} snapshot capture active.")
                self.market_was_open = True
            else:
                print(f"[SnapshotEngine] Market is CLOSED. {index_name} snapshot capture will resume at 09:15 IST.")

            while self.running:
                self.capture_snapshot(data_store, spot_poller, index_name, contract_multiplier, expiry_datetime)
                for _ in range(30):
                    if not self.running:
                        break
                    time.sleep(1)

        self.timer_thread = threading.Thread(target=timer_loop, daemon=True)
        self.timer_thread.start()
        print(f"[SnapshotEngine] {index_name} snapshot timer started (30s, market hours only)")

    def stop(self):
        self.running = False
        if hasattr(self, "timer_thread"):
            self.timer_thread.join(timeout=5)
        self.writer_thread.join(timeout=5)