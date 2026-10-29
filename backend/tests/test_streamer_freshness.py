"""Regression tests for upstream source-feed freshness measurements."""

from streamer_integration import LiveDataStore, SpotPricePoller


def test_option_chain_age_is_unavailable_until_an_upstream_tick():
    store = LiveDataStore()

    assert store.age_sec() is None

    store.update(strike=25000, option_type="CE", ltp=125.5, oi=120000, volume=80000)

    age = store.age_sec()
    assert age is not None
    assert 0 <= age < 5


def test_underlying_and_futures_ages_are_measured_from_feed_receipt():
    poller = SpotPricePoller()

    assert poller.spot_age_sec() is None
    assert poller.futures_age_sec() is None

    poller.update_from_ws(25000.0)
    poller.update_futures_from_ws(25010.0, oi=1000, volume=100)

    spot_age = poller.spot_age_sec()
    futures_age = poller.futures_age_sec()
    assert spot_age is not None and 0 <= spot_age < 5
    assert futures_age is not None and 0 <= futures_age < 5
