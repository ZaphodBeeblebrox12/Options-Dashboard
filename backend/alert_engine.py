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

    def evaluate_rules(
        self,
        snapshot: Dict[str, Any],
        index_name: str = "NIFTY",
    ) -> List[AlertTriggerPayload]:
        """Evaluate all enabled rules against a snapshot. Return fired alerts."""
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

                state_info = get_rule_state(rule_type.value, index_name)
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

                        set_rule_state(
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

                elif current_state == AlertState.DISARMED.value and not condition_met:
                    set_rule_state(
                        rule_type.value, index_name,
                        AlertState.ARMED.value,
                        last_fired_at=last_fired,
                        cooldown_seconds=cooldown_sec,
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
