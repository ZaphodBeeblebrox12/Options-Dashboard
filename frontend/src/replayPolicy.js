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
export function resolveLiveStatus({
  liveMode,
  marketOpen,
  connected,
  hasLiveData,
  hasFreshMarketSources,
  hasError,
}) {
  if (!liveMode) return 'REPLAY';
  if (!marketOpen) return 'CLOSED';
  if (!connected || !hasLiveData) return 'NO FEED';
  if (!hasFreshMarketSources || hasError) return 'STALE';
  return 'LIVE';
}
