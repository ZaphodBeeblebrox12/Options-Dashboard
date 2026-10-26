"""Regression tests for deterministic option-pricing and OI calculations."""
import math

import pytest

from calculations import (
    black_scholes_price,
    calculate_gex,
    calculate_greeks,
    calculate_gamma_flip,
    calculate_max_pain,
    implied_volatility,
)


@pytest.mark.parametrize(
    ("option_type", "spot", "strike", "expected"),
    [
        ("CE", 25000, 24900, 100),
        ("CE", 25000, 25100, 0),
        ("PE", 25000, 25100, 100),
        ("PE", 25000, 24900, 0),
    ],
)
def test_expired_option_price_is_intrinsic_value(option_type, spot, strike, expected):
    assert black_scholes_price(spot, strike, 0, 0.065, 0.2, option_type) == expected


@pytest.mark.parametrize("option_type", ["CE", "PE"])
def test_implied_volatility_round_trips_black_scholes_price(option_type):
    spot, strike, years, rate, expected_iv = 25000, 25000, 30 / 365, 0.065, 0.22
    market_price = black_scholes_price(
        spot, strike, years, rate, expected_iv, option_type
    )

    actual_iv = implied_volatility(
        spot, strike, years, rate, market_price, option_type
    )

    assert actual_iv == pytest.approx(expected_iv, abs=1e-5)


def test_call_put_parity_for_same_contract():
    spot, strike, years, rate, volatility = 25000, 25000, 30 / 365, 0.065, 0.22
    call = black_scholes_price(spot, strike, years, rate, volatility, "CE")
    put = black_scholes_price(spot, strike, years, rate, volatility, "PE")

    assert call - put == pytest.approx(
        spot - strike * math.exp(-rate * years), abs=1e-8
    )


def test_implied_volatility_rejects_impossible_market_price():
    assert implied_volatility(25000, 24000, 30 / 365, 0.065, 1, "CE") is None
    assert implied_volatility(25000, 25000, 0, 0.065, 100, "CE") is None


def test_greeks_have_expected_signs_and_invalid_volatility_is_rejected():
    call = calculate_greeks(25000, 25000, 30 / 365, 0.065, 0.22, "CE")
    put = calculate_greeks(25000, 25000, 30 / 365, 0.065, 0.22, "PE")

    assert call is not None and put is not None
    assert 0 < call["delta"] < 1
    assert -1 < put["delta"] < 0
    assert call["gamma"] > 0
    assert put["gamma"] > 0
    assert calculate_greeks(25000, 25000, 30 / 365, 0.065, 0, "CE") is None
    assert calculate_greeks(25000, 25000, 0, 0.065, 0.22, "PE") is None


def test_gamma_exposure_sign_and_missing_values():
    assert calculate_gex(0.02, 100, "CE", 50) == pytest.approx(100)
    assert calculate_gex(0.02, 100, "PE", 50) == pytest.approx(-100)
    assert calculate_gex(None, 100, "CE", 50) == 0
    assert calculate_gex(0.02, None, "PE", 50) == 0


def test_max_pain_selects_strike_with_minimum_aggregate_payoff():
    strikes = {
        100: {"CE": {"oi": 100}, "PE": {"oi": 0}},
        110: {"CE": {"oi": 0}, "PE": {"oi": 1}},
    }

    assert calculate_max_pain(strikes, contract_multiplier=1) == 100
    assert calculate_max_pain({}, contract_multiplier=50) == 0


def test_gamma_flip_returns_the_strike_after_cumulative_gex_crosses_zero():
    strikes = {
        100: {"CE": {"gex": 0}, "PE": {"gex": -10}},
        110: {"CE": {"gex": 20}, "PE": {"gex": 0}},
        120: {"CE": {"gex": 5}, "PE": {"gex": 0}},
    }

    assert calculate_gamma_flip(strikes, spot=108) == 110
    assert calculate_gamma_flip({}, spot=108) is None
