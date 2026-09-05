"""Real-time Angel One SmartAPI v2 integration — multi-index + Tier-2 stocks.

v3.0 changes:
- Removed SharedWebSocketManager. All WebSocket ownership moved to
  SubscriptionManager (subscription_manager.py): capacity-aware slots,
  990 token cap per connection, max 3 connections, tier-first allocation.
- NIFTY/SENSEX register as Tier-1 atomic groups; stocks are Tier-2 with
  cash-first bootstrap and dynamic ATM windows (stock_streamer.py).
- Public interface UNCHANGED: streamer_adapter, STREAMING_INDICES,
  ANGEL_ONE_AVAILABLE, get_streamer(), get_current_state(), LiveDataStore,
  SpotPricePoller, is_market_open().
"""
import os
import copy
import threading
import time
import logging
from datetime import datetime, time as dt_time
from typing import Dict, Optional, List, Any
from dataclasses import dataclass
from enum import Enum

from subscription_manager import Tier, TokenRequirement, TokenGroup, SubscriptionManager
import app_settings
from app_settings import init_settings as init_app_settings, get_stocks as settings_get_stocks

logger = logging.getLogger(__name__)

# ── Instrument configuration ─────────────────────────────────
TIER1_INDICES = ["NIFTY", "SENSEX"]

def _parse_tier2_env() -> List[str]:
    """Parse TIER2_STOCKS from env. Called at import time AND again at
    StreamerAdapter.start(), so the value is correct whether or not .env
    was loaded before this module was imported (main.py ordering fix)."""
    return [s.strip().upper() for s in os.getenv("TIER2_STOCKS", "").split(",") if s.strip()]

TIER2_STOCKS = _parse_tier2_env()
STREAMING_INDICES = TIER1_INDICES + TIER2_STOCKS

# ── Angel One libs ───────────────────────────────────────────
ANGEL_ONE_AVAILABLE = False
try:
    from SmartApi import SmartConnect
    import pyotp
    ANGEL_ONE_AVAILABLE = True
    logger.info("[Streamer] smartapi-python detected ✓")
except ImportError as e:
    logger.warning(f"[Streamer] smartapi-python NOT installed: {e}")


def is_market_open() -> bool:
    now = datetime.now()
    if now.weekday() > 4:
        return False
    current_time = now.time()
    return dt_time(9, 15, 0) <= current_time <= dt_time(15, 30, 0)


# =====================================================================
#  AUTH MANAGER
# =====================================================================
if ANGEL_ONE_AVAILABLE:
    class AuthManager:
        def __init__(self):
            self.api_key = os.getenv("API_KEY", "").strip()
            self.client_code = os.getenv("CLIENT_CODE", "").strip()
            self.password = os.getenv("PASSWORD", "").strip()
            self.totp_secret = os.getenv("TOTP_SECRET", "").strip()

            missing = [k for k, v in {
                "API_KEY": self.api_key,
                "CLIENT_CODE": self.client_code,
                "PASSWORD": self.password,
                "TOTP_SECRET": self.totp_secret,
            }.items() if not v]

            if missing:
                msg = f"Missing Angel One credentials: {', '.join(missing)}. Set them in backend/.env"
                raise ValueError(msg)

            self.smart_api = SmartConnect(self.api_key)
            self.jwt_token = None
            self.feed_token = None
            self.last_login = 0
            self.token_expiry = 55 * 60
            self.lock = threading.RLock()

        def login(self):
            with self.lock:
                try:
                    logger.info("[Auth] Logging in to Angel One...")
                    totp = pyotp.TOTP(self.totp_secret).now()
                    login_data = self.smart_api.generateSession(
                        clientCode=self.client_code,
                        password=self.password,
                        totp=totp
                    )
                    if not login_data.get("status"):
                        err = login_data.get("message", "Unknown error")
                        logger.error(f"[Auth] Login failed: {err}")
                        return False
                    self.jwt_token = login_data["data"]["jwtToken"]
                    self.feed_token = login_data["data"].get("feedToken", self.smart_api.getfeedToken())
                    self.last_login = time.time()
                    logger.info("[Auth] Login successful")
                    return True
                except Exception as e:
                    logger.error(f"[Auth] Login error: {e}")
                    return False

        def get_valid_jwt(self):
            with self.lock:
                if time.time() - self.last_login > self.token_expiry:
                    logger.warning("[Auth] Token expired, refreshing...")
                    if not self.login():
                        raise ConnectionError("Token refresh failed")
                return self.jwt_token

        def get_valid_feed_token(self):
            self.get_valid_jwt()
            with self.lock:
                return self.feed_token


# =====================================================================
#  LIVE DATA STORE  (unchanged — tick-level prev_oi + daily baseline)
# =====================================================================
class LiveDataStore:
    def __init__(self):
        self.data = {}
        self.prev_oi = {}
        self.daily_oi_baseline = {}
        self.baseline_loaded_from_db = False
        self.msg_count = 0
        self.last_update = None
        self.lock = threading.Lock()

    def update(self, strike, option_type, ltp, oi, volume):
        with self.lock:
            self.msg_count += 1
            self.last_update = datetime.now().isoformat()
            if strike not in self.data:
                self.data[strike] = {"CE": {}, "PE": {}}
            old_oi = self.data[strike].get(option_type, {}).get("oi", 0)
            if old_oi > 0:
                if strike not in self.prev_oi:
                    self.prev_oi[strike] = {}
                self.prev_oi[strike][option_type] = old_oi
            self.data[strike][option_type] = {
                "ltp": ltp,
                "oi": oi,
                "volume": volume,
                "last_update": datetime.now().isoformat()
            }
            key = (strike, option_type)
            if key not in self.daily_oi_baseline:
                self.daily_oi_baseline[key] = oi

    def get_snapshot(self):
        with self.lock:
            return copy.deepcopy(self.data), copy.deepcopy(self.prev_oi)

    def get_data(self):
        with self.lock:
            return copy.deepcopy(self.data)

    def get_stats(self):
        with self.lock:
            strikes = len(self.data)
            ce_count = sum(1 for s in self.data if "CE" in self.data[s] and self.data[s]["CE"])
            pe_count = sum(1 for s in self.data if "PE" in self.data[s] and self.data[s]["PE"])
            return self.msg_count, strikes, ce_count, pe_count

    def get_daily_baseline(self, strike, option_type):
        with self.lock:
            return self.daily_oi_baseline.get((strike, option_type), None)

    def set_daily_baseline(self, strike, option_type, oi):
        with self.lock:
            self.daily_oi_baseline[(strike, option_type)] = oi

    def load_baselines_from_dict(self, baselines):
        with self.lock:
            self.daily_oi_baseline.update(baselines)
            self.baseline_loaded_from_db = True

    def compute_oi_change(self, strike, option_type, current_oi):
        with self.lock:
            baseline = self.daily_oi_baseline.get((strike, option_type))
            if baseline is None:
                self.daily_oi_baseline[(strike, option_type)] = current_oi
                baseline = current_oi
            oi_change = current_oi - baseline
            oi_change_pct = round((oi_change / baseline) * 100, 2) if baseline > 0 else 0.0
            return oi_change, oi_change_pct


class SpotPricePoller:
    def __init__(self):
        self.spot_price = None
        self.spot_source = None
        self.futures_price = None
        self.futures_source = None
        self.last_ws_update = 0
        self.last_futures_ws_update = 0
        self.spot_lock = threading.Lock()

    def get_spot(self):
        with self.spot_lock:
            return self.spot_price

    def get_futures(self):
        with self.spot_lock:
            return self.futures_price

    def get_premium_discount(self):
        with self.spot_lock:
            if self.futures_price is None or self.spot_price is None or self.spot_price == 0:
                return None, None, None
            diff = self.futures_price - self.spot_price
            pct = (diff / self.spot_price) * 100
            return diff, pct, "PREMIUM" if diff >= 0 else "DISCOUNT"

    def update_from_ws(self, ltp):
        with self.spot_lock:
            self.spot_price = ltp
            self.spot_source = "WS"
            self.last_ws_update = time.time()

    def spot_age_sec(self):
        """Seconds since the last underlying tick (None if never)."""
        with self.spot_lock:
            if not self.last_ws_update:
                return None
            return round(time.time() - self.last_ws_update)

    def update_futures_from_ws(self, ltp):
        with self.spot_lock:
            self.futures_price = ltp
            self.futures_source = "WS"
            self.last_futures_ws_update = time.time()


# =====================================================================
#  INDEX STREAMER (Tier 1) — data consumer, no WebSocket ownership
# =====================================================================
if ANGEL_ONE_AVAILABLE:
    class AngelOneIndexStreamer:
        def __init__(self, index_name: str, auth_manager):
            self.index_name = index_name
            self.auth_manager = auth_manager
            self.data_store = LiveDataStore()
            self.spot_poller = SpotPricePoller()

            self.token_map = {}
            self.index_info = None
            self.futures_info = None
            self.options_df = None
            self.contract_multiplier = 50
            self.expiry_datetime = None
            self.expiry_str = None

            self._state_cache = None
            self._state_cache_time = 0
            self._analytics_cache = None
            self._analytics_cache_key = None
            self._analytics_cache_time = 0

            self._manager: Optional[SubscriptionManager] = None

            self._load_instruments()
            self._load_baselines_from_db()
            self._load_yesterday_baselines()

        @property
        def ws_connected(self) -> bool:
            return self._manager.any_open if self._manager else False

        def _load_instruments(self):
            from scrip_master import scrip_master
            try:
                scrip_master.load()
                self.contract_multiplier = scrip_master.get_lot_size(self.index_name)
                logger.info(f"[{self.index_name}] Lot size: {self.contract_multiplier}")

                expiry_str = scrip_master.get_nearest_weekly_expiry(self.index_name)
                if expiry_str:
                    self.expiry_datetime = datetime.strptime(expiry_str, "%d%b%Y").replace(hour=15, minute=30)
                    self.expiry_str = expiry_str.upper()
                    logger.info(f"[{self.index_name}] Expiry: {self.expiry_str}")
                else:
                    from datetime import timedelta
                    self.expiry_datetime = datetime.now() + timedelta(days=7)
                    self.expiry_datetime = self.expiry_datetime.replace(hour=15, minute=30)
                    self.expiry_str = self.expiry_datetime.strftime("%d%b%Y").upper()
                    logger.warning(f"[{self.index_name}] Fallback expiry: {self.expiry_str}")

                self.index_info = scrip_master.get_index_info(self.index_name)
                self.futures_info = scrip_master.get_futures_info(self.index_name)

                self.options_df = scrip_master.get_index_options(self.index_name, expiry_str)
                if self.options_df is not None and len(self.options_df) > 0:
                    self._build_token_map()
                    logger.info(f"[{self.index_name}] Loaded {len(self.options_df)} option contracts")
                else:
                    logger.warning(f"[{self.index_name}] No options found for expiry {expiry_str}")
            except Exception as e:
                logger.error(f"[{self.index_name}] Instrument load failed: {e}")
                raise

        def _load_baselines_from_db(self):
            try:
                from database import get_db_connection, load_all_baselines_for_date
                today_str = datetime.now().strftime("%Y-%m-%d")
                conn = get_db_connection()
                baselines = load_all_baselines_for_date(conn, today_str, self.index_name)
                conn.close()
                if baselines:
                    self.data_store.load_baselines_from_dict(baselines)
                    logger.info(f"[{self.index_name}] Loaded {len(baselines)} OI baselines from DB")
            except Exception as e:
                logger.warning(f"[{self.index_name}] Could not load baselines from DB: {e}")

        def _load_yesterday_baselines(self):
            try:
                from database import get_db_connection
                conn = get_db_connection()
                cursor = conn.execute("""
                    SELECT o.strike, o.option_type, o.oi
                    FROM option_snapshots o
                    JOIN snapshots s ON o.snapshot_id = s.id
                    WHERE s.index_name = ?
                      AND date(s.timestamp) < date('now')
                    ORDER BY s.timestamp DESC
                """, (self.index_name,))

                loaded = 0
                seen = set()
                for row in cursor.fetchall():
                    key = (row["strike"], row["option_type"])
                    if key in seen:
                        continue
                    seen.add(key)
                    self.data_store.set_daily_baseline(row["strike"], row["option_type"], row["oi"])
                    loaded += 1

                conn.close()
                if loaded:
                    logger.info(f"[{self.index_name}] Seeded {loaded} baselines from yesterday's closing OI")
            except Exception as e:
                logger.warning(f"[{self.index_name}] Could not load yesterday baselines: {e}")

        def _build_token_map(self):
            from stock_streamer import option_type
            self.token_map = {}
            for _, row in self.options_df.iterrows():
                self.token_map[str(row["token"])] = {
                    "strike": int(row["strike"]),
                    "type": option_type(str(row["symbol"])),
                }

        def register_with_manager(self, manager: SubscriptionManager):
            """Register all tokens as a Tier-1 atomic group. No WS ownership here."""
            self._manager = manager
            group_tokens: List[TokenRequirement] = []
            gid = f"{self.index_name}_FULL"

            if self.index_info and self.index_info.get("token"):
                idx_exch = 3 if self.index_name == "SENSEX" else 1
                group_tokens.append(TokenRequirement(
                    token=self.index_info["token"], exchange_type=idx_exch,
                    instrument_name=self.index_name, tier=Tier.TIER_1,
                    group_id=gid, mode=1, metadata={"type": "index_spot"},
                ))
                manager.bind_handler(self.index_info["token"], self._handle_spot_tick)
                logger.info(f"[{self.index_name}] Index token {self.index_info['token']} on {'BSE' if idx_exch == 3 else 'NSE'}")

            if self.futures_info and self.futures_info.get("token"):
                fut_exch = 4 if self.index_name == "SENSEX" else 2
                group_tokens.append(TokenRequirement(
                    token=self.futures_info["token"], exchange_type=fut_exch,
                    instrument_name=self.index_name, tier=Tier.TIER_1,
                    group_id=gid, mode=1, metadata={"type": "futures"},
                ))
                manager.bind_handler(self.futures_info["token"], self._handle_futures_tick)
                logger.info(f"[{self.index_name}] Futures token {self.futures_info['token']} on {'BFO' if fut_exch == 4 else 'NFO'}")

            if self.options_df is not None and len(self.options_df) > 0:
                opt_exch = 4 if self.index_name == "SENSEX" else 2
                for token in self.options_df["token"].tolist():
                    group_tokens.append(TokenRequirement(
                        token=str(token), exchange_type=opt_exch,
                        instrument_name=self.index_name, tier=Tier.TIER_1,
                        group_id=gid, mode=3, metadata={"type": "option"},
                    ))
                    manager.bind_handler(str(token), self._handle_option_tick)
                logger.info(f"[{self.index_name}] Registered {len(self.options_df)} option tokens on {'BFO' if opt_exch == 4 else 'NFO'}")

            ok = manager.register_group(TokenGroup(
                group_id=gid, tier=Tier.TIER_1,
                instrument_name=self.index_name, tokens=set(group_tokens),
            ))
            logger.info(f"[{self.index_name}] Tier-1 group registered ({'ACTIVE' if ok else 'PARTIAL'}): "
                        f"{len(group_tokens)} tokens")

        def _handle_spot_tick(self, message: dict):
            try:
                ltp = float(message.get("last_traded_price", 0) or 0) / 100.0
                self.spot_poller.update_from_ws(ltp)
            except Exception as e:
                logger.error(f"[{self.index_name}] Spot tick error: {e}")

        def _handle_futures_tick(self, message: dict):
            try:
                ltp = float(message.get("last_traded_price", 0) or 0) / 100.0
                self.spot_poller.update_futures_from_ws(ltp)
            except Exception as e:
                logger.error(f"[{self.index_name}] Futures tick error: {e}")

        def _handle_option_tick(self, message: dict):
            try:
                token = str(message.get("token", ""))
                info = self.token_map.get(token)
                if not info:
                    return
                ltp = float(message.get("last_traded_price", 0) or 0) / 100.0
                oi = int(message.get("open_interest", 0) or 0)
                volume = int(message.get("volume_trade_for_the_day", 0) or 0)
                self.data_store.update(info["strike"], info["type"], ltp, oi, volume)
            except Exception as e:
                logger.error(f"[{self.index_name}] Option tick error: {e}")

        def stop(self):
            logger.info(f"[{self.index_name}] Stopping streamer...")

        def get_current_state(self):
            now = time.time()
            if self._state_cache is not None and now - self._state_cache_time < 1.0:
                return {
                    **self._state_cache,
                    "data": {**self._state_cache["data"], "timestamp": datetime.now().isoformat()}
                }

            data = self.data_store.get_data()
            spot = self.spot_poller.get_spot()
            futures = self.spot_poller.get_futures()
            diff, pct, label = self.spot_poller.get_premium_discount() or (None, None, None)

            if not data or spot is None:
                return {
                    "type": "tick",
                    "data": {
                        "index_name": self.index_name,
                        "spot": spot,
                        "futures": futures,
                        "timestamp": datetime.now().isoformat(),
                        "options": [],
                        "market_open": is_market_open(),
                        "message": "Waiting for market data..." if is_market_open() else None,
                    }
                }

            cache_key = (
                self.data_store.msg_count,
                round(spot, 2) if spot else None,
                round(futures, 2) if futures else None,
            )
            analytics = None
            if (self._analytics_cache is not None and
                    self._analytics_cache_key == cache_key and
                    now - self._analytics_cache_time < 30.0):
                analytics = self._analytics_cache
            else:
                from calculations import calculate_analytics
                try:
                    analytics = calculate_analytics(
                        data, spot, futures, self.expiry_datetime, self.contract_multiplier,
                        instrument=self.index_name
                    )
                    self._analytics_cache = analytics
                    self._analytics_cache_key = cache_key
                    self._analytics_cache_time = now
                except Exception as e:
                    logger.error(f"[{self.index_name}] Analytics error: {e}")
                    return {
                        "type": "tick",
                        "data": {
                            "index_name": self.index_name,
                            "spot": spot, "futures": futures,
                            "timestamp": datetime.now().isoformat(),
                            "options": [], "market_open": is_market_open(),
                            "error": str(e),
                        }
                    }

            _age = self.spot_poller.spot_age_sec()
            if (_age is not None and _age > 90 and is_market_open()
                    and now - getattr(self, "_last_stale_warn", 0) > 60):
                self._last_stale_warn = now
                logger.warning(f"[{self.index_name}] underlying tick is {_age}s old — "
                               f"GEX/ATM computed from a stale spot ({spot})")

            try:
                enriched_options = []
                for strike in sorted(data.keys()):
                    for opt_type in ["CE", "PE"]:
                        opt = data[strike].get(opt_type, {})
                        analytics_opt = analytics["strikes_data"].get(strike, {}).get(opt_type, {})
                        current_oi = opt.get("oi", 0)
                        oi_change, oi_change_pct = self.data_store.compute_oi_change(strike, opt_type, current_oi)
                        enriched_options.append({
                            "strike": strike, "option_type": opt_type,
                            "oi": current_oi, "oi_change": oi_change, "oi_change_pct": oi_change_pct,
                            "volume": opt.get("volume", 0), "ltp": opt.get("ltp", 0),
                            "iv": analytics_opt.get("iv"), "delta": analytics_opt.get("delta"),
                            "gamma": analytics_opt.get("gamma"), "theta": analytics_opt.get("theta"),
                            "vega": analytics_opt.get("vega"), "gex": analytics_opt.get("gex"),
                        })

                result = {
                    "type": "tick",
                    "data": {
                        "index_name": self.index_name,
                        "spot": spot,
                        "futures": futures,
                        "futures_spread": analytics.get("futures_spread"),
                        "futures_spread_pct": round(pct, 3) if pct else None,
                        "spread_label": label,
                        "timestamp": datetime.now().isoformat(),
                        "options": enriched_options,
                        "net_gex": analytics.get("net_gex"),
                        "max_gex_strike": analytics.get("max_gex_strike"),
                        "max_pain": analytics.get("max_pain"),
                        "gamma_flip": analytics.get("gamma_flip"),
                        "market_open": is_market_open(),
                        "contract_multiplier": self.contract_multiplier,
                        "expiry": self.expiry_str,
                        "instrument_kind": "index",
                        "tier": 1,
                        "spot_age_sec": _age,
                    }
                }
                self._state_cache = result
                self._state_cache_time = time.time()
                return result
            except Exception as e:
                logger.error(f"[{self.index_name}] Enrichment error: {e}")
                return {
                    "type": "tick",
                    "data": {
                        "index_name": self.index_name,
                        "spot": spot, "futures": futures,
                        "timestamp": datetime.now().isoformat(),
                        "options": [], "market_open": is_market_open(),
                        "error": str(e),
                    }
                }


# =====================================================================
#  STREAMER ADAPTER — owns SubscriptionManager + all streamers
# =====================================================================
class StreamerAdapter:
    def __init__(self):
        self.streamers: Dict[str, Any] = {}
        self.stock_streamers: Dict[str, Any] = {}
        self.running = False
        self.mode = "unknown"
        self.auth_manager = None
        self.manager: Optional[SubscriptionManager] = None
        self._supervisor = None
        self.configured_stocks: List[str] = list(TIER2_STOCKS)
        self.on_stock_added = None      # set by main.py -> starts snapshot timer
        self.on_stock_removed = None    # set by main.py -> stops snapshot timer
        self.on_tier_changed = None     # set by main.py -> start/stop snapshot timer
        self.on_scanner_alerts = None   # set by main.py -> dispatch fired alerts

    def start(self):
        self.running = True

        if not ANGEL_ONE_AVAILABLE:
            self.mode = "unavailable"
            logger.warning("[StreamerAdapter] smartapi-python not installed. Live streaming unavailable.")
            logger.warning("[StreamerAdapter] Historical replay from DB still works.")
            return

        try:
            # ScripMaster source is public (no auth needed) — warm the
            # 143k-row master concurrently with the Angel One login instead
            # of serializing the parse behind authentication. load() is
            # idempotent + lock-guarded, so the first instrument's lookup
            # joins this parse; failures surface independently at first use.
            from scrip_master import scrip_master as _scrip_master
            threading.Thread(target=_scrip_master.load, daemon=True,
                             name="scrip-warm").start()

            self.auth_manager = AuthManager()
            if not self.auth_manager.login():
                logger.error("[StreamerAdapter] Angel One login failed")
                self.mode = "unavailable"
                return

            self.mode = "real"
            logger.info("[StreamerAdapter] REAL mode activated (Angel One SmartAPI)")

            # env fallback until app settings load (settings DB is authoritative)
            self.configured_stocks = _parse_tier2_env()

            self.manager = SubscriptionManager(self.auth_manager)
            self.manager.start()
            if not self.manager.wait_until_open(timeout=20):
                logger.warning("[StreamerAdapter] WebSocket not open after 20s — "
                               "group registrations will flush when it connects")

            # Tier 1 — indices
            for index_name in TIER1_INDICES:
                try:
                    streamer = AngelOneIndexStreamer(index_name, self.auth_manager)
                    streamer.register_with_manager(self.manager)
                    self.streamers[index_name] = streamer
                    logger.info(f"[StreamerAdapter] {index_name} streamer ready")
                    time.sleep(1)
                except Exception as e:
                    logger.error(f"[StreamerAdapter] Failed to start {index_name}: {e}")

            # Tier 2 — stocks (cash-first bootstrap), seeded from app settings
            init_app_settings()
            self.configured_stocks = settings_get_stocks()
            logger.info(f"[StreamerAdapter] TIER2_STOCKS configured: {self.configured_stocks}")
            if self.configured_stocks:
                for symbol in self.configured_stocks:
                    kind = app_settings.get_instrument_kind(symbol)
                    tier = app_settings.get_instrument_tier(symbol)
                    self._start_instrument(symbol, kind=kind, tier=tier, delay=0.3)
                for sym in self.stock_streamers:
                    self._wire_streamer_hooks(sym)
                self._ensure_supervisor()

            if self.streamers:
                market_status = "OPEN" if is_market_open() else "CLOSED"
                names = ", ".join(self.streamers.keys())
                logger.info(f"[StreamerAdapter] Streaming {names}. Market: {market_status}.")
                logger.info(f"[StreamerAdapter] WS stats: {self.manager.stats()}")
            else:
                logger.error("[StreamerAdapter] No streamers started")
                self.mode = "unavailable"
        except ValueError as e:
            logger.warning(f"[StreamerAdapter] {e}")
            logger.warning("[StreamerAdapter] Create backend/.env with credentials for real data.")
            self.mode = "unavailable"
        except Exception as e:
            logger.error(f"[StreamerAdapter] Real mode failed: {e}")
            self.mode = "unavailable"

    def stop(self):
        """Orderly shutdown:
        1. reconnect loops (manager closing state) -> 2. processing workers
        (supervisor/streamers) -> 3. WebSockets closed + threads joined
        (inside manager.stop) -> 4. API logout LAST, with full diagnostics."""
        logger.info("[StreamerAdapter] Stopping: reconnect loops -> workers -> sockets -> logout")
        self.running = False

        # 1. reconnect loops + close sockets + join slot threads
        if self.manager:
            self.manager.stop()

        # 2. processing workers
        for streamer in self.streamers.values():
            try:
                streamer.stop()
            except Exception:
                pass
        if self._supervisor:
            self._supervisor.stop()

        # 3. logout LAST, under the auth lock; the full response is logged and
        #    failures are NOT suppressed (AG8004 etc. stay visible).
        if self.auth_manager and ANGEL_ONE_AVAILABLE:
            try:
                with self.auth_manager.lock:
                    resp = self.auth_manager.smart_api.terminateSession(self.auth_manager.client_code)
                logger.info(f"[StreamerAdapter] Logout response: {resp}")
                if not (isinstance(resp, dict) and resp.get("status")):
                    logger.error(
                        "[StreamerAdapter] Logout rejected by Angel One. Verify the API_KEY in "
                        ".env belongs to the app registered for client code "
                        f"{self.auth_manager.client_code[:2]}*** and has not been rotated; also "
                        "check the key was copied without truncation."
                    )
            except Exception as e:
                logger.error(f"[StreamerAdapter] Logout error: {e}")
        logger.info("[StreamerAdapter] All streamers stopped")

    # ── Live instrument management (Settings > Instruments) ──
    def _start_instrument(self, symbol: str, kind: Optional[str] = None,
                          tier: int = 2, delay: float = 0.0) -> dict:
        from stock_streamer import InstrumentStreamer
        try:
            sym = symbol.strip().upper()
            if sym in self.stock_streamers:
                return {"ok": False, "error": f"{sym} already added"}
            if kind is None:
                from scrip_master import scrip_master
                kind = scrip_master.detect_kind(sym)
                if kind is None:
                    return {"ok": False, "error": f"{sym} not found in scrip master "
                                                    f"(index / stock / commodity)"}
            s = InstrumentStreamer(sym, self.manager, kind=kind, tier=tier)
            s.start()
            self.stock_streamers[sym] = s
            self.streamers[sym] = s
            if delay:
                time.sleep(delay)
            logger.info(f"[StreamerAdapter] {sym} streamer starting "
                        f"({s.kind}, tier {s.tier}, {s.state})")
            return {"ok": True, "state": s.state, "kind": s.kind, "tier": s.tier}
        except Exception as e:
            logger.error(f"[StreamerAdapter] Failed to start {symbol}: {e}")
            return {"ok": False, "error": str(e)}

    def _ensure_supervisor(self):
        if self._supervisor is None:
            from stock_streamer import Tier2Supervisor
            self._supervisor = Tier2Supervisor(self.stock_streamers)
            self._supervisor.start()

    def add_instrument(self, symbol: str, kind: Optional[str] = None,
                       tier: int = 3) -> dict:
        """Add an instrument of any kind. Kind auto-detected when omitted.
        Every new instrument defaults to Tier 3 (lightweight scanner) —
        promote via /api/instruments/{sym}/tier to 2 (full analytics) or 1."""
        if self.mode != "real" or self.manager is None:
            return {"ok": False, "error": "Live streaming unavailable"}
        sym = symbol.strip().upper()
        result = self._start_instrument(sym, kind=kind, tier=tier)
        if result.get("ok"):
            app_settings.add_instrument(sym, result.get("kind", kind or "STOCK"))
            app_settings.set_instrument_tier(sym, tier)
            if sym not in self.configured_stocks:
                self.configured_stocks.append(sym)   # dropdown reads this list
            self._wire_streamer_hooks(sym)
            self._ensure_supervisor()
            if self.on_stock_added:
                try:
                    self.on_stock_added(self.stock_streamers[sym])
                except Exception as e:
                    logger.error(f"[StreamerAdapter] on_stock_added hook: {e}")
        return result

    def _wire_streamer_hooks(self, sym: str):
        s = self.stock_streamers.get(sym)
        if not s:
            return
        s.on_alerts_fired = lambda fired, a=self: a.on_scanner_alerts and a.on_scanner_alerts(fired)
        s.on_tier_changed = lambda streamer, a=self: a.on_tier_changed and a.on_tier_changed(streamer)

    def add_stock(self, symbol: str, kind: Optional[str] = None) -> dict:
        # Backward-compatible entry point (old /api/stocks clients)
        return self.add_instrument(symbol, kind=kind, tier=2)

    def set_instrument_tier(self, symbol: str, tier: int) -> dict:
        sym = symbol.strip().upper()
        s = self.stock_streamers.get(sym)
        if not s:
            return {"ok": False, "error": f"{sym} not found"}
        result = s.set_tier(tier)
        if result.get("ok"):
            app_settings.set_instrument_tier(sym, tier)
            logger.info(f"[StreamerAdapter] {sym} tier -> {tier}")
        return result

    def remove_stock(self, symbol: str) -> dict:
        sym = symbol.strip().upper()
        s = self.stock_streamers.get(sym)
        if not s:
            return {"ok": False, "error": f"{sym} not found"}
        for gid in (f"{sym}_SPOT", f"{sym}_FUTURES", f"{sym}_OPTION_WINDOW", f"{sym}_CASH"):
            try:
                self.manager.unregister_group(gid)
            except Exception as e:
                logger.debug(f"[StreamerAdapter] Unregister {gid}: {e}")
        try:
            s.stop()
        except Exception:
            pass
        self.stock_streamers.pop(sym, None)
        self.streamers.pop(sym, None)
        if self._supervisor is not None and not self.stock_streamers:
            self._supervisor.stop()
            self._supervisor = None
        app_settings.remove_instrument(sym)
        if sym in self.configured_stocks:
            self.configured_stocks.remove(sym)
        if self.on_stock_removed:
            try:
                self.on_stock_removed(sym)
            except Exception as e:
                logger.error(f"[StreamerAdapter] on_stock_removed hook: {e}")
        logger.info(f"[StreamerAdapter] {sym} removed (snapshots and history kept)")
        return {"ok": True}

    def pause_stock(self, symbol: str) -> dict:
        s = self.stock_streamers.get(symbol.strip().upper())
        if not s:
            return {"ok": False, "error": "not found"}
        s.pause()
        return {"ok": True, "state": s.state}

    def resume_stock(self, symbol: str) -> dict:
        s = self.stock_streamers.get(symbol.strip().upper())
        if not s:
            return {"ok": False, "error": "not found"}
        s.resume()
        return {"ok": True, "state": s.state}

    def rebuild_all_windows(self):
        for s in self.stock_streamers.values():
            try:
                s.rebuild_window()
            except Exception as e:
                logger.error(f"[StreamerAdapter] Rebuild {s.symbol}: {e}")

    def instruments_status(self) -> list:
        rows = []
        for s in self.stock_streamers.values():
            st = s.status()
            st["fixed"] = False
            rows.append(st)
        # Fixed Tier-1 indices (NIFTY/SENSEX) live outside stock_streamers
        for name, s in self.streamers.items():
            if name in self.stock_streamers:
                continue
            tokens = 0
            if self.manager:
                try:
                    tokens = self.manager.usage_by_instrument().get(name, 0)
                except Exception:
                    pass
            rows.append({
                "symbol": name,
                "kind": "INDEX",
                "tier": 1,
                "fixed": True,
                "state": "WINDOW_ACTIVE" if getattr(s.data_store, "msg_count", 0) > 0 else "IDLE",
                "paused": False,
                "spot": s.spot_poller.get_spot(),
                "futures": s.spot_poller.get_futures(),
                "atm": None,
                "expiry": getattr(s, "expiry_str", None),
                "lot": getattr(s, "contract_multiplier", None),
                "tokens": tokens,
                "msg_count": getattr(s.data_store, "msg_count", 0),
            })
        return rows

    def stocks_status(self) -> list:
        # Backward-compatible alias
        return self.instruments_status()

    def get_streamer(self, index_name: str):
        return self.streamers.get(index_name)

    def get_current_state(self, index_name: str = "NIFTY"):
        streamer = self.streamers.get(index_name)
        if not streamer:
            return {
                "type": "tick",
                "data": {
                    "index_name": index_name,
                    "error": f"Streamer not available for {index_name}",
                    "timestamp": datetime.now().isoformat(),
                }
            }
        return streamer.get_current_state()

    def get_all_states(self):
        return {name: s.get_current_state() for name, s in self.streamers.items()}


streamer_adapter = StreamerAdapter()
