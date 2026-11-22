/**
 * Shared per-contract volume eligibility for the option chain, OI walls and GEX.
 *
 * An eligible contract must have a verified volume tick and volume >= 2.
 * Migrated historical rows have volume_valid=0 because their original feed
 * receipt cannot be reconstructed; their stored volume number is not enough.
 */
export const MIN_ELIGIBLE_VOLUME = 2;

export function hasEligibleVolumeContract(contract) {
  const volume = contract?.volume;
  const valid = contract?.volume_valid === true || contract?.volume_valid === 1;
  return valid && typeof volume === 'number' &&
    Number.isFinite(volume) &&
    volume >= MIN_ELIGIBLE_VOLUME;
}

export function shouldHideStrikeForVolume(ce, pe) {
  return !hasEligibleVolumeContract(ce) && !hasEligibleVolumeContract(pe);
}
