"""FastAPI backend for NIFTY/SENSEX + Tier-2 stocks Option Chain Replay Dashboard + Alert System v2.2."""
import os

# ── Load .env BEFORE any project imports ─────────────────────
# streamer_integration parses TIER2_STOCKS at import time; if dotenv
# runs after the imports, the stocks list is silently empty.
from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(env_path):
    load_dotenv(env_path, override=True)
    print(f"[ENV] Loaded: {env_path}")
else:
    print(f"[ENV] Warning: {env_path} not found. Create it from .env.example")
    print("[ENV] The server will start with historical replay only (live streaming unavailable).")

import asyncio
import json
import logging
import time
from datetime import datetime, date, time as dt_time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from database import init_db, get_db
from models import CurrentState, TimestampList
from snapshot_engine import SnapshotEngine, is_market_open
from streamer_integration import streamer_adapter, ANGEL_ONE_AVAILABLE, STREAMING_INDICES, TIER1_INDICES, TIER2_STOCKS
import app_settings
import app_perf
from calculations import set_risk_free_rate
from websocket_manager import manager

# ── Alert System Imports ──────────────────────────────────────
from alert_db import init_alert_db
from alert_engine import alert_engine
from alert_models import (
    AlertSettings, AlertHistoryResponse, BacktestRequest, BacktestResponse,
    AlertStatus, AlertTriggerPayload, NotificationChannel,
)
from telegram_notifier import send_telegram_alert, test_telegram_connection
from sound_manager import (
    get_all_sounds, get_sound_base64, save_uploaded_sound, remove_custom_sound,
    BUILT_IN_SOUNDS,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)

snapshot_engine = SnapshotEngine()
alert_broadcast_queue: asyncio.Queue = asyncio.Queue()
_main_loop: asyncio.AbstractEventLoop | None = None


def log_startup_status():
    now = datetime.now()
    market_open = is_market_open()
    day_name = now.strftime("%A")
    time_str = now.strftime("%H:%M:%S IST")

    print("=" * 60)
    print(f"  Multi-Instrument Option Chain Replay Dashboard")
    print(f"  Alert System v2.2 + Tier-2 Stocks (Subscription Manager v3.0)")
    print("=" * 60)
    print(f"  Local Time: {day_name}, {time_str}")
    print(f"  Market Status: {'OPEN' if market_open else 'CLOSED'}")
    if not market_open:
        if now.weekday() > 4:
            print("  Reason: Weekend (markets closed Sat-Sun)")
        else:
            print("  Reason: Outside trading hours (09:15-15:30 IST)")
    print(f"  SmartApi: {'✓ INSTALLED' if ANGEL_ONE_AVAILABLE else '✗ NOT INSTALLED'}")
    print(f"  Tier 1: {', '.join(TIER1_INDICES)}")
    _stocks = getattr(streamer_adapter, "configured_stocks", None) or TIER2_STOCKS
    print(f"  Tier 2 stocks: {', '.join(_stocks) if _stocks else '(none configured — set TIER2_STOCKS in .env)'}")
    print("=" * 60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _main_loop
    _main_loop = asyncio.get_running_loop()
    init_db()
    init_alert_db()
    app_settings.init_settings()
    set_risk_free_rate(app_settings.get_risk_free_rate())
    log_startup_status()

    def _streamer_name(s) -> str:
        # InstrumentStreamer uses .symbol; AngelOneIndexStreamer uses .index_name
        return getattr(s, "symbol", None) or getattr(s, "index_name", "UNKNOWN")

    def _start_timer(s):
        """Tier 1/2 get 30s analytics snapshots; Tier 3 scanners skip the
        snapshot pipeline entirely (their own lightweight loop + triggers)."""
        name = _streamer_name(s)
        if getattr(s, "tier", 2) == 3:
            print(f"[Startup] {name}: Tier 3 scanner — no snapshot timer")
            return
        snapshot_engine.start_snapshot_timer(
            s.data_store, s.spot_poller, index_name=name,
            contract_multiplier=lambda: s.contract_multiplier,
            expiry_datetime=lambda: s.expiry_datetime,
            market_hours=lambda: getattr(s, "market_hours", None)
        )

    try:
        streamer_adapter.start()
        for index_name in list(streamer_adapter.streamers.keys()):
            streamer = streamer_adapter.get_streamer(index_name)
            if streamer:
                try:
                    _start_timer(streamer)
                except Exception as e:
                    # one streamer's timer failure must never suppress the hooks
                    print(f"[Startup] Snapshot timer failed for {index_name}: {e}")

        # Live add/remove/tier hooks (Settings > Instruments, no restart)
        def _on_stock_added(s):
            _start_timer(s)

        def _on_stock_removed(symbol):
            snapshot_engine.stop_snapshot_timer(symbol)

        def _on_tier_changed(s):
            if getattr(s, "tier", 2) == 3:
                snapshot_engine.stop_snapshot_timer(_streamer_name(s))
            else:
                _start_timer(s)

        streamer_adapter.on_stock_added = _on_stock_added
        streamer_adapter.on_stock_removed = _on_stock_removed
        streamer_adapter.on_scanner_alerts = lambda fired: _dispatch_fired_alerts(fired)
        streamer_adapter.on_tier_changed = _on_tier_changed
    except Exception as e:
        print(f"[Startup] Streamer error: {e}")

    broadcast_task = asyncio.create_task(broadcast_loop())
    alert_broadcast_task = asyncio.create_task(alert_broadcast_loop())
    print(f"[FastAPI] Server ready at http://localhost:8000")
    print(f"[FastAPI] Mode: {streamer_adapter.mode.upper()}")
    if streamer_adapter.mode == "unavailable":
        print("[FastAPI] WARNING: Live streaming unavailable.")
        print("[FastAPI] Historical replay from DB is still available.")
    yield

    # Orderly shutdown: async broadcast tasks -> snapshot workers -> WS
    # reconnect loops & sockets (manager.stop) -> streamer threads -> logout.
    print("[FastAPI] Shutdown initiated — stopping broadcast tasks...")
    broadcast_task.cancel()
    alert_broadcast_task.cancel()
    try:
        await asyncio.gather(broadcast_task, alert_broadcast_task, return_exceptions=True)
    except Exception:
        pass
    print("[FastAPI] Stopping snapshot engine (timers + DB writer)...")
    snapshot_engine.stop()
    print("[FastAPI] Stopping streamer adapter (sockets, threads, logout)...")
    streamer_adapter.stop()
    print("[FastAPI] Server shutting down")


app = FastAPI(
    title="Multi-Instrument Option Chain Replay Dashboard",
    description="Live intraday options forensic dashboard with replay capability + Alert System v2.2 + Tier-2 stocks",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────
# Alert Evaluation Hook (called by snapshot engine)
# ─────────────────────────────────────────────────────────────

def _dispatch_fired_alerts(fired) -> None:
    """Shared dispatch for fired alerts — the snapshot pipeline AND Tier 3
    scanner triggers both land here (WS broadcast for toast/sound, Telegram)."""
    for alert in fired:
        settings = alert_engine.get_settings()
        telegram_cfg = settings.get("telegram", {})

        if telegram_cfg.get("enabled", False) and NotificationChannel.TELEGRAM.value in [c.value for c in alert.channels_fired]:
            if _main_loop is not None and _main_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    asyncio.to_thread(
                        send_telegram_alert,
                        telegram_cfg.get("bot_token", ""),
                        telegram_cfg.get("chat_id", ""),
                        alert.model_dump(),
                    ),
                    _main_loop,
                )

        if _main_loop is not None and _main_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                alert_broadcast_queue.put(alert.model_dump()),
                _main_loop,
            )


def on_snapshot_for_alerts(snapshot: dict, index_name: str):
    try:
        if not app_settings.get_alerts_armed():
            return
        fired = alert_engine.evaluate_rules(snapshot, index_name)
        _dispatch_fired_alerts(fired)
    except Exception as e:
        logging.error(f"[AlertEngine] Evaluation error: {e}")


_original_write = snapshot_engine._write_snapshot_to_db

def _write_snapshot_to_db_with_alerts(conn, snapshot):
    _original_write(conn, snapshot)
    on_snapshot_for_alerts(snapshot, snapshot.get("index_name", "NIFTY"))

snapshot_engine._write_snapshot_to_db = _write_snapshot_to_db_with_alerts


async def alert_broadcast_loop():
    while True:
        try:
            alert = await alert_broadcast_queue.get()
            await manager.broadcast({
                "type": "alert",
                "data": alert,
            })
        except asyncio.CancelledError:
            break
        except Exception as e:
            logging.error(f"[AlertBroadcast] Error: {e}")


# ─────────────────────────────────────────────────────────────
# Broadcast Loop
# ─────────────────────────────────────────────────────────────

_last_tier2_broadcast = 0.0
TIER2_BROADCAST_INTERVAL = 30.0   # stocks refresh at 30s cadence; Tier 1 stays at 5s


async def broadcast_loop():
    """Broadcast live data to all connected clients.
    Tier 1 (indices): every 5 seconds.
    Tier 2 (stocks):  every 30 seconds — Greeks/snapshots for stocks are
    30s-cadence only; the 5s fast path is reserved for Tier 1."""
    global _last_tier2_broadcast
    while True:
        try:
            await asyncio.sleep(5)
            if streamer_adapter.mode != "real":
                continue
            if manager.active_connections:
                now = time.time()
                for index_name in list(streamer_adapter.streamers.keys()):
                    streamer = streamer_adapter.streamers.get(index_name)
                    if not streamer:
                        continue
                    is_tier2 = getattr(streamer, "tier", 2) != 1  # tier attr — promotion-aware
                    if is_tier2 and (now - _last_tier2_broadcast) < TIER2_BROADCAST_INTERVAL:
                        continue
                    _bt0 = time.perf_counter()
                    state = await asyncio.to_thread(
                        streamer_adapter.get_current_state,
                        index_name
                    )
                    app_perf.record_broadcast(index_name, time.perf_counter() - _bt0)
                    if state.get("data", {}).get("error"):
                        continue
                    await manager.broadcast(state)
                    if is_tier2:
                        _last_tier2_broadcast = now
        except asyncio.CancelledError:
            break
        except Exception as e:
            logging.error(f"[Broadcast] Error: {e}")


# ─────────────────────────────────────────────────────────────
# REST API Endpoints
# ─────────────────────────────────────────────────────────────

@app.get("/api/current")
async def get_current_state(index: str = Query(default="NIFTY", description="Instrument name: NIFTY, SENSEX, or a Tier-2 stock symbol")):
    latest = snapshot_engine.get_latest_snapshot(index)
    if latest:
        return CurrentState(**latest, is_live=True)

    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM snapshots WHERE index_name = ? ORDER BY timestamp DESC LIMIT 1",
            (index,)
        ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail=f"No snapshots available for {index}")

        options = conn.execute(
            """SELECT strike, option_type, oi, oi_change, oi_change_pct, volume, ltp,
                      iv, delta, gamma, theta, vega, gex
               FROM option_snapshots WHERE snapshot_id = ?
               ORDER BY strike, option_type""",
            (row["id"],)
        ).fetchall()

        snapshot = dict(row)
        snapshot["options"] = [dict(opt) for opt in options]
        return CurrentState(**snapshot, is_live=False)


@app.get("/api/instruments")
async def get_instruments():
    """Searchable dropdown source: fixed Tier-1 indices + all configured
    instruments (any kind, any tier)."""
    configured = getattr(streamer_adapter, "configured_stocks", None) or TIER2_STOCKS
    stocks_running = [s for s in configured if s in streamer_adapter.streamers]
    instruments = [{
        "name": s,
        "kind": app_settings.get_instrument_kind(s).lower(),
        "tier": app_settings.get_instrument_tier(s),
    } for s in configured]
    return {
        "tier1": [{"name": n, "tier": 1, "kind": "index"} for n in TIER1_INDICES],
        "stocks": [{"name": n, "tier": 2, "kind": "stock"} for n in configured],
        "instruments": instruments,
        "stocks_running": stocks_running,
        "ws": streamer_adapter.manager.stats() if streamer_adapter.manager else None,
    }


# ─────────────────────────────────────────────────────────────
# SETTINGS API (v3.1)
# ─────────────────────────────────────────────────────────────

@app.get("/api/settings")
async def get_settings():
    """App settings: stocks, risk-free rate, window half-width, alerts arm."""
    return app_settings.get_all()


@app.put("/api/settings")
async def put_settings(body: dict):
    allowed = {}
    for k in ("risk_free_rate", "window_half_width", "alerts_armed",
              "alert_scope", "snapshot_interval_seconds", "alert_rearm_seconds"):
        if k in body:
            allowed[k] = body[k]
    if "tier3_window_half_width" in body:
        # clamp: scanner window must stay a sane, narrow band
        try:
            allowed["tier3_window_half_width"] = max(2, min(20, int(body["tier3_window_half_width"])))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="tier3_window_half_width must be an integer")
    updated = app_settings.update(allowed)
    if "risk_free_rate" in allowed:
        set_risk_free_rate(float(updated["risk_free_rate"]))
    if "window_half_width" in allowed or "tier3_window_half_width" in allowed:
        # rebuild_window picks the per-tier width at build time (tier 3 uses
        # the scanner width, tier 2 the full-analytics width)
        streamer_adapter.rebuild_all_windows()
    return updated


@app.get("/api/stocks")
async def list_stocks():
    """Per-stock live status for Settings > Stocks."""
    return {"stocks": streamer_adapter.stocks_status()}


@app.post("/api/stocks")
async def add_stock(body: dict):
    symbol = (body.get("symbol") or "").strip().upper()
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")
    kind = (body.get("kind") or "").strip().upper() or None
    result = streamer_adapter.add_stock(symbol, kind=kind)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "failed to add stock"))
    return result


@app.delete("/api/stocks/{symbol}")
async def remove_stock(symbol: str):
    result = streamer_adapter.remove_stock(symbol)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "not found"))
    return result


@app.post("/api/stocks/{symbol}/pause")
async def pause_stock(symbol: str):
    result = streamer_adapter.pause_stock(symbol)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "not found"))
    return result


@app.post("/api/stocks/{symbol}/resume")
async def resume_stock(symbol: str):
    result = streamer_adapter.resume_stock(symbol)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "not found"))
    return result


@app.get("/api/stocks/search")
async def search_stocks(q: str = Query(default="")):
    """Typeahead source for the Add-stock bar (searches scrip master OPTSTK names)."""
    from scrip_master import scrip_master
    try:
        matches = scrip_master.search_stock_names(q)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"matches": matches}


@app.get("/api/instruments/search")
async def search_instruments(q: str = Query(default="")):
    """Kind-aware typeahead: [{symbol, kind}] across INDEX / STOCK / COMMODITY."""
    from scrip_master import scrip_master
    try:
        matches = scrip_master.search_instruments(q)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"matches": matches}


@app.post("/api/instruments")
async def add_instrument(body: dict):
    """Add an instrument of any kind. Kind auto-detected when omitted.
    New instruments default to Tier 2 — promote via /api/instruments/{sym}/tier."""
    symbol = (body.get("symbol") or "").strip().upper()
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")
    kind = (body.get("kind") or "").strip().upper() or None
    tier = body.get("tier", 2)
    result = streamer_adapter.add_instrument(symbol, kind=kind, tier=tier)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "failed to add instrument"))
    return result


@app.post("/api/instruments/{symbol}/tier")
async def set_instrument_tier(symbol: str, body: dict):
    """Promote (tier=1) or demote (tier=2) a tracked instrument."""
    tier = body.get("tier", 2)
    result = streamer_adapter.set_instrument_tier(symbol, tier)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "not found"))
    return result


@app.get("/api/ws/usage")
async def ws_usage():
    """WebSocket slot stats + per-instrument token usage (Settings > Connections)."""
    if not streamer_adapter.manager:
        return {"ws": None, "usage_by_instrument": {}}
    return {
        "ws": streamer_adapter.manager.stats(),
        "usage_by_instrument": streamer_adapter.manager.usage_by_instrument(),
    }


@app.get("/api/app-health")
async def app_health():
    """Application-specific performance — Settings > Connections > App health.

    Answers 'can I add more Tier-2 stocks?' with real pipeline timings:
    analytics / broadcast / snapshot cycle durations (avg + p95), freshness,
    and DB write queue depth. Status: Healthy / Warning / Degraded / Idle.
    """
    from snapshot_engine import is_market_open as _market_open

    perf = app_perf.snapshot()
    interval = app_settings.get_snapshot_interval()
    stocks_tracked = len(streamer_adapter.stock_streamers)
    queue_depth = snapshot_engine.snapshot_queue.qsize()
    market_open = _market_open()

    def grade(p95_ms, ok_ms, warn_ms):
        if p95_ms is None:
            return "idle"
        return "ok" if p95_ms < ok_ms else ("warning" if p95_ms < warn_ms else "degraded")

    # Underlying feed staleness (worst across all streamers) — catches a
    # stalled index/underlying token while option ticks keep flowing.
    ages = []
    for name, s in streamer_adapter.streamers.items():
        try:
            a = s.spot_poller.spot_age_sec()
            if a is not None:
                ages.append((a, name))
        except Exception:
            pass
    max_age = max(ages)[0] if ages else None
    if not market_open or max_age is None:
        g_underlying = "idle"
    else:
        g_underlying = "ok" if max_age <= 120 else ("warning" if max_age <= 300 else "degraded")

    g_analytics = grade(perf["analytics_tier2"]["p95_ms"], 500, 2000)
    g_broadcast = grade(perf["broadcast_tier2"]["p95_ms"], 1000, 3000)
    g_queue = "ok" if queue_depth == 0 else ("warning" if queue_depth <= 3 else "degraded")

    # Freshness: newest Tier-2 snapshot vs the configured interval (market hours only)
    last_t2 = max(
        (ts for name, ts in perf["last"]["snapshot"].items()
         if app_settings.get_instrument_tier(name) == 2),
        default=None,
    )
    age = (time.time() - last_t2) if last_t2 else None
    if not market_open:
        g_fresh = "idle"
    elif age is None:
        g_fresh = "idle" if stocks_tracked == 0 else "degraded"
    else:
        g_fresh = "ok" if age <= 2 * interval else ("warning" if age <= 4 * interval else "degraded")

    if stocks_tracked == 0:
        overall = "idle"
    else:
        order = {"idle": 0, "ok": 1, "warning": 2, "degraded": 3}
        overall = max([g_analytics, g_broadcast, g_queue, g_fresh], key=lambda g: order[g])

    return {
        "overall": overall,
        "grades": {"analytics": g_analytics, "broadcast": g_broadcast,
                   "queue": g_queue, "freshness": g_fresh, "underlying": g_underlying},
        "max_spot_age_sec": max_age,
        "oldest_feed": (max(ages)[1] if ages else None),
        "stocks_tracked": stocks_tracked,
        "queue_depth": queue_depth,
        "snapshot_interval": interval,
        "market_open": market_open,
        "last_tier2_snapshot_at": last_t2,
        "last_tier2_snapshot_age_sec": round(age) if age is not None else None,
        **perf,
    }


@app.get("/api/snapshots")
async def get_snapshots(
    date_str: str = Query(..., alias="date"),
    index: str = Query(default="NIFTY", description="Instrument name")
):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT timestamp FROM snapshots WHERE date(timestamp) = ? AND index_name = ? ORDER BY timestamp",
            (date_str, index)
        ).fetchall()

    timestamps = [row["timestamp"] for row in rows]
    return TimestampList(date=date_str, index_name=index, timestamps=timestamps)


@app.get("/api/snapshot/{timestamp}")
async def get_snapshot_by_timestamp(
    timestamp: str,
    index: str = Query(default="NIFTY", description="Instrument name")
):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM snapshots WHERE timestamp = ? AND index_name = ?",
            (timestamp, index)
        ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Snapshot not found")

        options = conn.execute(
            """SELECT strike, option_type, oi, oi_change, oi_change_pct, volume, ltp,
                      iv, delta, gamma, theta, vega, gex
               FROM option_snapshots WHERE snapshot_id = ?
               ORDER BY strike, option_type""",
            (row["id"],)
        ).fetchall()

        snapshot = dict(row)
        snapshot["options"] = [dict(opt) for opt in options]
        return snapshot


@app.get("/api/history/{strike}")
async def get_strike_history(
    strike: int,
    date_str: str = Query(default=None, alias="date"),
    index: str = Query(default="NIFTY", description="Instrument name")
):
    if not date_str:
        date_str = date.today().isoformat()

    with get_db() as conn:
        rows = conn.execute("""
            SELECT s.timestamp, o.option_type, o.oi, o.oi_change, o.oi_change_pct, o.volume,
                   o.ltp, o.iv, o.delta, o.gamma, o.theta, o.vega, o.gex
            FROM snapshots s
            JOIN option_snapshots o ON s.id = o.snapshot_id
            WHERE date(s.timestamp) = ? AND o.strike = ? AND s.index_name = ?
            ORDER BY s.timestamp, o.option_type
        """, (date_str, strike, index)).fetchall()

    timeseries = [dict(row) for row in rows]
    return {"strike": strike, "index_name": index, "timeseries": timeseries}


@app.get("/api/gex-history")
async def get_gex_history(
    date_str: str = Query(default=None, alias="date"),
    index: str = Query(default="NIFTY", description="Instrument name")
):
    if not date_str:
        date_str = date.today().isoformat()

    with get_db() as conn:
        rows = conn.execute(
            "SELECT timestamp, net_gex FROM snapshots WHERE date(timestamp) = ? AND index_name = ? ORDER BY timestamp",
            (date_str, index)
        ).fetchall()

    timeseries = [{"timestamp": row["timestamp"], "net_gex": row["net_gex"]} for row in rows]
    return {"index_name": index, "timeseries": timeseries}


@app.get("/api/gex-by-strike")
async def get_gex_by_strike(
    timestamp: str,
    index: str = Query(default="NIFTY", description="Instrument name")
):
    with get_db() as conn:
        snapshot = conn.execute(
            "SELECT id FROM snapshots WHERE timestamp = ? AND index_name = ?",
            (timestamp, index)
        ).fetchone()

        if not snapshot:
            raise HTTPException(status_code=404, detail="Snapshot not found")

        rows = conn.execute("""
            SELECT strike, option_type, gex
            FROM option_snapshots
            WHERE snapshot_id = ?
            ORDER BY strike
        """, (snapshot["id"],)).fetchall()

    gex_data = {}
    for row in rows:
        s = row["strike"]
        if s not in gex_data:
            gex_data[s] = {"ce_gex": 0, "pe_gex": 0, "net_gex": 0}
        gex_val = row["gex"] or 0
        if row["option_type"] == "CE":
            gex_data[s]["ce_gex"] = gex_val
        else:
            gex_data[s]["pe_gex"] = gex_val
        gex_data[s]["net_gex"] = gex_data[s]["ce_gex"] + gex_data[s]["pe_gex"]

    result = [{"strike": k, **v} for k, v in sorted(gex_data.items())]
    return result


@app.get("/api/available-dates")
async def get_available_dates(index: str = Query(default="NIFTY", description="Instrument name")):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT date(timestamp) as dt FROM snapshots WHERE index_name = ? ORDER BY dt DESC",
            (index,)
        ).fetchall()

    return {"index_name": index, "dates": [row["dt"] for row in rows]}


@app.get("/api/strikes")
async def get_strikes(
    timestamp: str = Query(default=None),
    index: str = Query(default="NIFTY", description="Instrument name")
):
    with get_db() as conn:
        if timestamp:
            snapshot = conn.execute(
                "SELECT id FROM snapshots WHERE timestamp = ? AND index_name = ?",
                (timestamp, index)
            ).fetchone()
            if not snapshot:
                raise HTTPException(status_code=404, detail="Snapshot not found")
            snapshot_id = snapshot["id"]
        else:
            row = conn.execute(
                "SELECT id FROM snapshots WHERE index_name = ? ORDER BY timestamp DESC LIMIT 1",
                (index,)
            ).fetchone()
            if not row:
                return {"strikes": []}
            snapshot_id = row["id"]

        rows = conn.execute(
            "SELECT DISTINCT strike FROM option_snapshots WHERE snapshot_id = ? ORDER BY strike",
            (snapshot_id,)
        ).fetchall()

    return {"strikes": [row["strike"] for row in rows]}


@app.get("/api/market-status")
async def get_market_status():
    return {
        "market_open": is_market_open(),
        "live_available": streamer_adapter.mode == "real",
        "timestamp": datetime.now().isoformat(),
    }


# ─────────────────────────────────────────────────────────────
# ALERT API ENDPOINTS (v2.2)
# ─────────────────────────────────────────────────────────────

@app.get("/api/alerts/settings")
async def get_alert_settings():
    return alert_engine.get_settings()


@app.post("/api/alerts/settings")
async def update_alert_settings(settings: dict):
    alert_engine.update_settings(settings)
    return {"status": "saved"}


@app.get("/api/alerts/status")
async def get_alert_status() -> AlertStatus:
    return AlertStatus(**alert_engine.get_status())


@app.post("/api/alerts/reset")
async def reset_alert_states(index: str = Query(default=None)):
    alert_engine.reset_states(index)
    return {"status": "reset", "index": index}


@app.get("/api/alerts/history")
async def get_alert_history(
    index: str = Query(default=None),
    date: str = Query(default=None),
    rule_type: str = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    from alert_db import get_alert_history
    result = get_alert_history(index, date, rule_type, page, page_size)
    return AlertHistoryResponse(**result)


@app.get("/api/alerts/history/dates")
async def get_alert_history_dates(index: str = Query(default=None)):
    """Lightweight per-day alert counts for the history calendar.
    Returns {"dates": [{"date": "2026-09-04", "count": 7}, ...]} newest first."""
    from alert_db import get_alert_date_counts
    return {"dates": get_alert_date_counts(index)}


@app.post("/api/alerts/backtest")
async def run_backtest(req: BacktestRequest):
    from database import get_db
    # Isolated scratch state for this backtest run: evaluate_rules reads and
    # writes THIS map instead of the live alert_rule_state table, so a
    # backtest can neither see nor mutate live armed/disarmed state,
    # last_fired_at, cooldown, or rearm-debounce state. Live evaluations
    # (snapshot writer / Tier-3 scanner) pass no state_map and are unaffected.
    bt_rule_state: dict = {}
    triggers = []

    with get_db() as conn:
        snap_rows = conn.execute(
            "SELECT * FROM snapshots WHERE date(timestamp) = ? AND index_name = ? ORDER BY timestamp",
            (req.date_str, req.index_name)
        ).fetchall()

        for snap in snap_rows:
            opt_rows = conn.execute(
                """SELECT strike, option_type, oi, oi_change, oi_change_pct, volume, ltp,
                          iv, delta, gamma, theta, vega, gex
                   FROM option_snapshots WHERE snapshot_id = ?
                   ORDER BY strike, option_type""",
                (snap["id"],)
            ).fetchall()

            snapshot = dict(snap)
            snapshot["options"] = [dict(opt) for opt in opt_rows]

            fired = alert_engine.evaluate_rules(snapshot, req.index_name, state_map=bt_rule_state)
            for alert in fired:
                if alert.rule_type in req.rule_types:
                    triggers.append({
                        "timestamp": alert.timestamp,
                        "rule_type": alert.rule_type.value,
                        "rule_name": alert.rule_name,
                        "spot": alert.spot,
                        "atm_strike": alert.atm_strike,
                        "max_ce_oi_strike": alert.max_ce_oi_strike,
                        "max_pe_oi_strike": alert.max_pe_oi_strike,
                        "max_negative_gex_strike": alert.max_negative_gex_strike,
                    })

    return BacktestResponse(
        date_str=req.date_str,
        index_name=req.index_name,
        total_triggers=len(triggers),
        triggers=triggers,
    )


@app.get("/api/alerts/sounds")
async def list_sounds():
    return {"sounds": get_all_sounds()}


@app.get("/api/alerts/sounds/{sound_id}")
async def get_sound_data(sound_id: str):
    data = get_sound_base64(sound_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Sound not found")
    return {"sound_id": sound_id, "base64": data}


@app.post("/api/alerts/sounds/upload")
async def upload_sound(
    file: UploadFile = File(...),
    name: str = Form(...),
):
    if not file.content_type or not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="File must be an audio file")

    content = await file.read()
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 5MB)")

    result = save_uploaded_sound(name, file.content_type, content)
    return result


@app.delete("/api/alerts/sounds/{sound_id}")
async def delete_sound(sound_id: str):
    remove_custom_sound(sound_id)
    return {"status": "deleted"}


@app.post("/api/alerts/telegram/test")
async def test_telegram(cfg: dict):
    success, msg = test_telegram_connection(
        cfg.get("bot_token", ""),
        cfg.get("chat_id", ""),
    )
    return {"success": success, "message": msg}


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {
        "market_open": is_market_open(),
        "mode": streamer_adapter.mode,
        "timestamp": datetime.now().isoformat(),
        "indices": {
            name: {
                "connected": s.ws_connected,
                "messages": s.data_store.msg_count,
                "spot": s.spot_poller.get_spot(),
            }
            for name, s in streamer_adapter.streamers.items()
        },
        "ws_slots": streamer_adapter.manager.stats() if streamer_adapter.manager else None,
        "alerts": {
            "engine_running": True,
            "total_firings_today": alert_engine.get_status()["total_firings_today"],
        },
    }


# ─────────────────────────────────────────────────────────────
# WebSocket Endpoint
# ─────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        for index_name in list(streamer_adapter.streamers.keys()):
            if index_name in streamer_adapter.streamers:
                state = await asyncio.to_thread(
                    streamer_adapter.get_current_state,
                    index_name
                )
                await manager.send_personal_message(state, websocket)

        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=60.0)
                try:
                    msg = json.loads(data)
                    if msg.get("action") == "ping":
                        await manager.send_personal_message({"type": "pong"}, websocket)
                except json.JSONDecodeError:
                    pass
            except asyncio.TimeoutError:
                logging.info("[WS] Client silent for 60s, closing connection")
                break

    except WebSocketDisconnect:
        logging.info("[WS] Client disconnected")
    except Exception as e:
        logging.error(f"[WS] Handler error: {e}")
    finally:
        manager.disconnect(websocket)


# ─────────────────────────────────────────────────────────────
# Static Files (Frontend)
# ─────────────────────────────────────────────────────────────

frontend_build = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.exists(frontend_build):
    app.mount("/assets", StaticFiles(directory=os.path.join(frontend_build, "assets")), name="assets")

    @app.get("/{path:path}")
    async def serve_frontend(path: str):
        index_path = os.path.join(frontend_build, "index.html")
        if os.path.exists(index_path):
            return FileResponse(index_path)
        raise HTTPException(status_code=404)
else:
    @app.get("/")
    async def root():
        return {
            "status": "API only — no frontend build found",
            "endpoints": [
                "/api/current", "/api/snapshots", "/api/instruments",
                "/api/alerts/settings", "/api/alerts/history", "/api/health",
            ],
        }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
