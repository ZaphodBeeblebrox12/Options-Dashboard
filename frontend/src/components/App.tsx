import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AnalyticsHeader } from './components/AnalyticsHeader';
import { OptionChain } from './components/OptionChain';
import { ReplayControls } from './components/ReplayControls';
import { GexChart } from './components/GexChart';
import { StrikeChart } from './components/StrikeChart';
import { NetGexChart } from './components/NetGexChart';
import { SettingsModal } from './components/SettingsModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { fetchInstruments } from './instrumentsCache';
import { AlertHistoryPanel } from './components/AlertHistory';
import { AlertToastContainer } from './components/AlertToast';
import { useWebSocket } from './hooks/useWebSocket';
import { useSnapshots, useSnapshot, useGexHistory, useStrikeHistory, useGexByStrike, useAvailableDates } from './hooks/useApi';
import { useAlertSettings, useAlertNotifications, AlertFiring } from './hooks/useAlerts';
import { Monitor, AlertTriangle, Info, WifiOff, Bell, Settings, X } from 'lucide-react';
import { hoursForType, isSessionOpen, fmtSessionRange, InstrumentKind, SessionHours } from './session';

// ── Fatal error overlay ─────────────────────────────────────────
// Catches errors that unmount the ENTIRE React tree — which otherwise
// leaves a blank page and silently drops the WebSocket — and renders the
// real error message + stack on screen, immune to React teardown.
function showFatalOverlay(message: string, stack?: string) {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let el = document.getElementById('fatal-error-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal-error-overlay';
    el.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:rgba(10,10,16,0.97);' +
      'color:#e7ebf3;padding:28px 20px;overflow:auto;font-family:ui-monospace,Menlo,monospace;';
    document.body.appendChild(el);
  }
  el.innerHTML =
    '<div style="color:#f87171;font-weight:bold;font-size:15px;margin-bottom:10px;">&#9888; App crashed</div>' +
    '<div style="font-size:13px;margin-bottom:10px;max-width:720px;word-break:break-word;">' + esc(message) + '</div>' +
    '<pre style="white-space:pre-wrap;color:#8d97ab;font-size:11px;max-width:900px;">' + esc(stack || '(no stack)') + '</pre>' +
    '<button onclick="location.reload()" style="margin-top:16px;padding:9px 18px;background:rgba(234,179,8,0.15);' +
    'color:#eab308;border:1px solid rgba(234,179,8,0.4);border-radius:8px;cursor:pointer;font-family:inherit;">Reload app</button>';
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    showFatalOverlay(e.message || 'Unknown script error', (e.error as any)?.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r: any = e.reason;
    showFatalOverlay(String(r?.message || r || 'Unhandled promise rejection'), r?.stack);
  });
}

const STORAGE_KEY = 'option_chain_view_state';
const HISTORY_LAST_OPENED_KEY = 'history_last_opened_at';
const SCROLL_KEY = 'option_chain_scroll_y';

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

  const [selectedIndex, setSelectedIndex] = useState(persisted.selectedIndex || "NIFTY");
  const [selectedDate, setSelectedDate] = useState(persisted.selectedDate || (() => {
    const today = new Date();
    return today.toISOString().split('T')[0];
  }));
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [fullMode, setFullMode] = useState(persisted.fullMode ?? false);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(persisted.selectedStrike ?? null);
  const [liveMode, setLiveMode] = useState(persisted.liveMode ?? true);
  // market_open is broadcast PER INSTRUMENT — keep a map, not one global bool
  // (a single bool reflected whichever instrument ticked last).
  const [marketOpenMap, setMarketOpenMap] = useState<Record<string, boolean>>({});
  // Instrument kind (index/stock/commodity) per symbol → drives the session.
  const [indexKinds, setIndexKinds] = useState<Record<string, InstrumentKind>>({});
  const [wsErrorMap, setWsErrorMap] = useState<Record<string, string | null>>({});
  const [showReconnectBanner, setShowReconnectBanner] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAlertHistory, setShowAlertHistory] = useState(false);
  const [unseenAlertCount, setUnseenAlertCount] = useState(0);
  const playTimerRef = useRef<ReturnType<typeof setInterval>>();
  const hasRestoredRef = useRef(false);
  const enteringLiveRef = useRef(false);
  const scrollRestoredRef = useRef(false);

  const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
  const { connected, lastMessage } = useWebSocket(wsUrl);

  const timestamps = useSnapshots(selectedDate, selectedIndex, liveMode);
  const currentTimestamp = (currentIndex >= 0 && currentIndex < timestamps.length) ? timestamps[currentIndex] : null;
  const { snapshot, isLoading: snapshotLoading } = useSnapshot(currentTimestamp, selectedIndex, liveMode);
  const gexHistory = useGexHistory(selectedDate, selectedIndex, liveMode);
  const strikeHistory = useStrikeHistory(selectedStrike, selectedDate, selectedIndex, liveMode);
  const gexByStrike = useGexByStrike(currentTimestamp, selectedIndex, liveMode);
  const availableDates = useAvailableDates(selectedIndex, liveMode);

  const [liveDataMap, setLiveDataMap] = useState<Record<string, any>>({});
  const [alertScope, setAlertScope] = useState<'viewed' | 'all'>('viewed');
  const { settings: alertSettings } = useAlertSettings();
  const { toasts, addToast, removeToast, playAlertSound } = useAlertNotifications();

  // SELECTED instrument's session (equity 09:15–15:30 / MCX 09:00–23:30).
  const sessionHours: SessionHours = hoursForType(indexKinds[selectedIndex]);
  // Backend broadcasts market_open per instrument; until the first tick for
  // this instrument arrives, fall back to the locally computed session.
  const marketOpen = marketOpenMap[selectedIndex] ?? isSessionOpen(sessionHours);

  // Alert notification scope — user-configurable in Settings > Alerts.
  // Reloads when the settings modal saves (custom event) or on mount.
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

  // Instrument kinds → per-instrument trading session (equity vs MCX).
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchInstruments()
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
    const t = setInterval(load, 60000); // pick up instruments added at runtime
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
      setLiveDataMap((prev) => ({ ...prev, [idx]: lastMessage.data }));
      if (lastMessage.data.market_open !== undefined) {
        setMarketOpenMap((prev) => ({ ...prev, [idx]: lastMessage.data.market_open }));
      }
      setWsErrorMap((prev) => ({ ...prev, [idx]: lastMessage.data.error || lastMessage.data.message || null }));
    }

    if (lastMessage.type === 'alert') {
      const alertData: AlertFiring = lastMessage.data;
      if (!showAlertHistory) {
        setUnseenAlertCount((c) => c + 1);
      }
      if (alertScope === 'all' || alertData.index_name === selectedIndex) {
        addToast(alertData);
        const ruleConfig = alertSettings?.rules.find((r) => r.rule_type === alertData.rule_type);
        if (ruleConfig?.sound_enabled && alertSettings?.sound.master_enabled) {
          const soundId = ruleConfig.custom_sound_id || ruleConfig.sound_choice;
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
    if (isPlaying && currentIndex >= timestamps.length - 1 && timestamps.length > 0 && marketOpen) {
      setIsPlaying(false);
      setLiveMode(true);
    }
  }, [currentIndex, isPlaying, timestamps.length, marketOpen]);

  useEffect(() => {
    setCurrentIndex(-1); setIsPlaying(false); setSelectedStrike(null);
    hasRestoredRef.current = false; scrollRestoredRef.current = false;
  }, [selectedIndex]);

  const liveData = liveDataMap[selectedIndex];
  const hasLiveData = liveData && Array.isArray(liveData.options) && liveData.options.length > 0 && liveData.spot != null;
  const displayData = liveMode && hasLiveData ? liveData : snapshot;
  const wsError = wsErrorMap[selectedIndex] || null;

  const spot = displayData?.spot ?? null;
  const futures = displayData?.futures ?? null;
  const futuresSpread = displayData?.futures_spread ?? null;
  const spreadLabel = displayData?.spread_label ?? null;
  const netGex = displayData?.net_gex ?? null;
  const maxGexStrike = displayData?.max_gex_strike ?? null;
  const maxPain = displayData?.max_pain ?? null;
  const gammaFlip = displayData?.gamma_flip ?? null;
  const timestamp = displayData?.timestamp ?? new Date().toISOString();
  const options = displayData?.options ?? [];

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

  const handlePlay = useCallback(() => {
    if (currentIndex >= timestamps.length - 1) setCurrentIndex(0);
    setLiveMode(false); setIsPlaying(true);
  }, [currentIndex, timestamps.length]);

  const handlePause = useCallback(() => setIsPlaying(false), []);
  const handleSeek = useCallback((index: number) => {
    const isAtEnd = index >= 0 && timestamps.length > 0 && index === timestamps.length - 1;
    if (isAtEnd && marketOpen) {
      setLiveMode(true);
      setIsPlaying(false);
      setCurrentIndex(index);
    } else {
      setLiveMode(false);
      setIsPlaying(false);
      setCurrentIndex(index);
    }
  }, [timestamps.length, marketOpen]);
  const handleRefresh = useCallback(() => window.location.reload(), []);
  const handleDateChange = useCallback((date: string) => { setSelectedDate(date); setCurrentIndex(-1); setIsPlaying(false); setLiveMode(false); hasRestoredRef.current = false; scrollRestoredRef.current = false; }, []);
  const handleIndexChange = useCallback((index: string) => { setSelectedIndex(index); setCurrentIndex(-1); setIsPlaying(false); setSelectedStrike(null); setLiveMode(true); enteringLiveRef.current = true; hasRestoredRef.current = false; scrollRestoredRef.current = false; }, []);
  const handleSelectStrike = useCallback((strike: number) => setSelectedStrike(strike), []);
  const handleFullModeChange = useCallback((v: boolean) => setFullMode(v), []);
  const toggleLiveMode = useCallback(() => {
    setLiveMode((prev) => {
      const next = !prev;
      if (next) { setIsPlaying(false); setSelectedDate(new Date().toISOString().split('T')[0]); setCurrentIndex(-1); enteringLiveRef.current = true; hasRestoredRef.current = false; scrollRestoredRef.current = false; }
      return next;
    });
  }, []);

  // Keyboard: L = toggle live, End = jump to latest, Ctrl+, = settings
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
    if (!spot || normalizedOptions.length === 0) return null;
    const strikes = [...new Set(normalizedOptions.map((o: any) => o.strike))].sort((a: number, b: number) => a - b);
    return strikes.reduce((closest: number, s: number) => Math.abs(s - spot) < Math.abs(closest - spot) ? s : closest);
  }, [spot, normalizedOptions]);

  const refreshUnseenCount = useCallback(async () => {
    const today = new Date().toISOString().split('T')[0];
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
    // Defer the first badge count: it downloads up to 200 alert-history
    // rows and competes with the startup request burst. Non-critical.
    const t0 = setTimeout(refreshUnseenCount, 5000);
    const interval = setInterval(refreshUnseenCount, 60000);
    return () => { clearTimeout(t0); clearInterval(interval); };
  }, [refreshUnseenCount]);

  const toastDuration = alertSettings?.toast_duration_ms ?? 6000;

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
          <button onClick={toggleLiveMode} className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono font-semibold transition-colors ${liveMode ? 'bg-terminal-pe/20 text-terminal-pe' : 'bg-terminal-bg text-terminal-muted hover:text-terminal-text'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${liveMode ? 'bg-terminal-pe animate-pulse' : 'bg-terminal-muted'}`} />
            LIVE
          </button>
        </div>
      </div>

      <ErrorBoundary label="Dashboard">
      <div className="p-2 sm:p-3 space-y-2 sm:space-y-3">
        <AnalyticsHeader indexName={selectedIndex} isFetching={snapshotLoading} spot={spot} futures={futures} futuresSpread={futuresSpread} spreadLabel={spreadLabel} netGex={netGex} maxGexStrike={maxGexStrike} maxPain={maxPain} gammaFlip={gammaFlip} timestamp={timestamp} isLive={liveMode && connected && marketOpen} />
        <ReplayControls timestamps={timestamps} currentIndex={currentIndex} isFetching={snapshotLoading} isPlaying={isPlaying} onPlay={handlePlay} onPause={handlePause} onSeek={handleSeek} onRefresh={handleRefresh} selectedDate={selectedDate} onDateChange={handleDateChange} selectedIndex={selectedIndex} onIndexChange={handleIndexChange} availableDates={availableDates} sessionHours={sessionHours} />
        <OptionChain options={normalizedOptions} spot={spot} futures={futures} maxPain={maxPain} gammaFlip={gammaFlip} fullMode={fullMode} selectedStrike={selectedStrike} onSelectStrike={handleSelectStrike} />
        <GexChart data={gexByStrike} atmStrike={atmStrike} maxPain={maxPain} gammaFlip={gammaFlip} />
        <StrikeChart data={strikeHistory} strike={selectedStrike ?? 0} />
        <NetGexChart data={gexHistory} />
      </div>
      </ErrorBoundary>

      {showSettings && (
        <ErrorBoundary label="Settings">
        <SettingsModal
          onClose={() => setShowSettings(false)}
          fullMode={fullMode}
          onFullModeChange={handleFullModeChange}
          onTestToast={handleTestToast}
        />
        </ErrorBoundary>
      )}

      {showAlertHistory && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-4 sm:pt-8 px-2 sm:px-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowAlertHistory(false)} />
          <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto terminal-panel">
            <div className="sticky top-0 bg-terminal-panel border-b border-terminal-border px-4 py-2 flex items-center justify-between z-10">
              <span className="text-sm font-bold">Alert History</span>
              <button onClick={() => setShowAlertHistory(false)} className="p-1 rounded hover:bg-white/10 text-terminal-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            <AlertHistoryPanel indexName={selectedIndex} />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
