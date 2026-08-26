"""Real-time Angel One SmartAPI v2 integration for NIFTY/SENSEX.

MATCHES nifty_streamer_rich.py EXACTLY:
- _on_error triggers reconnect (like working script)
- _on_close does NOT auto-reconnect (prevents double-reconnect storms)
- FORCE_REAL env var to block mock fallback
- Full try/except on all callbacks
- Same token parsing as working script
"""
import os
import copy
import random
import threading
import time
import logging
from datetime import datetime, time as dt_time
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# ── Force real mode ──────────────────────────────────────────
FORCE_REAL = os.getenv("FORCE_REAL", "false").lower() in ("1", "true", "yes")

# ── Scalable index configuration ─────────────────────────────
# Add new symbols here. Real mode auto-discovers strikes from scrip master.
# Mock mode uses the config below for synthetic data generation.
STREAMING_INDICES = ["NIFTY", "SENSEX"]

INDEX_MOCK_CONFIG = {
    "NIFTY":     {"base_spot": 24500.0, "strike_range": (24000, 25100), "strike_step": 50},
    "SENSEX":    {"base_spot": 80500.0, "strike_range": (79500, 81500), "strike_step": 100},
    # ── Add more symbols here ─────────────────────────────────
    # "BANKNIFTY": {"base_spot": 52000.0, "strike_range": (51000, 53000), "strike_step": 100},
    # "FINNIFTY":  {"base_spot": 23500.0, "strike_range": (23000, 24000), "strike_step": 50},
    # "MIDCPNIFTY":{"base_spot": 13200.0, "strike_range": (12700, 13700), "strike_step": 25},
}

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
    if FORCE_REAL:
        raise RuntimeError(
            "FORCE_REAL=true but smartapi-python is not installed. "
            "Run: pip install smartapi-python pyotp"
        )


def is_market_open() -> bool:
    """Check if Indian equity markets are currently open."""
    now = datetime.now()
    if now.weekday() > 4:
        return False
    current_time = now.time()
    return dt_time(9, 15, 0) <= current_time <= dt_time(15, 30, 0)


# =====================================================================
#  AUTH MANAGER (matches nifty_streamer_rich.py)
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
                if FORCE_REAL:
                    raise ValueError(msg)
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
#  LIVE DATA STORE (matches nifty_streamer_rich.py)
# =====================================================================
class LiveDataStore:
    def __init__(self):
        self.data = {}
        self.prev_oi = {}
        self.lock = threading.Lock()
        self.msg_count = 0
        self.last_update = None

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
#  MOCK STREAMER
# =====================================================================
class MockIndexStreamer:
    """Generates realistic synthetic option chain data for UI testing."""

    def __init__(self, index_name: str, base_spot: float, strike_range: tuple, strike_step: int):
        self.index_name = index_name
        self.base_spot = base_spot
        self.strike_range = strike_range
        self.strike_step = strike_step
        self.data_store = LiveDataStore()
        self.spot_poller = SpotPricePoller()
        self.running = False
        self.thread = None
        self._mock_spot = base_spot
        self._mock_strikes = list(range(strike_range[0], strike_range[1] + 1, strike_step))
        self._mock_direction = 1
        self.contract_multiplier = 50 if index_name == "NIFTY" else 10
        self.expiry_datetime = datetime.now() + __import__("datetime").timedelta(days=7)
        self.expiry_datetime = self.expiry_datetime.replace(hour=15, minute=30, second=0, microsecond=0)
        self.expiry_str = self.expiry_datetime.strftime("%d%b%Y").upper()
        self._state_cache = None
        self._state_cache_time = 0

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._mock_stream_loop, daemon=True)
        self.thread.start()
        logger.info(f"[{self.index_name}] MOCK streamer started (spot ~{self.base_spot})")

    def _mock_stream_loop(self):
        import random
        while self.running:
            self._mock_spot += random.uniform(-5, 5) * self._mock_direction
            if self._mock_spot > self.base_spot + 200:
                self._mock_direction = -1
            elif self._mock_spot < self.base_spot - 200:
                self._mock_direction = 1

            self.spot_poller.update_from_ws(self._mock_spot)
            self.spot_poller.update_futures_from_ws(self._mock_spot + random.uniform(-10, 15))

            for strike in self._mock_strikes:
                distance = abs(strike - self._mock_spot)

                ce_ltp = max(self._mock_spot - strike + random.uniform(-2, 2), 0.5)
                ce_oi = int(50000 + random.uniform(-5000, 5000) + max(0, 100000 - distance * 50))
                ce_vol = int(ce_oi * 0.1 + random.uniform(0, 1000))
                self.data_store.update(strike, "CE", round(ce_ltp, 2), int(ce_oi), int(ce_vol))

                pe_ltp = max(strike - self._mock_spot + random.uniform(-2, 2), 0.5)
                pe_oi = int(50000 + random.uniform(-5000, 5000) + max(0, 100000 - distance * 50))
                pe_vol = int(pe_oi * 0.1 + random.uniform(0, 1000))
                self.data_store.update(strike, "PE", round(pe_ltp, 2), int(pe_oi), int(pe_vol))

            time.sleep(1)

    def stop(self):
        self.running = False
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

        try:
            analytics = calculate_analytics(
                data, spot, futures, self.expiry_datetime, self.contract_multiplier
            )
            enriched_options = []
            for strike in sorted(data.keys()):
                for opt_type in ["CE", "PE"]:
                    opt = data[strike].get(opt_type, {})
                    analytics_opt = analytics["strikes_data"].get(strike, {}).get(opt_type, {})
                    enriched_options.append({
                        "strike": strike,
                        "option_type": opt_type,
                        "oi": opt.get("oi", 0),
                        "oi_change": 0,
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
                    "demo_mode": True,
                    "market_open": is_market_open(),
                    "contract_multiplier": self.contract_multiplier,
                    "expiry": self.expiry_str,
                }
            }
            self._state_cache = result
            self._state_cache_time = time.time()
            return result
        except Exception as e:
            logger.error(f"[{self.index_name}] Mock analytics error: {e}")
            return {
                "type": "tick",
                "data": {
                    "index_name": self.index_name,
                    "spot": spot,
                    "futures": futures,
                    "timestamp": datetime.now().isoformat(),
                    "options": [],
                    "demo_mode": True,
                    "market_open": is_market_open(),
                    "error": str(e),
                }
            }


# =====================================================================
#  REAL STREAMER (matches nifty_streamer_rich.py EXACTLY)
# =====================================================================
if ANGEL_ONE_AVAILABLE:
    class AngelOneIndexStreamer:
        """Real-time streamer for a single index via Angel One SmartAPI v2.

        CALLBACK BEHAVIOR (matches working script):
        - _on_error → triggers reconnect (like nifty_streamer_rich.py)
        - _on_close → does NOT auto-reconnect (prevents double-reconnect storms)
        """

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
                    if FORCE_REAL:
                        raise RuntimeError(
                            f"FORCE_REAL=true but no options found for {self.index_name} "
                            f"expiry {expiry_str}. Check scrip master data."
                        )
            except Exception as e:
                logger.error(f"[{self.index_name}] Instrument load failed: {e}")
                raise

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
                    if FORCE_REAL:
                        raise RuntimeError(f"FORCE_REAL=true but Angel One login failed for {self.index_name}")
                    return
                self._init_websocket()
            except Exception as e:
                logger.error(f"[{self.index_name}] Streamer thread crashed: {e}")
                if FORCE_REAL:
                    raise

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
            if FORCE_REAL:
                raise RuntimeError(
                    f"FORCE_REAL=true but WebSocket connection failed after {max_retries} retries"
                )

        def _on_open(self, wsapp):
            """MATCHES nifty_streamer_rich.py: subscribe index, futures, options."""
            try:
                logger.info(f"[{self.index_name}] WebSocket connected")
                self.ws_connected = True

                # Subscribe index spot — NSE=1 for NIFTY, BSE=3 for SENSEX
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

                # Subscribe current-month futures — NFO=2 for NIFTY, BFO=4 for SENSEX
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

                # Subscribe option tokens — NFO=2 for NIFTY, BFO=4 for SENSEX
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
            """MATCHES nifty_streamer_rich.py EXACTLY:
            - Check token against index_info['token'] for spot
            - Check token against futures_info['token'] for futures
            - Otherwise look up in token_map for options
            """
            try:
                if not isinstance(message, dict):
                    return
                token = str(message.get("token", ""))

                # Spot price update — matches working script
                if self.index_info and token == self.index_info.get("token"):
                    ltp_raw = message.get("last_traded_price", 0) or 0
                    ltp = float(ltp_raw) / 100.0
                    self.spot_poller.update_from_ws(ltp)
                    return

                # Futures price update — matches working script
                if self.futures_info and token == self.futures_info.get("token"):
                    ltp_raw = message.get("last_traded_price", 0) or 0
                    ltp = float(ltp_raw) / 100.0
                    self.spot_poller.update_futures_from_ws(ltp)
                    return

                # Option data — matches working script
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
            """MATCHES nifty_streamer_rich.py: error triggers reconnect."""
            logger.error(f"[{self.index_name}] WebSocket error: {error}")
            self.ws_connected = False
            self._reconnect_websocket()

        def _on_close(self, wsapp):
            """MATCHES nifty_streamer_rich.py: close does NOT auto-reconnect.
            Prevents double-reconnect storms when _on_error already triggered it."""
            logger.info(f"[{self.index_name}] WebSocket closed")
            self.ws_connected = False

        def _reconnect_websocket(self):
            """MATCHES nifty_streamer_rich.py: stop websocket, wait, re-login, re-init."""
            logger.info(f"[{self.index_name}] Attempting WebSocket reconnection...")
            self._stop_websocket()
            time.sleep(5)
            try:
                self.auth_manager.login()
                self._init_websocket()
            except Exception as e:
                logger.error(f"[{self.index_name}] Reconnection failed: {e}")

        def _stop_websocket(self):
            """MATCHES nifty_streamer_rich.py: close_connection with error swallow."""
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
                        "demo_mode": False,
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
                        prev_oi = 0
                        oi_change = opt.get("oi", 0) - prev_oi
                        enriched_options.append({
                            "strike": strike,
                            "option_type": opt_type,
                            "oi": opt.get("oi", 0),
                            "oi_change": oi_change,
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
                        "demo_mode": False,
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
                        "demo_mode": False,
                        "market_open": is_market_open(),
                        "error": str(e),
                    }
                }


# =====================================================================
#  STREAMER ADAPTER
# =====================================================================
class StreamerAdapter:
    """Manages multiple index streamers. Auto-falls back to mock if real is unavailable."""

    def __init__(self, force_mock: bool = False):
        self.force_mock = force_mock
        self.streamers: Dict[str, any] = {}
        self.running = False
        self.mode = "unknown"
        self.auth_manager = None

    def start(self):
        self.running = True

        # ── Try REAL mode first ──────────────────────────────────────
        if not self.force_mock and ANGEL_ONE_AVAILABLE:
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
                            if FORCE_REAL:
                                raise

                    if self.streamers:
                        market_status = "OPEN" if is_market_open() else "CLOSED"
                        indices = ", ".join(self.streamers.keys())
                        logger.info(f"[StreamerAdapter] Streaming {indices}. Market: {market_status}.")
                        return
                    else:
                        msg = "[StreamerAdapter] No real streamers started"
                        logger.warning(msg)
                        if FORCE_REAL:
                            raise RuntimeError(f"{msg} and FORCE_REAL=true")
                        logger.warning("[StreamerAdapter] Falling back to mock...")
                else:
                    msg = "[StreamerAdapter] Angel One login failed"
                    logger.warning(msg)
                    if FORCE_REAL:
                        raise RuntimeError(f"{msg} and FORCE_REAL=true")
                    logger.warning("[StreamerAdapter] Falling back to mock...")
            except ValueError as e:
                logger.warning(f"[StreamerAdapter] {e}")
                if FORCE_REAL:
                    raise
                logger.warning("[StreamerAdapter] Create backend/.env with credentials for real data.")
            except Exception as e:
                logger.error(f"[StreamerAdapter] Real mode failed: {e}")
                if FORCE_REAL:
                    raise
        else:
            if not ANGEL_ONE_AVAILABLE:
                logger.warning("[StreamerAdapter] smartapi-python not installed.")
                if FORCE_REAL:
                    raise RuntimeError("FORCE_REAL=true but smartapi-python not installed")
            if self.force_mock:
                logger.info("[StreamerAdapter] Mock mode forced by user.")

        # ── Fall back to MOCK mode ───────────────────────────────────
        if FORCE_REAL:
            raise RuntimeError("FORCE_REAL=true but could not start real mode. Check logs above.")

        self.mode = "mock"
        logger.info("[StreamerAdapter] MOCK mode activated — synthetic data for UI testing")

        for index_name in STREAMING_INDICES:
            cfg = INDEX_MOCK_CONFIG.get(index_name)
            if cfg:
                self.streamers[index_name] = MockIndexStreamer(
                    index_name,
                    cfg["base_spot"],
                    cfg["strike_range"],
                    cfg["strike_step"]
                )

        for streamer in self.streamers.values():
            streamer.start()

        logger.info(f"[StreamerAdapter] Mock streamers running for: {', '.join(self.streamers.keys())}")

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
streamer_adapter = StreamerAdapter(force_mock=False)
