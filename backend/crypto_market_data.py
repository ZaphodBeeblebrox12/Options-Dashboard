"""Public BTC/USDT spot candles from Binance and OKX.

No credentials are used. These helpers fetch one UTC calendar day and return
exchange-native OHLCV bars. Live updates are intentionally handled by the
browser's public WebSocket connection, not by opening another backend broker
session.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import requests

BINANCE_REST = "https://data-api.binance.vision/api/v3/klines"
OKX_CANDLES = "https://openapi.okx.com/api/v5/market/candles"
OKX_HISTORY_CANDLES = "https://openapi.okx.com/api/v5/market/history-candles"

BINANCE_INTERVALS = {"1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"}
OKX_INTERVALS = {"1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"}
INTERVAL_MS = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000,
    "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000,
    "2h": 7_200_000, "4h": 14_400_000, "1d": 86_400_000,
}


def _utc_day_bounds(date_str: str) -> tuple[int, int]:
    try:
        day = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError("date must use YYYY-MM-DD") from exc
    start_ms = int(day.timestamp() * 1000)
    return start_ms, start_ms + 86_400_000


def _bar(ts: Any, open_: Any, high: Any, low: Any, close: Any, volume: Any) -> dict:
    return {
        "time": int(ts),
        "open": float(open_),
        "high": float(high),
        "low": float(low),
        "close": float(close),
        "volume": float(volume),
    }


def _fetch_binance(interval: str, start_ms: int, end_ms: int,
                   session: Any = requests) -> list[dict]:
    if interval not in BINANCE_INTERVALS:
        raise ValueError(f"Unsupported Binance interval: {interval}")
    output: dict[int, dict] = {}
    cursor = start_ms
    step_ms = INTERVAL_MS[interval]
    # One UTC day contains at most 1,440 one-minute candles; two pages are
    # sufficient for the smallest supported interval.
    for _ in range(4):
        response = session.get(
            BINANCE_REST,
            params={
                "symbol": "BTCUSDT",
                "interval": interval,
                "startTime": cursor,
                "endTime": end_ms - 1,
                "limit": 1000,
            },
            timeout=15,
        )
        response.raise_for_status()
        rows = response.json()
        if not isinstance(rows, list):
            raise RuntimeError("Binance returned an unexpected kline response")
        if not rows:
            break
        for row in rows:
            ts = int(row[0])
            if start_ms <= ts < end_ms:
                output[ts] = _bar(ts, row[1], row[2], row[3], row[4], row[5])
        last_ts = int(rows[-1][0])
        next_cursor = last_ts + step_ms
        if len(rows) < 1000 or next_cursor <= cursor or next_cursor >= end_ms:
            break
        cursor = next_cursor
    return [output[key] for key in sorted(output)]


def _fetch_okx(interval: str, start_ms: int, end_ms: int,
               session: Any = requests) -> list[dict]:
    if interval not in OKX_INTERVALS:
        raise ValueError(f"Unsupported OKX interval: {interval}")
    bar_code = "1Dutc" if interval == "1d" else ("1H" if interval == "1h" else interval)
    today_start = int(datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    ).timestamp() * 1000)
    # The regular candles endpoint serves the latest window; the history
    # endpoint pages older records. Both are public, unauthenticated endpoints.
    endpoint = OKX_CANDLES if start_ms >= today_start else OKX_HISTORY_CANDLES
    output: dict[int, dict] = {}
    cursor = end_ms
    for _ in range(12):
        response = session.get(
            endpoint,
            params={"instId": "BTC-USDT", "bar": bar_code, "after": str(cursor), "limit": "300"},
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != "0":
            raise RuntimeError(f"OKX error {payload.get('code')}: {payload.get('msg', 'unknown error')}")
        rows = payload.get("data") or []
        if not rows:
            break
        for row in rows:
            ts = int(row[0])
            if start_ms <= ts < end_ms:
                output[ts] = _bar(ts, row[1], row[2], row[3], row[4], row[5])
        oldest = min(int(row[0]) for row in rows)
        if oldest <= start_ms or len(rows) < 300 or oldest >= cursor:
            break
        cursor = oldest
    return [output[key] for key in sorted(output)]


def fetch_crypto_candles(exchange: str, interval: str, date_str: str) -> list[dict]:
    """Load BTC/USDT spot OHLCV for one UTC day from Binance or OKX."""
    selected = exchange.strip().upper()
    start_ms, end_ms = _utc_day_bounds(date_str)
    if selected == "BINANCE":
        return _fetch_binance(interval, start_ms, end_ms)
    if selected == "OKX":
        return _fetch_okx(interval, start_ms, end_ms)
    raise ValueError("exchange must be BINANCE or OKX")
