"""Alert Engine v2.2 — evaluates rules on 30s snapshots.

Core design:
- Evaluated AFTER analytics/Greeks/GEX calculations complete
- Two rules: Rule 1 (strong), Rule 2 (wall alignment)
- ARMED/DISARMED state with FALSE->TRUE transition
- One cooldown per rule (shared across Toast/Sound/Telegram)
- Full market state captured at trigger time
"""
import json
import time
import threading
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any

from alert_models import (
    AlertRuleType, NotificationChannel, AlertState,
    AlertTriggerPayload, AlertRuleConfig, AlertStatus,
)
from alert_db import (
    get_rule_state, set_rule_state, save_alert_history,
    get_today_firing_count, load_settings, save_settings,
    get_all_index_names, get_alert_db,
)
import app_settings


class AlertEngine:
    """Evaluates alert rules against snapshot data."""

    def __init__(self):
        self.lock = threading.Lock()
        self.last_evaluation: Optional[str] = None
        self._initialized = False

    def _ensure_initialized(self):
        """Lazy initialization — safe to call after DB tables exist."""
        if self._initialized:
            return
        try:
            self._ensure_default_settings()
            self._initialized = True
        except Exception as e:
            # DB not ready yet — will retry on next evaluation
            print(f"[AlertEngine] Deferred init (DB not ready): {e}")

    def _ensure_default_settings(self):
        """Seed default settings if none exist."""
        settings = load_settings()
        changed = False
        if not settings.get("rules"):
            settings["rules"] = [
                {
                    "rule_type": AlertRuleType.RULE_1.value,
                    "enabled": True,
                    "cooldown_seconds": 300,
                    "channels": [NotificationChannel.TOAST.value],
                    "sound_enabled": False,
                    "sound_choice": "alert",
                    "custom_sound_id": None,
                    "telegram_enabled": False,
                },
                {
                    "rule_type": AlertRuleType.RULE_2.value,
                    "enabled": True,
                    "cooldown_seconds": 300,
                    "channels": [NotificationChannel.TOAST.value],
                    "sound_enabled": False,
                    "sound_choice": "bell",
                    "custom_sound_id": None,
                    "telegram_enabled": False,
                },
            ]
            changed = True
        if "telegram" not in settings:
            settings["telegram"] = {"enabled": False, "bot_token": "", "chat_id": ""}
            changed = True
        if "sound" not in settings:
            settings["sound"] = {"master_enabled": True, "volume_percent": 80}
            changed = True
        if "custom_sounds" not in settings:
            settings["custom_sounds"] = []
            changed = True
        if changed:
            save_settings(settings)

    def get_settings(self) -> Dict[str, Any]:
        self._ensure_initialized()
        return load_settings()

    def update_settings(self, settings: Dict[str, Any]):
        self._ensure_initialized()
        save_settings(settings)

    def _get_rule_config(self, rule_type: str, settings: Dict) -> Optional[Dict]:
        for rule in settings.get("rules", []):
            if rule.get("rule_type") == rule_type:
                return rule
        return None

    def _calculate_walls(self, options: List[Dict]) -> Dict[str, Any]:
        """Calculate ATM, max CE OI, max PE OI, max negative GEX from options data."""
        if not options:
            return {}

        by_strike: Dict[int, Dict[str, Any]] = {}
        for opt in options:
            s = opt.get("strike", 0)
            if s not in by_strike:
                by_strike[s] = {"CE": {}, "PE": {}}
            ot = opt.get("option_type", "")
            if ot in ("CE", "PE"):
                by_strike[s][ot] = opt

        strikes = sorted(by_strike.keys())
        if not strikes:
            return {}

        max_ce_oi = 0
        max_ce_strike = None
        max_pe_oi = 0
        max_pe_strike = None
        max_neg_gex = 0.0
        max_neg_gex_strike = None

        for strike, data in by_strike.items():
            ce = data.get("CE", {})
            pe = data.get("PE", {})

            ce_oi = ce.get("oi", 0)
            if ce_oi > max_ce_oi:
                max_ce_oi = ce_oi
                max_ce_strike = strike

            pe_oi = pe.get("oi", 0)
            if pe_oi > max_pe_oi:
                max_pe_oi = pe_oi
                max_pe_strike = strike

            ce_gex = ce.get("gex", 0) or 0
            pe_gex = pe.get("gex", 0) or 0
            net_gex = ce_gex + pe_gex
            if net_gex < 0 and abs(net_gex) > max_neg_gex:
                max_neg_gex = abs(net_gex)
                max_neg_gex_strike = strike

        return {
            "strikes": strikes,
            "max_ce_oi_strike": max_ce_strike,
            "max_pe_oi_strike": max_pe_strike,
            "max_negative_gex_strike": max_neg_gex_strike,
            "max_ce_oi": max_ce_oi,
            "max_pe_oi": max_pe_oi,
            "max_negative_gex": max_neg_gex,
        }

    # ── Rule-state routing (live DB vs. isolated in-memory map) ──────
    # Backtests must never read or mutate the live alert_rule_state table.
    # When a caller supplies `state_map`, ALL rule-state reads and writes for
    # that call go to this in-memory dict (keyed by (rule_type, index_name))
    # instead of the DB. The write mirrors alert_db.set_rule_state upsert
    # semantics exactly: every field is overwritten with the value passed.
    @staticmethod
    def _default_rule_state() -> Dict[str, Any]:
        return {"state": "armed", "last_fired_at": None,
                "cooldown_seconds": 300, "condition_cleared_at": None}

    @classmethod
    def _read_rule_state(cls, state_map, rule_type: str, index_name: str) -> Dict[str, Any]:
        if state_map is None:
            return get_rule_state(rule_type, index_name)
        key = (rule_type, index_name)
        if key not in state_map:
            state_map[key] = cls._default_rule_state()
        return dict(state_map[key])

    @staticmethod
    def _write_rule_state(state_map, rule_type: str, index_name: str, state: str,
                          last_fired_at=None, cooldown_seconds=300,
                          condition_cleared_at=None):
        if state_map is None:
            set_rule_state(rule_type, index_name, state,
                           last_fired_at=last_fired_at,
                           cooldown_seconds=cooldown_seconds,
                           condition_cleared_at=condition_cleared_at)
            return
        state_map[(rule_type, index_name)] = {
            "state": state,
            "last_fired_at": last_fired_at,
            "cooldown_seconds": cooldown_seconds,
            "condition_cleared_at": condition_cleared_at,
        }

    def evaluate_rules(
        self,
        snapshot: Dict[str, Any],
        index_name: str = "NIFTY",
        rule_types: Optional[List[AlertRuleType]] = None,
        state_map: Optional[Dict[Any, Dict[str, Any]]] = None,
    ) -> List[AlertTriggerPayload]:
        """Evaluate enabled rules against a snapshot. Return fired alerts.
        rule_types: optional subset (e.g. the Tier-3 scanner evaluates RULE_1
        only, since it confirms walls with the expensive calc on trigger).
        state_map: optional isolated rule-state store used INSTEAD of the live
        alert_rule_state table. Backtests pass a fresh dict per request so they
        can neither read nor mutate live armed/disarmed state, last_fired_at,
        cooldown, or rearm-debounce state. Live callers (snapshot writer,
        Tier-3 scanner) omit it and hit the DB exactly as before."""
        self._ensure_initialized()
        with self.lock:
            self.last_evaluation = datetime.now().isoformat()
            settings = self.get_settings()
            fired: List[AlertTriggerPayload] = []

            options = snapshot.get("options", [])
            spot = snapshot.get("spot")
            net_gex = snapshot.get("net_gex")
            futures_spread = snapshot.get("futures_spread")
            timestamp = snapshot.get("timestamp", datetime.now().isoformat())

            walls = self._calculate_walls(options)
            if not walls:
                return fired

            atm_strike = None
            if spot and walls.get("strikes"):
                atm_strike = min(walls["strikes"], key=lambda s: abs(s - spot))

            for rule_type in [AlertRuleType.RULE_1, AlertRuleType.RULE_2]:
                if rule_types and rule_type not in rule_types:
                    continue
                config = self._get_rule_config(rule_type.value, settings)
                if not config or not config.get("enabled", False):
                    continue

                condition_met = False

                if rule_type == AlertRuleType.RULE_1:
                    cond_a = atm_strike is not None and atm_strike == walls.get("max_negative_gex_strike")
                    cond_b = atm_strike is not None and (
                        atm_strike == walls.get("max_ce_oi_strike") or
                        atm_strike == walls.get("max_pe_oi_strike")
                    )
                    condition_met = cond_a and cond_b
                    rule_name = "ATM + Negative GEX + OI Wall"

                elif rule_type == AlertRuleType.RULE_2:
                    condition_met = atm_strike is not None and (
                        atm_strike == walls.get("max_ce_oi_strike") or
                        atm_strike == walls.get("max_pe_oi_strike")
                    )
                    rule_name = "ATM Maximum CE/PE Wall"

                state_info = self._read_rule_state(state_map, rule_type.value, index_name)
                current_state = state_info.get("state", AlertState.ARMED.value)
                last_fired = state_info.get("last_fired_at")
                cooldown_sec = config.get("cooldown_seconds", 300)

                if current_state == AlertState.ARMED.value and condition_met:
                    cooldown_ok = True
                    if last_fired:
                        last_dt = datetime.fromisoformat(last_fired)
                        if datetime.now() - last_dt < timedelta(seconds=cooldown_sec):
                            cooldown_ok = False

                    if cooldown_ok:
                        channels: List[str] = []
                        if NotificationChannel.TOAST.value in config.get("channels", []):
                            channels.append(NotificationChannel.TOAST.value)
                        if config.get("sound_enabled", False) and settings.get("sound", {}).get("master_enabled", True):
                            channels.append(NotificationChannel.SOUND.value)
                        if config.get("telegram_enabled", False) and settings.get("telegram", {}).get("enabled", False):
                            channels.append(NotificationChannel.TELEGRAM.value)

                        payload = AlertTriggerPayload(
                            timestamp=timestamp,
                            index_name=index_name,
                            rule_type=rule_type,
                            rule_name=rule_name,
                            spot=spot,
                            atm_strike=atm_strike,
                            max_ce_oi_strike=walls.get("max_ce_oi_strike"),
                            max_pe_oi_strike=walls.get("max_pe_oi_strike"),
                            max_negative_gex_strike=walls.get("max_negative_gex_strike"),
                            net_gex=net_gex,
                            futures_spread=futures_spread,
                            channels_fired=[NotificationChannel(c) for c in channels],
                            market_state=snapshot,
                        )
                        fired.append(payload)

                        self._write_rule_state(state_map,
                            rule_type.value, index_name,
                            AlertState.DISARMED.value,
                            last_fired_at=datetime.now().isoformat(),
                            cooldown_seconds=cooldown_sec,
                        )

                        save_alert_history(
                            timestamp=timestamp,
                            index_name=index_name,
                            rule_type=rule_type.value,
                            rule_name=rule_name,
                            spot=spot,
                            atm_strike=atm_strike,
                            max_ce_oi_strike=walls.get("max_ce_oi_strike"),
                            max_pe_oi_strike=walls.get("max_pe_oi_strike"),
                            max_negative_gex_strike=walls.get("max_negative_gex_strike"),
                            net_gex=net_gex,
                            futures_spread=futures_spread,
                            channels_fired=channels,
                            market_state=snapshot,
                        )

                elif current_state == AlertState.DISARMED.value:
                    # Correct rearm semantics:
                    #  - While the condition STILL HOLDS: stay disarmed.
                    #    Never re-fire for the same condition instance.
                    #  - Once the condition clears: wait alert_rearm_seconds
                    #    (user-configurable debounce), then re-arm. A condition
                    #    that flickers back within the debounce does NOT alert.
                    # Cooldown still applies independently to the next firing.
                    rearm_sec = app_settings.get_alert_rearm_seconds()
                    cleared_at = state_info.get("condition_cleared_at")
                    now = datetime.now()

                    if condition_met:
                        if cleared_at is not None:
                            self._write_rule_state(state_map,
                                rule_type.value, index_name,
                                AlertState.DISARMED.value,
                                last_fired_at=last_fired,
                                cooldown_seconds=cooldown_sec,
                                condition_cleared_at=None,
                            )
                    else:
                        if cleared_at is None:
                            self._write_rule_state(state_map,
                                rule_type.value, index_name,
                                AlertState.DISARMED.value,
                                last_fired_at=last_fired,
                                cooldown_seconds=cooldown_sec,
                                condition_cleared_at=now.isoformat(),
                            )
                        else:
                            try:
                                cleared_dt = datetime.fromisoformat(cleared_at)
                                if (now - cleared_dt).total_seconds() >= rearm_sec:
                                    self._write_rule_state(state_map,
                                        rule_type.value, index_name,
                                        AlertState.ARMED.value,
                                        last_fired_at=last_fired,
                                        cooldown_seconds=cooldown_sec,
                                        condition_cleared_at=None,
                                    )
                            except Exception:
                                self._write_rule_state(state_map,
                                    rule_type.value, index_name,
                                    AlertState.DISARMED.value,
                                    last_fired_at=last_fired,
                                    cooldown_seconds=cooldown_sec,
                                    condition_cleared_at=now.isoformat(),
                                )

            return fired

    def get_status(self) -> Dict[str, Any]:
        self._ensure_initialized()
        settings = self.get_settings()
        rules_status = {}
        # Dynamically discover all indices that have state entries
        all_indices = get_all_index_names()
        # Also include any indices from today's history
        with get_alert_db() as conn:
            today = datetime.now().strftime("%Y-%m-%d")
            hist_rows = conn.execute(
                "SELECT DISTINCT index_name FROM alert_history WHERE date(timestamp) = ?",
                (today,)
            ).fetchall()
            for r in hist_rows:
                if r["index_name"] not in all_indices:
                    all_indices.append(r["index_name"])
        # If no indices tracked yet, show rules as global (apply to any symbol)
        if not all_indices:
            all_indices = ["*"]
        for rule in settings.get("rules", []):
            rt = rule.get("rule_type", "")
            for idx in all_indices:
                state = get_rule_state(rt, idx)
                rules_status[f"{rt}_{idx}"] = {
                    "rule_type": rt,
                    "index_name": idx,
                    "state": state.get("state"),
                    "last_fired_at": state.get("last_fired_at"),
                    "cooldown_seconds": state.get("cooldown_seconds"),
                    "enabled": rule.get("enabled", False),
                }
        return {
            "engine_running": True,
            "rules": rules_status,
            "last_evaluation": self.last_evaluation,
            "total_firings_today": get_today_firing_count(),
        }

    def reset_states(self, index_name: Optional[str] = None):
        from alert_db import reset_all_rule_states
        self._ensure_initialized()
        reset_all_rule_states(index_name)


# Global instance — initialization is deferred until first use
alert_engine = AlertEngine()
