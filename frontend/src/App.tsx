import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AnalyticsHeader } from './components/AnalyticsHeader';
import { OptionChain } from './components/OptionChain';
import { ReplayControls } from './components/ReplayControls';
import { GexChart } from './components/GexChart';
import { StrikeChart } from './components/StrikeChart';
import { NetGexChart } from './components/NetGexChart';
import { useWebSocket } from './hooks/useWebSocket';
import { useSnapshots, useSnapshot, useGexHistory, useStrikeHistory, useGexByStrike, useAvailableDates } from './hooks/useApi';
import { Eye, EyeOff, Monitor, AlertTriangle, Info } from 'lucide-react';

function App() {
  const [selectedIndex, setSelectedIndex] = useState("NIFTY");
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = new Date();
    return today.toISOString().split('T')[0];
  });
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [fullMode, setFullMode] = useState(false);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  const [marketOpen, setMarketOpen] = useState(true);
  // FIXED: wsError is now per-index so SENSEX errors don't break NIFTY display
  const [wsErrorMap, setWsErrorMap] = useState<Record<string, string | null>>({});
  const playTimerRef = useRef<ReturnType<typeof setInterval>>();

  const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
  const { connected, lastMessage } = useWebSocket(wsUrl);

  // API data — all index-aware
  const timestamps = useSnapshots(selectedDate, selectedIndex);
  const currentTimestamp = (currentIndex >= 0 && currentIndex < timestamps.length) ? timestamps[currentIndex] : null;
  const snapshot = useSnapshot(currentTimestamp, selectedIndex);
  const gexHistory = useGexHistory(selectedDate, selectedIndex);
  const strikeHistory = useStrikeHistory(selectedStrike, selectedDate, selectedIndex);
  const gexByStrike = useGexByStrike(currentTimestamp, selectedIndex);
  const availableDates = useAvailableDates(selectedIndex);

  // Live data per index
  const [liveDataMap, setLiveDataMap] = useState<Record<string, any>>({});

  // DIAGNOSTIC: Log every message received
  useEffect(() => {
    if (lastMessage) {
      console.log('[APP] WS message:', {
        type: lastMessage.type,
        index: lastMessage.data?.index_name,
        spot: lastMessage.data?.spot,
        optionsCount: lastMessage.data?.options?.length,
        message: lastMessage.data?.message,
        error: lastMessage.data?.error,
      });
    }
  }, [lastMessage]);

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
      // FIXED: Store error/message per-index instead of globally
      setWsErrorMap((prev) => ({
        ...prev,
        [idx]: lastMessage.data.error || lastMessage.data.message || null,
      }));
    }
  }, [lastMessage]);

  // Initialize currentIndex to the latest snapshot on first load
  useEffect(() => {
    if (timestamps.length > 0 && currentIndex < 0) {
      setCurrentIndex(timestamps.length - 1);
    }
  }, [timestamps, currentIndex]);

  // FIXED: Keep playhead pinned to the live edge while in live mode.
  // Uses a functional update so we only re-render when the index actually changes.
  useEffect(() => {
    if (liveMode && timestamps.length > 0) {
      setCurrentIndex((prev) => {
        const latest = timestamps.length - 1;
        return prev === latest ? prev : latest;
      });
    }
  }, [timestamps.length, liveMode]);

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

  // Reset when index changes
  useEffect(() => {
    setCurrentIndex(-1);
    setIsPlaying(false);
    setSelectedStrike(null);
  }, [selectedIndex]);

  const liveData = liveDataMap[selectedIndex];
  const displayData = liveMode && liveData ? liveData : snapshot;

  // FIXED: Only show error for the currently selected index
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

  // DIAGNOSTIC: Log render state
  useEffect(() => {
    console.log('[APP] Render state:', {
      selectedIndex,
      liveMode,
      connected,
      hasLiveData: !!liveData,
      spot,
      optionsCount: normalizedOptions.length,
      wsError,
    });
  });

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

  // FIXED: Exit live mode when changing dates so the slider doesn't fight
  // the empty -> loaded transition and the user starts in replay mode.
  const handleDateChange = useCallback((date: string) => {
    setSelectedDate(date);
    setCurrentIndex(-1);
    setIsPlaying(false);
    setLiveMode(false);
  }, []);

  const handleIndexChange = useCallback((index: string) => {
    setSelectedIndex(index);
    setCurrentIndex(-1);
    setIsPlaying(false);
    setSelectedStrike(null);
    setLiveMode(true);
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
        setCurrentIndex(timestamps.length - 1);
      }
      return next;
    });
  }, [timestamps.length]);

  const atmStrike = React.useMemo(() => {
    if (!spot || normalizedOptions.length === 0) return null;
    const strikes = [...new Set(normalizedOptions.map((o: any) => o.strike))].sort((a: number, b: number) => a - b);
    return strikes.reduce((closest: number, s: number) =>
      Math.abs(s - spot) < Math.abs(closest - spot) ? s : closest
    );
  }, [spot, normalizedOptions]);

  return (
    <div className="min-h-screen bg-terminal-bg">
      {/* Demo Mode / Market Closed Banner */}
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
      <div className="border-b border-terminal-border bg-terminal-panel px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Monitor className="w-5 h-5 text-terminal-atm" />
          <h1 className="text-sm font-bold tracking-wide">{selectedIndex} Option Chain Replay Dashboard</h1>
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${connected ? 'bg-terminal-pe/20 text-terminal-pe' : 'bg-terminal-ce/20 text-terminal-ce'}`}>
            {connected ? 'WS Connected' : 'WS Disconnected'}
          </span>
          {demoMode && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-900/30 text-amber-400 border border-amber-700/30">
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
            {fullMode ? 'Compact' : 'Full'}
          </button>
        </div>
      </div>

      <div className="p-3 space-y-3">
        <AnalyticsHeader
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
