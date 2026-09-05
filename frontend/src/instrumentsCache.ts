/**
 * Shared in-memory cache for GET /api/instruments.
 *
 * App.tsx (instrument-kind/session loader, polls every 60s) and
 * InstrumentSelect.tsx (replay-controls dropdown) both fetch this at
 * startup — this cache dedupes the burst so the endpoint is hit once.
 */
let cached: { data: any; ts: number } | null = null;
const TTL_MS = 60_000;

export async function fetchInstruments(): Promise<any> {
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;
  const res = await fetch('/api/instruments');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  cached = { data, ts: Date.now() };
  return data;
}
