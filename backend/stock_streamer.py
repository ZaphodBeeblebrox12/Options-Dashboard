"""Tier-2/Tier-1 instrument streamer — Index / Stock / Commodity.

Generalization of the original stock streamer. One class, three underlying kinds,
driven by scrip_master.KIND_EXCHANGES (no per-instrument special cases):

  INDEX     spot = index token (NSE)          futures = nearest FUTIDX   options = OPTIDX/NFO
  STOCK     spot = equity token (NSE)         futures = none             options = OPTSTK/NFO
  COMMODITY spot = nearest FUTCOM (MCX)       futures = same tick        options = OPTFUT/MCX (exch_type 5)

Bootstrap stays cash/underlying-first (your original design): subscribe the
underlying -> first tick -> ATM = nearest listed strike -> subscribe the
±window option group -> delta-follow the underlying intraday.

Tier: every added instrument defaults to Tier 2; promote via set_tier(1) which
re-registers all groups with Tier-1 priority (sacred, may spill across slots,
and gets the 5s broadcast cadence).
"""
import os
import time
import threading
import logging
from datetime import datetime, time as dt_time
from typing import Dict, List, Optional, Set

from subscription_manager import Tier, TokenRequirement, TokenGroup, SubscriptionManager
from streamer_integration import LiveDataStore, SpotPricePoller
import app_settings

logger = logging.getLogger(__name__)

RETRY_SEC = int(os.getenv("WS_TIER2_RETRY_SEC", "60"))

# Tier 3 scanner: narrow window, cheap eval cadence, two-stage confirmation
SCANNER_HALF_WIDTH = int(os.getenv("WS_TIER3_WINDOW_SIZE", "8"))
SCANNER_INTERVAL = int(os.getenv("WS_TIER3_SCAN_SEC", "30"))
SCANNER_RECHECK_SEC = int(os.getenv("WS_TIER3_RECHECK_SEC", "60"))
# Stage 2: temporarily widen to the FULL chain to confirm the wall chain-wide
SCANNER_CONFIRM_SEC = int(os.getenv("WS_TIER3_CONFIRM_SEC", "45"))
SCANNER_MIN_COVERAGE = float(os.getenv("WS_TIER3_MIN_COVERAGE", "0.6"))
SCANNER_FALSE_BACKOFF_SEC = int(os.getenv("WS_TIER3_FALSE_BACKOFF_SEC", "300"))


def _scanner_half_width() -> int:
    """Runtime-adjustable Tier-3 scanner window (Settings > Analytics).

    Falls back to the WS_TIER3_WINDOW_SIZE env default when the setting
    is absent (e.g. settings row predates this key)."""
    try:
        return app_settings.get_tier3_window_half_width()
    except Exception:
        return SCANNER_HALF_WIDTH

EQUITY_HOURS = ((9, 15), (15, 30))
# MCX sessions are per-commodity (agri/intl-agri/non-agri) and DST-aware —
# resolved per symbol via scrip_master.mcx_hours().


def option_type(symbol: str) -> str:
    """CE/PE from an Angel One option symbol by SUFFIX.
    A substring check breaks for underlyings whose name contains 'CE'
    (e.g. RELIA-NCE) — every PE would be misclassified as CE."""
    s = symbol.strip().upper()
    return "PE" if s.endswith("PE") else "CE"


def _half_width() -> int:
    try:
        return app_settings.get_window_half_width()
    except Exception:
        return 20


def _market_open(hours) -> bool:
    now = datetime.now()
    if now.weekday() > 4:
        return False
    (h1, m1), (h2, m2) = hours
    return dt_time(h1, m1, 0) <= now.time() <= dt_time(h2, m2, 0)


class InstrumentStreamer:
    """Real-time data consumer for one instrument of any kind."""

    def __init__(self, symbol: str, manager: SubscriptionManager,
                 kind: str = "STOCK", tier: int = 2):
        self.symbol = symbol.strip().upper()
        if not self.symbol:
            raise ValueError("Empty symbol")
        self.kind = kind.strip().upper() if kind else "STOCK"
        if self.kind not in ("INDEX", "STOCK", "COMMODITY"):
            raise ValueError(f"Unknown kind '{kind}' for {self.symbol}")
        tier = int(tier)
        self.tier = tier if tier in (1, 2, 3) else 3
        self.manager = manager
        self.data_store = LiveDataStore()
        self.spot_poller = SpotPricePoller()

        if self.kind == "COMMODITY":
            from scrip_master import mcx_hours
            self.market_hours = mcx_hours(self.symbol)
        else:
            self.market_hours = EQUITY_HOURS
        self._deriv_exch_type = 5 if self.kind == "COMMODITY" else 2

        self.contract_multiplier = 1
        self.expiry_str: Optional[str] = None
        self.expiry_datetime: Optional[datetime] = None
        self.strikes: List[int] = []
        self.option_meta: Dict[str, dict] = {}

        self.state = "IDLE"
        self.paused = False
        self.atm_index: Optional[int] = None

        self.spot_group_id = f"{self.symbol}_SPOT"
        self.futures_group_id = f"{self.symbol}_FUTURES"
        self.window_group_id = f"{self.symbol}_OPTION_WINDOW"
        self._spot_token: Optional[str] = None
        self._futures_token: Optional[str] = None

        self.lock = threading.RLock()
        self._state_cache = None
        self._state_cache_time = 0.0
        self._analytics_cache = None
        self._analytics_cache_key = None
        self._analytics_cache_time = 0.0

        # Tier 3 scanner state
        self._scanner_thread: Optional[threading.Thread] = None
        self._scanner_stop: Optional[threading.Event] = None
        self._last_trigger: Optional[datetime] = None
        self._last_trigger_atm: Optional[int] = None
        self._wall_cleared_at: Optional[datetime] = None
        # Stage-2 full-chain confirmation
        self._confirming = False
        self._confirm_thread: Optional[threading.Thread] = None
        self._confirm_stop: Optional[threading.Event] = None
        self._confirm_atm: Optional[int] = None
        self._confirm_started_at: float = 0.0
        self._false_trigger_atm: Dict[int, datetime] = {}
        self._epoch = 0                # bumped on pause/resume/tier/remove — invalidates in-flight confirmations
        self._confirm_epoch = 0
        self.on_alerts_fired = None   # set by the adapter -> dispatch (toast/sound/telegram)
        self.on_tier_changed = None   # set by the adapter -> start/stop snapshot timer

    def _tier_enum(self) -> Tier:
        return {1: Tier.TIER_1, 2: Tier.TIER_2}.get(self.tier, Tier.TIER_3)

    # ─────────────────────────────────────────────────────────
    # Phase 1 — underlying (spot) token; futures for indices
    # ─────────────────────────────────────────────────────────
    def _register_underlying(self) -> bool:
        reqs = [TokenRequirement(
            token=self._spot_token, exchange_type=self._spot_exch_type,
            instrument_name=self.symbol, tier=self._tier_enum(),
            group_id=self.spot_group_id, mode=1, metadata={"type": "underlying"},
        )]
        ok = self.manager.register_group(TokenGroup(
            group_id=self.spot_group_id, tier=self._tier_enum(),
            instrument_name=self.symbol, tokens=set(reqs),
        ))
        self.manager.bind_handler(self._spot_token, self._on_underlying_tick)
        return ok

    def _register_futures(self) -> bool:
        if not self._futures_token:
            return True
        req = TokenRequirement(
            token=self._futures_token, exchange_type=self._deriv_exch_type,
            instrument_name=self.symbol, tier=self._tier_enum(),
            group_id=self.futures_group_id, mode=1, metadata={"type": "futures"},
        )
        ok = self.manager.register_group(TokenGroup(
            group_id=self.futures_group_id, tier=self._tier_enum(),
            instrument_name=self.symbol, tokens={req},
        ))
        self.manager.bind_handler(self._futures_token, self._on_futures_tick)
        return ok

    def start(self):
        from scrip_master import scrip_master
        meta = scrip_master.get_spot_meta(self.symbol, self.kind)
        if not meta or not meta.get("token"):
            self.state = "ERROR"
            raise ValueError(f"[{self.symbol}] No underlying token for kind={self.kind} "
                             f"(index/equity/futures record missing in scrip master)")
        self._spot_token = meta["token"]
        self._spot_exch_type = meta["exchange_type"]

        if self.kind == "INDEX":
            fut = scrip_master.get_futures_meta(self.symbol, self.kind)
            if fut:
                self._futures_token = fut["token"]

        ok = self._register_underlying()
        if self.kind == "INDEX":
            ok = self._register_futures() and ok
        self.state = "CASH_SUBSCRIBED" if ok else "CASH_PENDING"
        src = "futures (MCX)" if meta.get("via_futures") else "spot"
        logger.info(f"[{self.symbol}] Underlying ({self.kind}, via {src}) token {self._spot_token} "
                    f"registered ({self.state}, tier {self.tier}) — waiting for price to build window")

        try:
            self._load_option_metadata()
        except Exception as e:
            logger.warning(f"[{self.symbol}] Option metadata preload failed: {e}")

        if self.tier == 3:
            self._start_scanner_loop()
            logger.info(f"[{self.symbol}] Tier 3 scanner active (±{_scanner_half_width()} window, "
                        f"{SCANNER_INTERVAL}s eval, trigger = ATM at CE/PE wall + max negative GEX)")

    # ─────────────────────────────────────────────────────────
    # Phase 2/3/4 — first underlying tick bootstraps the option window
    # ─────────────────────────────────────────────────────────
    def _on_underlying_tick(self, message: dict):
        try:
            ltp = float(message.get("last_traded_price", 0) or 0) / 100.0
            if ltp <= 0:
                return
            if self.kind == "COMMODITY":
                # no cash exists — the futures price IS the underlying for Greeks
                self.spot_poller.update_from_ws(ltp)
                self.spot_poller.update_futures_from_ws(ltp)
            else:
                self.spot_poller.update_from_ws(ltp)

            with self.lock:
                need_bootstrap = (self.option_meta
                                  and self.state != "WINDOW_ACTIVE"
                                  and not self.paused)
            if need_bootstrap:
                self._bootstrap_options()
            else:
                self._maybe_move_window()
        except Exception as e:
            logger.error(f"[{self.symbol}] Underlying tick error: {e}")

    def _on_futures_tick(self, message: dict):
        try:
            ltp = float(message.get("last_traded_price", 0) or 0) / 100.0
            if ltp > 0:
                self.spot_poller.update_futures_from_ws(ltp)
        except Exception as e:
            logger.error(f"[{self.symbol}] Futures tick error: {e}")

    def _load_option_metadata(self) -> bool:
        if self.strikes:
            return True
        from scrip_master import scrip_master
        self.contract_multiplier = scrip_master.get_deriv_lot_size(self.symbol, self.kind)

        expiry = scrip_master.get_current_expiry(self.symbol, self.kind)
        if not expiry:
            self.state = "WINDOW_UNAVAILABLE"
            logger.warning(f"[{self.symbol}] No option expiries for kind={self.kind}")
            return False
        self.expiry_str = expiry
        exp_dt = datetime.strptime(expiry, "%d%b%Y")
        self.expiry_datetime = exp_dt.replace(hour=self.market_hours[1][0], minute=self.market_hours[1][1])

        df = scrip_master.get_deriv_options(self.symbol, self.kind, expiry)
        if df is None or len(df) == 0:
            self.state = "WINDOW_UNAVAILABLE"
            logger.warning(f"[{self.symbol}] No option contracts for {expiry}")
            return False

        self.strikes = sorted({int(s) for s in df["strike"].tolist()})
        self.option_meta = {
            str(r["token"]): {"strike": int(r["strike"]),
                              "type": option_type(str(r["symbol"]))}
            for _, r in df.iterrows()
        }
        for tok in self.option_meta:
            self.manager.bind_handler(tok, self._on_option_tick)

        logger.info(f"[{self.symbol}] Option metadata loaded ({self.kind}): expiry {self.expiry_str}, "
                    f"lot {self.contract_multiplier}, {len(self.strikes)} strikes")
        return True

    def _bootstrap_options(self):
        try:
            spot = self.spot_poller.get_spot()
            if spot is None:
                return
            if not self.strikes and not self._load_option_metadata():
                return

            self.atm_index = min(range(len(self.strikes)),
                                 key=lambda i: abs(self.strikes[i] - spot))
            window = self._build_window_tokens(self.atm_index)

            ok = self.manager.register_group(TokenGroup(
                group_id=self.window_group_id, tier=self._tier_enum(),
                instrument_name=self.symbol, tokens=window,
            ))
            self.state = "WINDOW_ACTIVE" if ok else "WINDOW_PENDING"
            logger.info(
                f"[{self.symbol}] Window {'ACTIVE' if ok else 'PENDING (capacity)'}: "
                f"ATM {self.strikes[self.atm_index]:,} | {len(self.strikes)} strikes | "
                f"window {len(window)} tokens | expiry {self.expiry_str} | lot {self.contract_multiplier}"
            )
        except Exception as e:
            logger.error(f"[{self.symbol}] Bootstrap failed: {e}")
            self.state = "ERROR"

    def _build_window_tokens(self, center_idx: int) -> Set[TokenRequirement]:
        hw = _scanner_half_width() if self.tier == 3 else _half_width()
        lo = max(0, center_idx - hw)
        hi = min(len(self.strikes), center_idx + hw + 1)
        selected = set(self.strikes[lo:hi])
        return {
            TokenRequirement(token=tok, exchange_type=self._deriv_exch_type,
                             instrument_name=self.symbol, tier=self._tier_enum(),
                             group_id=self.window_group_id, mode=3, metadata=meta)
            for tok, meta in self.option_meta.items() if meta["strike"] in selected
        }

    # ─────────────────────────────────────────────────────────
    # Phase 5 — underlying moved -> delta update
    # ─────────────────────────────────────────────────────────
    def _maybe_move_window(self):
        spot = self.spot_poller.get_spot()
        if spot is None or not self.strikes:
            return
        new_idx = min(range(len(self.strikes)), key=lambda i: abs(self.strikes[i] - spot))
        if new_idx == self.atm_index:
            return
        new_tokens = self._build_window_tokens(new_idx)
        result = self.manager.update_group_tokens(self.window_group_id, new_tokens)
        old_atm = self.strikes[self.atm_index] if self.atm_index is not None else None
        self.atm_index = new_idx
        self._analytics_cache = None
        logger.info(f"[{self.symbol}] ATM {old_atm} -> {self.strikes[new_idx]} | "
                    f"+{result['subbed']} -{result['unsubbed']}"
                    + (f" ({result['unplaced']} unplaced — capacity)" if result["unplaced"] else ""))

    # ─────────────────────────────────────────────────────────
    # Tier promotion (Settings)
    # ─────────────────────────────────────────────────────────
    def set_tier(self, tier: int) -> dict:
        tier = int(tier)
        if tier not in (1, 2, 3):
            tier = 3
        with self.lock:
            if self.tier == tier:
                return {"ok": True, "unchanged": True, "tier": tier}
            self.tier = tier
            self._epoch += 1                      # invalidate any in-flight confirmation
            if self._confirm_stop:
                self._confirm_stop.set()
        logger.info(f"[{self.symbol}] Tier changed -> {tier} — re-registering groups")
        if not self.paused:
            self._unregister_groups()
            ok = self._register_underlying()
            if self.kind == "INDEX":
                ok = self._register_futures() and ok
            self.state = "CASH_SUBSCRIBED" if ok else "CASH_PENDING"
            if self.strikes and self.atm_index is not None:
                window = self._build_window_tokens(self.atm_index)
                wok = self.manager.register_group(TokenGroup(
                    group_id=self.window_group_id, tier=self._tier_enum(),
                    instrument_name=self.symbol, tokens=window,
                ))
                self.state = "WINDOW_ACTIVE" if wok else "WINDOW_PENDING"
            self._analytics_cache = None
            self._state_cache = None
        self._stop_scanner_loop()
        if self.tier == 3 and not self.paused:
            self._start_scanner_loop()
        if self.on_tier_changed:
            try:
                self.on_tier_changed(self)
            except Exception as e:
                logger.error(f"[{self.symbol}] on_tier_changed hook: {e}")
        return {"ok": True, "tier": tier, "state": self.state}

    def _unregister_groups(self):
        for gid in (self.spot_group_id, self.futures_group_id, self.window_group_id):
            try:
                self.manager.unregister_group(gid)
            except Exception as e:
                logger.debug(f"[{self.symbol}] Unregister {gid}: {e}")

    # ─────────────────────────────────────────────────────────
    # Pause / resume / rebuild / status
    # ─────────────────────────────────────────────────────────
    def pause(self):
        with self.lock:
            if self.paused:
                return
            self.paused = True
            self._stop_scanner_loop()
            self._epoch += 1
            if self._confirm_stop:
                self._confirm_stop.set()
            self._unregister_groups()
            self.state = "PAUSED"
            self._analytics_cache = None
            self._state_cache = None
            logger.info(f"[{self.symbol}] Paused — all tokens freed, config kept")

    def resume(self):
        with self.lock:
            if not self.paused:
                return
            self.paused = False
            self._epoch += 1
            self.atm_index = None
            self._analytics_cache = None
            self._state_cache = None
        try:
            ok = self._register_underlying()
            if self.kind == "INDEX":
                ok = self._register_futures() and ok
            self.state = "CASH_SUBSCRIBED" if ok else "CASH_PENDING"
            if self.tier == 3:
                self._start_scanner_loop()
            logger.info(f"[{self.symbol}] Resumed ({self.state}) — rebuilding window")
        except Exception as e:
            logger.error(f"[{self.symbol}] Resume failed: {e}")
            self.state = "ERROR"

    def rebuild_window(self) -> dict:
        with self.lock:
            if self.state not in ("WINDOW_ACTIVE", "WINDOW_PENDING") or not self.strikes:
                return {"rebuilt": False, "reason": self.state}
        spot = self.spot_poller.get_spot()
        if spot is None:
            return {"rebuilt": False, "reason": "no spot"}
        new_idx = min(range(len(self.strikes)), key=lambda i: abs(self.strikes[i] - spot))
        new_tokens = self._build_window_tokens(new_idx)
        result = self.manager.update_group_tokens(self.window_group_id, new_tokens)
        self.atm_index = new_idx
        self._analytics_cache = None
        logger.info(f"[{self.symbol}] Window rebuilt (±{_half_width()}): +{result['subbed']} -{result['unsubbed']}")
        return {"rebuilt": True, **result}

    # ─────────────────────────────────────────────────────────
    # Tier 3 scanner — lightweight wall/ATM tracking, expensive
    # analytics ONLY when the trigger condition warrants it.
    # ─────────────────────────────────────────────────────────
    def _start_scanner_loop(self):
        if self._scanner_thread and self._scanner_thread.is_alive():
            return
        self._scanner_stop = threading.Event()
        self._scanner_thread = threading.Thread(
            target=self._scanner_loop, daemon=True, name=f"scanner-{self.symbol}")
        self._scanner_thread.start()

    def _stop_scanner_loop(self):
        if self._scanner_stop:
            self._scanner_stop.set()
        if self._scanner_thread:
            self._scanner_thread.join(timeout=5)
        self._scanner_thread = None
        self._scanner_stop = None

    def _scanner_loop(self):
        while self._scanner_stop and not self._scanner_stop.is_set():
            try:
                self._scanner_eval()
            except Exception as e:
                logger.error(f"[{self.symbol}] scanner eval error: {e}")
            self._scanner_stop.wait(SCANNER_INTERVAL)

    def _cheap_walls(self, data) -> Dict[str, Optional[int]]:
        """CE/PE max-OI wall strikes — pure argmax, no Greeks. Microseconds."""
        ce_wall = pe_wall = None
        ce_oi = pe_oi = -1
        for strike, d in data.items():
            ce = d.get("CE") or {}
            pe = d.get("PE") or {}
            if ce.get("oi", 0) > ce_oi:
                ce_oi, ce_wall = ce["oi"], strike
            if pe.get("oi", 0) > pe_oi:
                pe_oi, pe_wall = pe["oi"], strike
        return {"ce_wall": ce_wall, "pe_wall": pe_wall,
                "ce_wall_oi": ce_oi if ce_oi > 0 else 0,
                "pe_wall_oi": pe_oi if pe_oi > 0 else 0}

    def _scanner_eval(self):
        """Cheap 30s eval: track ATM vs walls; run expensive analytics only on
        an ARMED rule when ATM reaches a wall. While DISARMED, no expensive
        work at all — rearm debounce mirrors the alert-engine semantics."""
        if self.paused or not self._market_open():
            return
        if self._confirming:
            return  # stage-2 full-chain confirmation in progress
        spot = self.spot_poller.get_spot()
        if spot is None or not self.strikes:
            return
        data = self.data_store.get_data()
        if not data:
            return

        walls = self._cheap_walls(data)
        atm = min(self.strikes, key=lambda s: abs(s - spot))
        at_wall = atm in (walls["ce_wall"], walls["pe_wall"])
        self._last_walls = {**walls, "atm": atm, "at_wall": at_wall}

        from alert_db import get_rule_state, set_rule_state
        from alert_models import AlertRuleType
        st = get_rule_state(AlertRuleType.RULE_1.value, self.symbol)
        now = datetime.now()

        if at_wall and st.get("state") == "armed":
            if (self._last_trigger and self._last_trigger_atm == atm
                    and (now - self._last_trigger).total_seconds() < SCANNER_RECHECK_SEC):
                return
            # false-trigger backoff: a strike that failed full-chain confirmation
            # recently doesn't get re-confirmed for a while (no subscription churn)
            blocked = self._false_trigger_atm.get(atm)
            if blocked and (now - blocked).total_seconds() < SCANNER_FALSE_BACKOFF_SEC:
                return
            self._start_confirmation(atm)
        elif not at_wall and st.get("state") == "disarmed":
            # Condition cleared — debounce with the same rearm setting, then re-arm.
            if self._wall_cleared_at is None:
                self._wall_cleared_at = now
            elif (now - self._wall_cleared_at).total_seconds() >= app_settings.get_alert_rearm_seconds():
                set_rule_state(
                    AlertRuleType.RULE_1.value, self.symbol, "armed",
                    last_fired_at=st.get("last_fired_at"),
                    cooldown_seconds=st.get("cooldown_seconds") or 300,
                )
                logger.info(f"[{self.symbol}] scanner re-armed after clear + rearm debounce")
                self._wall_cleared_at = None
        else:
            self._wall_cleared_at = None

    # ─────────────────────────────────────────────────────────
    # Stage 2 — full-chain confirmation (transient widen, no permanent
    # extra subscription; same expiry/instrument as the scanner)
    # ─────────────────────────────────────────────────────────
    def _build_full_chain_tokens(self) -> Set[TokenRequirement]:
        """Full option chain for the SAME expiry the scanner already uses —
        option_meta was loaded from the scrip master for the whole chain."""
        return {
            TokenRequirement(token=tok, exchange_type=self._deriv_exch_type,
                             instrument_name=self.symbol, tier=self._tier_enum(),
                             group_id=self.window_group_id, mode=3, metadata=meta)
            for tok, meta in self.option_meta.items()
        }

    def _start_confirmation(self, atm: int):
        if not self.option_meta:
            return
        self._confirming = True
        self._confirm_atm = atm
        self._confirm_epoch = self._epoch
        self._confirm_started_at = time.time()
        self._confirm_stop = threading.Event()
        # Widen the EXISTING window group to the full chain (delta subscribe).
        # If capacity is short, the manager subscribes what fits and the
        # coverage check below fails gracefully.
        result = self.manager.update_group_tokens(
            self.window_group_id, self._build_full_chain_tokens())
        logger.info(f"[{self.symbol}] STAGE-1 trigger at {atm:,} — widening to full chain "
                    f"for confirmation (+{result['subbed']} tokens)")
        self._confirm_thread = threading.Thread(
            target=self._confirmation_watch, daemon=True, name=f"confirm-{self.symbol}")
        self._confirm_thread.start()

    def _fresh_contracts(self) -> Dict[tuple, int]:
        """Contracts that ticked since stage-2 began -> OI. Stale pre-widening
        data is excluded so walls are computed from fresh chain-wide ticks only."""
        data = self.data_store.get_data()
        fresh: Dict[tuple, int] = {}
        for strike, d in data.items():
            for ot in ("CE", "PE"):
                opt = d.get(ot) or {}
                lu = opt.get("last_update")
                if not lu:
                    continue
                try:
                    ts = datetime.fromisoformat(lu).timestamp()
                except Exception:
                    continue
                if ts >= self._confirm_started_at:
                    fresh[(strike, ot)] = opt.get("oi", 0)
        return fresh

    def _confirmation_watch(self):
        deadline = self._confirm_started_at + SCANNER_CONFIRM_SEC
        try:
            while time.time() < deadline:
                if self._confirm_stop.is_set():
                    break  # -> _finish_confirmation handles epoch + revert
                fresh = self._fresh_contracts()
                if len(fresh) >= len(self.option_meta):
                    break  # full coverage
                (self._confirm_stop or threading.Event()).wait(5)
            self._finish_confirmation()
        finally:
            # Belt-and-braces: _confirming can NEVER survive this thread, even
            # if a future edit reintroduces an early exit above.
            self._confirming = False

    def _finish_confirmation(self):
        atm = self._confirm_atm
        epoch = self._confirm_epoch
        try:
            if epoch != self._epoch:
                logger.info(f"[{self.symbol}] confirmation superseded by "
                            f"pause/tier/remove — no fire, no re-subscribe")
                return
            fresh = self._fresh_contracts()
            coverage = len(fresh) / max(1, len(self.option_meta))
            if coverage < SCANNER_MIN_COVERAGE:
                logger.info(f"[{self.symbol}] stage-2 ABORT at {atm:,}: fresh coverage "
                            f"{coverage:.0%} < {SCANNER_MIN_COVERAGE:.0%} (capacity/data)")
                self._false_trigger_atm[atm] = datetime.now()
                return

            # Full-chain walls from FRESH data only — the stage-1 strike must be
            # the chain-wide max-OI wall, not merely the local window max.
            ce_wall = pe_wall = None
            ce_oi = pe_oi = -1
            for (strike, ot), oi in fresh.items():
                if ot == "CE" and oi > ce_oi:
                    ce_oi, ce_wall = oi, strike
                if ot == "PE" and oi > pe_oi:
                    pe_oi, pe_wall = oi, strike

            if atm in (ce_wall, pe_wall):
                logger.info(f"[{self.symbol}] STAGE-2 CONFIRMED: {atm:,} is a chain-wide "
                            f"max-OI wall (CE wall {ce_wall}, PE wall {pe_wall}) — running GEX")
                # Analytics over the fresh chain only — no stale strikes
                fresh_data = {}
                data = self.data_store.get_data()
                for (strike, ot), _ in fresh.items():
                    src_opt = data.get(strike, {}).get(ot) or {}
                    fresh_data.setdefault(strike, {"CE": {}, "PE": {}})[ot] = dict(src_opt)
                self._run_triggered_analytics(atm, data=fresh_data)
            else:
                logger.info(f"[{self.symbol}] stage-2 NOT confirmed at {atm:,}: "
                            f"chain walls are CE {ce_wall} / PE {pe_wall}")
                self._false_trigger_atm[atm] = datetime.now()
        finally:
            if epoch == self._epoch:
                self._revert_to_window()
            self._confirming = False
            self._last_trigger = datetime.now()
            self._last_trigger_atm = atm

    def _revert_to_window(self):
        """Always release the transient full-chain tokens back to the narrow
        scanner window so the token budget returns to steady state. Never
        skips: falls back to the last-known ATM anchor (then the confirm ATM)
        if the underlying tick is unavailable."""
        if not self.strikes:
            return
        spot = self.spot_poller.get_spot()
        idx = self.atm_index
        if idx is None:
            if spot is not None:
                idx = min(range(len(self.strikes)), key=lambda i: abs(self.strikes[i] - spot))
            elif self._confirm_atm in self.strikes:
                idx = self.strikes.index(self._confirm_atm)
            else:
                idx = len(self.strikes) // 2
        self.atm_index = idx
        window = self._build_window_tokens(idx)
        result = self.manager.update_group_tokens(self.window_group_id, window)
        logger.info(f"[{self.symbol}] reverted to scanner window "
                    f"(+{result['subbed']} -{result['unsubbed']} tokens)")

    def _run_triggered_analytics(self, atm: int, data: Optional[Dict] = None):
        """The expensive path — runs ONLY on a confirmed trigger. Uses the SAME
        calculate_analytics and alert engine as Tier 1/2, so walls/GEX and
        alert semantics are identical (no second implementation). `data` may
        carry the fresh full-chain subset from stage-2 confirmation."""
        from calculations import calculate_analytics
        from alert_engine import alert_engine
        from alert_models import AlertRuleType

        spot = self.spot_poller.get_spot()
        if data is None:
            data = self.data_store.get_data()
        analytics = calculate_analytics(
            data, spot, self.spot_poller.get_futures(),
            self.expiry_datetime, self.contract_multiplier,
            instrument=self.symbol,
        )
        enriched = []
        for strike in sorted(data.keys()):
            for opt_type in ["CE", "PE"]:
                opt = data[strike].get(opt_type, {})
                a_opt = analytics["strikes_data"].get(strike, {}).get(opt_type, {})
                current_oi = opt.get("oi", 0)
                oi_change, oi_change_pct = self.data_store.compute_oi_change(strike, opt_type, current_oi)
                enriched.append({
                    "strike": strike, "option_type": opt_type,
                    "oi": current_oi, "oi_change": oi_change, "oi_change_pct": oi_change_pct,
                    "volume": opt.get("volume", 0), "ltp": opt.get("ltp", 0),
                    "iv": a_opt.get("iv"), "delta": a_opt.get("delta"),
                    "gamma": a_opt.get("gamma"), "theta": a_opt.get("theta"),
                    "vega": a_opt.get("vega"), "gex": a_opt.get("gex"),
                })
        snapshot = {
            "timestamp": datetime.now().isoformat(),
            "index_name": self.symbol,
            "spot": spot,
            "futures": self.spot_poller.get_futures(),
            "futures_spread": analytics.get("futures_spread"),
            "net_gex": analytics.get("net_gex"),
            "options": enriched,
        }
        fired = alert_engine.evaluate_rules(
            snapshot, self.symbol, rule_types=[AlertRuleType.RULE_1])
        if fired:
            logger.info(f"[{self.symbol}] SCANNER TRIGGER at wall {atm:,} — "
                        f"{len(fired)} alert(s) fired")
            if self.on_alerts_fired:
                try:
                    self.on_alerts_fired(fired)
                except Exception as e:
                    logger.error(f"[{self.symbol}] alert dispatch hook: {e}")

    def tokens_active(self) -> int:
        if self.state == "PAUSED" or self.manager is None:
            return 0
        n = 0
        if self._spot_token and self.manager.is_token_active(self._spot_token, self._spot_exch_type, 1):
            n += 1
        if self._futures_token and self.manager.is_token_active(self._futures_token, self._deriv_exch_type, 1):
            n += 1
        with self.manager.lock:
            g = self.manager.groups.get(self.window_group_id)
            if g:
                n += sum(1 for t in g.tokens if t.key() in self.manager.token_map)
        return n

    def status(self) -> dict:
        out = {
            "symbol": self.symbol,
            "kind": self.kind,
            "tier": self.tier,
            "state": self.state,
            "paused": self.paused,
            "spot": self.spot_poller.get_spot(),
            "futures": self.spot_poller.get_futures(),
            "atm": self.strikes[self.atm_index] if (self.atm_index is not None and self.strikes) else None,
            "expiry": self.expiry_str,
            "lot": self.contract_multiplier,
            "tokens": self.tokens_active(),
            "msg_count": self.data_store.msg_count,
        }
        if self.tier == 3:
            walls = getattr(self, "_last_walls", None)
            if walls is None:
                data = self.data_store.get_data()
                if data:
                    walls = self._cheap_walls(data)
                    spot = self.spot_poller.get_spot()
                    if spot is not None and self.strikes:
                        walls["atm"] = min(self.strikes, key=lambda s: abs(s - spot))
                        walls["at_wall"] = walls["atm"] in (walls["ce_wall"], walls["pe_wall"])
            if walls:
                out.update({
                    "ce_wall": walls.get("ce_wall"),
                    "pe_wall": walls.get("pe_wall"),
                    "at_wall": walls.get("at_wall"),
                })
            out["confirming"] = self._confirming
        return out

    def retry_pending(self):
        if self.paused:
            return
        if self.state == "WINDOW_PENDING":
            logger.info(f"[{self.symbol}] Retrying window registration...")
            self._bootstrap_options()
        elif self.state == "CASH_PENDING":
            logger.info(f"[{self.symbol}] Retrying underlying registration...")
            try:
                ok = self._register_underlying()
                if self.kind == "INDEX":
                    ok = self._register_futures() and ok
                self.state = "CASH_SUBSCRIBED" if ok else "CASH_PENDING"
            except Exception as e:
                logger.error(f"[{self.symbol}] Underlying retry failed: {e}")

    # ─────────────────────────────────────────────────────────
    # Ticks
    # ─────────────────────────────────────────────────────────
    def _on_option_tick(self, message: dict):
        try:
            meta = self.option_meta.get(str(message.get("token", "")))
            if not meta:
                return
            ltp = float(message.get("last_traded_price", 0) or 0) / 100.0
            oi = int(message.get("open_interest", 0) or 0)
            vol = int(message.get("volume_trade_for_the_day", 0) or 0)
            self.data_store.update(meta["strike"], meta["type"], ltp, oi, vol)
        except Exception as e:
            logger.error(f"[{self.symbol}] Option tick error: {e}")

    @property
    def ws_connected(self) -> bool:
        return self.manager.any_open

    def _market_open(self) -> bool:
        return _market_open(self.market_hours)

    # ─────────────────────────────────────────────────────────
    # State payload — same shape as the index streamer (frontend unchanged)
    # ─────────────────────────────────────────────────────────
    def _scanner_state_payload(self, data, spot):
        """Tier 3 broadcast payload: raw OI/LTP (already in the store) with NO
        Greeks/GEX — the expensive analytics run only at wall triggers."""
        walls = self._cheap_walls(data) if data else {}
        atm = None
        if spot is not None and self.strikes:
            atm = min(self.strikes, key=lambda s: abs(s - spot))
        enriched = []
        for strike in sorted(data.keys()):
            for opt_type in ["CE", "PE"]:
                opt = data[strike].get(opt_type, {})
                current_oi = opt.get("oi", 0)
                oi_change, oi_change_pct = self.data_store.compute_oi_change(strike, opt_type, current_oi)
                enriched.append({
                    "strike": strike, "option_type": opt_type,
                    "oi": current_oi, "oi_change": oi_change, "oi_change_pct": oi_change_pct,
                    "volume": opt.get("volume", 0), "ltp": opt.get("ltp", 0),
                    "iv": None, "delta": None, "gamma": None,
                    "theta": None, "vega": None, "gex": None,
                })
        return {"type": "tick", "data": {
            "index_name": self.symbol,
            "spot": spot,
            "futures": None if self.kind == "COMMODITY" else self.spot_poller.get_futures(),
            "futures_spread": None,
            "timestamp": datetime.now().isoformat(),
            "options": enriched,
            "net_gex": None, "max_gex_strike": None, "max_pain": None, "gamma_flip": None,
            "market_open": self._market_open(),
            "contract_multiplier": self.contract_multiplier,
            "expiry": self.expiry_str,
            "instrument_kind": self.kind.lower(),
            "tier": 3,
            "window_state": self.state,
            "scanner": True,
            "ce_wall": walls.get("ce_wall"),
            "pe_wall": walls.get("pe_wall"),
            "atm": atm,
            "at_wall": (atm in (walls.get("ce_wall"), walls.get("pe_wall"))) if atm is not None else None,
            "window_note": f"Scanner — analytics only at wall trigger (±{_scanner_half_width()})",
        }}

    def get_current_state(self):
        now = time.time()
        if self._state_cache is not None and now - self._state_cache_time < 1.0:
            return {**self._state_cache,
                    "data": {**self._state_cache["data"], "timestamp": datetime.now().isoformat()}}

        data = self.data_store.get_data()
        spot = self.spot_poller.get_spot()

        if self.tier == 3:
            return self._scanner_state_payload(data, spot)

        if self.paused:
            return {"type": "tick", "data": {
                "index_name": self.symbol, "spot": spot, "futures": self.spot_poller.get_futures(),
                "timestamp": datetime.now().isoformat(), "options": [],
                "market_open": self._market_open(), "window_state": self.state,
                "message": "Streaming paused — resume from Settings"}}

        if not data or spot is None:
            return {"type": "tick", "data": {
                "index_name": self.symbol, "spot": spot, "futures": self.spot_poller.get_futures(),
                "timestamp": datetime.now().isoformat(), "options": [],
                "market_open": self._market_open(), "window_state": self.state,
                "message": (f"Building option window for {self.symbol}..."
                            if self.state in ("CASH_SUBSCRIBED", "WINDOW_PENDING") and self._market_open()
                            else None)}}

        cache_key = (self.data_store.msg_count, round(spot, 2))
        analytics = None
        if (self._analytics_cache is not None
                and self._analytics_cache_key == cache_key
                and now - self._analytics_cache_time < 30.0):
            analytics = self._analytics_cache
        else:
            from calculations import calculate_analytics
            try:
                analytics = calculate_analytics(
                    data, spot, self.spot_poller.get_futures(),
                    self.expiry_datetime, self.contract_multiplier,
                    instrument=self.symbol
                )
                self._analytics_cache = analytics
                self._analytics_cache_key = cache_key
                self._analytics_cache_time = now
            except Exception as e:
                logger.error(f"[{self.symbol}] Analytics error: {e}")
                return {"type": "tick", "data": {
                    "index_name": self.symbol, "spot": spot, "futures": self.spot_poller.get_futures(),
                    "timestamp": datetime.now().isoformat(), "options": [],
                    "market_open": self._market_open(), "error": str(e)}}

        _age = self.spot_poller.spot_age_sec()
        if (_age is not None and _age > 90 and self._market_open()
                and now - getattr(self, "_last_stale_warn", 0) > 60):
            self._last_stale_warn = now
            logger.warning(f"[{self.symbol}] underlying tick is {_age}s old — "
                           f"GEX/ATM computed from a stale spot ({spot})")

        try:
            enriched = []
            for strike in sorted(data.keys()):
                for opt_type in ["CE", "PE"]:
                    opt = data[strike].get(opt_type, {})
                    a_opt = analytics["strikes_data"].get(strike, {}).get(opt_type, {})
                    current_oi = opt.get("oi", 0)
                    oi_change, oi_change_pct = self.data_store.compute_oi_change(strike, opt_type, current_oi)
                    enriched.append({
                        "strike": strike, "option_type": opt_type,
                        "oi": current_oi, "oi_change": oi_change, "oi_change_pct": oi_change_pct,
                        "volume": opt.get("volume", 0), "ltp": opt.get("ltp", 0),
                        "iv": a_opt.get("iv"), "delta": a_opt.get("delta"),
                        "gamma": a_opt.get("gamma"), "theta": a_opt.get("theta"),
                        "vega": a_opt.get("vega"), "gex": a_opt.get("gex"),
                    })

            diff, pct, label = self.spot_poller.get_premium_discount() or (None, None, None)
            # Commodities have no cash market: the front-month futures price IS the
            # underlying used for Greeks. Show it as SPOT and blank the FUTURES card
            # instead of displaying the same number twice.
            is_commodity = self.kind == "COMMODITY"
            result = {"type": "tick", "data": {
                "index_name": self.symbol,
                "spot": spot,
                "futures": None if is_commodity else self.spot_poller.get_futures(),
                "futures_spread": None if is_commodity else analytics.get("futures_spread"),
                "futures_spread_pct": None if is_commodity else (round(pct, 3) if pct else None),
                "spread_label": None if is_commodity else label,
                "timestamp": datetime.now().isoformat(),
                "options": enriched,
                "net_gex": analytics.get("net_gex"),
                "max_gex_strike": analytics.get("max_gex_strike"),
                "max_pain": analytics.get("max_pain"),
                "gamma_flip": analytics.get("gamma_flip"),
                "market_open": self._market_open(),
                "contract_multiplier": self.contract_multiplier,
                "expiry": self.expiry_str,
                "instrument_kind": self.kind.lower(),
                "tier": self.tier,
                "window_state": self.state,
                "spot_age_sec": _age,
                "window_note": f"ATM±{_half_width()} strikes (window view)",
            }}
            self._state_cache = result
            self._state_cache_time = now
            return result
        except Exception as e:
            logger.error(f"[{self.symbol}] Enrichment error: {e}")
            return {"type": "tick", "data": {
                "index_name": self.symbol, "spot": spot, "futures": self.spot_poller.get_futures(),
                "timestamp": datetime.now().isoformat(), "options": [],
                "market_open": self._market_open(), "error": str(e)}}

    def stop(self):
        self._stop_scanner_loop()
        self._epoch += 1
        if self._confirm_stop:
            self._confirm_stop.set()
        logger.info(f"[{self.symbol}] Stopping streamer...")


# Backward-compatible alias — the original class name keeps working everywhere.
StockStreamer = InstrumentStreamer


class Tier2Supervisor:
    """Retries capacity-deferred windows every RETRY_SEC (all instruments)."""

    def __init__(self, streamers: Dict[str, InstrumentStreamer]):
        self.streamers = streamers
        self.running = False
        self.thread: Optional[threading.Thread] = None

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True, name="tier2-supervisor")
        self.thread.start()

    def _loop(self):
        while self.running:
            time.sleep(RETRY_SEC)
            try:
                for s in self.streamers.values():
                    if not s.paused and s.state in ("WINDOW_PENDING", "CASH_PENDING"):
                        s.retry_pending()
            except Exception as e:
                logger.error(f"[Tier2Supervisor] Error: {e}")

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=5)
