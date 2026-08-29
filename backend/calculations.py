"""Financial calculations: Greeks, GEX, Max Pain, Gamma Flip."""
import math
from typing import Dict, List, Tuple, Optional
from scipy.stats import norm
from scipy.optimize import brentq
import numpy as np

# Constants
RISK_FREE_RATE = 0.065  # 6.5% for India
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
        return S * norm.cdf(d1) - K * math.exp(-r * T) * norm.cdf(d2)
    else:
        return K * math.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1)


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


def calculate_greeks(S, K, T, r, sigma, option_type):
    """Calculate all Greeks for an option.

    Returns None for all Greeks if sigma is None or <= 0.
    """
    if sigma is None or T <= 0 or sigma <= 0:
        return None

    d1 = _d1(S, K, T, r, sigma)
    d2 = _d2(S, K, T, r, sigma)
    nd1 = norm.pdf(d1)

    if option_type == "CE":
        delta = norm.cdf(d1)
        theta = (-(S * nd1 * sigma) / (2 * math.sqrt(T)) 
                 - r * K * math.exp(-r * T) * norm.cdf(d2)) / 365
    else:
        delta = norm.cdf(d1) - 1
        theta = (-(S * nd1 * sigma) / (2 * math.sqrt(T)) 
                 + r * K * math.exp(-r * T) * norm.cdf(-d2)) / 365

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
    """Calculate Gamma Flip strike."""
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


def calculate_analytics(strikes_data: Dict, spot: float, futures: Optional[float] = None,
                       expiry_datetime=None, contract_multiplier: int = 50) -> Dict:
    """Calculate all analytics for a snapshot with instrument-specific multiplier.

    Options that fail IV sanity checks are excluded from GEX calculations
    but still displayed in the chain with their raw OI/volume/LTP.
    """
    from datetime import datetime

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

    for strike in strikes_data:
        for opt_type in ["CE", "PE"]:
            opt_data = strikes_data[strike].get(opt_type, {})
            ltp = opt_data.get("ltp", 0)
            oi = opt_data.get("oi", 0)

            # ── Calculate IV and Greeks ─────────────────────────────
            iv = None
            greeks = None
            gex = 0.0

            if ltp > 0 and spot > 0:
                iv = implied_volatility(spot, strike, T, RISK_FREE_RATE, ltp, opt_type)
                if iv is not None:
                    greeks = calculate_greeks(spot, strike, T, RISK_FREE_RATE, iv, opt_type)
                    if greeks:
                        gex = calculate_gex(greeks["gamma"], oi, opt_type, contract_multiplier)
                        net_gex += gex
                        if abs(gex) > abs(max_gex):
                            max_gex = gex
                            max_gex_strike = strike

            # Store everything — valid or invalid — with validity flag
            strikes_data[strike][opt_type].update({
                "iv": iv,
                "delta": greeks["delta"] if greeks else None,
                "gamma": greeks["gamma"] if greeks else None,
                "theta": greeks["theta"] if greeks else None,
                "vega": greeks["vega"] if greeks else None,
                "gex": gex,
                "quote_valid": iv is not None and greeks is not None,
            })

    max_pain = calculate_max_pain(strikes_data, contract_multiplier)
    gamma_flip = calculate_gamma_flip(strikes_data, spot)

    futures_spread = None
    if futures is not None and spot is not None and spot > 0:
        futures_spread = futures - spot

    return {
        "net_gex": round(net_gex, 2),
        "max_gex_strike": max_gex_strike,
        "max_pain": max_pain,
        "gamma_flip": gamma_flip,
        "futures_spread": round(futures_spread, 2) if futures_spread is not None else None,
        "strikes_data": strikes_data,
    }


def get_next_expiry():
    """DEPRECATED: Use ScripMasterManager.get_nearest_weekly_expiry() instead."""
    from datetime import datetime, timedelta
    today = datetime.now()
    days_ahead = (1 - today.weekday() + 7) % 7
    if days_ahead == 0:
        if today.hour >= 15 and today.minute >= 30:
            days_ahead = 7
    next_tue = today + timedelta(days=days_ahead)
    return next_tue.replace(hour=15, minute=30, second=0, microsecond=0)
