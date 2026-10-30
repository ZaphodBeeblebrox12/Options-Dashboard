import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AnalyticsHeader } from './components/AnalyticsHeader';
import { BuildupCard } from './components/BuildupCard';
import { OptionChain } from './components/OptionChain';
import { ReplayControls } from './components/ReplayControls';
import { GexChart } from './components/GexChart';
import { StrikeChart } from './components/StrikeChart';
import { NetGexChart } from './components/NetGexChart';
import { SettingsModal } from './components/SettingsModal';
import { AlertHistoryPanel } from './components/AlertHistory';
import { AlertToastContainer } from './components/AlertToast';
import { useWebSocket } from './hooks/useWebSocket';
import { useSnapshots, useSnapshot, useGexHistory, useStrikeHistory, useGexByStrike, useAvailableDates } from './hooks/useApi';
import { useAlertSettings, useAlertNotifications, AlertFiring } from './hooks/useAlerts';
import { Monitor, AlertTriangle, Info, WifiOff, Bell, Settings, X, ChevronDown } from 'lucide-react';
import { hoursForType, isSessionOpen, fmtSessionRange, getMarketDateIST, InstrumentKind, SessionHours } from './session';
import { canReturnToLive, resolveLiveStatus } from './replayPolicy.js';
import { useIsMobile } from "./components/mobile/useIsMobile";
import MobileApp from "./components/mobile/MobileApp";

const STORAGE_KEY = 'option_chain_view_state';
const HISTORY_LAST_OPENED_KEY = 'history_last_opened_at';
const SCROLL_KEY = 'option_chain_scroll_y';

// Source freshness threshold: every required upstream feed must have
// delivered a tick within 75 seconds. These ages are measured by the backend
// at receipt time, not inferred from when a payload was rebroadcast.
const STALE_AFTER_MS = 75_000;

interface PersistedState {
  selectedIndex: string;
  selectedDate: string;
  currentTimestamp: string | null;
  liveMode: boolean;
  fullMode: boolean;
  selectedStrike: number | null;
}

function loadPersistedState(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function savePersistedState(state: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}
function getLastOpenedHistory(): string {
  try { return localStorage.getItem(HISTORY_LAST_OPENED_KEY) || ''; } catch { return ''; }
}
function saveLastOpenedHistory(ts: string) {
  try { localStorage.setItem(HISTORY_LAST_OPENED_KEY, ts); } catch {}
}


function App() {
  const persisted = loadPersistedState();

  const initialLiveMode = persisted.liveMode ?? true;
  const [selectedIndex, setSelectedIndex] = useState(persisted.selectedIndex || "NIFTY");
  // A restored LIVE state must always point at today's market date in IST.
  // Historical dates are restored only when the persisted mode is REPLAY.
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = getMarketDateIST();
    return initialLiveMode ? today : (persisted.selectedDate || today);
  });
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [fullMode, setFullMode] = useState(persisted.fullMode ?? false);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(persisted.selectedStrike ?? null);
  const [liveMode, setLiveMode] = useState(initialLiveMode);
  const [marketOpenMap, setMarketOpenMap] = useState<Record<string, boolean>>({});
  const [indexKinds, setIndexKinds] = useState<Record<string, InstrumentKind>>({});
  const [wsErrorMap, setWsErrorMap] = useState<Record<string, string | null>>({});
  const [showReconnectBanner, setShowReconnectBanner] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAlertHistory, setShowAlertHistory] = useState(false);
  const [unseenAlertCount, setUnseenAlertCount] = useState(0);
  const [showFeedDetails, setShowFeedDetails] = useState(false);
  const feedDetailsRef = useRef<HTMLDivElement>(null);
  // Re-evaluate feed health even if the WebSocket stops delivering messages.
  const [now, setNow] = useState(() => Date.now());
  const playTimerRef = useRef<ReturnType<typeof setInterval>>();
  const hasRestoredRef = useRef(false);
  const enteringLiveRef = useRef(false);
  const scrollRestoredRef = useRef(false);

  const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
  const { connected, lastMessage } = useWebSocket(wsUrl);

  const isMobile = useIsMobile();

  const timestamps = useSnapshots(selectedDate, selectedIndex, liveMode);
  const currentTimestamp = (currentIndex >= 0 && currentIndex < timestamps.length) ? timestamps[currentIndex] : null;
  const { snapshot, isLoading: snapshotLoading } = useSnapshot(currentTimestamp, selectedIndex, liveMode);
  const gexHistory = useGexHistory(selectedDate, selectedIndex, liveMode);
  const strikeHistory = useStrikeHistory(selectedStrike, selectedDate, selectedIndex, liveMode);
  const gexByStrike = useGexByStrike(liveMode ? null : currentTimestamp, selectedIndex, liveMode);
  const availableDates = useAvailableDates(selectedIndex, liveMode);

  const [liveDataMap, setLiveDataMap] = useState<Record<string, any>>({});
  const [alertScope, setAlertScope] = useState<'viewed' | 'all'>('viewed');
  const { settings: alertSettings } = useAlertSettings();
  const { toasts, addToast, removeToast, playAlertSound } = useAlertNotifications();

  const sessionHours: SessionHours = hoursForType(indexKinds[selectedIndex]);
  const marketOpen = marketOpenMap[selectedIndex] ?? isSessionOpen(sessionHours);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!showFeedDetails) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!feedDetailsRef.current?.contains(event.target as Node)) setShowFeedDetails(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowFeedDetails(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showFeedDetails]);

  useEffect(() => {
    const load = () =>
      fetch('/api/settings')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setAlertScope(d.alert_scope === 'all' ? 'all' : 'viewed'); })
        .catch(() => {});
    load();
    window.addEventListener('app-settings-changed', load);
    return () => window.removeEventListener('app-settings-changed', load);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/instruments')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive || !d) return;
          const map: Record<string, InstrumentKind> = {};
          const put = (x: any, fallbackKind: InstrumentKind) => {
            if (!x) return;
            const name = typeof x === 'string' ? x : x.name;
            const kind = (typeof x === 'string' ? fallbackKind : x.kind) || fallbackKind;
            if (name) map[name] = kind;
          };
          (d.tier1 || []).forEach((x: any) => put(x, 'index'));
          (d.stocks || []).forEach((x: any) => put(x, 'stock'));
          (d.instruments || []).forEach((x: any) => put(x, 'stock'));
          if (Object.keys(map).length > 0) setIndexKinds(map);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const saveableStateRef = useRef<PersistedState>({
    selectedIndex, selectedDate, currentTimestamp: null,
    liveMode, fullMode, selectedStrike,
  });

  useEffect(() => {
    saveableStateRef.current = {
      selectedIndex, selectedDate,
      currentTimestamp: currentIndex >= 0 && currentIndex < timestamps.length ? timestamps[currentIndex] : null,
      liveMode, fullMode, selectedStrike,
    };
  });

  useEffect(() => {
    const save = () => {
      savePersistedState(saveableStateRef.current);
      try { localStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch {}
    };
    window.addEventListener('beforeunload', save);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') save();
    });
    return () => { window.removeEventListener('beforeunload', save); };
  }, []);

  useEffect(() => {
    if (hasRestoredRef.current) return;
    if (timestamps.length === 0) return;
    if (enteringLiveRef.current) {
      setCurrentIndex(timestamps.length - 1);
      enteringLiveRef.current = false;
      hasRestoredRef.current = true;
      return;
    }
    const savedTs = persisted.currentTimestamp;
    if (savedTs) {
      const idx = timestamps.indexOf(savedTs);
      if (idx >= 0) { setCurrentIndex(idx); hasRestoredRef.current = true; return; }
    }
    setCurrentIndex(timestamps.length - 1);
    hasRestoredRef.current = true;
  }, [timestamps, selectedDate]);

  useEffect(() => {
    if (liveMode && timestamps.length > 0 && !isPlaying) {
      setCurrentIndex(timestamps.length - 1);
    }
  }, [timestamps, liveMode, isPlaying]);

  useEffect(() => {
    if (currentIndex < 0) return;
    if (scrollRestoredRef.current) return;
    const savedY = localStorage.getItem(SCROLL_KEY);
    if (savedY) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: parseInt(savedY, 10), behavior: 'instant' });
        localStorage.removeItem(SCROLL_KEY);
      });
    }
    scrollRestoredRef.current = true;
  }, [currentIndex]);

  useEffect(() => {
    if (!connected) setShowReconnectBanner(true);
    else { const t = setTimeout(() => setShowReconnectBanner(false), 2000); return () => clearTimeout(t); }
  }, [connected]);

  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.type === 'tick') {
      const idx = lastMessage.data?.index_name || 'NIFTY';
      setLiveDataMap((prev) => ({
        ...prev,
        [idx]: { ...lastMessage.data, __receivedAtMs: Date.now() },
      }));
      if (lastMessage.data.market_open !== undefined) {
        setMarketOpenMap((prev) => ({ ...prev, [idx]: lastMessage.data.market_open }));
      }
      setWsErrorMap((prev) => ({ ...prev, [idx]: lastMessage.data.error || null }));
    }

    if (lastMessage.type === 'alert') {
      const alertData: AlertFiring = lastMessage.data;
      if (!showAlertHistory) {
        setUnseenAlertCount((c) => c + 1);
      }
      if (alertScope === 'all' || alertData.index_name === selectedIndex) {
        const channels = alertData.channels_fired ?? [];
        if (channels.includes('toast')) {
          addToast(alertData);
        }
        if (channels.includes('sound') && alertSettings?.sound.master_enabled) {
          const ruleConfig = alertSettings?.rules.find((r) => r.rule_type === alertData.rule_type);
          const soundId = ruleConfig?.custom_sound_id || ruleConfig?.sound_choice || 'alert';
          const volume = (alertSettings.sound.volume_percent || 80) / 100;
          playAlertSound(soundId, volume);
        }
      }
    }
  }, [lastMessage, selectedIndex, alertSettings, alertScope, addToast, playAlertSound]);

  useEffect(() => {
    if (isPlaying) {
      playTimerRef.current = setInterval(() => {
        setCurrentIndex((prev) => {
          if (prev >= timestamps.length - 1) { setIsPlaying(false); return prev; }
          return prev + 1;
        });
      }, 5000);
    }
    return () => { if (playTimerRef.current) clearInterval(playTimerRef.current); };
  }, [isPlaying, timestamps.length]);

  useEffect(() => {
    if (!isPlaying || timestamps.length === 0 || currentIndex < timestamps.length - 1) return;

    // Playback of a prior session must never change source to today's live feed.
    setIsPlaying(false);
    setLiveMode(canReturnToLive(
      true,
      selectedDate,
      getMarketDateIST(),
      marketOpen,
    ));
  }, [currentIndex, isPlaying, timestamps.length, marketOpen, selectedDate]);

  useEffect(() => {
    setCurrentIndex(-1); setIsPlaying(false); setSelectedStrike(null);
    hasRestoredRef.current = false; scrollRestoredRef.current = false;
  }, [selectedIndex]);

  const liveData = liveDataMap[selectedIndex];
  const hasLiveData = liveData && Array.isArray(liveData.options) && liveData.options.length > 0 && liveData.spot != null;
  // Do not fall back to a historical DB snapshot while the UI is in LIVE mode.
  // Blank values are safer than presenting yesterday's data as today's market.
  const displayData = liveMode ? (hasLiveData ? liveData : null) : snapshot;
  const wsError = wsErrorMap[selectedIndex] || null;

  // Freshness is based on source-tick ages from the backend, not the timestamp
  // attached when a cached/rebroadcast payload was assembled.
  const liveMessageAgeMs = typeof liveData?.__receivedAtMs === 'number'
    ? Math.max(0, now - liveData.__receivedAtMs)
    : Number.POSITIVE_INFINITY;
  // The receive-age term also catches a frozen WebSocket/broadcast path where
  // no new payload arrives to advance the backend's source-age measurements.
  const needsFuturesFreshness = !!liveData &&
    (liveData.instrument_kind === 'commodity' || liveData.futures != null);
  const feedAgeSeconds = (age: unknown): number | null =>
    typeof age === 'number' && Number.isFinite(age) && age >= 0 && Number.isFinite(liveMessageAgeMs)
      ? Math.max(0, age + liveMessageAgeMs / 1000)
      : null;
  const spotFeedAge = feedAgeSeconds(liveData?.spot_age_sec);
  const optionsFeedAge = feedAgeSeconds(liveData?.option_age_sec);
  const futuresFeedAge = feedAgeSeconds(liveData?.futures_age_sec);
  // Missing age telemetry is not proof that a source feed has stopped.
  // Report measured-old feeds as STALE, but keep missing measurements UNKNOWN.
  const requiredFeedAges = [
    spotFeedAge,
    optionsFeedAge,
    ...(needsFuturesFreshness ? [futuresFeedAge] : []),
  ];
  const hasStaleMarketSources = requiredFeedAges.some(
    (age) => age !== null && age * 1000 > STALE_AFTER_MS
  );
  const hasUnknownMarketSources = requiredFeedAges.some((age) => age === null);
  const hasFreshMarketSources = requiredFeedAges.length > 0 &&
    requiredFeedAges.every((age) => age !== null && age * 1000 <= STALE_AFTER_MS);
  const formatFeedAge = (age: number | null) => age === null ? 'Age unknown' : `${Math.round(age)}s`;
  const liveStatusLabel = resolveLiveStatus({
    liveMode,
    marketOpen,
    connected,
    hasLiveData: !!hasLiveData,
    hasFreshMarketSources,
    hasStaleMarketSources,
    hasUnknownMarketSources,
    hasError: !!wsError,
  });
  const isLiveDataStale = liveMode && marketOpen && liveStatusLabel === 'STALE';
  const isTrulyLive = liveStatusLabel === 'LIVE';
  // Wall watches are anchored against a fresh backend snapshot. Do not make
  // missing age telemetry alone disable the control: UNVERIFIED means the
  // freshness proof is incomplete, not that the live option chain is unusable.
  // Explicitly stale, disconnected, closed-session, or errored feeds remain
  // ineligible; the arm endpoint performs the final server-side validation.
  const canArmWallWatch = liveMode && marketOpen && connected &&
    !!hasLiveData && !hasStaleMarketSources && !wsError;

  const spot = displayData?.spot ?? null;
  const futures = displayData?.futures ?? null;
  const futuresSpread = displayData?.futures_spread ?? null;
  const spreadLabel = displayData?.spread_label ?? null;
  const netGex = displayData?.net_gex ?? null;
  const maxGexStrike = displayData?.max_gex_strike ?? null;
  const maxPain = displayData?.max_pain ?? null;
  const gammaFlip = displayData?.gamma_flip ?? null;
  const timestamp = displayData?.timestamp ?? '';
  const options = displayData?.options ?? [];
  // ── FIX: walls must sit on the correct side of spot ──────────
  // A CE wall is resistance ABOVE spot; a PE wall is support BELOW it.
  // Without this filter, the max-OI strike from anywhere in the chain
  // (e.g. a far ITM put 14% above spot) gets labeled as a "wall" and
  // drawn on the GEX chart, compressing the meaningful near-ATM bars.
  const { ceWall, peWall } = React.useMemo(() => {
    let cew: number | null = null, pew: number | null = null, ceo = -1, peo = -1;
    for (const o of (options as any[])) {
      const oi = o?.oi ?? 0;
      if (o?.option_type === 'CE' && (spot == null || o.strike >= spot) && oi > ceo) { ceo = oi; cew = o.strike; }
      if (o?.option_type === 'PE' && (spot == null || o.strike <= spot) && oi > peo) { peo = oi; pew = o.strike; }
    }
    return { ceWall: cew, peWall: pew };
  }, [options, spot]);
  const instrumentTier = (displayData as any)?.tier ?? (selectedIndex === 'NIFTY' || selectedIndex === 'SENSEX' ? 1 : 2);


  const normalizedOptions = React.useMemo(() => {
    if (!options) return [];
    if (Array.isArray(options)) return options;
    const result: any[] = [];
    Object.entries(options).forEach(([strike, data]: [string, any]) => {
      if (data.CE) result.push({ strike: Number(strike), option_type: 'CE', oi: data.CE.oi ?? 0, oi_change: 0, volume: data.CE.volume ?? 0, ltp: data.CE.ltp ?? 0, iv: data.CE.iv, delta: data.CE.delta, gamma: data.CE.gamma, theta: data.CE.theta, vega: data.CE.vega, gex: data.CE.gex });
      if (data.PE) result.push({ strike: Number(strike), option_type: 'PE', oi: data.PE.oi ?? 0, oi_change: 0, volume: data.PE.volume ?? 0, ltp: data.PE.ltp ?? 0, iv: data.PE.iv, delta: data.PE.delta, gamma: data.PE.gamma, theta: data.PE.theta, vega: data.PE.vega, gex: data.PE.gex });
    });
    return result;
  }, [options]);

  // Live GEX bars must be derived from the same live payload as the option
  // chain; historical replay continues to use the selected DB snapshot.
  const liveGexByStrike = React.useMemo(() => {
    const byStrike: Record<number, { strike: number; ce_gex: number; pe_gex: number; net_gex: number }> = {};
    for (const option of normalizedOptions as any[]) {
      const strike = Number(option.strike);
      if (!Number.isFinite(strike)) continue;
      const point = byStrike[strike] ?? { strike, ce_gex: 0, pe_gex: 0, net_gex: 0 };
      const gex = Number(option.gex);
      const value = Number.isFinite(gex) ? gex : 0;
      if (option.option_type === 'CE') point.ce_gex = value;
      if (option.option_type === 'PE') point.pe_gex = value;
      point.net_gex = point.ce_gex + point.pe_gex;
      byStrike[strike] = point;
    }
    return Object.values(byStrike).sort((a, b) => a.strike - b.strike);
  }, [normalizedOptions]);
  const displayedGexByStrike = liveMode ? liveGexByStrike : gexByStrike;

  const handlePlay = useCallback(() => {
    if (currentIndex >= timestamps.length - 1) setCurrentIndex(0);
    setLiveMode(false); setIsPlaying(true);
  }, [currentIndex, timestamps.length]);

  const handlePause = useCallback(() => setIsPlaying(false), []);
  const handleSeek = useCallback((index: number) => {
    const isAtEnd = index >= 0 && timestamps.length > 0 && index === timestamps.length - 1;
    setLiveMode(canReturnToLive(isAtEnd, selectedDate, getMarketDateIST(), marketOpen));
    setIsPlaying(false);
    setCurrentIndex(index);
  }, [timestamps.length, marketOpen, selectedDate]);
  const handleRefresh = useCallback(() => window.location.reload(), []);
  const handleDateChange = useCallback((date: string) => { setSelectedDate(date); setCurrentIndex(-1); setIsPlaying(false); setLiveMode(false); hasRestoredRef.current = false; scrollRestoredRef.current = false; }, []);
  const handleIndexChange = useCallback((index: string) => {
    setSelectedIndex(index);
    setCurrentIndex(-1);
    setIsPlaying(false);
    setSelectedStrike(null);
    if (liveMode) {
      setSelectedDate(getMarketDateIST());
      enteringLiveRef.current = true;
    } else {
      enteringLiveRef.current = false;
    }
    hasRestoredRef.current = false;
    scrollRestoredRef.current = false;
  }, [liveMode]);
  const handleSelectStrike = useCallback((strike: number) => setSelectedStrike(strike), []);
  const handleFullModeChange = useCallback((v: boolean) => setFullMode(v), []);
  const toggleLiveMode = useCallback(() => {
    setLiveMode((prev) => {
      const next = !prev;
      if (next) { setIsPlaying(false); setSelectedDate(getMarketDateIST()); setCurrentIndex(-1); enteringLiveRef.current = true; hasRestoredRef.current = false; scrollRestoredRef.current = false; }
      return next;
    });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setShowSettings((s) => !s);
        return;
      }
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        toggleLiveMode();
      }
      if (e.key === 'End') {
        e.preventDefault();
        if (timestamps.length > 0) {
          handleSeek(timestamps.length - 1);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [timestamps.length, toggleLiveMode, handleSeek]);

  const atmStrike = React.useMemo(() => {
    const payloadAtm = (displayData as any)?.atm ?? null;
    if (payloadAtm != null) return payloadAtm;
    if (!spot || normalizedOptions.length === 0) return null;
    const strikes = [...new Set(normalizedOptions.map((o: any) => o.strike))].sort((a: number, b: number) => a - b);
    return strikes.reduce((closest: number, s: number) => Math.abs(s - spot) < Math.abs(closest - spot) ? s : closest);
  }, [spot, normalizedOptions, displayData]);

  const refreshUnseenCount = useCallback(async () => {
    const today = getMarketDateIST();
    const lastOpened = getLastOpenedHistory();
    try {
      const res = await fetch(`/api/alerts/history?date=${today}&page_size=200`);
      if (!res.ok) return;
      const data = await res.json();
      const entries = data.entries || [];
      const lastOpenedDate = lastOpened ? new Date(lastOpened) : null;
      const unseen = entries.filter((e: any) => {
        if (!lastOpenedDate) return true;
        return new Date(e.timestamp) > lastOpenedDate;
      }).length;
      setUnseenAlertCount(unseen);
    } catch {}
  }, []);

  const handleTestToast = useCallback(() => {
    addToast({
      timestamp: new Date().toISOString(),
      index_name: selectedIndex,
      rule_type: 'atm_negative_gex_oi_wall',
      rule_name: 'ATM + Negative GEX + OI Wall',
      spot: spot ?? 25142.35,
      atm_strike: atmStrike ?? 25150,
      max_ce_oi_strike: atmStrike ?? 25150,
      max_pe_oi_strike: atmStrike ? atmStrike - 150 : 25000,
      max_negative_gex_strike: atmStrike ?? 25150,
      net_gex: netGex ?? -1250000,
      channels_fired: ['toast', 'sound', 'telegram'],
    });
  }, [addToast, selectedIndex, spot, atmStrike, netGex]);

  useEffect(() => {
    refreshUnseenCount();
    const interval = setInterval(refreshUnseenCount, 60000);
    return () => clearInterval(interval);
  }, [refreshUnseenCount]);

  const toastDuration = alertSettings?.toast_duration_ms ?? 6000;

  if (isMobile) {
    return (
      <MobileApp
        connected={connected}
        lastMessage={lastMessage}
        toasts={toasts}
        removeToast={removeToast}
        onInstrumentChange={(name) => setSelectedIndex(name)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-terminal-bg">
      <AlertToastContainer alerts={toasts} onDismiss={removeToast} duration={toastDuration} />

      {showReconnectBanner && (
        <div className="bg-amber-900/40 border-b border-amber-700/50 px-4 py-1.5 flex items-center justify-center gap-2">
          <WifiOff className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-mono text-amber-300">
            {connected ? 'Reconnected — resuming live data...' : 'Connection lost — replay data is cached. Reconnecting...'}
          </span>
        </div>
      )}

      {!marketOpen && (
        <div className="bg-slate-800/50 border-b border-slate-700/50 px-4 py-1.5 flex items-center justify-center gap-2">
          <Info className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs font-mono text-slate-400">Market Closed ({fmtSessionRange(sessionHours)}, Mon–Fri) — Showing last known data.</span>
        </div>
      )}
      {wsError && liveMode && marketOpen && (
        <div className="bg-red-900/30 border-b border-red-700/50 px-4 py-1.5 flex items-center justify-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
          <span className="text-xs font-mono text-red-300">{wsError}</span>
        </div>
      )}

      <div className="border-b border-terminal-border bg-terminal-panel px-3 sm:px-4 py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Monitor className="w-5 h-5 text-terminal-atm shrink-0" />
          <h1 className="text-sm font-bold tracking-wide">
            <span className="sm:hidden">{selectedIndex} Dashboard</span>
            <span className="hidden sm:inline">{selectedIndex} Option Chain Replay Dashboard</span>
          </h1>
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded shrink-0 ${connected ? 'bg-terminal-pe/20 text-terminal-pe' : 'bg-terminal-ce/20 text-terminal-ce'}`}>
            <span className="sm:hidden">{connected ? 'WS' : '—'}</span>
            <span className="hidden sm:inline">{connected ? 'WS Connected' : 'WS Disconnected'}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setShowAlertHistory(true); setUnseenAlertCount(0); saveLastOpenedHistory(new Date().toISOString()); }} className="relative flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono bg-terminal-bg text-terminal-muted hover:text-terminal-text transition-colors">
            <Bell className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">History</span>
            {unseenAlertCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center border border-terminal-bg">
                {unseenAlertCount > 99 ? '99+' : unseenAlertCount}
              </span>
            )}
          </button>
          <button onClick={() => setShowSettings(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono bg-terminal-bg text-terminal-muted hover:text-terminal-text transition-colors">
            <Settings className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Settings</span>
          </button>
          {/* Mode control stays independent from feed health. A stale feed must
              never replace the LIVE/REPLAY mode label or change its action. */}
          <button
            type="button"
            onClick={toggleLiveMode}
            aria-pressed={liveMode}
            aria-label={liveMode ? 'Switch to replay mode' : 'Switch to live mode'}
            title={liveMode ? 'Live mode selected — click to switch to replay' : 'Replay mode selected — click to return to live'}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-atm ${
              liveMode
                ? 'bg-terminal-pe/20 text-terminal-pe hover:bg-terminal-pe/30'
                : 'bg-terminal-atm/15 text-terminal-atm hover:bg-terminal-atm/25'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${liveMode ? 'bg-terminal-pe animate-pulse' : 'bg-terminal-atm'}`} />
            {liveMode ? 'LIVE' : 'REPLAY'}
          </button>
          {liveMode && (
            <div className="relative" ref={feedDetailsRef}>
              <button
                type="button"
                onClick={() => setShowFeedDetails((open) => !open)}
                aria-expanded={showFeedDetails}
                aria-controls="live-feed-details"
                aria-label={`Feed status: ${liveStatusLabel}. Open feed details`}
                title={liveStatusLabel === 'UNVERIFIED'
                  ? 'Source age telemetry is unavailable; values may still be updating'
                  : 'Show market feed freshness details'}
                className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] font-mono font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-atm ${
                  liveStatusLabel === 'LIVE'
                    ? 'bg-terminal-pe/10 text-terminal-pe hover:bg-terminal-pe/20'
                    : liveStatusLabel === 'STALE'
                      ? 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
                      : liveStatusLabel === 'NO FEED'
                        ? 'bg-terminal-ce/15 text-terminal-ce hover:bg-terminal-ce/25'
                        : 'bg-terminal-bg text-terminal-muted hover:text-terminal-text'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${
                  liveStatusLabel === 'LIVE'
                    ? 'bg-terminal-pe'
                    : liveStatusLabel === 'STALE'
                      ? 'bg-amber-400'
                      : liveStatusLabel === 'NO FEED'
                        ? 'bg-terminal-ce'
                        : 'bg-terminal-muted'
                }`} />
                {liveStatusLabel === 'LIVE' ? 'FEED OK' : liveStatusLabel}
                <ChevronDown className={`w-3 h-3 transition-transform ${showFeedDetails ? 'rotate-180' : ''}`} />
              </button>

              {showFeedDetails && (
                <div
                  id="live-feed-details"
                  role="dialog"
                  aria-label="Live market feed details"
                  className="absolute right-0 top-full z-50 mt-2 w-64 rounded-md border border-terminal-border bg-terminal-panel shadow-xl"
                >
                  <div className="flex items-center justify-between border-b border-terminal-border px-3 py-2">
                    <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-terminal-text">Feed health</span>
                    <span className="text-[9px] font-mono text-terminal-muted">75s limit</span>
                  </div>
                  <div className="space-y-2 px-3 py-2.5">
                    {[
                      { label: 'Spot', age: spotFeedAge },
                      { label: 'Options', age: optionsFeedAge },
                      ...(needsFuturesFreshness ? [{ label: 'Futures', age: futuresFeedAge }] : []),
                    ].map((feed) => {
                      const fresh = feed.age !== null && feed.age * 1000 <= STALE_AFTER_MS;
                      const status = feed.age === null ? 'UNMEASURED' : fresh ? 'FRESH' : 'STALE';
                      const statusColor = feed.age === null
                        ? 'text-terminal-muted'
                        : fresh ? 'text-terminal-pe' : 'text-amber-400';
                      return (
                        <div key={feed.label} className="flex items-center justify-between gap-3">
                          <span className="text-[11px] font-mono text-terminal-muted">{feed.label}</span>
                          <span className={`text-[10px] font-mono tabular-nums ${statusColor}`}>
                            {formatFeedAge(feed.age)}
                          </span>
                          <span className={`w-20 text-right text-[9px] font-mono font-bold ${statusColor}`}>
                            {status}
                          </span>
                        </div>
                      );
                    })}
                    <div className="flex items-center justify-between border-t border-terminal-border pt-2">
                      <span className="text-[11px] font-mono text-terminal-muted">WebSocket</span>
                      <span className={`text-[10px] font-mono font-bold ${connected ? 'text-terminal-pe' : 'text-terminal-ce'}`}>
                        {connected ? 'CONNECTED' : 'DISCONNECTED'}
                      </span>
                    </div>
                    {wsError && (
                      <div className="rounded bg-terminal-ce/10 px-2 py-1.5 text-[10px] leading-relaxed text-terminal-ce break-words">
                        {wsError}
                      </div>
                    )}
                    {!marketOpen && (
                      <p className="text-[10px] leading-relaxed text-terminal-muted">
                        Market is closed. Feed ages show when the last ticks were received.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="p-2 sm:p-3 space-y-2 sm:space-y-3">
        <AnalyticsHeader indexName={selectedIndex} isFetching={snapshotLoading} spot={spot} futures={futures} futuresSpread={futuresSpread} spreadLabel={spreadLabel} netGex={netGex} maxGexStrike={maxGexStrike} maxPain={maxPain} gammaFlip={gammaFlip} timestamp={timestamp} isLive={isTrulyLive} isStale={isLiveDataStale} />
        {(!liveMode || isTrulyLive) && (
          <BuildupCard indexName={selectedIndex} date={selectedDate} live={liveMode} timestamp={currentTimestamp || undefined} />
        )}
        <ReplayControls timestamps={timestamps} currentIndex={currentIndex} isFetching={snapshotLoading} isPlaying={isPlaying} onPlay={handlePlay} onPause={handlePause} onSeek={handleSeek} onRefresh={handleRefresh} selectedDate={selectedDate} onDateChange={handleDateChange} selectedIndex={selectedIndex} onIndexChange={handleIndexChange} availableDates={availableDates} sessionHours={sessionHours} />
        <OptionChain options={normalizedOptions} spot={spot} futures={futures} maxPain={maxPain} gammaFlip={gammaFlip} fullMode={fullMode} selectedStrike={selectedStrike} onSelectStrike={handleSelectStrike} indexName={selectedIndex} timestamp={timestamp} canArm={canArmWallWatch} />
        {instrumentTier === 1 && (
          <GexChart data={displayedGexByStrike} atmStrike={atmStrike} maxPain={maxPain} gammaFlip={gammaFlip}
                    ceWall={ceWall} peWall={peWall} indexName={selectedIndex} timestamp={timestamp} />
        )}
        <StrikeChart data={strikeHistory} strike={selectedStrike ?? 0} indexName={selectedIndex} timestamp={timestamp} />
        {instrumentTier === 1 && (
          <NetGexChart data={gexHistory} indexName={selectedIndex} timestamp={timestamp} />
        )}
      </div>

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          fullMode={fullMode}
          onFullModeChange={handleFullModeChange}
          onTestToast={handleTestToast}
        />
      )}

      {showAlertHistory && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-4 sm:pt-8 px-2 sm:px-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowAlertHistory(false)} />
          <div className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto terminal-panel">
            <div className="sticky top-0 bg-terminal-panel border-b border-terminal-border px-4 py-2 flex items-center justify-between z-10">
              <span className="text-sm font-bold">Alert History</span>
              <button onClick={() => setShowAlertHistory(false)} className="p-1 rounded hover:bg-white/10 text-terminal-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            <AlertHistoryPanel
              indexName={selectedIndex}
              onNavigate={(sym) => { setShowAlertHistory(false); handleIndexChange(sym); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
