"""FastAPI backend for NIFTY/SENSEX Option Chain Replay Dashboard."""
import os
import asyncio
import json
import logging
from datetime import datetime, date, time as dt_time
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from database import init_db, get_db
from models import CurrentState, TimestampList
from snapshot_engine import SnapshotEngine, is_market_open
from streamer_integration import streamer_adapter, ANGEL_ONE_AVAILABLE, STREAMING_INDICES
from websocket_manager import manager

# Load .env before anything else
env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(env_path):
    load_dotenv(env_path, override=True)
    print(f"[ENV] Loaded: {env_path}")
else:
    print(f"[ENV] Warning: {env_path} not found. Create it from .env.example")
    print("[ENV] The server will start in MOCK mode with synthetic data.")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)

# Global state
snapshot_engine = SnapshotEngine()


def log_startup_status():
    now = datetime.now()
    market_open = is_market_open()
    day_name = now.strftime("%A")
    time_str = now.strftime("%H:%M:%S IST")

    print("=" * 60)
    print(f"  {'/'.join(STREAMING_INDICES)} Option Chain Replay Dashboard")
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
    init_db()
    log_startup_status()

    # Start streamers (real or mock — never crashes the server)
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
    print(f"[FastAPI] Server ready at http://localhost:8000")
    print(f"[FastAPI] Mode: {streamer_adapter.mode.upper()}")
    if streamer_adapter.mode == "mock":
        print("[FastAPI] NOTE: Running with synthetic data.")
        print("[FastAPI] For real market data:")
        print("  1. pip install smartapi-python pyotp")
        print("  2. cp .env.example .env")
        print("  3. Edit .env with your Angel One credentials")
        print("  4. Restart the server")
    yield

    snapshot_engine.stop()
    streamer_adapter.stop()
    broadcast_task.cancel()
    print("[FastAPI] Server shutting down")


app = FastAPI(
    title="Multi-Index Option Chain Replay Dashboard",
    description="Live intraday options forensic dashboard with replay capability (NIFTY, SENSEX, and more)",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def broadcast_loop():
    """Broadcast live data every 2 seconds to all connected clients."""
    while True:
        try:
            await asyncio.sleep(5)
            if manager.active_connections:
                for index_name in STREAMING_INDICES:
                    if index_name in streamer_adapter.streamers:
                        state = streamer_adapter.get_current_state(index_name)
                        await manager.broadcast(state)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logging.error(f"[Broadcast] Error: {e}")


# ─────────────────────────────────────────────────────────────
# REST API Endpoints
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
            """SELECT strike, option_type, oi, oi_change, volume, ltp,
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
            """SELECT strike, option_type, oi, oi_change, volume, ltp,
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
            SELECT s.timestamp, o.option_type, o.oi, o.oi_change, o.volume,
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
        "demo_mode": streamer_adapter.mode == "mock",
        "timestamp": datetime.now().isoformat(),
    }


# ─────────────────────────────────────────────────────────────
# WebSocket Endpoint
# ─────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send initial state for all indices
        for index_name in STREAMING_INDICES:
            if index_name in streamer_adapter.streamers:
                state = streamer_adapter.get_current_state(index_name)
                await manager.send_personal_message(state, websocket)

        # Keep connection alive with timeout on receive
        # If client doesn't send anything for 60s, we assume they're gone
        while True:
            try:
                # Timeout after 60 seconds — prevents dead connections from hanging forever
                data = await asyncio.wait_for(websocket.receive_text(), timeout=60.0)
                try:
                    msg = json.loads(data)
                    if msg.get("action") == "ping":
                        await manager.send_personal_message({"type": "pong"}, websocket)
                except json.JSONDecodeError:
                    pass
            except asyncio.TimeoutError:
                # Client silent for 60s — close connection cleanly
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
