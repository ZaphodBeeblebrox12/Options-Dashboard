/** Pure policies shared by the dashboard and its regression tests. */

export function canReturnToLive(isAtEnd, selectedDate, marketDate, marketOpen) {
  return Boolean(isAtEnd && selectedDate === marketDate && marketOpen);
}

export function isSourceFresh(ageSeconds, messageAgeMs, staleAfterMs) {
  return typeof ageSeconds === 'number' &&
    Number.isFinite(ageSeconds) &&
    ageSeconds >= 0 &&
    typeof messageAgeMs === 'number' &&
    Number.isFinite(messageAgeMs) &&
    messageAgeMs >= 0 &&
    (ageSeconds * 1000 + messageAgeMs) <= staleAfterMs;
}

/**
 * Status of the selected data source, independent of WebSocket connectivity
 * alone. WebSocket connectivity is necessary but not sufficient for LIVE.
 */
/**
 * Resolve the initial Replay date when the selected (usually current) date
 * has no snapshots yet. availableDates is returned newest-first by the API.
 * An explicit user date selection must never be silently changed.
 */
export function resolveInitialReplayDate(selectedDate, availableDates, userSelectedDate = false) {
  if (userSelectedDate || !Array.isArray(availableDates) || availableDates.length === 0) {
    return null;
  }
  if (availableDates.includes(selectedDate)) return null;
  return availableDates[0] || null;
}

export function resolveLiveStatus({
  liveMode,
  marketOpen,
  connected,
  hasLiveData,
  hasFreshMarketSources,
  hasStaleMarketSources = false,
  hasUnknownMarketSources = false,
  hasError,
}) {
  if (!liveMode) return 'REPLAY';
  if (!marketOpen) return 'CLOSED';
  if (!connected || !hasLiveData) return 'NO FEED';
  if (hasError || hasStaleMarketSources) return 'STALE';
  // Missing telemetry is not evidence of a stopped feed. Keep it visibly
  // unverified rather than falsely labelling changing market data as stale.
  if (hasUnknownMarketSources || !hasFreshMarketSources) return 'UNVERIFIED';
  return 'LIVE';
}
