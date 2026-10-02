/**
 * Shared in-memory cache for GET /api/instruments — dedupes concurrent
 * first-callers (single in-flight promise) and serves repeats for 60s.
 */
let cached: { data: any; ts: number } | null = null;
let inflight: Promise<any> | null = null;
const TTL_MS = 60_000;

export async function fetchInstruments(): Promise<any> {
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;
  if (!inflight) {
    inflight = fetch('/api/instruments')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        cached = { data, ts: Date.now() };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
