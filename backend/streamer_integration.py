"""Real-time Angel One SmartAPI v2 integration for NIFTY/SENSEX.

PURGED (v3.0):
- Removed MockIndexStreamer, INDEX_MOCK_CONFIG, FORCE_REAL
- Removed mock fallback — server starts in "real" or "unavailable" mode only
- Historical replay from SQLite still works when live is unavailable
"""
import os
import copy
import threading
import time
import logging
from datetime import datetime, time as dt_time
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# ── Scalable index configuration ─────────────────────────────
STREAMING_INDICES = ["NIFTY", "SENSEX"]

# ── Try to import Angel One libs ─────────────────────────────
ANGEL_ONE_AVAILABLE = False

try:
    from SmartApi import SmartConnect
    from SmartApi.smartWebSocketV2 import SmartWebSocketV2
    import pyotp
    ANGEL_ONE_AVAILABLE = True
    logger.info("[Streamer] smartapi-python detected ✓")
except ImportError as e:
    logger.warning(f"[Streamer] smartapi-python NOT installed: {e}")


def is_market_open() -> bool:
    """Check if Indian equity markets are currently open."""
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
#  LIVE DATA STORE  (v2.2 — with daily OI baseline)
# =====================================================================
class LiveDataStore:
    """Thread-safe data store with tick-level prev_oi AND daily baseline tracking."""

    def __init__(self):
        self.data = {}
        self.prev_oi = {}
        self.daily_oi_baseline = {}      # (strike, option_type) -> baseline_oi
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
            # Capture baseline on first sighting of the day
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

    # ── Daily baseline methods ───────────────────────────────
    def get_daily_baseline(self, strike, option_type):
        with self.lock:
            return self.daily_oi_baseline.get((strike, option_type), None)

    def set_daily_baseline(self, strike, option_type, oi):
        """Allow external seeding of baselines (e.g. from yesterday's close)."""
        with self.lock:
            self.daily_oi_baseline[(strike, option_type)] = oi

    def load_baselines_from_dict(self, baselines):
        """Load baselines from DB dict: {(strike, type): oi}"""
        with self.lock:
            self.daily_oi_baseline.update(baselines)
            self.baseline_loaded_from_db = True

    def compute_oi_change(self, strike, option_type, current_oi):
        """Compute broker-style OI change: current - day baseline."""
        with self.lock:
            baseline = self.daily_oi_baseline.get((strike, option_type))
            if baseline is None:
                # First time seeing this contract — set baseline now
                self.daily_oi_baseline[(strike, option_type)] = current_oi
                baseline = current_oi
            oi_change = current_oi - baseline
            oi_change_pct = round((oi_change / baseline) * 100, 2) if baseline > 0 else 0.0
            return oi_change, oi_change_pct


class SpotPricePoller:
    """Tracks spot and futures prices from WebSocket."""
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

    def update_futures_from_ws(self, ltp):
        with self.spot_lock:
            self.futures_price = ltp
            self.futures_source = "WS"
            self.last_futures_ws_update = time.time()


# =====================================================================
#  REAL STREAMER  (v2.2 — fixed OI change + yesterday baseline seed)
# =====================================================================
if ANGEL_ONE_AVAILABLE:
    class AngelOneIndexStreamer:
        """Real-time streamer for a single index via Angel One SmartAPI v2."""

        def __init__(self, index_name: str, auth_manager):
            self.index_name = index_name
            self.auth_manager = auth_manager
            self.data_store = LiveDataStore()
            self.spot_poller = SpotPricePoller()
            self.sws = None
            self.running = False
            self.ws_connected = False
            self.thread = None

            self.token_map = {}
            self.index_info = None
            self.futures_info = None
            self.options_df = None
            self.contract_multiplier = 50
            self.expiry_datetime = None
            self.expiry_str = None

            self._state_cache = None
            self._state_cache_time = 0

            self._load_instruments()
            self._load_baselines_from_db()
            self._load_yesterday_baselines()

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
            """Load today's baselines from DB so OI change survives restarts."""
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
            """Seed baselines with yesterday's closing OI so OI change matches broker."""
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
            self.token_map = {}
            for _, row in self.options_df.iterrows():
                self.token_map[str(row["token"])] = {
                    "strike": int(row["strike"]),
                    "type": "CE" if "CE" in str(row["symbol"]) else "PE",
                }

        def start(self):
            self.running = True
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
            logger.info(f"[{self.index_name}] Real streamer thread started")

        def _run(self):
            try:
                if not self.auth_manager.login():
                    logger.error(f"[{self.index_name}] Initial login failed")
                    return
                self._init_websocket()
            except Exception as e:
                logger.error(f"[{self.index_name}] Streamer thread crashed: {e}")

        def _init_websocket(self):
            retry_count = 0
            max_retries = 10
            while self.running and retry_count < max_retries:
                try:
                    jwt = self.auth_manager.get_valid_jwt()
                    feed = self.auth_manager.get_valid_feed_token()

                    self.sws = SmartWebSocketV2(
                        auth_token=jwt,
                        api_key=self.auth_manager.api_key,
                        client_code=self.auth_manager.client_code,
                        feed_token=feed
                    )
                    self.sws.on_open = self._on_open
                    self.sws.on_data = self._on_data
                    self.sws.on_error = self._on_error
                    self.sws.on_close = self._on_close

                    logger.info(f"[{self.index_name}] Connecting WebSocket...")
                    self.sws.connect()
                    return
                except Exception as e:
                    logger.error(f"[{self.index_name}] WebSocket init error: {e}")
                    retry_count += 1
                    time.sleep(min(2 ** retry_count, 30))
            logger.error(f"[{self.index_name}] Max WebSocket retries reached")

        def _on_open(self, wsapp):
            try:
                logger.info(f"[{self.index_name}] WebSocket connected")
                self.ws_connected = True

                if self.index_info and self.index_info.get("token"):
                    try:
                        idx_exch = 3 if self.index_name == "SENSEX" else 1
                        self.sws.subscribe("index_spot", 1, [{
                            "exchangeType": idx_exch,
                            "tokens": [self.index_info["token"]]
                        }])
                        logger.info(f"[{self.index_name}] Subscribed index token {self.index_info['token']} on {'BSE' if idx_exch == 3 else 'NSE'} [WS]")
                    except Exception as e:
                        logger.error(f"[{self.index_name}] Index subscription error: {e}")

                if self.futures_info and self.futures_info.get("token"):
                    try:
                        fut_exch = 4 if self.index_name == "SENSEX" else 2
                        self.sws.subscribe("futures_ltp", 1, [{
                            "exchangeType": fut_exch,
                            "tokens": [self.futures_info["token"]]
                        }])
                        logger.info(f"[{self.index_name}] Subscribed futures token {self.futures_info['token']} on {'BFO' if fut_exch == 4 else 'NFO'} [WS]")
                    except Exception as e:
                        logger.error(f"[{self.index_name}] Futures subscription error: {e}")

                if self.options_df is not None and len(self.options_df) > 0:
                    tokens = self.options_df["token"].tolist()
                    opt_exch = 4 if self.index_name == "SENSEX" else 2
                    logger.info(f"[{self.index_name}] Subscribing {len(tokens)} option tokens on {'BFO' if opt_exch == 4 else 'NFO'}...")
                    for i in range(0, len(tokens), 50):
                        chunk = [{"exchangeType": opt_exch, "tokens": tokens[i:i + 50]}]
                        try:
                            self.sws.subscribe(f"oi_stream_{i // 50}", 3, chunk)
                            logger.debug(f"  Batch {i//50 + 1}: {len(chunk[0]['tokens'])} tokens")
                        except Exception as e:
                            logger.error(f"[{self.index_name}] Option subscription error: {e}")
            except Exception as e:
                logger.error(f"[{self.index_name}] on_open crash: {e}")

        def _on_data(self, wsapp, message):
            try:
                if not isinstance(message, dict):
                    return
                token = str(message.get("token", ""))

                if self.index_info and token == self.index_info.get("token"):
                    ltp_raw = message.get("last_traded_price", 0) or 0
                    ltp = float(ltp_raw) / 100.0
                    self.spot_poller.update_from_ws(ltp)
                    return

                if self.futures_info and token == self.futures_info.get("token"):
                    ltp_raw = message.get("last_traded_price", 0) or 0
                    ltp = float(ltp_raw) / 100.0
                    self.spot_poller.update_futures_from_ws(ltp)
                    return

                if token not in self.token_map:
                    return

                info = self.token_map[token]
                ltp_raw = message.get("last_traded_price", 0) or 0
                oi = message.get("open_interest", 0) or 0
                volume = message.get("volume_trade_for_the_day", 0) or 0
                ltp = float(ltp_raw) / 100.0

                self.data_store.update(info["strike"], info["type"], ltp, int(oi), int(volume))
            except Exception as e:
                logger.error(f"[{self.index_name}] Data handling error: {e}")

        def _on_error(self, wsapp, error):
            logger.error(f"[{self.index_name}] WebSocket error: {error}")
            self.ws_connected = False
            self._reconnect_websocket()

        def _on_close(self, wsapp):
            logger.info(f"[{self.index_name}] WebSocket closed")
            self.ws_connected = False

        def _reconnect_websocket(self):
            logger.info(f"[{self.index_name}] Attempting WebSocket reconnection...")
            self._stop_websocket()
            time.sleep(5)
            try:
                self.auth_manager.login()
                self._init_websocket()
            except Exception as e:
                logger.error(f"[{self.index_name}] Reconnection failed: {e}")

        def _stop_websocket(self):
            if self.sws:
                try:
                    self.sws.close_connection()
                except Exception as e:
                    logger.error(f"[{self.index_name}] WebSocket close error: {e}")
                self.sws = None

        def stop(self):
            logger.info(f"[{self.index_name}] Stopping streamer...")
            self.running = False
            self._stop_websocket()
            if self.thread:
                self.thread.join(timeout=5)

        def get_current_state(self):
            now = time.time()
            if self._state_cache is not None and now - self._state_cache_time < 1.0:
                return {
                    **self._state_cache,
                    "data": {**self._state_cache["data"], "timestamp": datetime.now().isoformat()}
                }

            from calculations import calculate_analytics
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
                        "message": "Waiting for market data...",
                    }
                }

            try:
                analytics = calculate_analytics(
                    data, spot, futures, self.expiry_datetime, self.contract_multiplier
                )
                enriched_options = []
                for strike in sorted(data.keys()):
                    for opt_type in ["CE", "PE"]:
                        opt = data[strike].get(opt_type, {})
                        analytics_opt = analytics["strikes_data"].get(strike, {}).get(opt_type, {})

                        current_oi = opt.get("oi", 0)
                        oi_change, oi_change_pct = self.data_store.compute_oi_change(strike, opt_type, current_oi)

                        enriched_options.append({
                            "strike": strike,
                            "option_type": opt_type,
                            "oi": current_oi,
                            "oi_change": oi_change,
                            "oi_change_pct": oi_change_pct,
                            "volume": opt.get("volume", 0),
                            "ltp": opt.get("ltp", 0),
                            "iv": analytics_opt.get("iv"),
                            "delta": analytics_opt.get("delta"),
                            "gamma": analytics_opt.get("gamma"),
                            "theta": analytics_opt.get("theta"),
                            "vega": analytics_opt.get("vega"),
                            "gex": analytics_opt.get("gex"),
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
                    }
                }
                self._state_cache = result
                self._state_cache_time = time.time()
                return result
            except Exception as e:
                logger.error(f"[{self.index_name}] Analytics error: {e}")
                return {
                    "type": "tick",
                    "data": {
                        "index_name": self.index_name,
                        "spot": spot,
                        "futures": futures,
                        "timestamp": datetime.now().isoformat(),
                        "options": [],
                        "market_open": is_market_open(),
                        "error": str(e),
                    }
                }


# =====================================================================
#  STREAMER ADAPTER
# =====================================================================
class StreamerAdapter:
    """Manages multiple index streamers. No mock fallback — real or unavailable."""

    def __init__(self):
        self.streamers: Dict[str, any] = {}
        self.running = False
        self.mode = "unknown"
        self.auth_manager = None

    def start(self):
        self.running = True

        if not ANGEL_ONE_AVAILABLE:
            self.mode = "unavailable"
            logger.warning("[StreamerAdapter] smartapi-python not installed. Live streaming unavailable.")
            logger.warning("[StreamerAdapter] Historical replay from DB still works.")
            return

        try:
            self.auth_manager = AuthManager()
            if self.auth_manager.login():
                self.mode = "real"
                logger.info("[StreamerAdapter] REAL mode activated (Angel One SmartAPI)")

                for index_name in STREAMING_INDICES:
                    try:
                        streamer = AngelOneIndexStreamer(index_name, self.auth_manager)
                        streamer.start()
                        self.streamers[index_name] = streamer
                        time.sleep(2)
                    except Exception as e:
                        logger.error(f"[StreamerAdapter] Failed to start {index_name}: {e}")

                if self.streamers:
                    market_status = "OPEN" if is_market_open() else "CLOSED"
                    indices = ", ".join(self.streamers.keys())
                    logger.info(f"[StreamerAdapter] Streaming {indices}. Market: {market_status}.")
                else:
                    logger.error("[StreamerAdapter] No real streamers started")
                    self.mode = "unavailable"
            else:
                logger.error("[StreamerAdapter] Angel One login failed")
                self.mode = "unavailable"
        except ValueError as e:
            logger.warning(f"[StreamerAdapter] {e}")
            logger.warning("[StreamerAdapter] Create backend/.env with credentials for real data.")
            self.mode = "unavailable"
        except Exception as e:
            logger.error(f"[StreamerAdapter] Real mode failed: {e}")
            self.mode = "unavailable"

    def stop(self):
        self.running = False
        for streamer in self.streamers.values():
            streamer.stop()
        if self.auth_manager and ANGEL_ONE_AVAILABLE:
            try:
                self.auth_manager.smart_api.terminateSession(self.auth_manager.client_code)
            except Exception as e:
                logger.error(f"[StreamerAdapter] Logout error: {e}")
        logger.info("[StreamerAdapter] All streamers stopped")

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


# Global instance
streamer_adapter = StreamerAdapter()
