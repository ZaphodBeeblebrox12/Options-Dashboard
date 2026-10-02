NSE HOLIDAY FIX — drop-in replacement package (v3.13)
======================================================
Built against repo commit 144cd4388a5d ("updates", 2026-10-02).
DISCARD any previous holiday-fix ZIP — those targeted the old v2.x files
and would overwrite your v3.x code.

WHAT WAS WRONG
--------------
Every session gate checked only weekday + clock time. On NSE holidays
(today: Gandhi Jayanti, 2026-10-02 — a Friday inside market hours)
snapshots, candles and alert evaluations kept running all day.

FILES (copy over your backend/ files — same paths, drop-in)
-----------------------------------------------------------
backend/snapshot_engine.py
    + _is_trading_holiday(): XNSE trading calendar via exchange_calendars,
      cached once per calendar day, fail-open with a warning.
    market_open_for() returns False on holidays. This is THE session gate
    for the whole engine (equity AND MCX — MCX observes the same national
    holiday calendar), so capture, DB writes, freeze watchdog and health
    endpoints are all fixed by this one change. is_market_open() delegates.

backend/streamer_integration.py
    Local is_market_open() copy (status/bootstrap messages) calls the same
    shared holiday lookup — one cached calendar per process, not two.

backend/candle_builder.py
    CandleBuilder._session_open() (1m candle gate) excludes holidays —
    no more ghost candles_1m rows.

backend/main.py
    Startup banner + GET /api/market-status report the reason:
    "NSE holiday today (per trading calendar)" instead of bare CLOSED/false.

backend/requirements.txt
    + exchange-calendars>=4.5

INSTALL
-------
    cd backend
    pip install exchange-calendars          # or: pip install -r requirements.txt
    # copy the 5 files from this ZIP over backend/, then:
    python main.py

VERIFY
------
1. Restart on a holiday: banner shows
       Market Status: CLOSED
       Reason: NSE holiday today (per trading calendar)
   and NO "[SnapshotEngine] ... DB WRITE" lines appear.
2. GET /api/market-status returns {"market_open": false,
   "reason": "NSE holiday today (per trading calendar)", ...}
3. Next trading day captures normally. Fail-open: if the library is
   missing it warns once and keeps old behavior — a pip problem can
   never cost you a real trading day.

CLEAN UP TODAY'S BOGUS DATA (2026-10-02)
----------------------------------------
Back up the DB first, then (adjust filename to your DB_PATH):

    DELETE FROM option_snapshots WHERE snapshot_id IN
      (SELECT id FROM snapshots WHERE date(timestamp)='2026-10-02');
    DELETE FROM snapshots WHERE date(timestamp)='2026-10-02';
    DELETE FROM daily_oi_baseline WHERE date='2026-10-02';
    DELETE FROM candles_1m WHERE date(ts_minute)='2026-10-02';

Optionally delete today's alert_history rows (no FK to snapshots; filter
by timestamp date) if you don't want phantom alerts in History calendar.

WHY A CALENDAR LIBRARY
----------------------
NSE publishes holidays yearly (incl. ad-hoc closures). exchange_calendars'
XNSE calendar is maintained upstream, so nothing rots. MCX shares the
national holiday list, so one calendar covers both session types.


BUILDUP CARD (frontend) — v3.15
--------------------------------
The dashboard header now has a Futures-OI buildup strip (Long Buildup /
Short Covering / Short Buildup / Long Unwinding) for the selected index,
colored per quadrant, with a magnitude bar. Live mode refreshes every 30s;
replay mode shows the buildup as of the selected date.

Install:
  1. Copy backend/main.py (adds GET /api/buildup) from this ZIP.
  2. Copy frontend/src/components/BuildupCard.tsx from this ZIP.
  3. From the repo root:  python tools/patch_app_for_buildup.py
     (2 anchored insertions into App.tsx; idempotent; tells you the exact
     lines to add manually if your App.tsx has drifted)
  4. cd frontend && npm run build
  5. Restart the backend.

Endpoint: GET /api/buildup?index=NIFTY[&date=YYYY-MM-DD]
  -> { "NIFTY": { "label": "SHORT BUILDUP", "px": ..., "px_chg": ...,
                  "futures_oi": ..., "oi_chg": ..., "oi_source": "futures",
                  "baseline_ts": ..., "last_ts": ..., "live": true } }
oi_source is "options" for dates recorded before futures OI existed (proxy).
