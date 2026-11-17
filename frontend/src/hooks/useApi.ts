import { useState, useEffect, useCallback, useRef } from 'react';

const API_BASE = '';

// ── Simple in-memory cache for replay mode ─────────────────────
const _cache: Record<string, { data: any; ts: number }> = {};
const CACHE_TTL_MS = 60_000;

function _cacheKey(endpoint: string) {
  return endpoint;
}

function _getCached(endpoint: string) {
  const entry = _cache[_cacheKey(endpoint)];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    delete _cache[_cacheKey(endpoint)];
    return null;
  }
  return entry.data;
}

function _setCached(endpoint: string, data: any) {
  _cache[_cacheKey(endpoint)] = { data, ts: Date.now() };
}

export function useApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchJson = useCallback(async (endpoint: string, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data;
    } catch (e: any) {
      if (e.name === 'AbortError') return null;
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { fetchJson, loading, error };
}

// ── useSnapshots ───────────────────────────────────────────────
export function useSnapshots(date: string, index: string, liveMode: boolean) {
  const [timestampState, setTimestampState] = useState<{ key: string; data: string[] }>({ key: '', data: [] });
  const { fetchJson } = useApi();
  const lastGoodRef = useRef<{ key: string; data: string[] } | null>(null);

  useEffect(() => {
    if (!date || !index) return;
    const key = `${date}|${index}`;

    const load = () => {
      fetchJson(`/api/snapshots?date=${date}&index=${index}`).then((data) => {
        if (data?.timestamps) {
          setTimestampState({ key, data: data.timestamps });
          lastGoodRef.current = { key, data: data.timestamps };
        } else if (lastGoodRef.current?.key === key) {
          setTimestampState({ key, data: lastGoodRef.current.data });
        }
      });
    };

    load();
    if (!liveMode) return;
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [date, index, fetchJson, liveMode]);

  return timestampState.key === `${date}|${index}` ? timestampState.data : [];
}

// ── useSnapshot ────────────────────────────────────────────────
// CRITICAL FIX: keyed fallback so a failed seek to a new timestamp
// does not show the previous timestamp's data.
export function useSnapshot(timestamp: string | null, index: string, _liveMode: boolean) {
  const [snapshotEntry, setSnapshotEntry] = useState<{ key: string; data: any } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastGoodRef = useRef<{ key: string; data: any } | null>(null);

  const fetchJson = useCallback(async (endpoint: string, signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e: any) {
      if (e.name === 'AbortError') return null;
      return null;
    }
  }, []);

  useEffect(() => {
    if (!timestamp || !index) {
      setIsLoading(false);
      return;
    }

    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    const endpoint = `/api/snapshot/${encodeURIComponent(timestamp)}?index=${index}`;

    const cached = _getCached(endpoint);
    if (cached) {
      setSnapshotEntry({ key: endpoint, data: cached });
      lastGoodRef.current = { key: endpoint, data: cached };
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    fetchJson(endpoint, abortRef.current.signal).then((data) => {
      setIsLoading(false);
      if (data) {
        _setCached(endpoint, data);
        lastGoodRef.current = { key: endpoint, data };
        setSnapshotEntry({ key: endpoint, data });
      } else if (lastGoodRef.current?.key === endpoint) {
        // Same endpoint failed (e.g. network hiccup while already viewing this ts)
        setSnapshotEntry({ key: endpoint, data: lastGoodRef.current.data });
      }
      // A failed request for a different timestamp never exposes data from
      // the previously selected snapshot.
    });

    return () => {
      abortRef.current?.abort();
    };
  }, [timestamp, index, fetchJson]);

  const currentEndpoint = timestamp && index
    ? `/api/snapshot/${encodeURIComponent(timestamp)}?index=${index}`
    : null;
  const snapshot = currentEndpoint && snapshotEntry?.key === currentEndpoint
    ? snapshotEntry.data
    : null;
  return { snapshot, isLoading };
}

// ── useGexHistory ──────────────────────────────────────────────
export function useGexHistory(date: string, index: string, liveMode: boolean) {
  const [data, setData] = useState<any[]>([]);
  const { fetchJson } = useApi();
  const lastGoodRef = useRef<{ key: string; data: any[] } | null>(null);

  useEffect(() => {
    if (!date || !index) return;
    const key = `${date}|${index}`;

    const load = () => {
      fetchJson(`/api/gex-history?date=${date}&index=${index}`).then((res) => {
        if (res?.timeseries) {
          setData(res.timeseries);
          lastGoodRef.current = { key, data: res.timeseries };
        } else if (lastGoodRef.current?.key === key) {
          setData(lastGoodRef.current.data);
        }
      });
    };

    load();
    if (!liveMode) return;
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [date, index, fetchJson, liveMode]);

  return data;
}

// ── useStrikeHistory ───────────────────────────────────────────
export function useStrikeHistory(strike: number | null, date: string, index: string, liveMode: boolean) {
  const [data, setData] = useState<any[]>([]);
  const { fetchJson } = useApi();
  const abortRef = useRef<AbortController | null>(null);
  const lastGoodRef = useRef<{ key: string; data: any[] } | null>(null);

  useEffect(() => {
    if (!strike || !date || !index) return;
    const key = `${strike}|${date}|${index}`;

    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    const load = () => {
      fetchJson(`/api/history/${strike}?date=${date}&index=${index}`, abortRef.current?.signal).then((res) => {
        if (res?.timeseries) {
          setData(res.timeseries);
          lastGoodRef.current = { key, data: res.timeseries };
        } else if (lastGoodRef.current?.key === key) {
          setData(lastGoodRef.current.data);
        }
      });
    };

    load();
    if (!liveMode) return;
    const interval = setInterval(load, 30000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [strike, date, index, fetchJson, liveMode]);

  return data;
}

// ── useGexByStrike ─────────────────────────────────────────────
export function useGexByStrike(timestamp: string | null, index: string, liveMode: boolean) {
  const [data, setData] = useState<any[]>([]);
  const { fetchJson } = useApi();
  const abortRef = useRef<AbortController | null>(null);
  const lastGoodRef = useRef<{ key: string; data: any[] } | null>(null);

  useEffect(() => {
    if (!timestamp || !index) return;

    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    const endpoint = `/api/gex-by-strike?timestamp=${encodeURIComponent(timestamp)}&index=${index}`;

    const cached = _getCached(endpoint);
    if (cached) {
      setData(cached);
      lastGoodRef.current = { key: endpoint, data: cached };
      return;
    }

    fetchJson(endpoint, abortRef.current.signal).then((res) => {
      if (res) {
        _setCached(endpoint, res);
        lastGoodRef.current = { key: endpoint, data: res };
        setData(res);
      } else if (lastGoodRef.current?.key === endpoint) {
        setData(lastGoodRef.current.data);
      }
    });

    if (!liveMode) return;
    const interval = setInterval(() => {
      fetchJson(endpoint).then((res) => {
        if (res) {
          _setCached(endpoint, res);
          lastGoodRef.current = { key: endpoint, data: res };
          setData(res);
        } else if (lastGoodRef.current?.key === endpoint) {
          setData(lastGoodRef.current.data);
        }
      });
    }, 30000);

    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [timestamp, index, fetchJson, liveMode]);

  return data;
}


// ── useLastKnownSnapshot ───────────────────────────────────────
// Reads /api/current only when LIVE mode is outside the instrument session.
// The endpoint prefers an in-memory snapshot and falls back to the newest
// persisted DB snapshot. The UI must continue to label this data as CLOSED.
export function useLastKnownSnapshot(index: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<any>(null);

  useEffect(() => {
    if (!index || !enabled) {
      setSnapshot(null);
      return;
    }

    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/current?index=${encodeURIComponent(index)}`);
        if (res.status === 404) {
          if (active) setSnapshot(null);
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (active) setSnapshot(data && Array.isArray(data.options) ? data : null);
      } catch {
        // Preserve the last successful snapshot through a transient API error.
      }
    };

    load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [index, enabled]);

  return snapshot;
}

// ── useAvailableDates ──────────────────────────────────────────
export function useAvailableDates(index: string, liveMode: boolean) {
  const [dateState, setDateState] = useState<{ key: string; data: string[] }>({ key: '', data: [] });
  const { fetchJson } = useApi();
  const lastGoodRef = useRef<{ key: string; data: string[] } | null>(null);

  useEffect(() => {
    if (!index) return;
    const key = index;

    const load = () => {
      fetchJson(`/api/available-dates?index=${index}`).then((res) => {
        if (res?.dates) {
          setDateState({ key, data: res.dates });
          lastGoodRef.current = { key, data: res.dates };
        } else if (lastGoodRef.current?.key === key) {
          setDateState({ key, data: lastGoodRef.current.data });
        }
      });
    };

    load();
    if (!liveMode) return;
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [index, fetchJson, liveMode]);

  return dateState.key === index ? dateState.data : [];
}
