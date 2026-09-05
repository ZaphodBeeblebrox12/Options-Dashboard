"""Pydantic models for the Alert System v2.2."""
from pydantic import BaseModel, Field
from typing import List, Optional, Dict
from datetime import datetime
from enum import Enum


class AlertRuleType(str, Enum):
    RULE_1 = "atm_negative_gex_oi_wall"      # ATM == Max Neg GEX AND (ATM == Max CE OI OR ATM == Max PE OI)
    RULE_2 = "atm_max_ce_pe_wall"            # ATM == Max CE OI OR ATM == Max PE OI


class NotificationChannel(str, Enum):
    TOAST = "toast"
    SOUND = "sound"
    TELEGRAM = "telegram"


class AlertState(str, Enum):
    ARMED = "armed"
    DISARMED = "disarmed"


class BuiltInSound(str, Enum):
    CHIME = "chime"
    BELL = "bell"
    BEEP = "beep"
    ALERT = "alert"
    DOUBLE_BEEP = "double_beep"


class AlertRuleConfig(BaseModel):
    """Configuration for a single alert rule."""
    rule_type: AlertRuleType
    enabled: bool = True
    cooldown_seconds: int = Field(default=300, ge=30, le=3600)
    channels: List[NotificationChannel] = [NotificationChannel.TOAST]
    sound_enabled: bool = False
    sound_choice: BuiltInSound = BuiltInSound.ALERT
    custom_sound_id: Optional[str] = None  # If set, overrides sound_choice
    telegram_enabled: bool = False


class TelegramConfig(BaseModel):
    """Telegram bot configuration."""
    enabled: bool = False
    bot_token: str = ""
    chat_id: str = ""


class SoundSettings(BaseModel):
    """Global sound settings."""
    master_enabled: bool = True
    volume_percent: int = Field(default=80, ge=0, le=100)


class CustomSound(BaseModel):
    """A user-uploaded custom sound."""
    id: str
    name: str
    filename: str
    content_type: str
    size_bytes: int
    uploaded_at: str


class AlertSettings(BaseModel):
    """Complete alert settings payload."""
    rules: List[AlertRuleConfig]
    telegram: TelegramConfig
    sound: SoundSettings
    custom_sounds: List[CustomSound]


class AlertTriggerPayload(BaseModel):
    """Data captured at the moment an alert fires."""
    timestamp: str
    index_name: str
    rule_type: AlertRuleType
    rule_name: str
    spot: Optional[float]
    atm_strike: Optional[int]
    max_ce_oi_strike: Optional[int]
    max_pe_oi_strike: Optional[int]
    max_negative_gex_strike: Optional[int]
    net_gex: Optional[float]
    futures_spread: Optional[float]
    channels_fired: List[NotificationChannel]
    market_state: Dict  # Full snapshot data for expansion


class AlertHistoryEntry(BaseModel):
    """A recorded alert firing."""
    id: int
    timestamp: str
    index_name: str
    rule_type: str
    rule_name: str
    spot: Optional[float]
    atm_strike: Optional[int]
    max_ce_oi_strike: Optional[int]
    max_pe_oi_strike: Optional[int]
    max_negative_gex_strike: Optional[int]
    net_gex: Optional[float]
    futures_spread: Optional[float]
    channels_fired: str  # JSON array
    market_state: str    # JSON object
    created_at: str


class AlertHistoryResponse(BaseModel):
    entries: List[AlertHistoryEntry]
    total: int
    page: int
    page_size: int


class BacktestRequest(BaseModel):
    """Request to backtest alert rules on historical data."""
    date_str: str
    index_name: str = "NIFTY"
    rule_types: List[AlertRuleType]


class BacktestResult(BaseModel):
    """A single backtest trigger found in history."""
    timestamp: str
    rule_type: str
    rule_name: str
    spot: Optional[float]
    atm_strike: Optional[int]
    max_ce_oi_strike: Optional[int]
    max_pe_oi_strike: Optional[int]
    max_negative_gex_strike: Optional[int]


class BacktestResponse(BaseModel):
    date_str: str
    index_name: str
    total_triggers: int
    triggers: List[BacktestResult]


class AlertStatus(BaseModel):
    """Current status of the alert engine."""
    engine_running: bool
    rules: Dict[str, Dict]
    last_evaluation: Optional[str]
    total_firings_today: int
