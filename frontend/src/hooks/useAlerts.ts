import { useState, useEffect, useCallback, useRef } from 'react';

const API_BASE = '';

export interface AlertRuleConfig {
  rule_type: string;
  enabled: boolean;
  cooldown_seconds: number;
  channels: string[];
  sound_enabled: boolean;
  sound_choice: string;
  custom_sound_id: string | null;
  telegram_enabled: boolean;
}

export interface TelegramConfig {
  enabled: boolean;
  bot_token: string;
  chat_id: string;
}

export interface SoundSettings {
  master_enabled: boolean;
  volume_percent: number;
}

export interface CustomSound {
  id: string;
  name: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface AlertSettings {
  rules: AlertRuleConfig[];
  telegram: TelegramConfig;
  sound: SoundSettings;
  custom_sounds: CustomSound[];
  toast_duration_ms: number;  // ← NEW
}

export interface AlertHistoryEntry {
  id: number;
  timestamp: string;
  index_name: string;
  rule_type: string;
  rule_name: string;
  spot: number | null;
  atm_strike: number | null;
  max_ce_oi_strike: number | null;
  max_pe_oi_strike: number | null;
  max_negative_gex_strike: number | null;
  net_gex: number | null;
  futures_spread: number | null;
  channels_fired: string;
  market_state: string;
  created_at: string;
}

export interface AlertFiring {
  timestamp: string;
  index_name: string;
  rule_type: string;
  rule_name: string;
  spot: number | null;
  atm_strike: number | null;
  max_ce_oi_strike: number | null;
  max_pe_oi_strike: number | null;
  max_negative_gex_strike: number | null;
  net_gex: number | null;
  channels_fired: string[];
}

export function useAlertSettings() {
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/alerts/settings`);
      if (res.ok) {
        const data = await res.json();
        // Ensure default if backend doesn't send it yet
        if (data.toast_duration_ms === undefined) data.toast_duration_ms = 6000;
        setSettings(data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const saveSettings = useCallback(async (newSettings: AlertSettings) => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/alerts/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      });
      if (res.ok) {
        setSettings(newSettings);
        return true;
      }
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  return { settings, loading, saving, fetchSettings, saveSettings };
}

export function useAlertHistory(index?: string, date?: string, page: number = 1) {
  const [history, setHistory] = useState<AlertHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('page_size', '50');
      if (index) params.set('index', index);
      if (date) params.set('date', date);
      const res = await fetch(`${API_BASE}/api/alerts/history?${params}`);
      if (res.ok) {
        const data = await res.json();
        setHistory(data.entries || []);
        setTotal(data.total || 0);
      }
    } finally {
      setLoading(false);
    }
  }, [index, date, page]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return { history, total, loading, fetchHistory };
}

export function useSounds() {
  const [sounds, setSounds] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [loading, setLoading] = useState(false);

  const fetchSounds = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/alerts/sounds`);
      if (res.ok) {
        const data = await res.json();
        setSounds(data.sounds || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const uploadSound = useCallback(async (file: File, name: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    const res = await fetch(`${API_BASE}/api/alerts/sounds/upload`, {
      method: 'POST',
      body: form,
    });
    if (res.ok) {
      await fetchSounds();
      return true;
    }
    return false;
  }, [fetchSounds]);

  const deleteSound = useCallback(async (soundId: string) => {
    const res = await fetch(`${API_BASE}/api/alerts/sounds/${soundId}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      await fetchSounds();
      return true;
    }
    return false;
  }, [fetchSounds]);

  const playSound = useCallback(async (soundId: string, volume: number = 0.8) => {
    try {
      const res = await fetch(`${API_BASE}/api/alerts/sounds/${soundId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.base64) return;

      const audio = new Audio(`data:audio/wav;base64,${data.base64}`);
      audio.volume = volume;
      await audio.play();
    } catch (e) {
      console.error('[Sound] Playback failed:', e);
    }
  }, []);

  useEffect(() => {
    fetchSounds();
  }, [fetchSounds]);

  return { sounds, loading, fetchSounds, uploadSound, deleteSound, playSound };
}

export function useAlertNotifications() {
  const [toasts, setToasts] = useState<AlertFiring[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const addToast = useCallback((alert: AlertFiring) => {
    setToasts((prev) => [...prev.slice(-4), alert]); // Keep last 5
    // Fallback cleanup — generous enough for any duration up to 15s
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.timestamp !== alert.timestamp));
    }, 20000);
  }, []);

  const removeToast = useCallback((timestamp: string) => {
    setToasts((prev) => prev.filter((t) => t.timestamp !== timestamp));
  }, []);

  const playAlertSound = useCallback(async (soundId: string, volume: number) => {
    try {
      const res = await fetch(`/api/alerts/sounds/${soundId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.base64) return;

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }

      const audio = new Audio(`data:audio/wav;base64,${data.base64}`);
      audio.volume = volume;
      audioRef.current = audio;
      await audio.play();
    } catch (e) {
      console.error('[AlertSound] Playback failed:', e);
    }
  }, []);

  return { toasts, addToast, removeToast, playAlertSound };
}
