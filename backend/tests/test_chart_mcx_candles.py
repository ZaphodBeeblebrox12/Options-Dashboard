"""MCX and NSE session-bound chart candle regression tests."""
import asyncio
from datetime import datetime as RealDateTime

import candle_builder as candle_module
import main
import scrip_master


class FakeDateTime:
    current = RealDateTime(2026, 11, 27, 20, 0, 0)

    @classmethod
    def now(cls):
        return cls.current


def test_commodity_session_uses_symbol_specific_mcx_hours(monkeypatch):
    monkeypatch.setattr(candle_module, "datetime", FakeDateTime)
    monkeypatch.setattr(scrip_master, "mcx_hours", lambda symbol: ((9, 0), (23, 30)))
    builder = candle_module.CandleBuilder(db_path=":memory:")

    assert builder._session_open("CRUDEOIL", kind="COMMODITY") is True

    FakeDateTime.current = RealDateTime(2026, 11, 27, 23, 45, 0)
    assert builder._session_open("CRUDEOIL", kind="COMMODITY") is False

    FakeDateTime.current = RealDateTime(2026, 11, 28, 12, 0, 0)
    assert builder._session_open("CRUDEOIL", kind="COMMODITY") is False


def test_on_tick_passes_instrument_kind_to_session_gate(monkeypatch):
    builder = candle_module.CandleBuilder(db_path=":memory:")
    seen = {}

    def open_session(symbol, kind=None):
        seen["symbol"] = symbol
        seen["kind"] = kind
        return False

    monkeypatch.setattr(builder, "_session_open", open_session)
    builder.on_tick("GOLD", {"last_traded_price": 7000000}, kind="COMMODITY")

    assert seen == {"symbol": "GOLD", "kind": "COMMODITY"}
    assert builder._queue.empty()


def test_scanner_1m_and_intraday_buckets_use_mcx_session_open(monkeypatch):
    rows = [
        {"symbol": "CRUDEOIL", "ts_minute": "2026-11-26 08:59:00",
         "open": 6000, "high": 6000, "low": 6000, "close": 6000, "volume": None, "tick_count": 1},
        {"symbol": "CRUDEOIL", "ts_minute": "2026-11-26 09:00:00",
         "open": 6001, "high": 6002, "low": 6001, "close": 6002, "volume": None, "tick_count": 2},
        {"symbol": "CRUDEOIL", "ts_minute": "2026-11-26 09:01:00",
         "open": 6002, "high": 6003, "low": 6002, "close": 6003, "volume": None, "tick_count": 2},
        {"symbol": "CRUDEOIL", "ts_minute": "2026-11-26 13:00:00",
         "open": 6010, "high": 6011, "low": 6010, "close": 6011, "volume": None, "tick_count": 2},
    ]
    captured = {}

    def fake_load(symbol, **kwargs):
        captured["symbol"] = symbol
        captured.update(kwargs)
        return rows

    monkeypatch.setattr(main.candle_builder, "load_1m", fake_load)
    monkeypatch.setattr(main.app_settings, "get_instrument_kind", lambda symbol: "COMMODITY")
    monkeypatch.setattr(scrip_master, "mcx_hours", lambda symbol: ((9, 0), (23, 30)))

    one_minute = asyncio.run(main.scanner_candles(
        symbol="CRUDEOIL", tf="1m", date="2026-11-26"
    ))
    hourly = asyncio.run(main.scanner_candles(
        symbol="CRUDEOIL", tf="1H", date="2026-11-26"
    ))

    assert one_minute["kind"] == "COMMODITY"
    assert one_minute["source"] == "mcx_front_month_futures"
    assert one_minute["session_open"] == "09:00"
    assert [candle["ts_minute"] for candle in one_minute["candles"]] == [
        "2026-11-26 09:00:00", "2026-11-26 09:01:00",
        "2026-11-26 13:00:00",
    ]
    assert len(hourly["candles"]) == 2
    assert hourly["candles"][0]["ts_minute"] == "2026-11-26 09:00:00"
    assert hourly["candles"][1]["ts_minute"] == "2026-11-26 13:00:00"
