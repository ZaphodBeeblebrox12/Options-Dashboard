/**
 * Shared eligibility rule for inactive option strikes far from spot.
 *
 * A strike is excluded from row display (when the display setting is enabled)
 * and actionable wall selection when it is at least 5% away from spot and
 * both CE and PE have an explicit numeric zero volume. Raw snapshots and
 * contract OI values are never modified; provenance flags do not override an
 * explicit numeric zero volume.
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
