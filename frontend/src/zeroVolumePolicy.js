/**
 * Display-only filter for inactive option strikes far from spot.
 *
 * A strike is hidden only when it is at least 5% away from spot and both
 * its CE and PE contracts have an explicit numeric zero volume. This applies
 * equally to live and replay data; volume_valid/OI/LTP provenance is irrelevant.
 * The underlying options data and all OI calculations remain untouched.
 */
export const ZERO_VOLUME_OTM_THRESHOLD_PCT = 5;

export function shouldHideZeroVolumeStrike(ce, pe, strike, spot) {
  if (
    typeof strike !== 'number' ||
    !Number.isFinite(strike) ||
    typeof spot !== 'number' ||
    !Number.isFinite(spot) ||
    spot <= 0 ||
    strike <= 0
  ) {
    return false;
  }

  const distancePct = (Math.abs(strike - spot) / spot) * 100;
  if (distancePct < ZERO_VOLUME_OTM_THRESHOLD_PCT) return false;

  return ce?.volume === 0 && pe?.volume === 0;
}
