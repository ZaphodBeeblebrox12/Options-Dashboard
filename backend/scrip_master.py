"""Scrip Master manager: fetches, caches, and queries Angel One instrument data.

FIXED:
1. Added dropna() before astype() to prevent NaN crashes
2. SENSEX support: searches BFO/BSE exchanges (not just NFO/NSE)
   - SENSEX options trade on BFO (BSE Futures & Options)
   - SENSEX index is on BSE (not NSE)
   - SENSEX futures trade on BFO
"""
import os
import json
import requests
import time
import re
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Tuple
import pandas as pd
import numpy as np

SCRIP_MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache")
os.makedirs(CACHE_DIR, exist_ok=True)
CACHE_FILE = os.path.join(CACHE_DIR, "OpenAPIScripMaster.json")
CACHE_MAX_AGE_HOURS = 12

# Known lot sizes (fallback if not in scrip master)
KNOWN_LOT_SIZES = {
    "NIFTY": 50,
    "SENSEX": 10,
    "BANKNIFTY": 15,
    "FINNIFTY": 40,
    "MIDCPNIFTY": 75,
}

# Exchange mapping per index
INDEX_EXCHANGES = {
    "NIFTY": {"index": "NSE", "futures": "NFO", "options": "NFO"},
    "SENSEX": {"index": "BSE", "futures": "BFO", "options": "BFO"},
    "BANKNIFTY": {"index": "NSE", "futures": "NFO", "options": "NFO"},
    "FINNIFTY": {"index": "NSE", "futures": "NFO", "options": "NFO"},
}


def _parse_partial_json(raw_bytes: bytes) -> Optional[List[Dict]]:
    """Attempt to parse partial/truncated JSON from scrip master download."""
    text = raw_bytes.decode("utf-8", errors="ignore")

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    best_end = -1
    markers = ["},\n{", "}, {", "},{", "}]", "},\n]", "}, ]"]
    for marker in markers:
        idx = text.rfind(marker)
        if idx > best_end:
            best_end = idx

    if best_end < 0:
        best_end = text.rfind("}")

    if best_end < 0:
        return None

    truncated = text[:best_end + 1]
    if text.strip().startswith("["):
        truncated = truncated.rstrip() + "\n]"

    try:
        return json.loads(truncated)
    except json.JSONDecodeError:
        pass

    pattern = r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}"
    matches = re.findall(pattern, text)
    if matches:
        objects = []
        for m in matches:
            try:
                obj = json.loads(m)
                if isinstance(obj, dict):
                    objects.append(obj)
            except:
                pass
        if objects:
            print(f"[ScripMaster] Extracted {len(objects)} objects via regex fallback")
            return objects

    return None


def fetch_scrip_master(max_retries: int = 3, timeout: int = 180, chunk_size: int = 65536) -> pd.DataFrame:
    """Fetch scrip master with streaming download, partial recovery, and caching."""

    if os.path.exists(CACHE_FILE):
        cache_age = time.time() - os.path.getmtime(CACHE_FILE)
        if cache_age < CACHE_MAX_AGE_HOURS * 3600:
            try:
                with open(CACHE_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                print(f"[ScripMaster] Loaded {len(data):,} instruments from cache ({cache_age/3600:.1f}h old)")
                return pd.DataFrame(data)
            except Exception as e:
                print(f"[ScripMaster] Cache read failed: {e}, re-fetching...")

    all_chunks = []

    for attempt in range(1, max_retries + 1):
        try:
            print(f"[ScripMaster] Fetching scrip master (attempt {attempt}/{max_retries}, timeout={timeout}s)...")

            session = requests.Session()
            session.headers.update({
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "application/json",
            })

            response = session.get(SCRIP_MASTER_URL, timeout=timeout, stream=True)
            response.raise_for_status()

            total_bytes = 0
            for chunk in response.iter_content(chunk_size=chunk_size):
                if chunk:
                    all_chunks.append(chunk)
                    total_bytes += len(chunk)

            print(f"[ScripMaster] Downloaded {total_bytes:,} bytes successfully")

            raw_data = b"".join(all_chunks)
            data = json.loads(raw_data.decode("utf-8"))

            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f)
            print(f"[ScripMaster] Cached {len(data):,} instruments")

            return pd.DataFrame(data)

        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            print(f"[ScripMaster] Attempt {attempt}: Connection issue - {e}")
            if attempt < max_retries:
                wait_time = min(2 ** attempt, 30)
                print(f"[ScripMaster] Waiting {wait_time}s before retry...")
                time.sleep(wait_time)
            else:
                print("[ScripMaster] All retry attempts exhausted")

        except Exception as e:
            print(f"[ScripMaster] Attempt {attempt}: Download interrupted - {e}")
            if all_chunks:
                break
            if attempt < max_retries:
                time.sleep(2 ** attempt)

    if all_chunks:
        total_bytes = sum(len(c) for c in all_chunks)
        print(f"[ScripMaster] Attempting recovery from partial download ({total_bytes:,} bytes)...")

        raw_data = b"".join(all_chunks)
        data = _parse_partial_json(raw_data)

        if data:
            nifty_count = sum(1 for item in data if isinstance(item, dict) and 
                              str(item.get("name", "")).strip().upper() == "NIFTY")
            if nifty_count > 0:
                print(f"[ScripMaster] Recovered {len(data):,} instruments ({nifty_count} NIFTY records)")
                try:
                    with open(CACHE_FILE, "w", encoding="utf-8") as f:
                        json.dump(data, f)
                except Exception as e:
                    print(f"[ScripMaster] Could not cache partial data: {e}")
                return pd.DataFrame(data)
            else:
                print(f"[ScripMaster] Partial download has {len(data)} records but no NIFTY data")
        else:
            print("[ScripMaster] Could not parse partial download")

    if os.path.exists(CACHE_FILE):
        print(f"[ScripMaster] Using stale cache from: {CACHE_FILE}")
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            age_hours = (time.time() - os.path.getmtime(CACHE_FILE)) / 3600
            print(f"[ScripMaster] Loaded {len(data):,} instruments from stale cache ({age_hours:.1f}h old)")
            return pd.DataFrame(data)
        except Exception as e:
            print(f"[ScripMaster] Failed to load stale cache: {e}")

    raise ConnectionError(
        f"[ScripMaster] Failed to fetch scrip master. "
        f"No usable cache at {CACHE_FILE}. Check internet connection."
    )


class ScripMasterManager:
    """Manages scrip master data and provides index-specific queries."""

    def __init__(self):
        self.df: Optional[pd.DataFrame] = None
        self._last_fetch: Optional[datetime] = None

    def _get_exchanges(self, index_name: str) -> Dict[str, str]:
        """Get correct exchanges for an index (NSE/NFO for NIFTY, BSE/BFO for SENSEX)."""
        index_upper = index_name.strip().upper()
        return INDEX_EXCHANGES.get(index_upper, {"index": "NSE", "futures": "NFO", "options": "NFO"})

    def load(self) -> pd.DataFrame:
        """Load or reload scrip master data."""
        self.df = fetch_scrip_master()
        self._last_fetch = datetime.now()
        return self.df

    def get_index_options(self, index_name: str, expiry_date: Optional[str] = None) -> pd.DataFrame:
        """Get option chain for a specific index and expiry.

        FIXED: Supports SENSEX on BFO exchange. NaN-safe with dropna().
        """
        if self.df is None:
            self.load()

        df = self.df
        index_upper = index_name.strip().upper()
        exchanges = self._get_exchanges(index_name)
        opt_exchange = exchanges["options"]

        opt_filter = (
            (df["instrumenttype"] == "OPTIDX") &
            (df["exch_seg"] == opt_exchange) &
            (df["name"].str.strip().str.upper() == index_upper)
        )

        options = df[opt_filter].copy()

        if len(options) == 0:
            print(f"[ScripMaster] WARNING: No options found for {index_name} on {opt_exchange}")
            return options

        # ── FIX: Handle NaN in strike column safely ─────────────────
        options = options.dropna(subset=["strike"])
        raw_strikes = options["strike"].astype(float)
        # Angel One stores strikes in paise (×100) for NFO, but BFO may already be in points.
        # Heuristic: if max raw value > 100,000 it's paise; otherwise already in points.
        if raw_strikes.max() > 100000:
            options["strike"] = (raw_strikes / 100).astype(int)
        else:
            options["strike"] = raw_strikes.astype(int)

        # ── FIX: Handle invalid expiry dates safely ─────────────────
        options = options.dropna(subset=["expiry"])
        options["expiry_dt"] = pd.to_datetime(options["expiry"], format="%d%b%Y", errors="coerce")
        options = options.dropna(subset=["expiry_dt"])

        # Case-insensitive expiry comparison
        if expiry_date:
            options = options[options["expiry"].str.upper() == expiry_date.upper()]

        return options

    def get_available_expiries(self, index_name: str) -> List[Tuple[str, datetime]]:
        """Get all available expiry dates for an index, sorted nearest first."""
        if self.df is None:
            self.load()

        df = self.df
        index_upper = index_name.strip().upper()
        exchanges = self._get_exchanges(index_name)
        opt_exchange = exchanges["options"]

        opt_filter = (
            (df["instrumenttype"] == "OPTIDX") &
            (df["exch_seg"] == opt_exchange) &
            (df["name"].str.strip().str.upper() == index_upper)
        )

        options = df[opt_filter]
        if len(options) == 0:
            return []

        expiries = options["expiry"].dropna().unique()
        parsed = []
        for exp in expiries:
            try:
                dt = datetime.strptime(str(exp), "%d%b%Y")
                parsed.append((str(exp).upper(), dt))
            except:
                continue

        parsed.sort(key=lambda x: x[1])
        return parsed

    def get_nearest_weekly_expiry(self, index_name: str) -> Optional[str]:
        """Get the nearest weekly expiry date for an index.

        CRITICAL: On expiry day, returns the CURRENT expiry until 15:30 IST.
        Only switches to next week AFTER 15:30 on expiry day.
        """
        expiries = self.get_available_expiries(index_name)
        if not expiries:
            return None

        now = datetime.now()
        market_close = now.replace(hour=15, minute=30, second=0, microsecond=0)

        current_expiry = None
        next_expiry = None

        for i, (exp_str, exp_dt) in enumerate(expiries):
            exp_date = exp_dt.date()
            today = now.date()

            if exp_date == today:
                if now <= market_close:
                    return exp_str
                if i + 1 < len(expiries):
                    return expiries[i + 1][0]
                return exp_str

            if exp_date > today:
                if current_expiry is None:
                    current_expiry = exp_str
                elif next_expiry is None:
                    next_expiry = exp_str
                    break

        if current_expiry is None and expiries:
            return expiries[-1][0]

        return current_expiry

    def get_lot_size(self, index_name: str) -> int:
        """Get lot size for an index. Tries scrip master first, falls back to known values.

        FIXED: dropna() on lotsize before int() cast.
        """
        if self.df is None:
            self.load()

        df = self.df
        index_upper = index_name.strip().upper()
        exchanges = self._get_exchanges(index_name)
        fut_exchange = exchanges["futures"]

        lot_filter = (
            (df["name"].str.strip().str.upper() == index_upper) &
            (df["exch_seg"] == fut_exchange) &
            (df["instrumenttype"].isin(["FUTIDX", "OPTIDX"]))
        )

        matches = df[lot_filter]
        if len(matches) > 0 and "lotsize" in matches.columns:
            try:
                # ── FIX: Handle NaN in lotsize ─────────────────────────
                lot_values = matches["lotsize"].dropna()
                if len(lot_values) > 0:
                    lot_size = int(lot_values.iloc[0])
                    if lot_size > 0:
                        return lot_size
            except:
                pass

        return KNOWN_LOT_SIZES.get(index_upper, 50)

    def get_index_info(self, index_name: str) -> Dict:
        """Get index token and symbol info.

        FIXED: SENSEX index is on BSE, not NSE.
        """
        if self.df is None:
            self.load()

        df = self.df
        index_upper = index_name.strip().upper()
        exchanges = self._get_exchanges(index_name)
        idx_exchange = exchanges["index"]

        idx_filter = (
            (df["name"].str.strip().str.upper() == index_upper) &
            (df["exch_seg"] == idx_exchange) &
            (df["instrumenttype"].isin(["AMXIDX", "IDX", ""]))
        )

        idx_df = df[idx_filter]
        if len(idx_df) > 0:
            row = idx_df.iloc[0]
            return {
                "token": str(row["token"]),
                "symbol": str(row["symbol"]),
                "name": str(row["name"]),
            }

        # Fallback tokens
        fallbacks = {
            "NIFTY": {"token": "26000", "symbol": "NIFTY-EQ", "name": "NIFTY"},
            "SENSEX": {"token": "999001", "symbol": "SENSEX-EQ", "name": "SENSEX"},
        }
        return fallbacks.get(index_upper, {"token": "", "symbol": "", "name": index_name})

    def get_futures_info(self, index_name: str) -> Optional[Dict]:
        """Get current month futures info.

        FIXED: SENSEX futures are on BFO. dropna() before pd.to_datetime().
        """
        if self.df is None:
            self.load()

        df = self.df
        index_upper = index_name.strip().upper()
        exchanges = self._get_exchanges(index_name)
        fut_exchange = exchanges["futures"]

        fut_filter = (
            (df["name"].str.strip().str.upper() == index_upper) &
            (df["exch_seg"] == fut_exchange) &
            (df["instrumenttype"] == "FUTIDX")
        )

        fut_df = df[fut_filter].copy()
        if len(fut_df) == 0:
            return None

        # ── FIX: Handle invalid expiry dates safely ─────────────────
        fut_df = fut_df.dropna(subset=["expiry"])
        fut_df["expiry_dt"] = pd.to_datetime(fut_df["expiry"], format="%d%b%Y", errors="coerce")
        fut_df = fut_df.dropna(subset=["expiry_dt"])
        fut_df = fut_df.sort_values("expiry_dt")

        if len(fut_df) == 0:
            return None

        nearest = fut_df.iloc[0]
        return {
            "token": str(nearest["token"]),
            "symbol": str(nearest["symbol"]),
            "expiry": str(nearest["expiry"]),
        }


# Global instance
scrip_master = ScripMasterManager()
