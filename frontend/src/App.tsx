import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AnalyticsHeader } from './components/AnalyticsHeader';
import { OptionChain } from './components/OptionChain';
import { ReplayControls } from './components/ReplayControls';
import { GexChart } from './components/GexChart';
import { StrikeChart } from './components/StrikeChart';
import { NetGexChart } from './components/NetGexChart';
import { useWebSocket } from './hooks/useWebSocket';
import { useSnapshots, useSnapshot, useGexHistory, useStrikeHistory, useGexByStrike, useAvailableDates } from './hooks/useApi';
import { Eye, EyeOff, Monitor, AlertTriangle, Info, WifiOff } from 'lucide-react';

const STORAGE_KEY = 'option_chain_view_state';
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
  const [demoMode, setDemoMode] = useState(false);
  const [marketOpen, setMarketOpen] = useState(true);
  const [wsErrorMap, setWsErrorMap] = useState<Record<string, string | null>>({});
  const [showReconnectBanner, setShowReconnectBanner] = useState(false);
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

  // ── Ref that always holds the latest saveable state ──────────────
  const saveableStateRef = useRef<PersistedState>({
    selectedIndex,
    selectedDate,
    currentTimestamp: null,
    liveMode,
    fullMode,
    selectedStrike,
  });

  useEffect(() => {
    saveableStateRef.current = {
      selectedIndex,
      selectedDate,
      currentTimestamp: currentIndex >= 0 && currentIndex < timestamps.length ? timestamps[currentIndex] : null,
      liveMode,
      fullMode,
      selectedStrike,
    };
  });

  // ── Save state + scroll position before unload / hide ────────────
  useEffect(() => {
    const save = () => {
      savePersistedState(saveableStateRef.current);
      try {
        localStorage.setItem(SCROLL_KEY, String(window.scrollY));
      } catch {}
    };
    window.addEventListener('beforeunload', save);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') save();
    });
    return () => {
      window.removeEventListener('beforeunload', save);
    };
  }, []);

  // ── Restore timestamp from persisted state ───────────────────────
  useEffect(() => {
    if (hasRestoredRef.current) return;
    if (timestamps.length === 0) return;

    // If user explicitly entered live mode, jump to latest
    if (enteringLiveRef.current) {
      setCurrentIndex(timestamps.length - 1);
      enteringLiveRef.current = false;
      hasRestoredRef.current = true;
      return;
    }

    // Otherwise try to restore the exact saved timestamp
    const savedTs = persisted.currentTimestamp;
    if (savedTs) {
      const idx = timestamps.indexOf(savedTs);
      if (idx >= 0) {
        setCurrentIndex(idx);
        hasRestoredRef.current = true;
        return;
      }
    }

    // Fallback: latest snapshot
    setCurrentIndex(timestamps.length - 1);
    hasRestoredRef.current = true;
  }, [timestamps, selectedDate]);

  // ── Auto-advance to latest snapshot in live mode ───────────────
  useEffect(() => {
    if (liveMode && timestamps.length > 0 && !isPlaying) {
      setCurrentIndex(timestamps.length - 1);
    }
  }, [timestamps, liveMode, isPlaying]);

  // ── Restore scroll position once after timestamp is restored ─────
  useEffect(() => {
    if (currentIndex < 0) return; // Not restored yet
    if (scrollRestoredRef.current) return;

    const savedY = localStorage.getItem(SCROLL_KEY);
    if (savedY) {
      const y = parseInt(savedY, 10);
      requestAnimationFrame(() => {
        window.scrollTo({ top: y, behavior: 'instant' });
        localStorage.removeItem(SCROLL_KEY);
      });
    }
    scrollRestoredRef.current = true;
  }, [currentIndex]);

  // ── Reconnect banner ─────────────────────────────────────────────
  useEffect(() => {
    if (!connected) {
      setShowReconnectBanner(true);
    } else {
      const t = setTimeout(() => setShowReconnectBanner(false), 2000);
      return () => clearTimeout(t);
    }
  }, [connected]);

  useEffect(() => {
    if (lastMessage?.type === 'tick') {
      const idx = lastMessage.data?.index_name || 'NIFTY';
      setLiveDataMap((prev) => ({ ...prev, [idx]: lastMessage.data }));
      if (lastMessage.data.demo_mode !== undefined) {
        setDemoMode(lastMessage.data.demo_mode);
      }
      if (lastMessage.data.market_open !== undefined) {
        setMarketOpen(lastMessage.data.market_open);
      }
      setWsErrorMap((prev) => ({
        ...prev,
        [idx]: lastMessage.data.error || lastMessage.data.message || null,
      }));
    }
  }, [lastMessage]);

  useEffect(() => {
    if (isPlaying) {
      playTimerRef.current = setInterval(() => {
        setCurrentIndex((prev) => {
          if (prev >= timestamps.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 5000);
    }
    return () => {
      if (playTimerRef.current) clearInterval(playTimerRef.current);
    };
  }, [isPlaying, timestamps.length]);

  useEffect(() => {
    setCurrentIndex(-1);
    setIsPlaying(false);
    setSelectedStrike(null);
    hasRestoredRef.current = false;
    scrollRestoredRef.current = false;
  }, [selectedIndex]);

  const liveData = liveDataMap[selectedIndex];
  const displayData = liveMode && liveData ? liveData : snapshot;
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
      if (data.CE) {
        result.push({
          strike: Number(strike),
          option_type: 'CE',
          oi: data.CE.oi ?? 0,
          oi_change: 0,
          volume: data.CE.volume ?? 0,
          ltp: data.CE.ltp ?? 0,
          iv: data.CE.iv,
          delta: data.CE.delta,
          gamma: data.CE.gamma,
          theta: data.CE.theta,
          vega: data.CE.vega,
          gex: data.CE.gex,
        });
      }
      if (data.PE) {
        result.push({
          strike: Number(strike),
          option_type: 'PE',
          oi: data.PE.oi ?? 0,
          oi_change: 0,
          volume: data.PE.volume ?? 0,
          ltp: data.PE.ltp ?? 0,
          iv: data.PE.iv,
          delta: data.PE.delta,
          gamma: data.PE.gamma,
          theta: data.PE.theta,
          vega: data.PE.vega,
          gex: data.PE.gex,
        });
      }
    });
    return result;
  }, [options]);

  const handlePlay = useCallback(() => {
    if (currentIndex >= timestamps.length - 1) {
      setCurrentIndex(0);
    }
    setLiveMode(false);
    setIsPlaying(true);
  }, [currentIndex, timestamps.length]);

  const handlePause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const handleSeek = useCallback((index: number) => {
    setLiveMode(false);
    setIsPlaying(false);
    setCurrentIndex(index);
  }, []);

  const handleRefresh = useCallback(() => {
    window.location.reload();
  }, []);

  const handleDateChange = useCallback((date: string) => {
    setSelectedDate(date);
    setCurrentIndex(-1);
    setIsPlaying(false);
    setLiveMode(false);
    hasRestoredRef.current = false;
    scrollRestoredRef.current = false;
  }, []);

  const handleIndexChange = useCallback((index: string) => {
    setSelectedIndex(index);
    setCurrentIndex(-1);
    setIsPlaying(false);
    setSelectedStrike(null);
    setLiveMode(true);
    enteringLiveRef.current = true;
    hasRestoredRef.current = false;
    scrollRestoredRef.current = false;
  }, []);

  const handleSelectStrike = useCallback((strike: number) => {
    setSelectedStrike(strike);
  }, []);

  const toggleFullMode = useCallback(() => {
    setFullMode((prev) => !prev);
  }, []);

  const toggleLiveMode = useCallback(() => {
    setLiveMode((prev) => {
      const next = !prev;
      if (next) {
        setIsPlaying(false);
        const today = new Date().toISOString().split('T')[0];
        setSelectedDate(today);
        setCurrentIndex(-1);
        enteringLiveRef.current = true;
        hasRestoredRef.current = false;
        scrollRestoredRef.current = false;
      }
      return next;
    });
  }, []);

  const atmStrike = React.useMemo(() => {
    if (!spot || normalizedOptions.length === 0) return null;
    const strikes = [...new Set(normalizedOptions.map((o: any) => o.strike))].sort((a: number, b: number) => a - b);
    return strikes.reduce((closest: number, s: number) =>
      Math.abs(s - spot) < Math.abs(closest - spot) ? s : closest
    );
  }, [spot, normalizedOptions]);

  return (
    <div className="min-h-screen bg-terminal-bg">
      {/* Reconnecting banner */}
      {showReconnectBanner && (
        <div className="bg-amber-900/40 border-b border-amber-700/50 px-4 py-1.5 flex items-center justify-center gap-2">
          <WifiOff className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-mono text-amber-300">
            {connected ? 'Reconnected — resuming live data...' : 'Connection lost — replay data is cached. Reconnecting...'}
          </span>
        </div>
      )}

      {demoMode && (
        <div className="bg-amber-900/30 border-b border-amber-700/50 px-4 py-1.5 flex items-center justify-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-mono text-amber-300">
            DEMO MODE — Synthetic {selectedIndex} data for UI testing. No real market data.
          </span>
        </div>
      )}
      {!marketOpen && !demoMode && (
        <div className="bg-slate-800/50 border-b border-slate-700/50 px-4 py-1.5 flex items-center justify-center gap-2">
          <Info className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs font-mono text-slate-400">
            Market Closed (09:15–15:30 IST, Mon–Fri) — Showing last known data. Snapshots resume tomorrow.
          </span>
        </div>
      )}
      {wsError && liveMode && (
        <div className="bg-red-900/30 border-b border-red-700/50 px-4 py-1.5 flex items-center justify-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
          <span className="text-xs font-mono text-red-300">
            {wsError}
          </span>
        </div>
      )}

      {/* Top bar */}
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
          {demoMode && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-900/30 text-amber-400 border border-amber-700/30 shrink-0">
              DEMO
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleLiveMode}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono font-semibold transition-colors ${
              liveMode
                ? 'bg-terminal-pe/20 text-terminal-pe'
                : 'bg-terminal-bg text-terminal-muted hover:text-terminal-text'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${liveMode ? 'bg-terminal-pe animate-pulse' : 'bg-terminal-muted'}`} />
            LIVE
          </button>
          <button
            onClick={toggleFullMode}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono bg-terminal-bg text-terminal-muted hover:text-terminal-text transition-colors"
          >
            {fullMode ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{fullMode ? 'Compact' : 'Full'}</span>
          </button>
        </div>
      </div>

      <div className="p-2 sm:p-3 space-y-2 sm:space-y-3">
        <AnalyticsHeader
          indexName={selectedIndex}
          isFetching={snapshotLoading}
          spot={spot}
          futures={futures}
          futuresSpread={futuresSpread}
          spreadLabel={spreadLabel}
          netGex={netGex}
          maxGexStrike={maxGexStrike}
          maxPain={maxPain}
          gammaFlip={gammaFlip}
          timestamp={timestamp}
          isLive={liveMode && connected && marketOpen}
        />

        <ReplayControls
          timestamps={timestamps}
          currentIndex={currentIndex}
          isFetching={snapshotLoading}
          isPlaying={isPlaying}
          onPlay={handlePlay}
          onPause={handlePause}
          onSeek={handleSeek}
          onRefresh={handleRefresh}
          selectedDate={selectedDate}
          onDateChange={handleDateChange}
          selectedIndex={selectedIndex}
          onIndexChange={handleIndexChange}
          availableDates={availableDates}
        />

        <OptionChain
          options={normalizedOptions}
          spot={spot}
          futures={futures}
          maxPain={maxPain}
          gammaFlip={gammaFlip}
          fullMode={fullMode}
          selectedStrike={selectedStrike}
          onSelectStrike={handleSelectStrike}
        />

        <GexChart
          data={gexByStrike}
          atmStrike={atmStrike}
          maxPain={maxPain}
          gammaFlip={gammaFlip}
        />

        <StrikeChart
          data={strikeHistory}
          strike={selectedStrike ?? 0}
        />

        <NetGexChart data={gexHistory} />
      </div>
    </div>
  );
}

export default App;
