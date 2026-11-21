/**
 * Shared per-contract volume eligibility for the option chain, OI walls and GEX.
 *
 * Contracts with volume below 2 (including 0, 1, missing or invalid volume)
 * are not actionable. A strike remains visible when at least one side has
 * eligible volume; the inactive side is omitted from the displayed row.
 * Raw snapshot records are never modified.
 */
export const MIN_ELIGIBLE_VOLUME = 2;

export function hasEligibleVolumeContract(contract) {
  const volume = contract?.volume;
  return typeof volume === 'number' &&
    Number.isFinite(volume) &&
    volume >= MIN_ELIGIBLE_VOLUME;
}

export function shouldHideStrikeForVolume(ce, pe) {
  return !hasEligibleVolumeContract(ce) && !hasEligibleVolumeContract(pe);
}
