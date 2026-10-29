from wall_watch import calculate_wall_strikes, normalize_wall_options


def test_call_wall_uses_highest_call_oi_at_or_above_spot():
    options = [
        {"strike": 24900, "option_type": "CE", "oi": 900},
        {"strike": 25000, "option_type": "CE", "oi": 400},
        {"strike": 25100, "option_type": "CE", "oi": 700},
        {"strike": 25200, "option_type": "CE", "oi": 600},
        {"strike": 25000, "option_type": "PE", "oi": 800},
        {"strike": 24900, "option_type": "PE", "oi": 500},
    ]
    walls = calculate_wall_strikes(options, 25000)
    assert walls["CE"] == (25100, True)
    assert walls["PE"] == (25000, True)


def test_put_wall_ignores_put_oi_above_spot():
    options = [
        {"strike": 25000, "option_type": "PE", "oi": 100},
        {"strike": 24950, "option_type": "PE", "oi": 450},
        {"strike": 24900, "option_type": "PE", "oi": 700},
        {"strike": 25050, "option_type": "PE", "oi": 900},
        {"strike": 25000, "option_type": "CE", "oi": 500},
        {"strike": 25100, "option_type": "CE", "oi": 650},
    ]
    walls = calculate_wall_strikes(options, 25000)
    assert walls["PE"] == (24900, True)
    assert walls["CE"] == (25100, True)


def test_missing_side_is_incomplete_data_but_no_eligible_strike_is_vacant():
    options = [{"strike": 25000, "option_type": "CE", "oi": 100}]
    walls = calculate_wall_strikes(options, 25050)
    assert walls["CE"] == (None, True)
    assert walls["PE"] == (None, False)


def test_accepts_strike_keyed_live_chain_shape():
    options = {
        "25000": {"CE": {"oi": 100}, "PE": {"oi": 250}},
        "25100": {"CE": {"oi": 500}, "PE": {"oi": 50}},
    }
    rows = normalize_wall_options(options)
    assert len(rows) == 4
    walls = calculate_wall_strikes(options, 25000)
    assert walls["CE"] == (25100, True)
    assert walls["PE"] == (25000, True)


def test_equal_oi_ties_choose_lowest_eligible_strike_deterministically():
    options = [
        {"strike": 25100, "option_type": "CE", "oi": 500},
        {"strike": 25200, "option_type": "CE", "oi": 500},
    ]
    assert calculate_wall_strikes(options, 25000)["CE"] == (25100, True)
