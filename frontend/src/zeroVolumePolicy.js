/**
 * Separate display filtering from analytical volume eligibility.
 *
 * OI walls and GEX use hasEligibleVolumeContract() and require a verified
 * volume tick >= 2. The option-chain display must not discard historical
 * rows merely because older snapshots have no reconstructable volume_valid
 * provenance. Only hide a strike when BOTH sides have a verified zero-volume
 * tick; unknown/unverified history stays visible.
 */
export const MIN_ELIGIBLE_VOLUME = 2;

export function hasEligibleVolumeContract(contract) {
  const volume = contract?.volume;
  const valid = contract?.volume_valid === true || contract?.volume_valid === 1;
  return valid && typeof volume === 'number' &&
    Number.isFinite(volume) &&
    volume >= MIN_ELIGIBLE_VOLUME;
}

/**
 * Legacy replay snapshots can have volume_valid=0 after migration even when
 * their saved numeric volume is useful. Replay still enforces the same >=2
 * cutoff, but does not require provenance that cannot be reconstructed.
 */
export function hasStoredEligibleVolumeContract(contract) {
  const volume = contract?.volume;
  return typeof volume === 'number' &&
    Number.isFinite(volume) &&
    volume >= MIN_ELIGIBLE_VOLUME;
}

export function isConfirmedZeroVolume(contract) {
  const volume = contract?.volume;
  const valid = contract?.volume_valid === true || contract?.volume_valid === 1;
  return valid && typeof volume === 'number' && Number.isFinite(volume) && volume === 0;
}

export function shouldHideStrikeForVolume(ce, pe) {
  return isConfirmedZeroVolume(ce) && isConfirmedZeroVolume(pe);
}
