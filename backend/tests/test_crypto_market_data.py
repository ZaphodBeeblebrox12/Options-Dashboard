"""Tests for public BTC/USDT spot candle adapters."""
from datetime import datetime, timezone

import crypto_market_data as crypto


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class FakeSession:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def get(self, url, *, params, timeout):
        self.calls.append((url, params, timeout))
        return FakeResponse(self.payload)


def test_utc_day_bounds_are_a_full_utc_calendar_day():
    start, end = crypto._utc_day_bounds("2020-11-26")
    expected = int(datetime(2020, 11, 26, tzinfo=timezone.utc).timestamp() * 1000)
    assert start == expected
    assert end - start == 86_400_000


def test_binance_adapter_maps_spot_kline_and_uses_time_bounds():
    session = FakeSession([
        [1606348800000, "90000", "91000", "89500", "90500", "12.5",
         1606348859999, "1125000", 200, "6", "540000", "0"]
    ])
    start, end = crypto._utc_day_bounds("2020-11-26")

    bars = crypto._fetch_binance("1m", start, end, session=session)

    assert bars == [{
        "time": 1606348800000,
        "open": 90000.0,
        "high": 91000.0,
        "low": 89500.0,
        "close": 90500.0,
        "volume": 12.5,
    }]
    assert session.calls[0][1]["symbol"] == "BTCUSDT"
    assert session.calls[0][1]["startTime"] == start
    assert session.calls[0][1]["endTime"] == end - 1


def test_okx_adapter_maps_history_candles_and_keeps_utc_timestamp():
    ts = int(datetime(2020, 11, 26, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
    session = FakeSession({
        "code": "0",
        "msg": "",
        "data": [[str(ts), "90000", "91000", "89500", "90500", "12.5",
                  "1125000", "1125000", "1"]],
    })
    start, end = crypto._utc_day_bounds("2020-11-26")

    bars = crypto._fetch_okx("1m", start, end, session=session)

    assert bars[0]["time"] == ts
    assert bars[0]["volume"] == 12.5
    assert session.calls[0][0] == crypto.OKX_HISTORY_CANDLES
    assert session.calls[0][1]["instId"] == "BTC-USDT"
    assert session.calls[0][1]["bar"] == "1m"
    assert session.calls[0][1]["limit"] == "100"


def test_exchange_and_interval_inputs_are_validated():
    try:
        crypto.fetch_crypto_candles("SOMEWHERE", "5m", "2020-11-26")
    except ValueError as exc:
        assert "BINANCE or OKX" in str(exc)
    else:
        raise AssertionError("unsupported exchange should be rejected")

    start, end = crypto._utc_day_bounds("2020-11-26")
    try:
        crypto._fetch_binance("2m", start, end, session=FakeSession([]))
    except ValueError as exc:
        assert "Unsupported Binance interval" in str(exc)
    else:
        raise AssertionError("unsupported interval should be rejected")
