"""Regression tests for exchange-qualified SmartAPI tick routing."""

from subscription_manager import SubscriptionManager


def test_same_token_on_nfo_and_bfo_routes_to_distinct_handlers():
    manager = SubscriptionManager(auth_manager=None)
    received = []

    manager.bind_handler("88300", lambda message: received.append(("NFO", message["token"])),
                         exchange_type=2, mode=3)
    manager.bind_handler("88300", lambda message: received.append(("BFO", message["token"])),
                         exchange_type=4, mode=3)

    manager._on_data(None, {"exchange_type": 4, "subscription_mode": 3, "token": "88300"})
    manager._on_data(None, {"exchange_type": 2, "subscription_mode": 3, "token": "88300"})

    assert received == [("BFO", "88300"), ("NFO", "88300")]


def test_same_exchange_token_with_different_modes_routes_separately():
    manager = SubscriptionManager(auth_manager=None)
    received = []

    manager.bind_handler("12345", lambda message: received.append("LTP"),
                         exchange_type=4, mode=1)
    manager.bind_handler("12345", lambda message: received.append("SNAP_QUOTE"),
                         exchange_type=4, mode=3)

    manager._on_data(None, {"exchange_type": 4, "subscription_mode": 3, "token": "12345"})
    manager._on_data(None, {"exchange_type": 4, "subscription_mode": 1, "token": "12345"})

    assert received == ["SNAP_QUOTE", "LTP"]


def test_tick_without_exchange_identity_is_not_routed_by_token_alone():
    manager = SubscriptionManager(auth_manager=None)
    received = []
    manager.bind_handler("88300", lambda message: received.append(message),
                         exchange_type=4, mode=3)

    manager._on_data(None, {"subscription_mode": 3, "token": "88300"})

    assert received == []

