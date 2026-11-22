"""Shared per-contract minimum-volume eligibility rule."""

import math
from typing import Any

MIN_ELIGIBLE_VOLUME = 2


def has_eligible_volume(value: Any, volume_valid: Any = None) -> bool:
    """Require a verified volume tick and at least two traded contracts.

    Migrated historical rows default volume_valid to zero because their
    original feed receipt cannot be reconstructed. Their stored volume value
    alone is not enough evidence to make a contract eligible.
    """
    valid_flag = (
        volume_valid is True
        or (isinstance(volume_valid, int) and not isinstance(volume_valid, bool) and volume_valid == 1)
    )
    if not valid_flag:
        return False
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value)) and float(value) >= MIN_ELIGIBLE_VOLUME
