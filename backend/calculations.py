"""Financial calculations: Greeks, GEX, Max Pain, Gamma Flip."""
import math
import os
import threading
import time as _time
from collections import deque
from typing import Dict, List, Tuple, Optional
from scipy.optimize import brentq
from scipy.special import ndtr
import numpy as np


def _norm_pdf(x):
    """Standard normal PDF — ~50x faster than the scipy.stats equivalent."""
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)

# Constants
_DEFAULT_RISK_FREE_RATE = 6.5   # PERCENT, as displayed in Settings > Analytics
_RISK_FREE_RATE = float(os.getenv("RISK_FREE_RATE", _DEFAULT_RISK_FREE_RATE))


def set_risk_free_rate(rate_percent: float):
    """Update the risk-free rate (percent) used by ALL downstream calculations.
    Also bumps the RFR generation, voiding every cached IV (they were solved
    under the old rate) without the caller needing to reach any cache."""
    global _RISK_FREE_RATE, _RFR_GENERATION
    _RISK_FREE_RATE = float(rate_percent)
    _RFR_GENERATION += 1


# ── IV cache configuration (tunable at runtime via set_iv_cache_params) ──
# bands: (max moneyness |S-K|/S, price-error tolerance as a fraction of price);
# the INR floor always applies. vol_shock_pct: relative move of the fresh
# ATM-IV basket that voids the outer cache for that instrument.
IV_CFG = {
    "floor": 0.25,
    "bands": ((0.005, 0.0025), (0.015, 0.005), (float("inf"), 0.01)),
    "vol_shock_pct": 0.10,
    "neg_retry_base_sec": 60.0,
    "neg_retry_max_sec": 1800.0,
    "neg_price_trigger": 0.005,
    "neg_spot_trigger": 0.0025,
}
_RFR_GENERATION = 0


def set_iv_cache_params(floor=None, bands=None, vol_shock_pct=None):
    """Runtime tuning of the IV-cache acceptance bands (Settings > Analytics hook)."""
    if floor is not None:
        IV_CFG["floor"] = float(floor)
    if bands is not None:
        IV_CFG["bands"] = tuple(bands)
    if vol_shock_pct is not None:
        IV_CFG["vol_shock_pct"] = float(vol_shock_pct)


def get_rfr_generation() -> int:
    """Generation in effect. Cache entries are stamped with the generation at
    solve time and void once it changes (risk-free-rate change)."""
    return _RFR_GENERATION


def get_risk_free_rate() -> float:
    """Risk-free rate as a DECIMAL for Black-Scholes.

    The setting and UI use percent (6.5); BS requires 0.065. This division
    is the fix — feeding 6.5 as the decimal rate drags d1 ~0.6 sigma upward,
    redistributing gamma toward higher strikes and corrupting IV/GEX.
    """
    return _RISK_FREE_RATE / 100.0


# Frozen alias for backward compatibility — preserves the ORIGINAL decimal
# semantics (0.065). Internal code uses get_risk_free_rate().
RISK_FREE_RATE = _RISK_FREE_RATE / 100.0
TICK_SIZE = 0.05        # NSE/BSE minimum tick
SANITY_TOLERANCE = max(2.0, 2 * TICK_SIZE)  # ₹2 or 2 ticks, whichever is larger


def _d1(S, K, T, r, sigma):
    """Calculate d1 for Black-Scholes."""
    if T <= 0 or sigma <= 0:
        return 0
    return (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))


def _d2(S, K, T, r, sigma):
    """Calculate d2 for Black-Scholes."""
    return _d1(S, K, T, r, sigma) - sigma * math.sqrt(T)


def black_scholes_price(S, K, T, r, sigma, option_type):
    """Calculate Black-Scholes option price."""
    if T <= 0:
        if option_type == "CE":
            return max(S - K, 0)
        else:
            return max(K - S, 0)
    if sigma <= 0:
        sigma = 0.001

    d1 = _d1(S, K, T, r, sigma)
    d2 = _d2(S, K, T, r, sigma)

    if option_type == "CE":
        return S * ndtr(d1) - K * math.exp(-r * T) * ndtr(d2)
    else:
        return K * math.exp(-r * T) * ndtr(-d2) - S * ndtr(-d1)


def implied_volatility(S, K, T, r, market_price, option_type):
    """Find implied volatility using Brent's method.

    Returns None if:
    - market_price <= 0 or T <= 0
    - Price is below intrinsic by more than SANITY_TOLERANCE (stale/bad data)
    - Price exceeds theoretical upper bound + tolerance
    - Brent solver fails to converge
    """
    if market_price <= 0 or T <= 0:
        return None

    # ── Price sanity: lower bound check ─────────────────────────
    if option_type == "CE":
        intrinsic = max(S - K, 0)
        upper_bound = S
    else:
        intrinsic = max(K - S, 0)
        upper_bound = K

    # Reject if below intrinsic by more than tolerance
    if market_price < intrinsic - SANITY_TOLERANCE:
        return None

    # Reject if above theoretical max + tolerance
    if market_price > upper_bound + SANITY_TOLERANCE:
        return None

    def objective(sigma):
        return black_scholes_price(S, K, T, r, sigma, option_type) - market_price

    try:
        iv = brentq(objective, 0.001, 2.0, xtol=1e-6, maxiter=100)
        return iv
    except (ValueError, RuntimeError):
        return None


def solve_iv(S, K, T, r, market_price, option_type, seed_iv=None):
    """Implied-volatility inversion with an optional warm-start bracket.

    seed_iv (a previously solved IV for THIS contract) narrows the Brent
    bracket to [0.5*sigma, 2*sigma]; it is a search hint only - the returned
    IV is always solved from current market data. Returns (iv, warm_missed):
    iv=None on failure (same conditions as implied_volatility); warm_missed
    True when the narrow bracket did not contain a root and the full bracket
    was used (or also failed).
    """
    if market_price <= 0 or T <= 0:
        return None, False
    if option_type == "CE":
        intrinsic = max(S - K, 0)
        upper_bound = S
    else:
        intrinsic = max(K - S, 0)
        upper_bound = K
    if market_price < intrinsic - SANITY_TOLERANCE:
        return None, False
    if market_price > upper_bound + SANITY_TOLERANCE:
        return None, False

    def objective(sigma):
        return black_scholes_price(S, K, T, r, sigma, option_type) - market_price

    warm_missed = False
    if seed_iv is not None and 0.001 < seed_iv < 2.0:
        lo = max(0.001, 0.5 * seed_iv)
        hi = min(2.0, 2.0 * seed_iv)
        if lo < hi:
            try:
                return brentq(objective, lo, hi, xtol=1e-6, maxiter=100), False
            except (ValueError, RuntimeError):
                warm_missed = True   # root outside the warm bracket -> full bracket below
    try:
        return brentq(objective, 0.001, 2.0, xtol=1e-6, maxiter=100), warm_missed
    except (ValueError, RuntimeError):
        return None, warm_missed


class IVCacheStore:
    """Persistent, thread-safe per-instrument IV cache owned by a LiveDataStore
    and shared by every analytics path (5s broadcast, 30s snapshot, Tier-3
    trigger). Keyed by (expiry, strike, option_type)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._entries: Dict[tuple, dict] = {}
        self._counters = {w: {"hits": 0, "misses": 0, "solves": 0,
                              "fallbacks": 0, "failures": 0, "neg_hits": 0}
                          for w in ("active", "outer")}
        self._last_atm_iv: Optional[float] = None
        self._solve_times = deque(maxlen=2000)

    def lookup(self, key):
        with self._lock:
            e = self._entries.get(key)
            if e is None:
                return None
            if e.get("gen") != get_rfr_generation():
                del self._entries[key]          # solved under an old risk-free rate
                return None
            return dict(e)

    def store_success(self, key, iv, bucket, price, spot, t):
        with self._lock:
            self._entries[key] = {"iv": iv, "bucket": bucket, "price": price,
                                  "spot": spot, "t": t, "gen": get_rfr_generation(),
                                  "fails": 0, "last_attempt": None}

    def store_failure(self, key, price, spot, bucket, now):
        with self._lock:
            e = self._entries.get(key)
            fails = ((e or {}).get("fails") or 0) + 1
            self._entries[key] = {"iv": None, "bucket": bucket,
                                  "gen": get_rfr_generation(), "fails": fails,
                                  "last_attempt": now, "last_price": price,
                                  "last_spot": spot}

    def negative_retry_due(self, entry, price, spot, now) -> bool:
        if entry.get("gen") != get_rfr_generation():
            return True
        lp = entry.get("last_price")
        if lp and price and abs(price - lp) > max(IV_CFG["floor"], IV_CFG["neg_price_trigger"] * lp):
            return True
        ls = entry.get("last_spot")
        if ls and spot and abs(spot - ls) / spot > IV_CFG["neg_spot_trigger"]:
            return True
        fails = entry.get("fails") or 1
        backoff = min(IV_CFG["neg_retry_base_sec"] * (2 ** min(fails, 5)),
                      IV_CFG["neg_retry_max_sec"])
        la = entry.get("last_attempt")
        return la is None or (now - la) >= backoff

    def check_vol_shock(self, basket_iv: float) -> bool:
        """Fresh ATM-IV thermometer: a relative move >= vol_shock_pct voids the
        entire outer cache for this instrument. Active-window strikes never
        read the cache, so they are unaffected by the clear."""
        with self._lock:
            prev = self._last_atm_iv
            self._last_atm_iv = basket_iv
            if (prev and basket_iv
                    and abs(basket_iv - prev) / prev >= IV_CFG["vol_shock_pct"]):
                self._entries.clear()
                return True
            return False

    def bump(self, window: str, counter: str, n: int = 1):
        with self._lock:
            self._counters[window][counter] += n

    def note_solve(self):
        with self._lock:
            self._solve_times.append(_time.time())

    def stats(self) -> dict:
        with self._lock:
            c = {w: dict(v) for w, v in self._counters.items()}
            recent = sum(1 for t in self._solve_times if _time.time() - t < 60)
            entries = len(self._entries)
        o = c["outer"]
        hit_rate = o["hits"] / max(1, o["hits"] + o["misses"])
        return {"active": c["active"],
                "outer": {**o, "hit_rate": round(hit_rate, 3),
                          "solves_per_min": recent},
                "entries": entries}


def calculate_greeks(S, K, T, r, sigma, option_type):
    """Calculate all Greeks for an option.

    Returns None for all Greeks if sigma is None or <= 0.
    """
    if sigma is None or T <= 0 or sigma <= 0:
        return None

    d1 = _d1(S, K, T, r, sigma)
    d2 = _d2(S, K, T, r, sigma)
    nd1 = _norm_pdf(d1)

    if option_type == "CE":
        delta = ndtr(d1)
        theta = (-(S * nd1 * sigma) / (2 * math.sqrt(T)) 
                 - r * K * math.exp(-r * T) * ndtr(d2)) / 365
    else:
        delta = ndtr(d1) - 1
        theta = (-(S * nd1 * sigma) / (2 * math.sqrt(T)) 
                 + r * K * math.exp(-r * T) * ndtr(-d2)) / 365

    gamma = nd1 / (S * sigma * math.sqrt(T))
    vega = S * nd1 * math.sqrt(T) / 100

    return {
        "delta": delta,
        "gamma": gamma,
        "theta": theta,
        "vega": vega,
        "iv": sigma,
    }


def calculate_gex(gamma: float, oi: int, option_type: str, contract_multiplier: int) -> float:
    """Calculate GEX (Gamma Exposure) with instrument-specific multiplier.

    GEX = Gamma * OI * ContractMultiplier * sign
    For CE: positive gamma exposure
    For PE: negative gamma exposure (dealer short gamma)

    Returns 0 if gamma is None.
    """
    if gamma is None or oi is None:
        return 0.0
    sign = 1.0 if option_type == "CE" else -1.0
    return gamma * oi * contract_multiplier * sign


def calculate_max_pain(strikes_data: Dict, contract_multiplier: int) -> int:
    """Calculate Max Pain strike with instrument-specific lot size."""
    if not strikes_data:
        return 0

    all_strikes = sorted(strikes_data.keys())
    if not all_strikes:
        return 0

    min_loss = float("inf")
    max_pain_strike = all_strikes[0]

    for expiry_strike in all_strikes:
        total_loss = 0.0
        for strike in all_strikes:
            ce_data = strikes_data.get(strike, {}).get("CE", {})
            pe_data = strikes_data.get(strike, {}).get("PE", {})

            ce_oi = ce_data.get("oi", 0)
            pe_oi = pe_data.get("oi", 0)

            ce_loss = max(expiry_strike - strike, 0) * ce_oi * contract_multiplier
            pe_loss = max(strike - expiry_strike, 0) * pe_oi * contract_multiplier

            total_loss += ce_loss + pe_loss

        if total_loss < min_loss:
            min_loss = total_loss
            max_pain_strike = expiry_strike

    return max_pain_strike


def calculate_gamma_flip(strikes_data: Dict, spot: float) -> Optional[int]:
    """DEPRECATED: Old cumulative-at-current-spot method.

    Kept for backward compatibility. Use calculate_true_gamma_flip for
    the exact zero-GEX spot price.
    """
    if not strikes_data or spot is None:
        return None

    all_strikes = sorted(strikes_data.keys())
    if not all_strikes:
        return None

    cumulative_gex = 0.0
    gex_by_strike = []

    for strike in all_strikes:
        ce_data = strikes_data.get(strike, {}).get("CE", {})
        pe_data = strikes_data.get(strike, {}).get("PE", {})

        ce_gex = ce_data.get("gex", 0)
        pe_gex = pe_data.get("gex", 0)
        net = ce_gex + pe_gex

        cumulative_gex += net
        gex_by_strike.append((strike, cumulative_gex))

    for i in range(len(gex_by_strike) - 1):
        s1, g1 = gex_by_strike[i]
        s2, g2 = gex_by_strike[i + 1]
        if g1 <= 0 and g2 > 0:
            return s2
        if g1 >= 0 and g2 < 0:
            return s2

    return None


def calculate_true_gamma_flip(
    strikes_data: Dict,
    spot: float,
    cached_ivs: Dict[Tuple[int, str], float],
    T: float,
    contract_multiplier: int = 50
) -> Optional[int]:
    """
    Find exact spot price where total net GEX = 0.

    Uses cached IVs (sticky-strike assumption). Gamma is recalculated
    at every candidate spot S. Brent root-finds the zero crossing.

    Bracket search is robust: evaluates total GEX at each strike level
    to locate sign changes, then refines with Brent between the bracket.
    If no crossing within the chain, checks extended brackets (spot ±10%).

    Returns rounded int to maintain compatibility with existing schema.
    """
    if not strikes_data or not cached_ivs or spot is None or spot <= 0:
        return None

    # Build flat contracts list for fast iteration
    contracts = []
    for strike, opt_data in strikes_data.items():
        for opt_type in ["CE", "PE"]:
            opt = opt_data.get(opt_type, {})
            oi = opt.get("oi", 0)
            iv = cached_ivs.get((strike, opt_type))
            if iv and oi > 0:
                contracts.append((strike, opt_type, oi, iv))

    if not contracts:
        return None

    def total_gex_at_spot(S: float) -> float:
        """Total net GEX if spot were at price S. Closed-form, no Brent."""
        if S <= 0:
            return float("inf")
        total = 0.0
        for strike, opt_type, oi, iv in contracts:
            greeks = calculate_greeks(S, strike, T, get_risk_free_rate(), iv, opt_type)
            if greeks:
                gex = calculate_gex(greeks["gamma"], oi, opt_type, contract_multiplier)
                total += gex
        return total

    # ── Robust bracket search: evaluate at each strike level ─────
    all_strikes = sorted(strikes_data.keys())
    gex_by_level = []

    for candidate_spot in all_strikes:
        gex = total_gex_at_spot(candidate_spot)
        gex_by_level.append((candidate_spot, gex))

    # Find all sign changes between consecutive strike evaluations
    crossings = []
    for i in range(len(gex_by_level) - 1):
        s1, g1 = gex_by_level[i]
        s2, g2 = gex_by_level[i + 1]

        if g1 == 0:
            crossings.append(float(s1))
        elif g1 * g2 < 0:
            try:
                flip = brentq(total_gex_at_spot, s1, s2, xtol=0.5, maxiter=50)
                crossings.append(flip)
            except (ValueError, RuntimeError):
                continue

    # ── Extended bracket: if no crossing in chain, check outside ──
    if not crossings:
        extended_low = max(all_strikes[0] * 0.95, spot * 0.90)
        extended_high = min(all_strikes[-1] * 1.05, spot * 1.10)

        # Ensure we don't have inverted brackets
        if extended_low >= extended_high:
            extended_low, extended_high = spot * 0.90, spot * 1.10

        g_low = total_gex_at_spot(extended_low)
        g_high = total_gex_at_spot(extended_high)

        if g_low * g_high < 0:
            try:
                flip = brentq(total_gex_at_spot, extended_low, extended_high, xtol=0.5, maxiter=50)
                crossings.append(flip)
            except (ValueError, RuntimeError):
                pass

    if not crossings:
        return None

    # Return the crossing closest to current spot (most relevant)
    best_flip = min(crossings, key=lambda x: abs(x - spot))
    return int(round(best_flip))




def calculate_true_gamma_flip_vectorized(
    strikes_data: Dict,
    spot: float,
    cached_ivs: Dict[Tuple[int, str], float],
    T: float,
    contract_multiplier: int = 50
) -> Optional[int]:
    """
    Vectorized gamma flip: ~50-100x faster than the scalar loop.

    Instead of calling calculate_greeks() 32,000 times in pure Python,
    we build numpy arrays once and do all math in C-speed vector ops.
    """
    if not strikes_data or not cached_ivs or spot is None or spot <= 0:
        return None

    # ── 1. Build flat arrays once ─────────────────────────────────
    strikes_arr = []
    ois_arr = []
    ivs_arr = []
    signs_arr = []

    for strike, opt_data in strikes_data.items():
        for opt_type in ("CE", "PE"):
            opt = opt_data.get(opt_type, {})
            oi = opt.get("oi", 0)
            iv = cached_ivs.get((strike, opt_type))
            if iv and oi > 0:
                strikes_arr.append(strike)
                ois_arr.append(oi)
                ivs_arr.append(iv)
                signs_arr.append(1.0 if opt_type == "CE" else -1.0)

    n = len(strikes_arr)
    if n == 0:
        return None

    K = np.array(strikes_arr, dtype=np.float64)
    OI = np.array(ois_arr, dtype=np.float64)
    sigma = np.array(ivs_arr, dtype=np.float64)
    sign = np.array(signs_arr, dtype=np.float64)
    r = get_risk_free_rate()
    sqrt_T = math.sqrt(T)
    mult = contract_multiplier

    # ── 2. Vectorized total GEX at any spot S ─────────────────────
    def total_gex_at_spot(S: float) -> float:
        if S <= 0:
            return float("inf")
        d1 = (np.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * sqrt_T)
        nd1 = np.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
        gamma = nd1 / (S * sigma * sqrt_T)
        gex = gamma * OI * mult * sign
        return float(np.sum(gex))

    # ── 3. Narrow search band: gamma flip is always near spot ─────
    all_strikes = sorted(strikes_data.keys())
    low_bound = spot * 0.93
    high_bound = spot * 1.07
    candidate_strikes = [s for s in all_strikes if low_bound <= s <= high_bound]
    if len(candidate_strikes) < 2:
        idx = min(range(len(all_strikes)), key=lambda i: abs(all_strikes[i] - spot))
        start = max(0, idx - 7)
        end = min(len(all_strikes), idx + 8)
        candidate_strikes = all_strikes[start:end]

    # ── 4. Find sign change ───────────────────────────────────────
    gex_by_level = [(s, total_gex_at_spot(s)) for s in candidate_strikes]

    crossings = []
    for i in range(len(gex_by_level) - 1):
        s1, g1 = gex_by_level[i]
        s2, g2 = gex_by_level[i + 1]
        if g1 == 0:
            crossings.append(float(s1))
        elif g1 * g2 < 0:
            try:
                flip = brentq(total_gex_at_spot, s1, s2, xtol=0.5, maxiter=50)
                crossings.append(flip)
            except (ValueError, RuntimeError):
                continue

    # Extended bracket fallback
    if not crossings:
        extended_low = max(all_strikes[0] * 0.95, spot * 0.90)
        extended_high = min(all_strikes[-1] * 1.05, spot * 1.10)
        if extended_low >= extended_high:
            extended_low, extended_high = spot * 0.90, spot * 1.10
        g_low = total_gex_at_spot(extended_low)
        g_high = total_gex_at_spot(extended_high)
        if g_low * g_high < 0:
            try:
                flip = brentq(total_gex_at_spot, extended_low, extended_high, xtol=0.5, maxiter=50)
                crossings.append(flip)
            except (ValueError, RuntimeError):
                pass

    if not crossings:
        return None

    return int(round(min(crossings, key=lambda x: abs(x - spot))))

def calculate_analytics(strikes_data: Dict, spot: float, futures: Optional[float] = None,
                       expiry_datetime=None, contract_multiplier: int = 50,
                       instrument: Optional[str] = None,
                       iv_store: Optional["IVCacheStore"] = None,
                       active_window: int = 0, expiry: Optional[str] = None) -> Dict:
    """Calculate all analytics for a snapshot with instrument-specific multiplier.

    Options that fail IV sanity checks are excluded from GEX calculations
    but still displayed in the chain with their raw OI/volume/LTP.

    iv_store: persistent per-instrument IV cache (LiveDataStore.iv_cache). None
      -> legacy behavior (fresh solve for every contract, every call).
    active_window: strikes ATM±N are solved fresh on EVERY call with no cache
      reuse (5s broadcast, 30s snapshot and Tier-3 paths alike); a cached IV
      may seed the Brent bracket (warm start) but never substitutes a solve.
      0 with a store -> every strike is treated as outer/cached.
    expiry: expiry string for cache keys (e.g. "11SEP2026").
    """
    from datetime import datetime, timedelta

    _t0 = _time.perf_counter()

    if expiry_datetime is None:
        expiry_datetime = datetime.now() + timedelta(days=7)

    now = datetime.now()
    T = max((expiry_datetime - now).total_seconds() / (365.25 * 24 * 3600), 0.0001)

    # Handle spot=None gracefully — return empty analytics instead of crashing
    if spot is None or spot <= 0:
        return {
            "net_gex": 0.0,
            "max_gex_strike": None,
            "max_pain": None,
            "gamma_flip": None,
            "futures_spread": None,
            "strikes_data": strikes_data,
        }

    net_gex = 0.0
    max_gex = 0.0
    max_gex_strike = None

    # NEW: Cache IVs for true gamma flip calculation
    cached_ivs: Dict[Tuple[int, str], float] = {}
    r = get_risk_free_rate()   # hoisted: reused by the IV engine below

    # ── IV/Greek engine ───────────────────────────────────────────
    # Active window (ATM ± active_window strikes): NO cache — Brent runs on
    # every call on every path. Outer strikes: persistent
    # (expiry, strike, option_type) cache gated by a Black-Scholes
    # theoretical-price error test; unsolved strikes live in a negative cache
    # with material-change triggers and exponential backoff. A vol_shock_pct
    # move in the fresh ATM-IV basket voids the outer cache (shock guard).
    expiry_key = expiry if expiry is not None else str(expiry_datetime)
    sorted_strikes = sorted(strikes_data.keys())
    atm_idx = (min(range(len(sorted_strikes)), key=lambda i: abs(sorted_strikes[i] - spot))
               if sorted_strikes else None)
    windowed = active_window > 0 and atm_idx is not None
    lo_i = (atm_idx - active_window) if windowed else 1
    hi_i = (atm_idx + active_window) if windowed else 0
    now_ts = _time.time()

    def _bucket_of(strike: int) -> int:
        m = abs(spot - strike) / spot
        for b, (max_m, _pct) in enumerate(IV_CFG["bands"]):
            if m < max_m:
                return b
        return len(IV_CFG["bands"]) - 1

    def _tol_of(strike: int, price: float) -> float:
        m = abs(spot - strike) / spot
        for max_m, pct in IV_CFG["bands"]:
            if m < max_m:
                return max(IV_CFG["floor"], price * pct)
        return max(IV_CFG["floor"], price * IV_CFG["bands"][-1][1])

    def _accumulate(gex, strike):
        nonlocal net_gex, max_gex, max_gex_strike
        net_gex += gex
        if abs(gex) > abs(max_gex):
            max_gex = gex
            max_gex_strike = strike

    def _finish(opt_data, iv, greeks, gex):
        opt_data.update({
            "iv": iv,
            "delta": greeks["delta"] if greeks else None,
            "gamma": greeks["gamma"] if greeks else None,
            "theta": greeks["theta"] if greeks else None,
            "vega": greeks["vega"] if greeks else None,
            "gex": gex,
            "quote_valid": iv is not None and greeks is not None,
        })

    fresh_window_ivs: List[float] = []

    def _active_contract(strike: int, opt_type: str) -> None:
        """Active window (or legacy no-store mode): always a fresh solve."""
        opt_data = strikes_data[strike].get(opt_type, {})
        ltp = opt_data.get("ltp", 0)
        oi = opt_data.get("oi", 0)
        iv = None
        greeks = None
        gex = 0.0
        if ltp > 0 and spot > 0:
            key = (expiry_key, strike, opt_type)
            seed = None
            if iv_store is not None:
                e = iv_store.lookup(key)
                if e and e.get("iv"):
                    seed = e["iv"]            # warm-start bracket ONLY
            iv, warm_missed = solve_iv(spot, strike, T, r, ltp, opt_type, seed_iv=seed)
            if iv_store is not None:
                iv_store.bump("active", "solves")
                iv_store.note_solve()
                if warm_missed:
                    iv_store.bump("active", "fallbacks")
                if iv is None:
                    iv_store.bump("active", "failures")
                    iv_store.store_failure(key, ltp, spot, _bucket_of(strike), now_ts)
                else:
                    iv_store.store_success(key, iv, _bucket_of(strike), ltp, spot, T)
                    fresh_window_ivs.append(iv)
            if iv is not None:
                cached_ivs[(strike, opt_type)] = iv
                greeks = calculate_greeks(spot, strike, T, r, iv, opt_type)
                if greeks:
                    gex = calculate_gex(greeks["gamma"], oi, opt_type, contract_multiplier)
                    _accumulate(gex, strike)
        _finish(opt_data, iv, greeks, gex)

    def _solve_outer(key, strike, opt_type, ltp, seed):
        iv, warm_missed = solve_iv(spot, strike, T, r, ltp, opt_type, seed_iv=seed)
        iv_store.bump("outer", "solves")
        iv_store.note_solve()
        if warm_missed:
            iv_store.bump("outer", "fallbacks")
        if iv is None:
            iv_store.bump("outer", "failures")
            iv_store.store_failure(key, ltp, spot, _bucket_of(strike), _time.time())
        else:
            iv_store.store_success(key, iv, _bucket_of(strike), ltp, spot, T)
        return iv

    def _outer_contract(strike: int, opt_type: str) -> None:
        opt_data = strikes_data[strike].get(opt_type, {})
        ltp = opt_data.get("ltp", 0)
        oi = opt_data.get("oi", 0)
        iv = None
        greeks = None
        gex = 0.0
        if ltp > 0 and spot > 0:
            key = (expiry_key, strike, opt_type)
            entry = iv_store.lookup(key)
            if (entry is not None and entry.get("iv") is not None
                    and entry.get("bucket") == _bucket_of(strike)):
                # Time value measured against the European (discounted) floor,
                # not undiscounted intrinsic — the latter sits ABOVE the fair
                # price of deep-ITM options by the carry (K*(1-e^-rT)), which
                # would make this freeze unreachable outside the final hour
                # of expiry day. Existing sanity checks are untouched.
                fwd_intrinsic = (max(spot - strike * math.exp(-r * T), 0) if opt_type == "CE"
                                 else max(strike * math.exp(-r * T) - spot, 0))
                if ltp - fwd_intrinsic < IV_CFG["floor"]:
                    iv = entry["iv"]          # deep-ITM freeze — re-tested every call
                else:
                    theoretical = black_scholes_price(spot, strike, T, r, entry["iv"], opt_type)
                    if abs(theoretical - ltp) <= _tol_of(strike, ltp):
                        iv = entry["iv"]      # price-error test passed
                if iv is not None:
                    iv_store.bump("outer", "hits")
            if iv is None:
                suppressed = False
                if entry is not None and entry.get("iv") is None:
                    if iv_store.negative_retry_due(entry, ltp, spot, now_ts):
                        entry = None          # retry now
                    else:
                        suppressed = True     # negative cache hold
                        iv_store.bump("outer", "neg_hits")
                if not suppressed:
                    iv_store.bump("outer", "misses")
                    seed = entry.get("iv") if entry else None
                    iv = _solve_outer(key, strike, opt_type, ltp, seed)
            if iv is not None:
                cached_ivs[(strike, opt_type)] = iv
                greeks = calculate_greeks(spot, strike, T, r, iv, opt_type)
                if greeks:
                    gex = calculate_gex(greeks["gamma"], oi, opt_type, contract_multiplier)
                    _accumulate(gex, strike)
        _finish(opt_data, iv, greeks, gex)

    if iv_store is None:
        # Legacy mode — identical to pre-cache behavior (fresh solve everywhere).
        for strike in sorted_strikes:
            for opt_type in ["CE", "PE"]:
                _active_contract(strike, opt_type)
    else:
        for si, strike in enumerate(sorted_strikes):
            if windowed and lo_i <= si <= hi_i:
                for opt_type in ["CE", "PE"]:
                    _active_contract(strike, opt_type)
        if windowed and fresh_window_ivs:
            # Volatility-shock guard: fresh ATM basket vs the previous cycle.
            basket = sum(fresh_window_ivs) / len(fresh_window_ivs)
            iv_store.check_vol_shock(basket)
        for si, strike in enumerate(sorted_strikes):
            if not (windowed and lo_i <= si <= hi_i):
                for opt_type in ["CE", "PE"]:
                    _outer_contract(strike, opt_type)

    max_pain = calculate_max_pain(strikes_data, contract_multiplier)

    # NEW: True gamma flip using cached IVs
    # Vectorized true gamma flip: exact math, ~5ms instead of 30-90s
    gamma_flip = calculate_true_gamma_flip_vectorized(
        strikes_data, spot, cached_ivs, T, contract_multiplier
    )

    futures_spread = None
    if futures is not None and spot is not None and spot > 0:
        futures_spread = futures - spot

    if instrument:
        try:
            import app_perf
            app_perf.record_analytics(instrument, _time.perf_counter() - _t0)
            if iv_store is not None:
                app_perf.record_iv(instrument, iv_store.stats())
        except Exception:
            pass

    return {
        "net_gex": round(net_gex, 2),
        "max_gex_strike": max_gex_strike,
        "max_pain": max_pain,
        "gamma_flip": gamma_flip,
        "futures_spread": round(futures_spread, 2) if futures_spread is not None else None,
        "strikes_data": strikes_data,
    }
