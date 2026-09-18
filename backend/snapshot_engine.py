"""Snapshot engine: captures market state every 30s during market hours and queues for DB write.

v3.1 (settings upgrade):
- Per-index timer handles: stop_snapshot_timer(index_name) enables live stock removal
  without restarting the server.
- contract_multiplier / expiry_datetime may be zero-arg callables, resolved at each
  capture — required because a stock's lot size and expiry are only known after its
  option window bootstraps (post-first-spot-tick).
Everything else identical to v2.1 (daily OI baseline tracking).

Session handling (v3.5 fix):
- ALL market-open/closed decisions inside this engine go through market_open_for()
  with the instrument's own market_hours (equity, MCX, or any future provider session).
  The module-level is_market_open() is a legacy EQUITY-ONLY helper kept for other
  modules — the generic engine never uses it.
"""
import queue
import time
import threading
import sqlite3
from datetime import datetime, time as dt_time
from concurrent.futures import ThreadPoolExecutor
from database import get_db_connection, get_daily_baseline, set_daily_baseline, get_yesterday_last_oi
from calculations import calculate_analytics
import app_settings


def _capture_interval() -> int:
    """Snapshot timer rearm interval — read live from settings each cycle."""
    try:
        return app_settings.get_snapshot_interval()
    except Exception:
        return 30


def market_open_for(hours) -> bool:
    """Per-instrument session check: hours = ((start_h, start_m), (end_h, end_m)).
    Equity 09:15–15:30, MCX commodities ~09:00–23:30 — the caller decides via the
    market_hours it supplies. This is the ONLY session gate the engine uses."""
    now = datetime.now()
    if now.weekday() > 4:
        return False
    (h1, m1), (h2, m2) = hours
    return dt_time(h1, m1, 0) <= now.time() <= dt_time(h2, m2, 0)


def is_market_open() -> bool:
    """LEGACY equity-only check (09:15–15:30 IST).

    Retained for external modules (main.py health endpoints, index streamer
    bootstrap messages). The SnapshotEngine itself must NEVER call this — every
    engine decision uses market_open_for() with the instrument-supplied
    market_hours so non-equity sessions (MCX, future providers) are respected.
    """
    return market_open_for(((9, 15), (15, 30)))


_DEFAULT_HOURS = ((9, 15), (15, 30))  # fallback only when a caller supplies no session


def _fmt_hours(hours) -> str:
    """'((9, 0), (23, 30))' -> '09:00–23:30' (en dash, per-instrument messages)."""
    (h1, m1), (h2, m2) = hours
    return f"{h1:02d}:{m1:02d}–{h2:02d}:{m2:02d}"


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

        # v2.1: Daily OI baselines per index
        self.daily_baselines = {}
        self.baseline_loaded_for_index = set()

        # v3.1: per-index timer handles for live add/remove of instruments
        self._timer_events = {}
        self._timer_threads = {}
        # v3.5: per-instrument session state (was a single global flag keyed to
        # equity hours — wrong for mixed equity/MCX fleets)
        self._instrument_open = {}   # index_name -> bool (session-state logging)

        self._analytics_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="analytics")

    def _resolve(self, value):
        """Values may be plain or zero-arg callables (resolved fresh each capture)."""
        return value() if callable(value) else value

    def _resolve_hours(self, market_hours):
        """Instrument session, resolved fresh (callables supported). Callers that
        don't supply a session get the equity default — never the other way round."""
        return self._resolve(market_hours) or _DEFAULT_HOURS

    def _get_or_create_baseline(self, conn, index_name, strike, option_type, current_oi):
        today_str = datetime.now().strftime("%Y-%m-%d")
        key = (index_name, strike, option_type)

        if key in self.daily_baselines:
            return self.daily_baselines[key]

        baseline = get_daily_baseline(conn, today_str, index_name, strike, option_type)
        if baseline is not None:
            self.daily_baselines[key] = baseline
            return baseline

        baseline = get_yesterday_last_oi(conn, index_name, strike, option_type)
        if baseline is not None:
            self.daily_baselines[key] = baseline
            set_daily_baseline(conn, today_str, index_name, strike, option_type,
                               baseline, source="yesterday_close", commit=False)
            return baseline

        baseline = current_oi
        self.daily_baselines[key] = baseline
        set_daily_baseline(conn, today_str, index_name, strike, option_type,
                           baseline, source="first_reading", commit=False)
        return baseline

    def _preload_baselines(self, index_name):
        """One-time, single-query preload of yesterday's closing OI for an
        instrument into self.daily_baselines — so the capture loop never
        touches the DB per contract. Same two-step indexed lookup as the
        Tier-1 streamer fix (MAX via idx_snapshots_index, then one snapshot's
        rows via idx_option_snapshots_snapshot).

        v3.3: without this, the first capture per instrument ran
        get_yesterday_last_oi per contract — an index-defeating full
        scan+sort each time (382 sequential calls for SENSEX) — which
        wedged NIFTY/SENSEX silently for the whole session once the
        36-stock first-capture burst hit at startup."""
        if index_name in self.baseline_loaded_for_index:
            return
        self.baseline_loaded_for_index.add(index_name)   # once, even on failure
        try:
            from database import get_db_connection
            conn = get_db_connection()
            try:
                row = conn.execute(
                    "SELECT MAX(timestamp) FROM snapshots "
                    "WHERE index_name = ? AND timestamp < date('now')",
                    (index_name,)).fetchone()
                last_ts = row[0] if row else None
                if not last_ts:
                    return
                cur = conn.execute(
                    "SELECT o.strike, o.option_type, o.oi "
                    "FROM option_snapshots o JOIN snapshots s ON o.snapshot_id = s.id "
                    "WHERE s.index_name = ? AND s.timestamp = ?",
                    (index_name, last_ts))
                n = 0
                for r in cur.fetchall():
                    self.daily_baselines[(index_name, r["strike"], r["option_type"])] = r["oi"]
                    n += 1
                if n:
                    print(f"[SnapshotEngine] {index_name}: preloaded {n} OI baselines "
                          f"from {last_ts[:10]} close (one query)")
            finally:
                conn.close()
        except Exception as e:
            print(f"[SnapshotEngine] {index_name}: baseline preload failed ({e}) — "
                  f"per-contract fallback active")
        # Bound the per-contract DB fallback: after 3s of misses, new
        # contracts simply baseline to current OI (oi_change=0) instead of
        # opening DB connections per contract.
        self._baseline_db_budget_until = time.monotonic() + 3.0

    def _get_or_create_baseline_readonly(self, index_name, strike, option_type, current_oi):
        """Determine the baseline value WITHOUT a DB connection.
        Mirrors _get_or_create_baseline logic but returns the value only;
        the caller queues it for the writer thread to persist."""
        today_str = datetime.now().strftime("%Y-%m-%d")
        key = (index_name, strike, option_type)
        if key in self.daily_baselines:
            return self.daily_baselines[key]
        # check yesterday's close ONCE per contract, cache in memory
        if not hasattr(self, '_baseline_cache'):
            self._baseline_cache = {}
        ck = (index_name, strike, option_type)
        if ck in self._baseline_cache:
            return self._baseline_cache[ck]
        # budget guard: after preload + 3s grace, never open per-contract DB
        # connections here (new intraday contracts baseline to current OI)
        if time.monotonic() > getattr(self, '_baseline_db_budget_until', 0.0):
            self._baseline_cache[ck] = current_oi
            return current_oi
        try:
            from database import get_db_connection, get_yesterday_last_oi
            conn = get_db_connection()
            baseline = get_yesterday_last_oi(conn, index_name, strike, option_type)
            conn.close()
            if baseline is not None:
                self._baseline_cache[ck] = baseline
                return baseline
        except Exception:
            pass
        self._baseline_cache[ck] = current_oi
        return current_oi

    def capture_snapshot(self, data_store, spot_poller, index_name="NIFTY",
                        contract_multiplier=50, expiry_datetime=None, market_hours=None,
                        expiry_key=None, analytics_fn=None, on_snapshot=None):
        """Create a snapshot from current market state and queue it.
        market_hours: ((h,m),(h,m)) or callable — per-instrument session (commodities).
        expiry_key: cache-key expiry string (e.g. "11SEP2026"), plain or callable.
        on_snapshot: optional callable(snapshot) invoked EXACTLY ONCE after a
        SUCCESSFUL capture (alert-evaluation hook). All failure paths — no data,
        missing spot, analytics timeout/exception — return before this is called."""
        hours = self._resolve_hours(market_hours)
        if not market_open_for(hours):
            # Session-transition logging only (per instrument, actual session).
            if self._instrument_open.get(index_name):
                print(f"[SnapshotEngine] {index_name}: session closed "
                      f"({_fmt_hours(hours)}) — capture paused")
            self._instrument_open[index_name] = False
            return
        if not self._instrument_open.get(index_name, False):
            print(f"[SnapshotEngine] {index_name}: session open "
                  f"({_fmt_hours(hours)}) — capture active")
        self._instrument_open[index_name] = True
        _cycle_t0 = time.perf_counter()

        try:
            data, prev_oi = data_store.get_snapshot()
            spot = spot_poller.get_spot()
            msg_count = getattr(data_store, 'msg_count', 0)

            print(f"[SnapshotEngine] {index_name}: msg_count={msg_count}, strikes={len(data)}, spot={spot}")

            if not data:
                print(f"[SnapshotEngine] {index_name}: SKIPPED — no data received from WebSocket yet")
                return

            if spot is None:
                print(f"[SnapshotEngine] {index_name}: SKIPPED — spot price not available yet")
                return

            futures = spot_poller.get_futures()
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            # Trading date for the queued baseline writes — the SAME local date
            # as the snapshot itself (one clock read; matches the established
            # convention and the daily_oi_baseline key).
            today_str = timestamp[:10]

            mult = self._resolve(contract_multiplier)
            expiry = self._resolve(expiry_datetime)
            ek = self._resolve(expiry_key)

            try:
                # Active window follows the instrument tier (Tier 1 -> ATM±5,
                # everything else -> ATM±3). The IV store lives on data_store,
                # so this 30s path and the 5s broadcast path share one
                # persistent cache per instrument.
                # analytics_fn (per-streamer provider) overrides the default
                # local path — Tier 4 passes an Angel-fed provider with NO
                # local Black-Scholes. Default: unchanged Tier 1/2/3 behavior.
                # analytics_fn is the provider itself: invoked as
                # _af(data, spot, futures) below. Do NOT route through
                # _resolve — that unwraps zero-arg callables and would call a
                # bound method with no arguments.
                _af = analytics_fn
                if _af is None:
                    try:
                        _tier = app_settings.get_instrument_tier(index_name)
                    except Exception:
                        _tier = 1 if index_name in ("NIFTY", "SENSEX") else 2
                    _window = 5 if _tier == 1 else 3
                    _iv_store = getattr(data_store, "iv_cache", None)
                    _af = lambda d, s, f: calculate_analytics(   # noqa: E731
                        d, s, f, expiry, mult, instrument=index_name,
                        iv_store=_iv_store, active_window=_window, expiry=ek)
                analytics = self._analytics_executor.submit(
                    lambda: _af(data, spot, futures)
                ).result(timeout=60)
            except TimeoutError:
                print(f"[SnapshotEngine] {index_name}: analytics timed out (>60s) — "
                      f"snapshot skipped, retries next cycle")
                return

            # v3.9: collect baselines for the writer thread — do NOT open a
            # per-capture connection here. The writer thread owns ALL writes,
            # eliminating the per-capture connections that caused the lock
            # storms (36 instruments × 30s all hitting the same file).
            baselines_to_write = []

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
                    current_oi = opt.get("oi", 0)

                    key = (index_name, strike, opt_type)
                    if key in self.daily_baselines:
                        baseline = self.daily_baselines[key]
                    else:
                        baseline = self._get_or_create_baseline_readonly(
                            index_name, strike, opt_type, current_oi)
                        self.daily_baselines[key] = baseline
                        baselines_to_write.append(
                            (today_str, index_name, strike, opt_type, baseline))

                    oi_change = current_oi - baseline
                    oi_change_pct = round((oi_change / baseline) * 100, 2) if baseline > 0 else 0.0

                    opt_snapshot = {
                        "index_name": index_name,
                        "strike": strike,
                        "option_type": opt_type,
                        "oi": current_oi,
                        "oi_change": oi_change,
                        "oi_change_pct": oi_change_pct,
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

            snapshot["_baselines"] = baselines_to_write

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

            try:
                import app_perf
                app_perf.record_snapshot_cycle(index_name, time.perf_counter() - _cycle_t0)
            except Exception:
                pass

            # ── Alert hook: the snapshot→alert-engine integration point. ──
            # One evaluation pass per successfully captured snapshot, after
            # queueing. A hook failure must not retroactively mark this
            # capture as failed, so it gets its own guard. Injected by
            # main.py (on_snapshot=...) to avoid a snapshot_engine→main
            # circular import.
            if on_snapshot is not None:
                try:
                    on_snapshot(snapshot)
                except Exception as e:
                    print(f"[SnapshotEngine] on_snapshot hook error for {index_name}: {e}")

        except Exception as e:
            print(f"[SnapshotEngine] Error capturing snapshot: {e}")
            import traceback
            traceback.print_exc()

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
        # v3.9: persist queued baselines in the SAME transaction as the
        # snapshot — single write path, no per-capture connections.
        for (date_s, idx, strike, opt_type, oi) in snapshot.get("_baselines", []):
            cursor.execute(
                "INSERT OR REPLACE INTO daily_oi_baseline"
                " (date, index_name, strike, option_type, baseline_oi, source)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (date_s, idx, strike, opt_type, oi, "first_reading"))

        # ── A2 fix: delete the previous row for this (timestamp, index_name)
        # FIRST, inside the same transaction. INSERT OR REPLACE on `snapshots`
        # is a DELETE+INSERT that mints a NEW rowid, so the old snapshot row's
        # option_snapshots (keyed by the OLD snapshot_id) would be orphaned
        # forever. Removing both up front keeps replacement truly replacing.
        cursor.execute(
            """DELETE FROM option_snapshots WHERE snapshot_id IN
               (SELECT id FROM snapshots WHERE timestamp = ? AND index_name = ?)""",
            (snapshot["timestamp"], snapshot["index_name"]))
        cursor.execute(
            "DELETE FROM snapshots WHERE timestamp = ? AND index_name = ?",
            (snapshot["timestamp"], snapshot["index_name"]))

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
                (snapshot_id, index_name, strike, option_type, oi, oi_change, oi_change_pct, volume, ltp, iv, delta, gamma, theta, vega, gex)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                snapshot_id,
                opt["index_name"],
                opt["strike"],
                opt["option_type"],
                opt["oi"],
                opt["oi_change"],
                opt["oi_change_pct"],
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
                            contract_multiplier=50, expiry_datetime=None, market_hours=None,
                            expiry_key=None, analytics_fn=None, on_snapshot=None):
        """Start (or restart) the 30s capture timer for one instrument.
        contract_multiplier / expiry_datetime / market_hours may be plain values
        or zero-arg callables. market_hours is the instrument's OWN session
        (equity default only when the caller supplies none).
        on_snapshot: optional per-capture callback (see capture_snapshot) —
        injected by main.py for alert evaluation; never imported here directly."""

        self.stop_snapshot_timer(index_name)
        self._preload_baselines(index_name)   # one query; replaces per-contract DB scans
        stop_event = threading.Event()
        self._timer_events[index_name] = stop_event

        def timer_loop():
            # De-phase timers: instruments started together would otherwise all
            # fire at the same :00/:30 mark and flood the analytics pool.
            stagger = sum(ord(c) for c in index_name) % 6
            for _ in range(stagger):
                if not self.running or stop_event.is_set():
                    return
                time.sleep(1)

            # v3.5: session verdict from the INSTRUMENT's hours — never the
            # equity-only is_market_open(). Log uses the actual session.
            hours = self._resolve_hours(market_hours)
            if market_open_for(hours):
                print(f"[SnapshotEngine] {index_name}: session open "
                      f"({_fmt_hours(hours)}) — capture active")
                self._instrument_open[index_name] = True
            else:
                print(f"[SnapshotEngine] {index_name}: session closed "
                      f"({_fmt_hours(hours)}) — capture will resume when the session opens")

            while self.running and not stop_event.is_set():
                self.capture_snapshot(data_store, spot_poller, index_name,
                                    contract_multiplier, expiry_datetime, market_hours,
                                    expiry_key=expiry_key, analytics_fn=analytics_fn,
                                    on_snapshot=on_snapshot)
                # Rearm interval is user-configurable (Settings > Analytics) and
                # re-read every cycle — changes apply without restarting timers.
                for _ in range(_capture_interval()):
                    if not self.running or stop_event.is_set():
                        break
                    time.sleep(1)

        t = threading.Thread(target=timer_loop, daemon=True, name=f"snapshot-{index_name}")
        self._timer_threads[index_name] = t
        t.start()
        print(f"[SnapshotEngine] {index_name} snapshot timer started "
              f"({_fmt_hours(self._resolve_hours(market_hours))} session, market hours only)")

    def stop_snapshot_timer(self, index_name="NIFTY"):
        """Stop the capture timer for one instrument (live removal of stocks)."""
        ev = self._timer_events.pop(index_name, None)
        if ev:
            ev.set()
        t = self._timer_threads.pop(index_name, None)
        if t:
            t.join(timeout=5)
            print(f"[SnapshotEngine] {index_name} snapshot timer stopped")
        self._instrument_open.pop(index_name, None)

    def stop(self):
        """Stop all capture timers + the DB writer.

        v3.3 fix for slow one-by-one shutdown: signal EVERY timer's stop
        event first, then join against ONE shared deadline. The old loop
        called stop_snapshot_timer() per instrument — a serial join with a
        5s timeout each — so timers caught mid-capture under load made
        shutdown burn up to 5s per instrument (~38 × 5s ≈ 190s worst case,
        observed as 'snapshot timer stopped' lines appearing one by one).
        In-flight captures run to completion on their own (they cannot be
        safely interrupted); setting all events at once stops NEW captures
        from starting and lets all threads exit CONCURRENTLY. Total wait is
        bounded by the shared deadline, not by the instrument count."""
        self.running = False
        # 1. Signal every timer at once — no new captures start after this.
        for ev in list(self._timer_events.values()):
            ev.set()
        # 2. Drain registrations; join with a single shared deadline instead
        #    of timeout=5 per thread. Threads past their deadline are daemon
        #    threads and finish their current capture harmlessly (data_store
        #    is lock-guarded; the DB queue put has its own timeout).
        deadline = time.monotonic() + 10
        for name in list(self._timer_events.keys()):
            self._timer_events.pop(name, None)
            t = self._timer_threads.pop(name, None)
            self._instrument_open.pop(name, None)
            if t:
                t.join(timeout=max(0.0, deadline - time.monotonic()))
        for name in list(self._timer_threads.keys()):
            t = self._timer_threads.pop(name, None)
            if t:
                t.join(timeout=max(0.0, deadline - time.monotonic()))
        print("[SnapshotEngine] all snapshot timers stopped")
        self.writer_thread.join(timeout=5)
        self._analytics_executor.shutdown(wait=False)
