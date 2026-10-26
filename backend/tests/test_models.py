"""Contract tests for API models shared with the frontend."""
from models import CurrentState, OptionData


def test_option_data_accepts_core_ce_and_pe_chain_fields():
    base = {
        "strike": 25000,
        "oi": 120000,
        "oi_change": 2500,
        "volume": 80000,
        "ltp": 125.5,
    }

    call = OptionData(option_type="CE", **base)
    put = OptionData(option_type="PE", **base)

    assert call.strike == put.strike == 25000
    assert call.oi == put.oi == 120000
    assert call.oi_change == put.oi_change == 2500
    assert call.ltp == put.ltp == 125.5
    assert call.oi_change_pct is None


def test_current_state_defaults_keep_chain_shape_stable():
    state = CurrentState(timestamp="2026-10-26T09:15:00", spot=25000)

    assert state.index_name == "NIFTY"
    assert state.is_live is True
    assert state.options == []
