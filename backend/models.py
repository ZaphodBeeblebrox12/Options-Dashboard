"""Pydantic models for API request/response."""
from pydantic import BaseModel
from typing import List, Optional, Dict
from datetime import datetime


class OptionData(BaseModel):
    strike: int
    option_type: str
    oi: int
    oi_change: int
    oi_change_pct: Optional[float] = None   # v2.1: percentage change from day baseline
    volume: int
    ltp: float
    iv: Optional[float] = None
    delta: Optional[float] = None
    gamma: Optional[float] = None
    theta: Optional[float] = None
    vega: Optional[float] = None
    gex: Optional[float] = None


class Snapshot(BaseModel):
    id: Optional[int] = None
    timestamp: str
    index_name: str = "NIFTY"
    spot: Optional[float] = None
    futures: Optional[float] = None
    futures_spread: Optional[float] = None
    net_gex: Optional[float] = None
    max_gex_strike: Optional[int] = None
    max_pain: Optional[int] = None
    gamma_flip: Optional[int] = None
    options: List[OptionData] = []


class CurrentState(BaseModel):
    timestamp: str
    index_name: str = "NIFTY"
    spot: Optional[float] = None
    futures: Optional[float] = None
    futures_spread: Optional[float] = None
    net_gex: Optional[float] = None
    max_gex_strike: Optional[int] = None
    max_pain: Optional[int] = None
    gamma_flip: Optional[int] = None
    options: List[OptionData] = []
    is_live: bool = True


class TimestampList(BaseModel):
    date: str
    index_name: str = "NIFTY"
    timestamps: List[str]


class StrikeHistory(BaseModel):
    strike: int
    index_name: str = "NIFTY"
    timeseries: List[Dict]


class GexHistory(BaseModel):
    index_name: str = "NIFTY"
    timeseries: List[Dict]


class GexByStrike(BaseModel):
    strike: int
    ce_gex: float
    pe_gex: float
    net_gex: float


class WebSocketMessage(BaseModel):
    type: str
    data: dict
