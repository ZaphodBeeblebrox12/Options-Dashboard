/**
 * Shared zero-volume policy for desktop and mobile option chains.
 *
 * volume_valid was added after older snapshots had already been stored.
 * SQLite migration defaults those old rows to 0, which means provenance was
 * not recorded, not that the exchange reported a non-zero/unknown value.
 *
 * For replay only, a legacy zero is eligible when that contract has both a
 * positive persisted OI and LTP, and no source-age measurement (the shape of
 * pre-provenance rows). Empty/unpopulated sides and rows with new freshness
 * telemetry remain unverified. This inference is deliberately never used for
 * live payloads.
 */
function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isConfirmedZeroVolume(side, allowLegacyReplay = false) {
  if (!side || side.volume !== 0) return false;

  if (side.volume_valid === true || side.volume_valid === 1) {
    return true;
  }

  return (
    allowLegacyReplay &&
    (side.volume_valid === false || side.volume_valid === 0) &&
    side.source_age_sec == null &&
    isPositiveNumber(side.oi) &&
    isPositiveNumber(side.ltp)
  );
}

export function shouldHideZeroVolumeStrike(ce, pe, allowLegacyReplay = false) {
  return (
    isConfirmedZeroVolume(ce, allowLegacyReplay) &&
    isConfirmedZeroVolume(pe, allowLegacyReplay)
  );
}
