export type OptionChainColumnKey =
  | 'oiChange'
  | 'oiChangePct'
  | 'volume'
  | 'ltp'
  | 'oi'
  | 'iv'
  | 'delta'
  | 'gamma'
  | 'buildup';

export type OptionChainColumnVisibility = Record<OptionChainColumnKey, boolean>;

export const COMPACT_OPTION_CHAIN_COLUMNS: OptionChainColumnVisibility = {
  oiChange: true,
  oiChangePct: true,
  volume: true,
  ltp: true,
  oi: true,
  iv: false,
  delta: false,
  gamma: false,
  buildup: true,
};

export const FULL_OPTION_CHAIN_COLUMNS: OptionChainColumnVisibility = {
  oiChange: true,
  oiChangePct: true,
  volume: true,
  ltp: true,
  oi: true,
  iv: true,
  delta: true,
  gamma: true,
  buildup: true,
};

const STORAGE_KEY = 'option_chain_columns_v1';
const HIDE_ZERO_VOLUME_STRIKES_KEY = 'option_chain_hide_zero_volume_strikes_v1';
const HIDE_ZERO_VOLUME_EVENT = 'option-chain-hide-zero-volume-changed';

export function loadHideZeroVolumeStrikes(): boolean {
  try {
    const saved = localStorage.getItem(HIDE_ZERO_VOLUME_STRIKES_KEY);
    return saved === null ? true : saved === 'true';
  } catch {
    return true;
  }
}

export function saveHideZeroVolumeStrikes(enabled: boolean): void {
  try {
    localStorage.setItem(HIDE_ZERO_VOLUME_STRIKES_KEY, String(enabled));
  } catch {
    // Storage restrictions must not break the option chain.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(HIDE_ZERO_VOLUME_EVENT, { detail: enabled }));
  }
}

export { MIN_ELIGIBLE_VOLUME, hasEligibleVolumeContract, shouldHideStrikeForVolume } from '../zeroVolumePolicy.js';

export { HIDE_ZERO_VOLUME_EVENT };

export function loadOptionChainColumns(fullMode: boolean): OptionChainColumnVisibility {
  const fallback = fullMode ? FULL_OPTION_CHAIN_COLUMNS : COMPACT_OPTION_CHAIN_COLUMNS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...fallback };
    const saved = JSON.parse(raw) as Partial<OptionChainColumnVisibility>;
    return { ...fallback, ...saved };
  } catch {
    return { ...fallback };
  }
}

export function saveOptionChainColumns(columns: OptionChainColumnVisibility): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(columns));
  } catch {
    // Private browsing or storage restrictions should not break the chain UI.
  }
}

export const OPTION_CHAIN_COLUMN_LABELS: Record<OptionChainColumnKey, string> = {
  oiChange: 'OI Change',
  oiChangePct: 'OI Change %',
  volume: 'Volume',
  ltp: 'LTP',
  oi: 'Open Interest',
  iv: 'Implied Volatility (IV)',
  delta: 'Delta',
  gamma: 'Gamma',
  buildup: 'Buildup + interpretation',
};
