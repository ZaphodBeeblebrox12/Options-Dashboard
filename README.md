# NIFTY / SENSEX Option Chain Replay Dashboard

A live, intraday options forensic dashboard that continuously records the option chain for **NIFTY 50** and **SENSEX** and allows replay of any point in the trading day.

## Architecture

```
Market Data → Python Streamer → In-Memory Snapshot → Background Queue → SQLite WAL
                                    ↓
                              Live WebSocket
                                    ↓
                              React Dashboard
```

## Technology Stack

**Backend:**
- Python 3.10+
- FastAPI
- SQLite (WAL mode)
- WebSocket
- Pandas / NumPy / SciPy

**Frontend:**
- React 18 + TypeScript
- Vite
- Tailwind CSS
- Recharts
- Lucide React

**Data Source:**
- Angel One SmartAPI v2 (WebSocket + REST)
- Mock data mode for testing without credentials

## Project Structure

```
nifty-dashboard/
├── backend/
│   ├── main.py                  # FastAPI app + WebSocket + REST API
│   ├── database.py              # SQLite WAL setup (multi-index)
│   ├── models.py                # Pydantic models
│   ├── calculations.py          # Greeks, GEX, Max Pain, Gamma Flip
│   ├── snapshot_engine.py       # 30s snapshot capture + background writer
│   ├── streamer_integration.py  # NIFTY + SENSEX streamers / mock data
│   ├── websocket_manager.py     # WebSocket connection manager
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── index.css
│   │   ├── components/
│   │   │   ├── AnalyticsHeader.tsx
│   │   │   ├── OptionChain.tsx
│   │   │   ├── ReplayControls.tsx
│   │   │   ├── GexChart.tsx
│   │   │   ├── StrikeChart.tsx
│   │   │   └── NetGexChart.tsx
│   │   └── hooks/
│   │       ├── useWebSocket.ts
│   │       └── useApi.ts
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.js
│   └── postcss.config.js
└── README.md
```

## Quick Start

### 1. Backend Setup

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Run with mock data (no API credentials needed)
python main.py
```

Backend runs on `http://localhost:8000`

### 2. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:5173` (proxies API to :8000)

### 3. Production Build

```bash
cd frontend
npm run build
# Copy dist/ to backend/ so FastAPI can serve it
cp -r dist ../backend/
cd ../backend
python main.py
```

## Supported Indices

| Index | Spot Range | Strike Step | Mock Base |
|-------|-----------|-------------|-----------|
| **NIFTY 50** | ~24,500 | 50 | 24,500 |
| **SENSEX** | ~80,500 | 100 | 80,500 |

Switch between indices using the dropdown in the replay controls.

## API Endpoints

All endpoints accept an `?index=NIFTY|SENSEX` parameter (defaults to NIFTY).

| Endpoint | Description |
|----------|-------------|
| `GET /api/current?index=NIFTY` | Latest snapshot for index |
| `GET /api/snapshots?date=YYYY-MM-DD&index=NIFTY` | Available timestamps |
| `GET /api/snapshot/{timestamp}?index=NIFTY` | Specific snapshot |
| `GET /api/history/{strike}?date=...&index=NIFTY` | Strike time-series |
| `GET /api/gex-history?date=...&index=NIFTY` | Net GEX history |
| `GET /api/gex-by-strike?timestamp=...&index=NIFTY` | GEX by strike |
| `GET /api/available-dates?index=NIFTY` | Dates with data (for calendar highlight) |
| `GET /api/market-status` | Market open/closed status |
| `WS /ws` | Live WebSocket feed (broadcasts both indices) |

## Database Schema

**snapshots** — market-level data every 30s
- timestamp, **index_name**, spot, futures, futures_spread, net_gex, max_gex_strike, max_pain, gamma_flip

**option_snapshots** — individual option states
- snapshot_id, **index_name**, strike, option_type, oi, oi_change, volume, ltp, iv, delta, gamma, theta, vega, gex

## Key Features

- **Dual Index Support**: Switch between NIFTY and SENSEX seamlessly
- **Calendar Highlighting**: Dates with saved data are highlighted in the date picker
- **Live Mode**: Real-time WebSocket updates every 2s
- **Replay Mode**: Time slider to jump to any captured moment
- **Auto-play**: Advances through snapshots every 5s
- **Compact/Full Mode**: Toggle between basic and Greeks columns
- **Strike Selection**: Click any strike to see LTP/OI/Gamma history
- **Visual Highlights**: ATM (yellow/cyan/magenta), Max OI #1-3 (red/green), Max Pain, Gamma Flip
- **GEX Analytics**: Net GEX, GEX by strike chart, GEX time-series
- **Max Pain Engine**: Recalculated per snapshot
- **Gamma Flip**: Zero-crossing of cumulative gamma

## Market Hours Behavior

- **Snapshots save only during market hours**: 09:15–15:30 IST, Monday–Friday
- **Outside hours**: Mock data continues streaming for UI testing, but DB writes are paused
- **Weekends**: Same behavior — data flows, nothing is persisted
- **Automatic resume**: Snapshots start saving again when market opens

## Calculations

- **Greeks**: Black-Scholes with implied volatility
- **GEX**: Gamma × OI × LotSize × sign(CE=+1, PE=-1)
  - NIFTY lot size: 50
  - SENSEX lot size: 10
- **Max Pain**: Strike minimizing aggregate option writer loss
- **Gamma Flip**: Strike where cumulative GEX crosses zero
