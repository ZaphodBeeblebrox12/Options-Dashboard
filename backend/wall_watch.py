"""Persistent, manually armed one-shot Call/Put wall departure watches.

A watch is anchored to the wall strike that was current when the user pressed
ARM. It fires once on the next valid live snapshot where the same side's wall
is no longer at that strike, then auto-disarms. Missing/stale-shaped option
payloads never count as a departure.
"""
import logging
import math
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import app_settings
from alert_db import get_alert_db, save_alert_history
from alert_engine import alert_engine
from alert_models import AlertRuleType, AlertTriggerPayload, NotificationChannel
from telegram_notifier import resolve_telegram_destination

logger = logging.getLogger(__name__)
SIDES = ("CE", "PE")
WALL_WATCH_MAX_OPTION_AGE_SEC = 90


def _number(value, fallback=None):
    try:
        value = float(value)
        return value if math.isfinite(value) else fallback
    except (TypeError, ValueError):
        return fallback


def normalize_wall_options(options: Any) -> List[dict]:
    """Normalize either live-chain shape (array or strike-keyed object)."""
    rows: List[dict] = []

    def add(strike_value, option_type, contract):
        if not isinstance(contract, dict):
            return
        strike = _number(contract.get("strike", strike_value))
        side = str(contract.get("option_type", option_type or "")).upper()
        if strike is None or side not in SIDES:
            return
        oi = _number(contract.get("oi", 0), 0.0)
        rows.append({
            "strike": strike,
            "option_type": side,
            "oi": oi if oi is not None else 0.0,
            "gex": _number(contract.get("gex"), 0.0),
        })

    if isinstance(options, list):
        for option in options:
            if isinstance(option, dict):
                add(option.get("strike"), option.get("option_type"), option)
    elif isinstance(options, dict):
        for strike_key, contracts in options.items():
            if not isinstance(contracts, dict):
                continue
            if str(contracts.get("option_type", "")).upper() in SIDES:
                add(contracts.get("strike", strike_key), contracts.get("option_type"), contracts)
                continue
            for side in SIDES:
                contract = contracts.get(side)
                if isinstance(contract, dict):
                    add(contract.get("strike", strike_key), side, contract)

    # Stable ordering gives a deterministic lower-strike winner when OI ties.
    rows.sort(key=lambda row: (row["strike"], row["option_type"]))
    return rows


def calculate_wall_strikes(options: Any, spot: Optional[float] = None) -> Dict[str, Tuple[Optional[float], bool]]:
    """Return the strongest CE and PE OI concentrations in the loaded expiry chain.

    Spot is accepted for call-site compatibility but intentionally does not
    participate in wall selection. A price crossing above a Call Wall or
    below a Put Wall is not an OI-wall migration and must not trigger a
    departure alert. Only a change in the side's OI distribution can move it.

    The boolean reports whether contracts for that side were present at all.
    Equal-OI ties resolve to the lower strike for deterministic results.
    """
    rows = normalize_wall_options(options)
    results: Dict[str, Tuple[Optional[float], bool]] = {}
    for side in SIDES:
        side_rows = [row for row in rows if row["option_type"] == side]
        if not side_rows:
            results[side] = (None, False)
            continue

        max_oi = max(row["oi"] for row in side_rows)
        winner = min(
            (row for row in side_rows if row["oi"] == max_oi),
            key=lambda row: row["strike"],
        )
        strike = winner["strike"]
        results[side] = (int(strike) if strike.is_integer() else strike, True)
    return results


def _latest_side_tick_age(options: Any, side: str, now: Optional[datetime] = None) -> Optional[float]:
    """Age of the freshest contract tick for one option side in a raw live store."""
    now = now or datetime.now()
    freshest = None
    if not isinstance(options, dict):
        return None
    for contracts in options.values():
        if not isinstance(contracts, dict):
            continue
        contract = contracts.get(side)
        if not isinstance(contract, dict):
            continue
        raw_timestamp = contract.get("last_update")
        if not raw_timestamp:
            continue
        try:
            stamp = datetime.fromisoformat(str(raw_timestamp))
            current = datetime.now(stamp.tzinfo) if stamp.tzinfo else now
            age = (current - stamp).total_seconds()
        except (TypeError, ValueError):
            continue
        # Ignore timestamps materially in the future; tolerate a few seconds
        # of clock skew between the provider callback and this reader.
        if age < -5:
            continue
        age = max(0.0, age)
        if freshest is None or age < freshest:
            freshest = age
    return freshest


def build_live_wall_watch_snapshot(
    streamer: Any,
    symbol: str,
    fallback_market_open,
    now: Optional[datetime] = None,
) -> Optional[dict]:
    """Read only raw OI state for a live manual wall watch.

    Do not call get_current_state(): that performs full Greeks/GEX analytics
    and can be expensive for Tier 2/4. The wall watch only needs current OI,
    source freshness, market-session state and the symbol's spot for context.
    """
    if streamer is None or bool(getattr(streamer, "paused", False)):
        return None

    # InstrumentStreamer instances expose their instrument-specific market
    # session and a window lifecycle state. Tier-1 index streamers use the
    # shared equity-session callback and have no .state/.paused attributes.
    state = getattr(streamer, "state", None)
    if state is not None and state != "WINDOW_ACTIVE":
        return None
    market_open_fn = getattr(streamer, "_market_open", None)
    try:
        market_open = market_open_fn() if callable(market_open_fn) else fallback_market_open()
    except Exception:
        return None
    if not market_open:
        return None

    data_store = getattr(streamer, "data_store", None)
    if data_store is None or not callable(getattr(data_store, "get_data", None)):
        return None
    if not callable(getattr(data_store, "age_sec", None)):
        return None
    try:
        option_age = _number(data_store.age_sec())
        if option_age is None or option_age > WALL_WATCH_MAX_OPTION_AGE_SEC:
            return None
        options = data_store.get_data()
    except Exception:
        return None
    if not isinstance(options, dict) or not options:
        return None

    now = now or datetime.now()
    side_ages = {
        side: _latest_side_tick_age(options, side, now)
        for side in SIDES
    }
    side_freshness = {
        side: age is not None and age <= WALL_WATCH_MAX_OPTION_AGE_SEC
        for side, age in side_ages.items()
    }

    spot_poller = getattr(streamer, "spot_poller", None)
    try:
        spot = spot_poller.get_spot() if spot_poller is not None else None
    except Exception:
        spot = None

    return {
        "index_name": str(symbol).strip().upper(),
        "timestamp": now.isoformat(),
        "spot": spot,
        "options": options,
        "market_open": True,
        "option_age_sec": option_age,
        "tier": getattr(streamer, "tier", 1),
        "_side_freshness": side_freshness,
    }


def _fmt_strike(value: Optional[float]) -> str:
    if value is None:
        return "—"
    number = float(value)
    return f"{int(number):,}" if number.is_integer() else f"{number:,.2f}"


class WallWatchManager:
    def __init__(self):
        self._lock = threading.RLock()

    def get_armed_symbols(self) -> List[str]:
        """Return symbols with at least one manually armed wall watch."""
        with get_alert_db() as conn:
            rows = conn.execute(
                "SELECT DISTINCT symbol FROM wall_watch_state WHERE armed = 1 ORDER BY symbol"
            ).fetchall()
        return [str(row["symbol"]) for row in rows]

    def get_watches(self, symbol: str) -> Dict[str, dict]:
        symbol = symbol.strip().upper()
        with get_alert_db() as conn:
            rows = conn.execute(
                "SELECT * FROM wall_watch_state WHERE symbol = ?", (symbol,)
            ).fetchall()
        by_side = {row["side"]: row for row in rows}
        result = {}
        for side in SIDES:
            row = by_side.get(side)
            result[side] = {
                "symbol": symbol,
                "side": side,
                "armed": bool(row["armed"]) if row else False,
                "watched_strike": row["watched_strike"] if row else None,
                "last_wall_strike": row["last_wall_strike"] if row else None,
                "new_wall_strike": row["new_wall_strike"] if row else None,
                "last_event": row["last_event"] if row else None,
                "last_triggered_at": row["last_triggered_at"] if row else None,
            }
        return result

    def arm(self, symbol: str, side: str, strike: float) -> dict:
        symbol = symbol.strip().upper()
        side = side.strip().upper()
        if side not in SIDES:
            raise ValueError("side must be CE or PE")
        strike = _number(strike)
        if strike is None:
            raise ValueError("strike must be a finite number")
        with self._lock, get_alert_db() as conn:
            conn.execute(
                """INSERT INTO wall_watch_state
                   (symbol, side, armed, watched_strike, last_wall_strike,
                    new_wall_strike, last_event, last_triggered_at, updated_at)
                   VALUES (?, ?, 1, ?, ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)
                   ON CONFLICT(symbol, side) DO UPDATE SET
                     armed=1, watched_strike=excluded.watched_strike,
                     last_wall_strike=excluded.last_wall_strike,
                     new_wall_strike=NULL, last_event=NULL,
                     last_triggered_at=NULL, updated_at=CURRENT_TIMESTAMP""",
                (symbol, side, strike, strike),
            )
            conn.commit()
        return self.get_watches(symbol)[side]

    def disarm(self, symbol: str, side: str) -> dict:
        symbol = symbol.strip().upper()
        side = side.strip().upper()
        if side not in SIDES:
            raise ValueError("side must be CE or PE")
        with self._lock, get_alert_db() as conn:
            conn.execute(
                """INSERT INTO wall_watch_state (symbol, side, armed)
                   VALUES (?, ?, 0)
                   ON CONFLICT(symbol, side) DO UPDATE SET
                     armed=0, updated_at=CURRENT_TIMESTAMP""",
                (symbol, side),
            )
            conn.commit()
        return self.get_watches(symbol)[side]

    def evaluate_snapshot(self, snapshot: dict, index_name: str) -> List[AlertTriggerPayload]:
        if not isinstance(snapshot, dict) or not snapshot.get("options"):
            return []
        option_age = _number(snapshot.get("option_age_sec"))
        if option_age is not None and option_age > WALL_WATCH_MAX_OPTION_AGE_SEC:
            return []
        # A click on the row's bell is an explicit, symbol/side-specific
        # opt-in. It must not be silently disabled by the unrelated global
        # automatic-alert switch or by the automatic WALL_VACATED rule toggle.
        # The rule's channel preferences still control delivery below.
        settings = alert_engine.get_settings()
        config = next(
            (rule for rule in settings.get("rules", [])
             if rule.get("rule_type") == AlertRuleType.WALL_VACATED.value),
            {},
        ) or {}

        spot = _number(snapshot.get("spot"))
        walls = calculate_wall_strikes(snapshot.get("options"), spot)
        rows = normalize_wall_options(snapshot.get("options"))
        if not rows:
            return []
        symbol = index_name.strip().upper()
        timestamp = snapshot.get("timestamp") or datetime.now().isoformat()
        fired: List[AlertTriggerPayload] = []

        with self._lock, get_alert_db() as conn:
            watches = conn.execute(
                "SELECT * FROM wall_watch_state WHERE symbol = ? AND armed = 1",
                (symbol,),
            ).fetchall()
            for watch in watches:
                side = watch["side"]
                watched_strike = _number(watch["watched_strike"])
                current_wall, side_present = walls.get(side, (None, False))
                side_freshness = snapshot.get("_side_freshness")
                if isinstance(side_freshness, dict) and not side_freshness.get(side, False):
                    continue
                if not side_present or watched_strike is None:
                    continue
                if current_wall is not None and abs(float(current_wall) - watched_strike) < 1e-6:
                    continue

                event = "vacated" if current_wall is None else "moved"
                side_label = "Call" if side == "CE" else "Put"
                if current_wall is None:
                    rule_name = f"{side_label} Wall vacated {_fmt_strike(watched_strike)}"
                else:
                    rule_name = (
                        f"{side_label} Wall moved from {_fmt_strike(watched_strike)} "
                        f"to {_fmt_strike(current_wall)}"
                    )
                triggered_at = datetime.now().isoformat()
                conn.execute(
                    """UPDATE wall_watch_state
                       SET armed=0, last_wall_strike=?, new_wall_strike=?,
                           last_event=?, last_triggered_at=?, updated_at=CURRENT_TIMESTAMP
                       WHERE symbol=? AND side=? AND armed=1""",
                    (current_wall, current_wall, event, triggered_at, symbol, side),
                )
                # Commit the watch transition before opening the independent
                # alert-history writer connection, avoiding SQLite writer-lock
                # contention between these two durable state changes.
                conn.commit()

                tier = snapshot.get("tier")
                if not isinstance(tier, int):
                    try:
                        tier = app_settings.get_instrument_tier(symbol)
                    except Exception:
                        tier = 1 if symbol in ("NIFTY", "SENSEX") else None
                telegram_destination = resolve_telegram_destination(settings, tier)
                telegram_ready = bool(
                    telegram_destination.get("enabled")
                    and telegram_destination.get("bot_token")
                    and telegram_destination.get("chat_id")
                )
                channels = []
                rule_channels = config.get("channels") or ["toast"]
                if NotificationChannel.TOAST.value in rule_channels:
                    channels.append(NotificationChannel.TOAST)
                if (NotificationChannel.SOUND.value in rule_channels
                        and config.get("sound_enabled", False)
                        and settings.get("sound", {}).get("master_enabled", True)):
                    channels.append(NotificationChannel.SOUND)
                if (NotificationChannel.TELEGRAM.value in rule_channels
                        and config.get("telegram_enabled", False)
                        and telegram_ready):
                    channels.append(NotificationChannel.TELEGRAM)

                strikes = sorted({row["strike"] for row in rows})
                atm = min(strikes, key=lambda strike: abs(strike - spot)) if spot is not None and strikes else None
                all_walls = {s: w for s, (w, present) in walls.items() if present}
                market_state = {
                    key: value for key, value in snapshot.items()
                    if key != "_side_freshness"
                }
                market_state["wall_watch"] = {
                    "symbol": symbol,
                    "side": side,
                    "watched_strike": watched_strike,
                    "previous_wall_strike": watched_strike,
                    "new_wall_strike": current_wall,
                    "event": event,
                }
                alert = AlertTriggerPayload(
                    timestamp=str(timestamp),
                    index_name=symbol,
                    rule_type=AlertRuleType.WALL_VACATED,
                    rule_name=rule_name,
                    instrument_tier=tier,
                    spot=spot,
                    atm_strike=int(atm) if atm is not None else None,
                    max_ce_oi_strike=int(all_walls["CE"]) if all_walls.get("CE") is not None else None,
                    max_pe_oi_strike=int(all_walls["PE"]) if all_walls.get("PE") is not None else None,
                    max_negative_gex_strike=snapshot.get("max_negative_gex_strike"),
                    net_gex=_number(snapshot.get("net_gex")),
                    futures_spread=_number(snapshot.get("futures_spread")),
                    channels_fired=channels,
                    market_state=market_state,
                    wall_side=side,
                    watched_strike=watched_strike,
                    new_wall_strike=current_wall,
                    wall_event=event,
                )
                fired.append(alert)
                try:
                    save_alert_history(
                        timestamp=str(timestamp),
                        index_name=symbol,
                        rule_type=AlertRuleType.WALL_VACATED.value,
                        rule_name=rule_name,
                        instrument_tier=tier,
                        spot=spot,
                        atm_strike=int(atm) if atm is not None else None,
                        max_ce_oi_strike=int(all_walls["CE"]) if all_walls.get("CE") is not None else None,
                        max_pe_oi_strike=int(all_walls["PE"]) if all_walls.get("PE") is not None else None,
                        max_negative_gex_strike=snapshot.get("max_negative_gex_strike"),
                        net_gex=_number(snapshot.get("net_gex")),
                        futures_spread=_number(snapshot.get("futures_spread")),
                        channels_fired=[channel.value for channel in channels],
                        market_state=market_state,
                    )
                except Exception as exc:
                    logger.error("[WallWatch] Failed to save wall alert history: %s", exc)
            conn.commit()
        return fired


wall_watch_manager = WallWatchManager()
