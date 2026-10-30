export type LiveStatus = 'REPLAY' | 'CLOSED' | 'NO FEED' | 'STALE' | 'UNVERIFIED' | 'LIVE';

export function canReturnToLive(
  isAtEnd: boolean,
  selectedDate: string,
  marketDate: string,
  marketOpen: boolean
): boolean;

export function isSourceFresh(
  ageSeconds: unknown,
  messageAgeMs: number,
  staleAfterMs: number
): boolean;

export function resolveLiveStatus(input: {
  liveMode: boolean;
  marketOpen: boolean;
  connected: boolean;
  hasLiveData: boolean;
  hasFreshMarketSources: boolean;
  hasStaleMarketSources?: boolean;
  hasUnknownMarketSources?: boolean;
  hasError: boolean;
}): LiveStatus;
