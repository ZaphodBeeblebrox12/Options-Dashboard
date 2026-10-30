/**
 * Select the strongest Call and Put OI concentrations from the loaded
 * expiry chain. A wall is an OI level, not a strike selected by its current
 * relationship to spot. Spot is intentionally absent from this API so
 * crossing a wall cannot make the overlay move.
 *
 * Ties are resolved to the lower strike for deterministic results.
 *
 * @param {Array<{strike:number, option_type:string, oi?:number|null}>|null|undefined} options
 * @returns {{ceWall:number|null, peWall:number|null}}
 */
export function computeOiWalls(options) {
  let ceWall = null;
  let peWall = null;
  let ceOi = Number.NEGATIVE_INFINITY;
  let peOi = Number.NEGATIVE_INFINITY;

  for (const option of Array.isArray(options) ? options : []) {
    if (!option || typeof option !== 'object') continue;

    const strike = Number(option.strike);
    const oi = Number(option.oi ?? 0);
    if (!Number.isFinite(strike) || !Number.isFinite(oi) || oi < 0) continue;

    if (
      option.option_type === 'CE' &&
      (oi > ceOi || (oi === ceOi && (ceWall === null || strike < ceWall)))
    ) {
      ceOi = oi;
      ceWall = strike;
    } else if (
      option.option_type === 'PE' &&
      (oi > peOi || (oi === peOi && (peWall === null || strike < peWall)))
    ) {
      peOi = oi;
      peWall = strike;
    }
  }

  return { ceWall, peWall };
}
