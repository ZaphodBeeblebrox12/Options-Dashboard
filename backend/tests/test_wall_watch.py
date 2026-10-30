from wall_watch import calculate_wall_strikes, normalize_wall_options


def test_walls_use_highest_oi_per_side_across_loaded_expiry_chain():
    options = [
        {"strike": 24500, "option_type": "CE", "oi": 1200},
        {"strike": 24900, "option_type": "CE", "oi": 900},
        {"strike": 25000, "option_type": "CE", "oi": 400},
        {"strike": 25100, "option_type": "CE", "oi": 700},
        {"strike": 25200, "option_type": "CE", "oi": 600},
        {"strike": 24800, "option_type": "PE", "oi": 500},
        {"strike": 25000, "option_type": "PE", "oi": 800},
        {"strike": 25050, "option_type": "PE", "oi": 900},
        {"strike": 25500, "option_type": "PE", "oi": 1100},
    ]
    walls = calculate_wall_strikes(options, 25000)
    assert walls["CE"] == (24500, True)
    assert walls["PE"] == (25500, True)


def test_crossing_call_wall_does_not_move_it_when_oi_is_unchanged():
    options = [
        {"strike": 24900, "option_type": "CE", "oi": 900},
        {"strike": 25000, "option_type": "CE", "oi": 400},
        {"strike": 25100, "option_type": "CE", "oi": 700},
    ]

    # Spot starts below the wall, moves above it, then returns below it.
    # Even a larger move cannot change the wall without a change in OI.
    assert calculate_wall_strikes(options, 24800)["CE"] == (24900, True)
    assert calculate_wall_strikes(options, 25050)["CE"] == (24900, True)
    assert calculate_wall_strikes(options, 27000)["CE"] == (24900, True)
    assert calculate_wall_strikes(options, 24850)["CE"] == (24900, True)


def test_crossing_put_wall_does_not_move_it_when_oi_is_unchanged():
    options = [
        {"strike": 24900, "option_type": "PE", "oi": 500},
        {"strike": 25000, "option_type": "PE", "oi": 800},
        {"strike": 25100, "option_type": "PE", "oi": 700},
    ]

    # Spot moves from above the Put Wall to below it and then back.
    assert calculate_wall_strikes(options, 25200)["PE"] == (25000, True)
    assert calculate_wall_strikes(options, 24950)["PE"] == (25000, True)
    assert calculate_wall_strikes(options, 22000)["PE"] == (25000, True)
    assert calculate_wall_strikes(options, 25250)["PE"] == (25000, True)


def test_changed_oi_can_move_a_wall():
    before = [
        {"strike": 24900, "option_type": "CE", "oi": 900},
        {"strike": 25000, "option_type": "CE", "oi": 400},
        {"strike": 25100, "option_type": "CE", "oi": 700},
    ]
    after = [
        {"strike": 24900, "option_type": "CE", "oi": 600},
        {"strike": 25000, "option_type": "CE", "oi": 400},
        {"strike": 25100, "option_type": "CE", "oi": 1000},
    ]
    assert calculate_wall_strikes(before, 25050)["CE"] == (24900, True)
    assert calculate_wall_strikes(after, 27000)["CE"] == (25100, True)


def test_missing_side_is_incomplete_data_and_does_not_create_a_wall():
    options = [{"strike": 25000, "option_type": "CE", "oi": 100}]
    walls = calculate_wall_strikes(options, 25050)
    assert walls["CE"] == (25000, True)
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


def test_equal_oi_ties_choose_lowest_strike_deterministically():
    options = [
        {"strike": 25100, "option_type": "CE", "oi": 500},
        {"strike": 25200, "option_type": "CE", "oi": 500},
    ]
    assert calculate_wall_strikes(options, 25000)["CE"] == (25100, True)
