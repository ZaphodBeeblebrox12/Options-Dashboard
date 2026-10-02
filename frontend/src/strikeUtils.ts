/**
 * Shared ATM (nearest-strike) definition — the ONLY client-side fallback.
 * Matches the backend `_nearest_strike` in stock_streamer.py exactly:
 * nearest listed strike to spot, ties resolve to the LOWER strike.
 * Returns null (never the raw spot price) when inputs are missing.
 * Primary source of truth is the backend payload `atm` field; this util is
 * only used when the payload does not carry one (e.g. replay snapshots).
 */
export function nearestStrike(spot: number | null | undefined, strikes: number[] | null | undefined): number | null {
  if (spot == null || !strikes || strikes.length === 0) return null;
  const sorted = [...strikes].sort((a, b) => a - b);
  let best = sorted[0];
  for (const s of sorted) {
    if (Math.abs(s - spot) < Math.abs(best - spot)) best = s;
  }
  return best;
}
