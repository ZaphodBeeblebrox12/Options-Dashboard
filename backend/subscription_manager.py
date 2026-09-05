"""Subscription Manager v3.0 — multi-connection, capacity-aware, tier-first.

Implements the 13 non-negotiable rules:
- One shared WebSocket whenever possible; extra connections ONLY when capacity requires.
- NIFTY/SENSEX = Tier 1 (sacred, never dropped). Stocks = Tier 2.
- Global token dedup. Hard cap per connection (default 990). Max connections (default 3).
- Tier-2 INITIAL registration is ATOMIC (all-or-nothing per group).
- Steady-state window moves are DELTA updates (asymmetric allowed: edge tokens may
  lag if capacity is tight; the window follows ATM immediately).
- Reconnect restores EXACTLY the tokens each slot had subscribed.
- Existing LiveDataStore / analytics / snapshots / alerts / frontend unchanged.
"""
import os
import time
import threading
import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple, Callable, Any

logger = logging.getLogger(__name__)

try:
    from SmartApi.smartWebSocketV2 import SmartWebSocketV2
    SWS_AVAILABLE = True
except ImportError:
    SWS_AVAILABLE = False
    logger.warning("[SubMgr] smartapi-python not installed")


class Tier(Enum):
    TIER_1 = 1      # NIFTY, SENSEX — full real-time analytics, sacred capacity
    TIER_2 = 2      # Full stock analytics with Greeks/GEX (fat window)
    TIER_3 = 3      # Lightweight scanner — no continuous Greeks/GEX


class ConnectionStatus(str, Enum):
    IDLE = "idle"
    CONNECTING = "connecting"
    OPEN = "open"
    RECONNECTING = "reconnecting"
    CLOSED = "closed"


@dataclass(frozen=True)
class TokenRequirement:
    token: str
    exchange_type: int          # 1=NSE, 2=NFO, 3=BSE, 4=BFO
    instrument_name: str
    tier: Tier
    group_id: str
    mode: int                   # 1=LTP, 3=full tick
    metadata: Optional[Dict[str, Any]] = field(default=None, compare=False)

    def key(self) -> Tuple[int, str, int]:
        return (self.exchange_type, self.token, self.mode)


@dataclass
class TokenGroup:
    group_id: str
    tier: Tier
    instrument_name: str
    tokens: Set[TokenRequirement] = field(default_factory=set)
    is_active: bool = False


@dataclass
class _ConnectionSlot:
    slot_id: int
    max_capacity: int
    status: ConnectionStatus = ConnectionStatus.IDLE
    ws: Any = None
    subscribed: Set[TokenRequirement] = field(default_factory=set)
    thread: Optional[threading.Thread] = None
    lock: threading.RLock = field(default_factory=threading.RLock)


class SubscriptionManager:
    """Owns all WebSocket connections. Modules register TokenGroups; the manager
    decides WHERE tokens live and keeps per-connection counts under the cap."""

    def __init__(self, auth_manager,
                 capacity_per_connection: Optional[int] = None,
                 max_connections: Optional[int] = None,
                 batch_size: Optional[int] = None):
        self.auth_manager = auth_manager
        self.capacity = capacity_per_connection or int(os.getenv("WS_CAPACITY_PER_CONNECTION", "990"))
        self.max_connections = max_connections or int(os.getenv("WS_MAX_CONNECTIONS", "3"))
        self.batch_size = batch_size or int(os.getenv("WS_BATCH_SIZE", "50"))
        # Delay between subscribe batches — prevents the burst that gets the
        # connection dropped (SSLEOFError) when hundreds of tokens flush at once
        self.flush_batch_delay = float(os.getenv("WS_FLUSH_BATCH_DELAY", "0.25"))

        self.groups: Dict[str, TokenGroup] = {}
        self.token_map: Dict[Tuple[int, str, int], TokenRequirement] = {}
        self._token_slot: Dict[Tuple[int, str, int], _ConnectionSlot] = {}
        self.handlers: Dict[str, Callable] = {}        # token str -> tick handler
        self.slots: List[_ConnectionSlot] = []
        self._slots_by_id: Dict[int, _ConnectionSlot] = {}

        self.lock = threading.RLock()
        self.running = False
        self._closing = threading.Event()   # intentional shutdown — reconnect must not fire
        self._slot_counter = 0

    # ─────────────────────────────────────────────────────────
    # Lifecycle
    # ─────────────────────────────────────────────────────────
    def start(self):
        self.running = True
        self._ensure_slot()
        logger.info(f"[SubMgr] Started. capacity/slot={self.capacity}, max_connections={self.max_connections}")

    def wait_until_open(self, timeout: float = 20.0) -> bool:
        """Block until any slot is OPEN (or timeout). Lets the adapter register
        groups AFTER the handshake completes instead of competing with it."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                if any(s.status == ConnectionStatus.OPEN for s in self.slots):
                    return True
            time.sleep(0.5)
        return False

    def stop(self):
        # PHASE 1: set the closing state FIRST — every reconnect/resubscribe
        # handler checks it and exits. Only then touch the sockets.
        logger.info("[SubMgr] Shutdown state set — reconnect/resubscribe disabled")
        self._closing.set()
        self.running = False
        # PHASE 2: close WebSockets (our patched on_close sees _closing and
        # skips the SDK's internal resubscribe), then join slot threads.
        for slot in list(self.slots):
            try:
                if slot.ws:
                    slot.ws.close_connection()
            except Exception as e:
                logger.debug(f"[SubMgr] Slot {slot.slot_id} close error: {e}")
        for slot in list(self.slots):
            if slot.thread:
                slot.thread.join(timeout=5)
            slot.status = ConnectionStatus.CLOSED
        logger.info("[SubMgr] All slots stopped")

    # ─────────────────────────────────────────────────────────
    # Public API — groups & handlers
    # ─────────────────────────────────────────────────────────
    def bind_handler(self, token: str, handler: Callable):
        with self.lock:
            self.handlers[token] = handler

    def register_group(self, group: TokenGroup) -> bool:
        """Register a group and subscribe it. Tier 1 may spill across slots.
        Tier 2 is ATOMIC: if the full group doesn't fit anywhere, nothing is
        subscribed and is_active stays False (retry later)."""
        with self.lock:
            self.groups[group.group_id] = group

        if group.tier == Tier.TIER_1:
            subbed, unplaced = self._subscribe_tokens(group.tokens)
            group.is_active = len(unplaced) == 0
            if unplaced:
                logger.error(f"[SubMgr] Tier-1 group '{group.group_id}' partially placed "
                             f"({len(unplaced)} unplaced) — raising capacity warning")
            return group.is_active

        # Tier 2 — atomic check first
        if not self._group_fits(group.tokens):
            group.is_active = False
            logger.warning(f"[SubMgr] Tier-2 group '{group.group_id}' ({len(group.tokens)} tokens) "
                           f"does not fit in remaining capacity. Deferred — will retry.")
            return False
        subbed, unplaced = self._subscribe_tokens(group.tokens)
        group.is_active = len(unplaced) == 0
        return group.is_active

    def unregister_group(self, group_id: str):
        with self.lock:
            group = self.groups.pop(group_id, None)
        if group:
            self._unsubscribe_tokens(set(group.tokens))

    def update_group_tokens(self, group_id: str, new_tokens: Set[TokenRequirement]) -> Dict[str, int]:
        """Steady-state delta for dynamic windows (ATM moved).
        Asymmetric policy: subscribe everything that fits, unsubscribe leavers."""
        with self.lock:
            group = self.groups.get(group_id)
            if group is None:
                return {"subbed": 0, "unsubbed": 0, "unplaced": 0}
            old_tokens = set(group.tokens)

        leavers = old_tokens - new_tokens
        joiners = {t for t in new_tokens if t.key() not in self.token_map}

        _, unplaced = self._subscribe_tokens(joiners)
        self._unsubscribe_tokens(leavers)

        with self.lock:
            group.tokens = {t for t in new_tokens if t.key() in self.token_map}
            return {"subbed": len(joiners) - len(unplaced), "unsubbed": len(leavers), "unplaced": len(unplaced)}

    def is_token_active(self, token: str, exchange_type: int, mode: int) -> bool:
        with self.lock:
            return (exchange_type, token, mode) in self.token_map

    @property
    def any_open(self) -> bool:
        with self.lock:
            return any(s.status == ConnectionStatus.OPEN for s in self.slots)

    def total_subscribed(self) -> int:
        with self.lock:
            return len(self.token_map)

    def usage_by_instrument(self) -> Dict[str, int]:
        """Active token count per instrument — feeds Settings > Connections."""
        with self.lock:
            usage: Dict[str, int] = {}
            for req in self.token_map.values():
                usage[req.instrument_name] = usage.get(req.instrument_name, 0) + 1
            return usage

    def stats(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "running": self.running,
                "capacity_per_connection": self.capacity,
                "max_connections": self.max_connections,
                "total_subscribed": len(self.token_map),
                "total_capacity": len(self.slots) * self.capacity,
                "slots": [
                    {"slot_id": s.slot_id, "status": s.status.value, "subscribed": len(s.subscribed),
                     "capacity": s.max_capacity}
                    for s in self.slots
                ],
                "groups": {
                    "total": len(self.groups),
                    "active": sum(1 for g in self.groups.values() if g.is_active),
                },
            }

    # ─────────────────────────────────────────────────────────
    # Capacity / placement internals
    # ─────────────────────────────────────────────────────────
    def _create_slot(self) -> _ConnectionSlot:
        self._slot_counter += 1
        slot = _ConnectionSlot(slot_id=self._slot_counter, max_capacity=self.capacity)
        self.slots.append(slot)
        self._slots_by_id[slot.slot_id] = slot
        slot.thread = threading.Thread(target=self._slot_loop, args=(slot,), daemon=True,
                                       name=f"ws-slot-{slot.slot_id}")
        slot.thread.start()
        logger.info(f"[SubMgr] Created connection slot #{slot.slot_id} (cap {self.capacity})")
        return slot

    def _ensure_slot(self) -> _ConnectionSlot:
        with self.lock:
            if not self.slots:
                return self._create_slot()
            return self.slots[0]

    def _find_slot_with_capacity_locked(self, needed: int) -> Optional[_ConnectionSlot]:
        for slot in self.slots:
            if len(slot.subscribed) + needed <= slot.max_capacity:
                return slot
        if len(self.slots) < self.max_connections:
            new_slot = self._create_slot()
            return new_slot
        return None

    def _remaining_capacity_locked(self) -> int:
        remaining = sum(max(0, s.max_capacity - len(s.subscribed)) for s in self.slots)
        remaining += (self.max_connections - len(self.slots)) * self.capacity
        return remaining

    def _group_fits(self, tokens: Set[TokenRequirement]) -> bool:
        with self.lock:
            needed = len({t.key() for t in tokens if t.key() not in self.token_map})
            return needed <= self._remaining_capacity_locked()

    # ─────────────────────────────────────────────────────────
    # Subscribe / unsubscribe with per-slot batching
    # ─────────────────────────────────────────────────────────
    def _subscribe_tokens(self, tokens: Set[TokenRequirement]) -> Tuple[int, List[TokenRequirement]]:
        if not tokens:
            return 0, []
        unplaced: List[TokenRequirement] = []
        pending_flush: Dict[int, List[TokenRequirement]] = {}
        with self.lock:
            self._ensure_slot()
            for t in sorted(tokens, key=lambda x: (x.exchange_type, x.mode, x.token)):
                if t.key() in self.token_map:
                    continue  # global dedup
                slot = self._find_slot_with_capacity_locked(1)
                if slot is None:
                    unplaced.append(t)
                    continue
                slot.subscribed.add(t)
                self.token_map[t.key()] = t
                self._token_slot[t.key()] = slot
                pending_flush.setdefault(slot.slot_id, []).append(t)
        # Flush outside the global lock; deferred automatically if slot not open yet
        for slot_id, reqs in pending_flush.items():
            slot = self._slots_by_id[slot_id]
            if slot.status == ConnectionStatus.OPEN and slot.ws is not None:
                self._flush_subscribe(slot, reqs)
        return len(tokens) - len(unplaced), unplaced

    def _unsubscribe_tokens(self, tokens: Set[TokenRequirement]):
        if not tokens:
            return
        pending: Dict[int, List[TokenRequirement]] = {}
        with self.lock:
            for t in tokens:
                slot = self._token_slot.pop(t.key(), None)
                self.token_map.pop(t.key(), None)
                if slot is None:
                    continue
                existing = next((x for x in slot.subscribed if x.key() == t.key()), None)
                if existing is not None:
                    slot.subscribed.remove(existing)
                pending.setdefault(slot.slot_id, []).append(t)
        for slot_id, reqs in pending.items():
            slot = self._slots_by_id[slot_id]
            if slot.status == ConnectionStatus.OPEN and slot.ws is not None:
                self._flush_unsubscribe(slot, reqs)

    def _flush_subscribe(self, slot: _ConnectionSlot, tokens: List[TokenRequirement]):
        by_key: Dict[Tuple[int, int], List[TokenRequirement]] = {}
        for t in tokens:
            by_key.setdefault((t.exchange_type, t.mode), []).append(t)
        for (exchange_type, mode), reqs in by_key.items():
            tok_list = [r.token for r in reqs]
            for i in range(0, len(tok_list), self.batch_size):
                batch = tok_list[i:i + self.batch_size]
                try:
                    slot.ws.subscribe(f"s{slot.slot_id}_{exchange_type}_{mode}_{i // self.batch_size}", mode,
                                      [{"exchangeType": exchange_type, "tokens": batch}])
                    logger.debug(f"[SubMgr] Slot {slot.slot_id}: subscribed {len(batch)} tokens (exch={exchange_type}, mode={mode})")
                except Exception as e:
                    logger.error(f"[SubMgr] Slot {slot.slot_id} subscribe error: {e}")
                # Pace the burst — Angel One drops connections flooded with
                # back-to-back subscribe frames (SSLEOFError / BAD_LENGTH)
                if self.flush_batch_delay > 0:
                    time.sleep(self.flush_batch_delay)

    def _flush_unsubscribe(self, slot: _ConnectionSlot, tokens: List[TokenRequirement]):
        by_key: Dict[Tuple[int, int], List[TokenRequirement]] = {}
        for t in tokens:
            by_key.setdefault((t.exchange_type, t.mode), []).append(t)
        for (exchange_type, mode), reqs in by_key.items():
            for t in reqs:
                try:
                    slot.ws.unsubscribe(f"u{slot.slot_id}_{t.token}", mode,
                                        [{"exchangeType": exchange_type, "tokens": [t.token]}])
                except Exception as e:
                    logger.debug(f"[SubMgr] Slot {slot.slot_id} unsubscribe error for {t.token}: {e}")

    # ─────────────────────────────────────────────────────────
    # Connection slot threads — connect, reconnect, restore
    # ─────────────────────────────────────────────────────────
    def _patch_ws_close(self, ws, slot):
        """SDK compatibility shim for the on_close signature mismatch.

        Older smartapi-python defines _on_close(self, wsapp) (2 args) but newer
        websocket-client invokes it with (wsapp, close_status_code, close_msg)
        (4 args) -> TypeError inside the SDK. We wrap the bound method so the
        SDK's own logic runs with the arg count it accepts, then our handler
        runs exactly once. During intentional shutdown the SDK close logic is
        bypassed entirely so its internal resubscribe/reconnect never fires.
        """
        import types
        orig_close = getattr(ws, "_on_close", None)

        def _close_compat(*args, **kwargs):
            if self._closing.is_set() or not self.running:
                slot.status = ConnectionStatus.CLOSED
                return
            if orig_close is not None:
                try:
                    orig_close(*args, **kwargs)
                except TypeError:
                    try:
                        orig_close(*args[:1])
                    except Exception as e2:
                        logger.error(f"[SubMgr] SDK on_close error: {e2}")
                except Exception as e2:
                    logger.error(f"[SubMgr] SDK on_close error: {e2}")
            self._on_close(slot)

        ws._on_close = types.MethodType(_close_compat, ws)

    def _slot_loop(self, slot: _ConnectionSlot):
        retries = 0
        while self.running and not self._closing.is_set():
            try:
                if not SWS_AVAILABLE:
                    logger.error("[SubMgr] SmartApi unavailable — slot thread exiting")
                    return
                jwt = self.auth_manager.get_valid_jwt()
                feed = self.auth_manager.get_valid_feed_token()
                slot.status = ConnectionStatus.CONNECTING
                try:
                    # max_retry_attempt caps the library's OWN resubscribe loop so
                    # it doesn't fight our slot-level reconnect
                    ws = SmartWebSocketV2(
                        auth_token=jwt, api_key=self.auth_manager.api_key,
                        client_code=self.auth_manager.client_code, feed_token=feed,
                        max_retry_attempt=2,
                    )
                except TypeError:  # older smartapi-python without this param
                    ws = SmartWebSocketV2(
                        auth_token=jwt, api_key=self.auth_manager.api_key,
                        client_code=self.auth_manager.client_code, feed_token=feed,
                    )
                slot.ws = ws
                self._patch_ws_close(ws, slot)   # private _on_close wrapped (signature fix + shutdown guard)
                ws.on_open = lambda w, *a, s=slot: self._on_open(s)
                ws.on_data = lambda w, m, *a: self._on_data(w, m)
                ws.on_error = lambda w, e, *a, s=slot: self._on_error(s, e)
                logger.info(f"[SubMgr] Slot {slot.slot_id} connecting...")
                ws.connect()  # blocks until closed
                retries = 0
            except Exception as e:
                if self._closing.is_set():
                    break
                logger.error(f"[SubMgr] Slot {slot.slot_id} error: {e}")
            if self._closing.is_set() or not self.running:
                break
            slot.status = ConnectionStatus.RECONNECTING
            retries += 1
            delay = min(2 ** min(retries, 5), 30)
            logger.info(f"[SubMgr] Slot {slot.slot_id} reconnecting in {delay}s (attempt {retries})")
            time.sleep(delay)
        slot.status = ConnectionStatus.CLOSED
        logger.info(f"[SubMgr] Slot {slot.slot_id} thread exited")

    def _on_open(self, slot: _ConnectionSlot):
        slot.status = ConnectionStatus.OPEN
        with slot.lock:
            tokens = list(slot.subscribed)
        logger.info(f"[SubMgr] Slot {slot.slot_id} OPEN — restoring {len(tokens)} subscriptions")
        if tokens:
            self._flush_subscribe(slot, tokens)

    def _on_data(self, wsapp, message):
        try:
            if not isinstance(message, dict):
                return
            token = str(message.get("token", ""))
            with self.lock:
                handler = self.handlers.get(token)
            if handler:
                handler(message)
        except Exception as e:
            logger.error(f"[SubMgr] Tick routing error: {e}")

    def _on_error(self, slot: _ConnectionSlot, error):
        logger.error(f"[SubMgr] Slot {slot.slot_id} error: {error}")
        slot.status = ConnectionStatus.RECONNECTING

    def _on_close(self, slot: _ConnectionSlot):
        logger.info(f"[SubMgr] Slot {slot.slot_id} closed")
        slot.status = ConnectionStatus.RECONNECTING
