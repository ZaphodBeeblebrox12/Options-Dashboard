"""FastAPI backend for NIFTY/SENSEX Option Chain Replay Dashboard + Alert System v2.2."""
import os
import asyncio
import json
import logging
from datetime import datetime, date, time as dt_time
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from database import init_db, get_db
from models import CurrentState, TimestampList
from snapshot_engine import SnapshotEngine, is_market_open
from streamer_integration import streamer_adapter, ANGEL_ONE_AVAILABLE, STREAMING_INDICES
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

# Load .env before anything else
env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(env_path):
    load_dotenv(env_path, override=True)
    print(f"[ENV] Loaded: {env_path}")
else:
    print(f"[ENV] Warning: {env_path} not found. Create it from .env.example")
    print("[ENV] The server will start with historical replay only (live streaming unavailable).")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)

# Global state
snapshot_engine = SnapshotEngine()

# In-memory queue for alert firings to broadcast via WebSocket
alert_broadcast_queue: asyncio.Queue = asyncio.Queue()

# Reference to the main event loop for thread-safe scheduling from DB writer thread
_main_loop: asyncio.AbstractEventLoop | None = None


def log_startup_status():
    now = datetime.now()
    market_open = is_market_open()
    day_name = now.strftime("%A")
    time_str = now.strftime("%H:%M:%S IST")

    print("=" * 60)
    print(f"  {'/'.join(STREAMING_INDICES)} Option Chain Replay Dashboard")
    print(f"  Alert System v2.2")
    print("=" * 60)
    print(f"  Local Time: {day_name}, {time_str}")
    print(f"  Market Status: {'OPEN' if market_open else 'CLOSED'}")
    if not market_open:
        if now.weekday() > 4:
            print("  Reason: Weekend (markets closed Sat-Sun)")
        else:
            print("  Reason: Outside trading hours (09:15-15:30 IST)")
    print(f"  SmartApi: {'✓ INSTALLED' if ANGEL_ONE_AVAILABLE else '✗ NOT INSTALLED'}")
    if not ANGEL_ONE_AVAILABLE:
        print("  Fix: pip install smartapi-python pyotp")
    print("=" * 60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _main_loop
    _main_loop = asyncio.get_running_loop()
    init_db()
    init_alert_db()
    log_startup_status()

    # Start streamers (real mode only — safe fallback to unavailable)
    try:
        streamer_adapter.start()
        for index_name in STREAMING_INDICES:
            streamer = streamer_adapter.get_streamer(index_name)
            if streamer:
                snapshot_engine.start_snapshot_timer(
                    streamer.data_store,
                    streamer.spot_poller,
                    index_name=index_name,
                    contract_multiplier=streamer.contract_multiplier,
                    expiry_datetime=streamer.expiry_datetime
                )
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

    snapshot_engine.stop()
    streamer_adapter.stop()
    broadcast_task.cancel()
    alert_broadcast_task.cancel()
    print("[FastAPI] Server shutting down")


app = FastAPI(
    title="Multi-Index Option Chain Replay Dashboard",
    description="Live intraday options forensic dashboard with replay capability + Alert System v2.2",
    version="2.2.0",
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

def on_snapshot_for_alerts(snapshot: dict, index_name: str):
    """Callback invoked after every snapshot is written to DB.
    Evaluates alert rules and queues firings for broadcast.

    NOTE: This runs on the DB writer thread, so all asyncio operations
    must be scheduled via run_coroutine_threadsafe().
    """
    try:
        fired = alert_engine.evaluate_rules(snapshot, index_name)
        for alert in fired:
            settings = alert_engine.get_settings()
            telegram_cfg = settings.get("telegram", {})

            # Telegram (thread-safe)
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

            # WebSocket broadcast (thread-safe via main loop)
            if _main_loop is not None and _main_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    alert_broadcast_queue.put(alert.model_dump()),
                    _main_loop,
                )
    except Exception as e:
        logging.error(f"[AlertEngine] Evaluation error: {e}")


# Patch snapshot engine to trigger alerts
_original_write = snapshot_engine._write_snapshot_to_db

def _write_snapshot_to_db_with_alerts(conn, snapshot):
    _original_write(conn, snapshot)
    on_snapshot_for_alerts(snapshot, snapshot.get("index_name", "NIFTY"))

snapshot_engine._write_snapshot_to_db = _write_snapshot_to_db_with_alerts


async def alert_broadcast_loop():
    """Broadcast alert firings to all WebSocket clients."""
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
# Broadcast Loop (existing)
# ─────────────────────────────────────────────────────────────

async def broadcast_loop():
    """Broadcast live data every 5 seconds to all connected clients."""
    while True:
        try:
            await asyncio.sleep(5)
            if streamer_adapter.mode != "real":
                continue
            if manager.active_connections:
                for index_name in STREAMING_INDICES:
                    if index_name in streamer_adapter.streamers:
                        state = await asyncio.to_thread(
                            streamer_adapter.get_current_state,
                            index_name
                        )
                        # Skip error-only states
                        if state.get("data", {}).get("error"):
                            continue
                        await manager.broadcast(state)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logging.error(f"[Broadcast] Error: {e}")


# ─────────────────────────────────────────────────────────────
# REST API Endpoints (existing + alert)
# ─────────────────────────────────────────────────────────────

@app.get("/api/current")
async def get_current_state(index: str = Query(default="NIFTY", description="Index name: NIFTY or SENSEX")):
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


@app.get("/api/snapshots")
async def get_snapshots(
    date_str: str = Query(..., alias="date"),
    index: str = Query(default="NIFTY", description="Index name: NIFTY or SENSEX")
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
    index: str = Query(default="NIFTY", description="Index name: NIFTY or SENSEX")
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
    index: str = Query(default="NIFTY", description="Index name: NIFTY or SENSEX")
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
    index: str = Query(default="NIFTY", description="Index name: NIFTY or SENSEX")
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
    index: str = Query(default="NIFTY", description="Index name: NIFTY or SENSEX")
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
async def get_available_dates(index: str = Query(default="NIFTY", description="Index name: NIFTY or SENSEX")):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT date(timestamp) as dt FROM snapshots WHERE index_name = ? ORDER BY dt DESC",
            (index,)
        ).fetchall()

    return {"index_name": index, "dates": [row["dt"] for row in rows]}


@app.get("/api/strikes")
async def get_strikes(
    timestamp: str = Query(default=None),
    index: str = Query(default="NIFTY", description="Index name: NIFTY or SENSEX")
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
    """Get current alert system settings."""
    return alert_engine.get_settings()


@app.post("/api/alerts/settings")
async def update_alert_settings(settings: dict):
    """Update alert system settings."""
    alert_engine.update_settings(settings)
    return {"status": "saved"}


@app.get("/api/alerts/status")
async def get_alert_status() -> AlertStatus:
    """Get current alert engine status."""
    return AlertStatus(**alert_engine.get_status())


@app.post("/api/alerts/reset")
async def reset_alert_states(index: str = Query(default=None)):
    """Reset all rule states to ARMED. Optionally filter by index."""
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
    """Get paginated alert history."""
    from alert_db import get_alert_history
    result = get_alert_history(index, date, rule_type, page, page_size)
    return AlertHistoryResponse(**result)


@app.post("/api/alerts/backtest")
async def run_backtest(req: BacktestRequest):
    """Backtest alert rules on historical snapshot data."""
    from database import get_db
    triggers = []

    with get_db() as conn:
        # Get all snapshots for the date
        snap_rows = conn.execute(
            "SELECT * FROM snapshots WHERE date(timestamp) = ? AND index_name = ? ORDER BY timestamp",
            (req.date_str, req.index_name)
        ).fetchall()

        for snap in snap_rows:
            # Load options for this snapshot
            opt_rows = conn.execute(
                """SELECT strike, option_type, oi, oi_change, oi_change_pct, volume, ltp,
                          iv, delta, gamma, theta, vega, gex
                   FROM option_snapshots WHERE snapshot_id = ?
                   ORDER BY strike, option_type""",
                (snap["id"],)
            ).fetchall()

            snapshot = dict(snap)
            snapshot["options"] = [dict(opt) for opt in opt_rows]

            # Temporarily reset states for clean backtest
            fired = alert_engine.evaluate_rules(snapshot, req.index_name)
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
    """List all available sounds (built-in + custom)."""
    return {"sounds": get_all_sounds()}


@app.get("/api/alerts/sounds/{sound_id}")
async def get_sound_data(sound_id: str):
    """Get base64-encoded sound data."""
    data = get_sound_base64(sound_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Sound not found")
    return {"sound_id": sound_id, "base64": data}


@app.post("/api/alerts/sounds/upload")
async def upload_sound(
    file: UploadFile = File(...),
    name: str = Form(...),
):
    """Upload a custom sound file."""
    if not file.content_type or not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="File must be an audio file")

    content = await file.read()
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 5MB)")

    result = save_uploaded_sound(name, file.content_type, content)
    return result


@app.delete("/api/alerts/sounds/{sound_id}")
async def delete_sound(sound_id: str):
    """Delete a custom sound."""
    remove_custom_sound(sound_id)
    return {"status": "deleted"}


@app.post("/api/alerts/telegram/test")
async def test_telegram(cfg: dict):
    """Test Telegram connection."""
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
        "alerts": {
            "engine_running": True,
            "total_firings_today": alert_engine.get_status()["total_firings_today"],
        },
    }


# ─────────────────────────────────────────────────────────────
# WebSocket Endpoint (updated with alert support)
# ─────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send initial state for all indices
        for index_name in STREAMING_INDICES:
            if index_name in streamer_adapter.streamers:
                state = await asyncio.to_thread(
                    streamer_adapter.get_current_state,
                    index_name
                )
                await manager.send_personal_message(state, websocket)

        # Keep connection alive
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
                "/api/current", "/api/snapshots", "/api/alerts/settings",
                "/api/alerts/history", "/api/health",
            ],
        }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
