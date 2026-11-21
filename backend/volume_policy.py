"""Shared per-contract minimum-volume eligibility rule."""

import math
from typing import Any

MIN_ELIGIBLE_VOLUME = 2


def has_eligible_volume(value: Any) -> bool:
    """Return True only for a finite numeric volume of at least two contracts."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value)) and float(value) >= MIN_ELIGIBLE_VOLUME
