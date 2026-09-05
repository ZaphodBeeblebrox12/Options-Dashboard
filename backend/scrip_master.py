"""Scrip Master manager: fetches, caches, and queries Angel One instrument data.

v3.0 additions (Tier-2 stocks):
- get_equity_info(symbol)        -> NSE cash token (Phase-1 spot source)
- get_stock_expiries(symbol)     -> OPTSTK expiries, nearest first
- get_stock_options(symbol, exp) -> OPTSTK chain, strikes converted from paise
- get_stock_lot_size(symbol)     -> equity option lot size

All original index methods unchanged.
"""
import os
import threading
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

KNOWN_LOT_SIZES = {
    "NIFTY": 50,
    "SENSEX": 10,
    "BANKNIFTY": 15,
    "FINNIFTY": 40,
    "MIDCPNIFTY": 75,
}

# ── MCX session hours (per commodity category, US-DST aware) ──────────────
# Non-agri (CRUDEOIL, GOLD, SILVER, NATURALGAS, base metals): 09:00–23:30 during
# US daylight saving, 09:00–23:55 in winter. Intl-linked agri: 09:00–21:00.
# Other agri: 09:00–17:00. (MCX circular, revised Mar 2026.)
_MCX_AGRI = {"MENTHAOIL", "CARDAMOM"}
_MCX_AGRI_INTL = {"COTTON", "COTTONOIL", "KAPAS"}


def _us_dst_active(now: Optional[datetime] = None) -> bool:
    """US DST: second Sunday of March -> first Sunday of November."""
    now = now or datetime.now()

    def nth_sunday(year, month, n):
        d = datetime(year, month, 1)
        offset = (6 - d.weekday()) % 7  # days until first Sunday
        return (d + timedelta(days=offset + 7 * (n - 1))).date()

    return nth_sunday(now.year, 3, 2) <= now.date() < nth_sunday(now.year, 11, 1)


def mcx_hours(symbol: str):
    """Trading session ((start_h, start_m), (end_h, end_m)) for an MCX symbol."""
    sym = symbol.strip().upper()
    if sym in _MCX_AGRI:
        return ((9, 0), (17, 0))
    if sym in _MCX_AGRI_INTL:
        return ((9, 0), (21, 0))
    return ((9, 0), (23, 30) if _us_dst_active() else (23, 55))


INDEX_EXCHANGES = {
    "NIFTY": {"index": "NSE", "futures": "NFO", "options": "NFO"},
    "SENSEX": {"index": "BSE", "futures": "BFO", "options": "BFO"},
    "BANKNIFTY": {"index": "NSE", "futures": "NFO", "options": "NFO"},
    "FINNIFTY": {"index": "NSE", "futures": "NFO", "options": "NFO"},
}


def _parse_partial_json(raw_bytes: bytes) -> Optional[List[Dict]]:
    text = raw_bytes.decode("utf-8", errors="ignore")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    best_end = -1
    for marker in ["},\n{", "}, {", "},{", "}]", "},\n]", "}, ]"]:
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
    def __init__(self):
        self.df: Optional[pd.DataFrame] = None
        self._last_fetch: Optional[datetime] = None
        self._load_lock = threading.Lock()

    def _get_exchanges(self, index_name: str) -> Dict[str, str]:
        index_upper = index_name.strip().upper()
        return INDEX_EXCHANGES.get(index_upper, {"index": "NSE", "futures": "NFO", "options": "NFO"})

    def load(self, force: bool = False) -> pd.DataFrame:
        """Idempotent, thread-safe load: parse once, serve from memory after.

        Internal accessors call load() only when df is None; the streamer
        warm-up thread (started before Angel One auth) may race them — the
        double-checked lock guarantees a single parse regardless. The 12h
        disk-cache policy inside fetch_scrip_master is unchanged.
        """
        if self.df is not None and not force:
            return self.df
        with self._load_lock:
            if self.df is not None and not force:
                return self.df
            self.df = fetch_scrip_master()
            self._last_fetch = datetime.now()
            return self.df

    # ── INDEX METHODS (unchanged) ────────────────────────────
    def get_index_options(self, index_name: str, expiry_date: Optional[str] = None) -> pd.DataFrame:
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

        options = options.dropna(subset=["strike"])
        raw_strikes = options["strike"].astype(float)
        if raw_strikes.max() > 100000:
            options["strike"] = (raw_strikes / 100).astype(int)
        else:
            options["strike"] = raw_strikes.astype(int)

        options = options.dropna(subset=["expiry"])
        options["expiry_dt"] = pd.to_datetime(options["expiry"], format="%d%b%Y", errors="coerce")
        options = options.dropna(subset=["expiry_dt"])

        if expiry_date:
            options = options[options["expiry"].str.upper() == expiry_date.upper()]
        return options

    def get_available_expiries(self, index_name: str) -> List[Tuple[str, datetime]]:
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
        expiries = self.get_available_expiries(index_name)
        if not expiries:
            return None
        now = datetime.now()
        market_close = now.replace(hour=15, minute=30, second=0, microsecond=0)

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
                return exp_str
        return expiries[-1][0]

    def get_lot_size(self, index_name: str) -> int:
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
                lot_values = matches["lotsize"].dropna()
                if len(lot_values) > 0:
                    lot_size = int(lot_values.iloc[0])
                    if lot_size > 0:
                        return lot_size
            except:
                pass
        return KNOWN_LOT_SIZES.get(index_upper, 50)

    def get_index_info(self, index_name: str) -> Dict:
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
            return {"token": str(row["token"]), "symbol": str(row["symbol"]), "name": str(row["name"])}

        fallbacks = {
            "NIFTY": {"token": "26000", "symbol": "NIFTY-EQ", "name": "NIFTY"},
            "SENSEX": {"token": "999001", "symbol": "SENSEX-EQ", "name": "SENSEX"},
        }
        return fallbacks.get(index_upper, {"token": "", "symbol": "", "name": index_name})

    def get_futures_info(self, index_name: str) -> Optional[Dict]:
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

        fut_df = fut_df.dropna(subset=["expiry"])
        fut_df["expiry_dt"] = pd.to_datetime(fut_df["expiry"], format="%d%b%Y", errors="coerce")
        fut_df = fut_df.dropna(subset=["expiry_dt"])
        fut_df = fut_df.sort_values("expiry_dt")
        if len(fut_df) == 0:
            return None

        nearest = fut_df.iloc[0]
        return {"token": str(nearest["token"]), "symbol": str(nearest["symbol"]), "expiry": str(nearest["expiry"])}

    # ── TIER-2 STOCK METHODS (new) ───────────────────────────
    def get_equity_info(self, symbol: str) -> Optional[Dict]:
        """NSE cash equity token — the Phase-1 spot source for a stock."""
        if self.df is None:
            self.load()
        df = self.df
        sym = symbol.strip().upper()

        eq_filter = (
            (df["exch_seg"] == "NSE") &
            (df["symbol"].str.strip().str.upper() == sym) &
            (df["instrumenttype"].isin(["", "EQ", "AE"]))
        )
        matches = df[eq_filter]
        if len(matches) == 0:
            name_filter = (
                (df["exch_seg"] == "NSE") &
                (df["name"].str.strip().str.upper() == sym) &
                (df["instrumenttype"].isin(["", "EQ", "AE"]))
            )
            matches = df[name_filter]
        if len(matches) == 0:
            return None
        row = matches.iloc[0]
        return {"token": str(row["token"]), "symbol": str(row["symbol"]), "name": str(row["name"])}

    def get_stock_expiries(self, symbol: str) -> List[Tuple[str, datetime]]:
        """All OPTSTK expiries for a stock on NFO, sorted nearest first."""
        if self.df is None:
            self.load()
        df = self.df
        sym = symbol.strip().upper()

        opt_filter = (
            (df["instrumenttype"] == "OPTSTK") &
            (df["exch_seg"] == "NFO") &
            (df["name"].str.strip().str.upper() == sym)
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

    def get_stock_options(self, symbol: str, expiry: str) -> pd.DataFrame:
        """OPTSTK option chain for a stock + expiry.
        NFO stock strikes are stored in paise (x100) — always divided by 100,
        with a degenerate-value fallback in case data is already in points."""
        if self.df is None:
            self.load()
        df = self.df
        sym = symbol.strip().upper()

        opt_filter = (
            (df["instrumenttype"] == "OPTSTK") &
            (df["exch_seg"] == "NFO") &
            (df["name"].str.strip().str.upper() == sym)
        )
        options = df[opt_filter].copy()
        if len(options) == 0:
            return options

        options = options[options["expiry"].str.upper() == expiry.upper()]

        options = options.dropna(subset=["strike"])
        raw = pd.to_numeric(options["strike"], errors="coerce")
        options = options[raw.notna()]
        raw = raw[raw.notna()]
        converted = raw / 100.0
        if converted.max() < 10:   # already in points (defensive)
            converted = raw
        options = options.assign(strike=converted.round().astype(int))
        return options

    def get_stock_lot_size(self, symbol: str) -> int:
        """Equity option lot size from scrip master; fallback 1."""
        if self.df is None:
            self.load()
        df = self.df
        sym = symbol.strip().upper()

        lot_filter = (
            (df["name"].str.strip().str.upper() == sym) &
            (df["exch_seg"] == "NFO") &
            (df["instrumenttype"] == "OPTSTK")
        )
        matches = df[lot_filter]
        if len(matches) > 0 and "lotsize" in matches.columns:
            try:
                lot_values = matches["lotsize"].dropna()
                if len(lot_values) > 0:
                    lot_size = int(lot_values.iloc[0])
                    if lot_size > 0:
                        return lot_size
            except:
                pass
        return 1


    def search_stock_names(self, query: str, limit: int = 10) -> List[str]:
        """Prefix-then-substring search over OPTSTK names (Settings > Stocks typeahead)."""
        if self.df is None:
            self.load()
        df = self.df
        q = query.strip().upper()
        if not q:
            return []
        opts = df[(df["instrumenttype"] == "OPTSTK") & (df["exch_seg"] == "NFO")]
        names = sorted({str(n).strip().upper() for n in opts["name"].dropna().tolist()})
        starts = [n for n in names if n.startswith(q)]
        contains = [n for n in names if q in n and not n.startswith(q)]
        return (starts + contains)[:limit]


    # ── KIND-AWARE INSTRUMENT REGISTRY (Index / Stock / Commodity) ──
    KIND_EXCHANGES = {
        "INDEX":     {"spot_exch": "NSE", "spot_types": ("AMXIDX", "IDX"),
                      "deriv_exch": "NFO", "opt": "OPTIDX", "fut": "FUTIDX",
                      "spot_exch_type": 1, "deriv_exch_type": 2, "close": (15, 30)},
        "STOCK":     {"spot_exch": "NSE", "spot_types": ("", "EQ", "AE"),
                      "deriv_exch": "NFO", "opt": "OPTSTK", "fut": None,
                      "spot_exch_type": 1, "deriv_exch_type": 2, "close": (15, 30)},
        "COMMODITY": {"spot_exch": "MCX", "spot_types": (),
                      "deriv_exch": "MCX", "opt": "OPTFUT", "fut": "FUTCOM",
                      "spot_exch_type": 5, "deriv_exch_type": 5, "close": (23, 30),
                      "spot_via_futures": True},
    }

    def detect_kind(self, symbol: str) -> Optional[str]:
        """Classify a symbol into INDEX / STOCK / COMMODITY from scrip master records."""
        if self.df is None:
            self.load()
        df = self.df
        sym = symbol.strip().upper()
        if len(df[(df["instrumenttype"] == "OPTIDX") & (df["exch_seg"] == "NFO") &
                  (df["name"].str.strip().str.upper() == sym)]) > 0:
            return "INDEX"
        if len(df[(df["instrumenttype"] == "OPTSTK") & (df["exch_seg"] == "NFO") &
                  (df["name"].str.strip().str.upper() == sym)]) > 0:
            return "STOCK"
        if len(df[(df["instrumenttype"] == "OPTFUT") & (df["exch_seg"] == "MCX") &
                  (df["name"].str.strip().str.upper() == sym)]) > 0:
            return "COMMODITY"
        return None

    def search_instruments(self, query: str, limit: int = 12) -> List[Dict[str, str]]:
        """Typeahead across ALL kinds — results tagged with kind.
        Returns [{symbol, kind}] — INDEX/STOCK/COMMODITY."""
        if self.df is None:
            self.load()
        df = self.df
        q = query.strip().upper()
        if not q:
            return []

        def names(inst, exch):
            sub = df[(df["instrumenttype"] == inst) & (df["exch_seg"] == exch)]
            return {str(n).strip().upper() for n in sub["name"].dropna().tolist()}

        pools = [("INDEX", names("OPTIDX", "NFO")),
                 ("STOCK", names("OPTSTK", "NFO")),
                 ("COMMODITY", names("OPTFUT", "MCX"))]
        results = []
        for kind, pool in pools:
            starts = sorted(n for n in pool if n.startswith(q))
            contains = sorted(n for n in pool if q in n and not n.startswith(q))
            for n in (starts + contains)[: max(1, limit // 3)]:
                results.append({"symbol": n, "kind": kind})
        return results[:limit]

    def get_spot_meta(self, symbol: str, kind: str) -> Optional[Dict]:
        """Underlying price source per kind:
        INDEX/STOCK -> spot token; COMMODITY -> nearest FUTCOM futures token (no cash exists)."""
        if self.df is None:
            self.load()
        df = self.df
        cfg = self.KIND_EXCHANGES[kind]
        sym = symbol.strip().upper()

        if cfg.get("spot_via_futures"):
            fut = self.get_futures_meta(symbol, kind)
            if fut:
                return {"token": fut["token"], "exchange_type": cfg["spot_exch_type"],
                        "via_futures": True, "expiry": fut.get("expiry")}
            return None

        f = ((df["exch_seg"] == cfg["spot_exch"]) &
             (df["name"].str.strip().str.upper() == sym) &
             (df["instrumenttype"].isin(cfg["spot_types"])))
        rows = df[f]
        if len(rows) == 0:
            # fallback: match by symbol column
            f2 = ((df["exch_seg"] == cfg["spot_exch"]) &
                  (df["symbol"].str.strip().str.upper() == sym) &
                  (df["instrumenttype"].isin(cfg["spot_types"])))
            rows = df[f2]
        if len(rows) == 0:
            return None
        row = rows.iloc[0]
        return {"token": str(row["token"]), "exchange_type": cfg["spot_exch_type"], "via_futures": False}

    def get_futures_meta(self, symbol: str, kind: str) -> Optional[Dict]:
        """Nearest futures contract (FUTIDX for indices, FUTCOM for commodities)."""
        if self.df is None:
            self.load()
        df = self.df
        cfg = self.KIND_EXCHANGES[kind]
        if not cfg.get("fut"):
            return None
        sym = symbol.strip().upper()
        f = ((df["name"].str.strip().str.upper() == sym) &
             (df["exch_seg"] == cfg["deriv_exch"]) &
             (df["instrumenttype"] == cfg["fut"]))
        fut_df = df[f].copy()
        if len(fut_df) == 0:
            return None
        fut_df = fut_df.dropna(subset=["expiry"])
        fut_df["expiry_dt"] = pd.to_datetime(fut_df["expiry"], format="%d%b%Y", errors="coerce")
        fut_df = fut_df.dropna(subset=["expiry_dt"]).sort_values("expiry_dt")
        if len(fut_df) == 0:
            return None
        row = fut_df.iloc[0]
        return {"token": str(row["token"]), "exchange_type": cfg["deriv_exch_type"],
                "expiry": str(row["expiry"]).upper()}

    def get_deriv_expiries(self, symbol: str, kind: str) -> List[Tuple[str, datetime]]:
        """Option expiries for any kind, sorted nearest first."""
        if self.df is None:
            self.load()
        df = self.df
        cfg = self.KIND_EXCHANGES[kind]
        sym = symbol.strip().upper()
        f = ((df["instrumenttype"] == cfg["opt"]) &
             (df["exch_seg"] == cfg["deriv_exch"]) &
             (df["name"].str.strip().str.upper() == sym))
        opts = df[f]
        if len(opts) == 0:
            return []
        parsed = []
        for exp in opts["expiry"].dropna().unique():
            try:
                parsed.append((str(exp).upper(), datetime.strptime(str(exp), "%d%b%Y")))
            except Exception:
                continue
        parsed.sort(key=lambda x: x[1])
        return parsed

    def get_current_expiry(self, symbol: str, kind: str) -> Optional[str]:
        """Nearest expiry; rolls to the next one after that expiry's market close."""
        expiries = self.get_deriv_expiries(symbol, kind)
        if not expiries:
            return None
        cfg = self.KIND_EXCHANGES[kind]
        now = datetime.now()
        if kind == "COMMODITY":
            close_h, close_m = mcx_hours(symbol)[1]
        else:
            close_h, close_m = cfg["close"]
        market_close = now.replace(hour=close_h, minute=close_m, second=0, microsecond=0)
        for i, (exp_str, exp_dt) in enumerate(expiries):
            if exp_dt.date() == now.date():
                if now <= market_close:
                    return exp_str
                if i + 1 < len(expiries):
                    return expiries[i + 1][0]
                return exp_str
            if exp_dt.date() > now.date():
                return exp_str
        return expiries[-1][0]

    def get_deriv_options(self, symbol: str, kind: str, expiry: str) -> pd.DataFrame:
        """Option chain for any kind. Strikes stored in paise (x100) on NFO/MCX —
        same heuristic as indices with a degenerate-value fallback."""
        if self.df is None:
            self.load()
        df = self.df
        cfg = self.KIND_EXCHANGES[kind]
        sym = symbol.strip().upper()
        f = ((df["instrumenttype"] == cfg["opt"]) &
             (df["exch_seg"] == cfg["deriv_exch"]) &
             (df["name"].str.strip().str.upper() == sym))
        options = df[f].copy()
        if len(options) == 0:
            return options
        options = options[options["expiry"].str.upper() == expiry.upper()]
        options = options.dropna(subset=["strike"])
        raw = pd.to_numeric(options["strike"], errors="coerce")
        options = options[raw.notna()]
        raw = raw[raw.notna()]
        converted = raw / 100.0
        if converted.max() < 10:
            converted = raw
        options = options.assign(strike=converted.round().astype(int))
        return options

    def get_deriv_lot_size(self, symbol: str, kind: str) -> int:
        if self.df is None:
            self.load()
        df = self.df
        cfg = self.KIND_EXCHANGES[kind]
        sym = symbol.strip().upper()
        f = ((df["name"].str.strip().str.upper() == sym) &
             (df["exch_seg"] == cfg["deriv_exch"]) &
             (df["instrumenttype"] == cfg["opt"]))
        rows = df[f]
        if len(rows) > 0 and "lotsize" in rows.columns:
            try:
                vals = rows["lotsize"].dropna()
                if len(vals) > 0:
                    v = int(vals.iloc[0])
                    if v > 0:
                        return v
            except Exception:
                pass
        return KNOWN_LOT_SIZES.get(sym, 1)


scrip_master = ScripMasterManager()
