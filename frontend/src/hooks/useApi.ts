import { useState, useEffect, useCallback } from 'react';

const API_BASE = '';

export function useApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchJson = useCallback(async (endpoint: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${endpoint}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { fetchJson, loading, error };
}

export function useSnapshots(date: string, index: string) {
  const [timestamps, setTimestamps] = useState<string[]>([]);
  const { fetchJson } = useApi();

  useEffect(() => {
    if (!date || !index) return;

    const load = () => {
      fetchJson(`/api/snapshots?date=${date}&index=${index}`).then((data) => {
        if (data?.timestamps) setTimestamps(data.timestamps);
      });
    };

    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [date, index, fetchJson]);

  return timestamps;
}

export function useSnapshot(timestamp: string | null, index: string) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const { fetchJson } = useApi();

  useEffect(() => {
    if (!timestamp || !index) return;
    fetchJson(`/api/snapshot/${encodeURIComponent(timestamp)}?index=${index}`).then((data) => {
      if (data) setSnapshot(data);
    });
  }, [timestamp, index, fetchJson]);

  return snapshot;
}

export function useGexHistory(date: string, index: string) {
  const [data, setData] = useState<any[]>([]);
  const { fetchJson } = useApi();

  useEffect(() => {
    if (!date || !index) return;

    const load = () => {
      fetchJson(`/api/gex-history?date=${date}&index=${index}`).then((res) => {
        if (res?.timeseries) setData(res.timeseries);
      });
    };

    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [date, index, fetchJson]);

  return data;
}

export function useStrikeHistory(strike: number | null, date: string, index: string) {
  const [data, setData] = useState<any[]>([]);
  const { fetchJson } = useApi();

  useEffect(() => {
    if (!strike || !date || !index) return;

    const load = () => {
      fetchJson(`/api/history/${strike}?date=${date}&index=${index}`).then((res) => {
        if (res?.timeseries) setData(res.timeseries);
      });
    };

    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [strike, date, index, fetchJson]);

  return data;
}

export function useGexByStrike(timestamp: string | null, index: string) {
  const [data, setData] = useState<any[]>([]);
  const { fetchJson } = useApi();

  useEffect(() => {
    if (!timestamp || !index) return;

    const load = () => {
      fetchJson(`/api/gex-by-strike?timestamp=${encodeURIComponent(timestamp)}&index=${index}`).then((res) => {
        if (res) setData(res);
      });
    };

    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [timestamp, index, fetchJson]);

  return data;
}

export function useAvailableDates(index: string) {
  const [dates, setDates] = useState<string[]>([]);
  const { fetchJson } = useApi();

  useEffect(() => {
    if (!index) return;

    const load = () => {
      fetchJson(`/api/available-dates?index=${index}`).then((res) => {
        if (res?.dates) setDates(res.dates);
      });
    };

    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [index, fetchJson]);

  return dates;
}
