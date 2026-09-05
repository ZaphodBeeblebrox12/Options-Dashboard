"""Application performance instrumentation.

Records ACTUAL pipeline timings (no synthetic benchmarks):
  - analytics:      every calculate_analytics call (streamer + snapshot paths)
  - broadcast:      every get_current_state push in the broadcast loop
  - snapshot cycle: full capture_snapshot duration (analytics + baselines + queue)

Feeds Settings > Connections > App health — answers
"can I safely add more Tier-2 stocks, or is the app falling behind?"
"""
import threading
import time
from collections import defaultdict, deque

def _tier_of(name: str) -> int:
    """Tier classification that respects promotion — from app settings."""
    try:
        import app_settings
        return app_settings.get_instrument_tier(name)
    except Exception:
        return 1 if name in ("NIFTY", "SENSEX") else 2


_lock = threading.Lock()
_analytics = defaultdict(lambda: deque(maxlen=300))
_broadcast = defaultdict(lambda: deque(maxlen=300))
_snapshot_cycle = defaultdict(lambda: deque(maxlen=300))
_last_analytics = {}
_last_broadcast = {}
_last_snapshot = {}


def record_analytics(instrument: str, duration: float):
    if not instrument:
        return
    with _lock:
        _analytics[instrument].append(duration)
        _last_analytics[instrument] = time.time()


def record_broadcast(instrument: str, duration: float):
    if not instrument:
        return
    with _lock:
        _broadcast[instrument].append(duration)
        _last_broadcast[instrument] = time.time()


def record_snapshot_cycle(instrument: str, duration: float):
    if not instrument:
        return
    with _lock:
        _snapshot_cycle[instrument].append(duration)
        _last_snapshot[instrument] = time.time()


def _stats(samples):
    if not samples:
        return {"count": 0, "avg_ms": None, "p95_ms": None, "last_ms": None}
    s = sorted(samples)
    n = len(s)
    p95 = s[min(n - 1, max(0, int(0.95 * n + 0.9999) - 1))]
    return {
        "count": n,
        "avg_ms": round(sum(s) / n * 1000, 1),
        "p95_ms": round(p95 * 1000, 1),
        "last_ms": round(s[-1] * 1000, 1),
    }


def _merge_tier2(per_instrument):
    """Non-Tier-1 analytics (Tier 2 continuous + rare Tier 3 trigger runs)."""
    merged = []
    for name, samples in per_instrument.items():
        if _tier_of(name) != 1:
            merged.extend(samples)
    return _stats(merged)


def snapshot():
    """Aggregate stats for the App health endpoint."""
    with _lock:
        a = {k: list(v) for k, v in _analytics.items()}
        b = {k: list(v) for k, v in _broadcast.items()}
        c = {k: list(v) for k, v in _snapshot_cycle.items()}
        last = {
            "analytics": dict(_last_analytics),
            "broadcast": dict(_last_broadcast),
            "snapshot": dict(_last_snapshot),
        }
    return {
        "analytics_tier2": _merge_tier2(a),
        "broadcast_tier2": _merge_tier2(b),
        "snapshot_cycle_tier2": _merge_tier2(c),
        "analytics_tier1": _stats([d for k, v in a.items() if _tier_of(k) == 1 for d in v]),
        "per_instrument_analytics": {k: _stats(v) for k, v in a.items()},
        "last": last,
    }
