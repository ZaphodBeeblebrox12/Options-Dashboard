import React, { useMemo, useRef, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowDown, ArrowUp, Bell, BellRing, Loader2 } from 'lucide-react';
import { ScreenshotButton } from './ScreenshotButton';
import { COMPACT_OPTION_CHAIN_COLUMNS, type OptionChainColumnVisibility } from './optionChainColumns';

interface OptionData {
  strike: number;
  option_type: string;
  oi: number;
  oi_change: number;
  volume: number;
  ltp: number;
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  gex?: number;
}

interface WallHistoryEvent {
  side: 'CE' | 'PE';
  timestamp: string;
  from_strike: number;
  to_strike: number;
  from_oi: number | null;
  to_oi: number | null;
}

interface WallHistoryPayload {
  date: string;
  index_name: string;
  points: Array<{
    timestamp: string;
    ce_wall: number | null;
    ce_oi: number | null;
    pe_wall: number | null;
    pe_oi: number | null;
  }>;
  events: WallHistoryEvent[];
}

interface WallHoverState {
  side: 'CE' | 'PE';
  strike: number;
  left: number;
  top: number;
}

type BuildupInterval = '5m' | '15m' | '30m' | '1h' | 'session';

interface BuildupSide {
  classification: string;
  bias: 'BULLISH' | 'BEARISH' | null;
  premium_change: number | null;
  premium_change_pct: number | null;
  oi_change: number | null;
  oi_change_pct: number | null;
  volume_change: number | null;
}

interface BuildupPayload {
  ready: boolean;
  reason?: string;
  index_name: string;
  date: string | null;
  interval: BuildupInterval;
  as_of_timestamp?: string;
  baseline_timestamp?: string | null;
  rows: Array<{ strike: number; CE: BuildupSide | null; PE: BuildupSide | null }>;
}

const BUILDUP_INTERVALS: Array<{ value: BuildupInterval; label: string }> = [
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
  { value: '1h', label: '1H' },
  { value: 'session', label: 'Session' },
];

const BUILDUP_CODES: Record<string, string> = {
  'LONG BUILDUP': 'LB',
  'SHORT BUILDUP': 'SB',
  'SHORT COVERING': 'SC',
  'LONG UNWINDING': 'LU',
  'MIXED': 'MX',
  'NO CHANGE': '—',
};

const BUILDUP_STYLES: Record<string, string> = {
  'LONG BUILDUP': 'text-emerald-300',
  'SHORT BUILDUP': 'text-red-300',
  'SHORT COVERING': 'text-cyan-300',
  'LONG UNWINDING': 'text-amber-300',
  'MIXED': 'text-terminal-muted',
  'NO CHANGE': 'text-terminal-muted/50',
};

function signedMetric(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function buildupTooltip(side: BuildupSide | null, baseline?: string | null, current?: string): string {
  if (!side) return 'No matching contract in comparison snapshot';
  const timeLabel = (value?: string | null) => value && value.length >= 16 ? value.slice(11, 19) : '—';
  return [
    side.classification,
    `Premium ${signedMetric(side.premium_change, 2)} (${side.premium_change_pct == null ? '—' : `${signedMetric(side.premium_change_pct, 2)}%`})`,
    `OI ${signedMetric(side.oi_change)} (${side.oi_change_pct == null ? '—' : `${signedMetric(side.oi_change_pct, 2)}%`})`,
    `Volume ${signedMetric(side.volume_change)}`,
    `${timeLabel(baseline)} → ${timeLabel(current)}`,
  ].join(' · ');
}

interface OptionChainProps {
  options: OptionData[];
  spot: number | null;
  maxPain: number | null;
  gammaFlip: number | null;
  columnVisibility?: OptionChainColumnVisibility;
  buildupDate?: string;
  buildupTimestamp?: string;
  selectedStrike: number | null;
  onSelectStrike: (strike: number) => void;
  indexName?: string;
  timestamp?: string;
  historyDate?: string;
  liveMode?: boolean;
  canArm?: boolean;
  isLoading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyFootnote?: string;
}

// FIX (ITM tint): subtle background used on the in-the-money side of a row.
// CE is ITM when strike < spot; PE is ITM when strike > spot. Kept very
// faint so the existing OI-rank badges, ATM highlights and gamma-flip
// underline all stay dominant.
const ITM_TINT_CLASS = 'bg-white/[0.045]';

// FIX (OI rank window): rank OI only within ±N% of spot. Without this, a
// far-from-spot strike (e.g. the 82,900 PE ~14% away) claims the #1 badge
// while being irrelevant as a nearby level — the visible badges then start
// at #2/#3, which looks like a ranking bug but is just an off-screen #1.
// Set to 100 to restore the old whole-chain ranking.
const OI_RANK_WINDOW_PCT = 5;

const OptionChainComponent: React.FC<OptionChainProps> = ({
  options,
  spot,
  gammaFlip,
  columnVisibility = COMPACT_OPTION_CHAIN_COLUMNS,
  buildupDate = '',
  buildupTimestamp,
  selectedStrike,
  onSelectStrike,
  indexName = 'INDEX',
  timestamp,
  historyDate,
  liveMode = true,
  canArm = false,
  isLoading = false,
  emptyTitle = 'No option data available',
  emptyDescription = 'Waiting for live market data from Angel One...',
  emptyFootnote = 'Ensure backend/.env has valid API_KEY, CLIENT_CODE, PASSWORD, TOTP_SECRET',
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [wallWatches, setWallWatches] = useState<Record<'CE' | 'PE', { armed: boolean; watched_strike: number | null }>>({
    CE: { armed: false, watched_strike: null }, PE: { armed: false, watched_strike: null },
  });
  const [watchBusy, setWatchBusy] = useState<'CE' | 'PE' | null>(null);
  const [strikeOrder, setStrikeOrder] = useState<'asc' | 'desc'>('desc');
  const [watchError, setWatchError] = useState<string | null>(null);
  const [wallHistory, setWallHistory] = useState<WallHistoryPayload | null>(null);
  const [wallHistoryError, setWallHistoryError] = useState(false);
  const [wallHover, setWallHover] = useState<WallHoverState | null>(null);
  const [buildupInterval, setBuildupInterval] = useState<BuildupInterval>('15m');
  const [buildupPayload, setBuildupPayload] = useState<BuildupPayload | null>(null);
  const [buildupError, setBuildupError] = useState<string | null>(null);
  const showBuildup = columnVisibility.buildup && columnVisibility.oiChange;

  const effectiveHistoryDate = historyDate || timestamp?.slice(0, 10) || '';

  useEffect(() => {
    if (!effectiveHistoryDate || !indexName) {
      setWallHistory(null);
      return;
    }
    let alive = true;
    let controller: AbortController | null = null;

    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(
          `/api/wall-history?date=${encodeURIComponent(effectiveHistoryDate)}&index=${encodeURIComponent(indexName)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as WallHistoryPayload;
        if (alive) {
          setWallHistory(payload);
          setWallHistoryError(false);
        }
      } catch (error) {
        if (!alive || (error instanceof Error && error.name === 'AbortError')) return;
        setWallHistoryError(true);
      }
    };

    void load();
    const poll = liveMode ? window.setInterval(() => void load(), 30000) : null;
    return () => {
      alive = false;
      controller?.abort();
      if (poll != null) window.clearInterval(poll);
    };
  }, [effectiveHistoryDate, indexName, liveMode]);

  useEffect(() => {
    if (!showBuildup || !indexName) {
      setBuildupPayload(null);
      setBuildupError(null);
      return;
    }

    let alive = true;
    let controller: AbortController | null = null;
    setBuildupPayload(null);
    setBuildupError(null);

    const load = async () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      try {
        const params = new URLSearchParams({ index: indexName, interval: buildupInterval });
        if (!liveMode) {
          if (buildupDate) params.set('date', buildupDate);
          if (buildupTimestamp) params.set('timestamp', buildupTimestamp);
        }
        const response = await fetch(`/api/options-buildup?${params.toString()}`, {
          signal: requestController.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.detail || `Buildup request failed (HTTP ${response.status})`);
        if (!alive) return;
        setBuildupPayload(body as BuildupPayload);
        setBuildupError(null);
      } catch (error) {
        if (!alive || (error instanceof Error && error.name === 'AbortError')) return;
        setBuildupError(error instanceof Error ? error.message : 'Unable to load buildup');
      }
    };

    void load();
    const poll = liveMode ? window.setInterval(() => void load(), 30000) : null;
    return () => {
      alive = false;
      controller?.abort();
      if (poll !== null) window.clearInterval(poll);
    };
  }, [indexName, liveMode, buildupDate, buildupTimestamp, buildupInterval, showBuildup]);

  const refreshWallWatches = useCallback(async () => {
    try {
      const response = await fetch(`/api/wall-watches?index=${encodeURIComponent(indexName)}`);
      if (!response.ok) return;
      const payload = await response.json();
      setWallWatches({
        CE: payload.watches?.CE ?? { armed: false, watched_strike: null },
        PE: payload.watches?.PE ?? { armed: false, watched_strike: null },
      });
    } catch { /* Keep the last known indicator state during transient network failures. */ }
  }, [indexName]);

  useEffect(() => {
    void refreshWallWatches();
    const timer = window.setInterval(() => void refreshWallWatches(), 4000);
    return () => window.clearInterval(timer);
  }, [refreshWallWatches]);

  const toggleWallWatch = useCallback(async (side: 'CE' | 'PE', event: React.MouseEvent) => {
    // Keep the strike-row selection click separate from the watch action.
    event.preventDefault();
    event.stopPropagation();
    const action = wallWatches[side]?.armed ? 'disarm' : 'arm';
    setWatchBusy(side);
    setWatchError(null);

    // A stalled backend request must not leave the bell permanently disabled.
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(
        `/api/wall-watches/${encodeURIComponent(indexName)}/${side}/${action}`,
        { method: 'POST', signal: controller.signal }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `Could not ${action} wall watch`);

      // Reflect the successful POST immediately; the refresh below reconciles
      // both sides with the persisted server state.
      if (payload && typeof payload === 'object' && 'armed' in payload) {
        setWallWatches((current) => ({ ...current, [side]: payload }));
      }
      await refreshWallWatches();
    } catch (error) {
      setWatchError(controller.signal.aborted
        ? 'Wall-watch request timed out. Check the backend connection and try again.'
        : error instanceof Error ? error.message : 'Wall watch update failed');
    } finally {
      window.clearTimeout(timeoutId);
      setWatchBusy(null);
    }
  }, [indexName, wallWatches, refreshWallWatches]);

  // ── Group options by strike ──
  const chainData = useMemo(() => {
    const grouped: Record<number, { CE?: OptionData; PE?: OptionData }> = {};
    options.forEach((opt) => {
      if (!grouped[opt.strike]) grouped[opt.strike] = {};
      grouped[opt.strike][opt.option_type as 'CE' | 'PE'] = opt;
    });
    return Object.entries(grouped)
      .map(([strike, data]) => ({ strike: Number(strike), ...data }))
      .sort((a, b) => a.strike - b.strike);
  }, [options]);

  // ── Calculate ATM ──
  const atmSpot = useMemo(() => {
    if (!spot || chainData.length === 0) return null;
    return chainData.reduce((closest, row) =>
      Math.abs(row.strike - spot) < Math.abs(closest.strike - spot) ? row : closest
    ).strike;
  }, [spot, chainData]);

  // ── FIX: rank only strikes within ±OI_RANK_WINDOW_PCT of spot ──
  const rankableRows = useMemo(() => {
    if (!spot) return chainData;
    const lo = spot * (1 - OI_RANK_WINDOW_PCT / 100);
    const hi = spot * (1 + OI_RANK_WINDOW_PCT / 100);
    const windowed = chainData.filter((r) => r.strike >= lo && r.strike <= hi);
    // Safety: if the window somehow contains nothing, fall back to all rows
    // so the badges never vanish entirely.
    return windowed.length > 0 ? windowed : chainData;
  }, [chainData, spot]);

  // ── CE/PE OI ranking — TOP 3 (within the spot window) ──
  const ceOiRanks = useMemo(() => {
    const sorted = [...rankableRows].sort((a, b) => (b.CE?.oi ?? 0) - (a.CE?.oi ?? 0));
    const ranks: Record<number, number> = {};
    sorted.slice(0, 3).forEach((row, i) => { ranks[row.strike] = i + 1; });
    return ranks;
  }, [rankableRows]);

  const peOiRanks = useMemo(() => {
    const sorted = [...rankableRows].sort((a, b) => (b.PE?.oi ?? 0) - (a.PE?.oi ?? 0));
    const ranks: Record<number, number> = {};
    sorted.slice(0, 3).forEach((row, i) => { ranks[row.strike] = i + 1; });
    return ranks;
  }, [rankableRows]);

  // Walls are the strongest OI concentrations in the loaded expiry chain.
  // Spot crossing a wall, or moving far away from it, must never reclassify
  // the wall. Only a change in relative CE/PE OI can move these levels.
  const currentWalls = useMemo(() => {
    const find = (side: 'CE' | 'PE') => {
      const sideRows = chainData.filter(row => side === 'CE' ? !!row.CE : !!row.PE);
      sideRows.sort((a, b) =>
        ((side === 'CE' ? b.CE?.oi ?? 0 : b.PE?.oi ?? 0) -
          (side === 'CE' ? a.CE?.oi ?? 0 : a.PE?.oi ?? 0)) ||
        a.strike - b.strike
      );
      return sideRows[0]?.strike ?? null;
    };
    return { CE: find('CE'), PE: find('PE') };
  }, [chainData]);

  const visibleWallEvents = useMemo(() => {
    const events = wallHistory?.events ?? [];
    const cutoff = timestamp ? timestamp.replace('T', ' ').slice(0, 19) : null;
    return cutoff
      ? events.filter((event) => event.timestamp.replace('T', ' ').slice(0, 19) <= cutoff)
      : events;
  }, [wallHistory, timestamp]);

  const lastWallMove = useMemo(() => {
    const findLatest = (side: 'CE' | 'PE') => {
      const currentStrike = currentWalls[side];
      if (currentStrike == null) return null;
      for (let i = visibleWallEvents.length - 1; i >= 0; i -= 1) {
        const event = visibleWallEvents[i];
        if (event.side === side && Number(event.to_strike) === Number(currentStrike)) return event;
      }
      return null;
    };
    return { CE: findLatest('CE'), PE: findLatest('PE') };
  }, [visibleWallEvents, currentWalls]);

  const showWallHover = useCallback((side: 'CE' | 'PE', strike: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const tooltipWidth = 292;
    const tooltipHeight = 208;
    const gap = 10;
    const edge = 12;
    const preferredLeft = side === 'CE' ? rect.right + gap : rect.left - tooltipWidth - gap;
    const alternateLeft = side === 'CE' ? rect.left - tooltipWidth - gap : rect.right + gap;
    const chosenLeft = preferredLeft >= edge && preferredLeft + tooltipWidth <= window.innerWidth - edge
      ? preferredLeft
      : alternateLeft;
    const left = Math.max(edge, Math.min(chosenLeft, window.innerWidth - tooltipWidth - edge));
    const top = Math.max(
      edge,
      Math.min(rect.top + rect.height / 2 - tooltipHeight / 2, window.innerHeight - tooltipHeight - edge),
    );
    setWallHover({ side, strike, left, top });
  }, []);

  const hideWallHover = useCallback(() => setWallHover(null), []);



  // ── Center view around ATM ──
  const displayRows = useMemo(() => {
    const center = atmSpot;
    let visibleRows = chainData;
    if (center && chainData.length > 21) {
      const centerIdx = chainData.findIndex((r) => r.strike === center);
      if (centerIdx < 0) {
        visibleRows = chainData.slice(0, 21);
      } else {
        const start = Math.max(0, centerIdx - 10);
        const end = Math.min(chainData.length, centerIdx + 11);
        visibleRows = chainData.slice(start, end);
      }
    }
    return strikeOrder === 'asc' ? visibleRows : [...visibleRows].reverse();
  }, [chainData, atmSpot, strikeOrder]);

  // ── Jump to ATM ──
  // Scroll only the option-chain rows. Element.scrollIntoView() can also
  // scroll ancestor containers (including the page), which moves the sticky
  // Market Timer over the replay seeker and hides the controls.
  const scrollToAtm = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !atmSpot) return;

    const atmRow = container.querySelector<HTMLElement>(`[data-strike="${atmSpot}"]`);
    if (!atmRow) return;

    const containerRect = container.getBoundingClientRect();
    const rowRect = atmRow.getBoundingClientRect();
    const rowTopWithinContainer = container.scrollTop + rowRect.top - containerRect.top;
    const targetTop = rowTopWithinContainer - (container.clientHeight - rowRect.height) / 2;

    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: 'smooth',
    });
  }, [atmSpot]);

  const buildupByStrike = useMemo(() => {
    const map = new Map<number, { CE: BuildupSide | null; PE: BuildupSide | null }>();
    for (const row of buildupPayload?.rows ?? []) map.set(row.strike, { CE: row.CE, PE: row.PE });
    return map;
  }, [buildupPayload]);

  const visibleColumnCount = [
    columnVisibility.oiChange,
    columnVisibility.volume,
    columnVisibility.ltp,
    columnVisibility.iv,
    columnVisibility.delta,
    columnVisibility.gamma,
    columnVisibility.oi,
  ].filter(Boolean).length;
  const sideGridStyle = { gridTemplateColumns: `repeat(${Math.max(1, visibleColumnCount)}, minmax(0, 1fr))` };

  const fmt = (n: number | undefined | null, digits = 0) => {
    if (n === undefined || n === null) return '—';
    if (digits === 0) return n.toLocaleString('en-IN');
    return n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };

  const getStrikeClass = (strike: number) => {
    if (strike === atmSpot) return 'bg-yellow-900/30 text-yellow-300 border border-yellow-500/40';
    return 'text-terminal-text border border-terminal-border/30';
  };

  const getCeOiClass = (strike: number) => {
    const rank = ceOiRanks[strike];
    if (rank === 1) return 'bg-red-800 text-red-100 font-bold shadow-sm shadow-red-900/50';
    if (rank === 2) return 'bg-red-900/40 text-red-300 font-semibold';
    if (rank === 3) return 'bg-red-950/30 text-red-400 font-medium';
    return 'text-terminal-text';
  };

  const getPeOiClass = (strike: number) => {
    const rank = peOiRanks[strike];
    if (rank === 1) return 'bg-green-800 text-green-100 font-bold shadow-sm shadow-green-900/50';
    if (rank === 2) return 'bg-green-900/40 text-green-300 font-semibold';
    if (rank === 3) return 'bg-green-950/30 text-green-400 font-medium';
    return 'text-terminal-text';
  };

  const getGammaFlipClass = (strike: number) => {
    return strike === gammaFlip ? 'border-b-2 border-cyan-500' : '';
  };

  const OiRankBadge = ({ rank }: { rank?: number }) => {
    if (!rank) return null;
    const colors = ['', 'bg-red-600', 'bg-red-500/70', 'bg-red-400/50'];
    const textColors = ['', 'text-white', 'text-red-100', 'text-red-200'];
    return (
      <span className={`inline-flex items-center justify-center w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full text-[8px] sm:text-[9px] font-bold ml-0.5 sm:ml-1 ${colors[rank]} ${textColors[rank]}`}>
        {rank}
      </span>
    );
  };

  const PeOiRankBadge = ({ rank }: { rank?: number }) => {
    if (!rank) return null;
    const colors = ['', 'bg-green-600', 'bg-green-500/70', 'bg-green-400/50'];
    const textColors = ['', 'text-white', 'text-green-100', 'text-green-200'];
    return (
      <span className={`inline-flex items-center justify-center w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full text-[8px] sm:text-[9px] font-bold mr-0.5 sm:mr-1 ${colors[rank]} ${textColors[rank]}`}>
        {rank}
      </span>
    );
  };

  // Screenshot filename
  const tsLabel = timestamp ? timestamp.replace(/[:\s]/g, '-') : new Date().toISOString().slice(0,16).replace('T/g','-');
  const screenshotFilename = `${indexName}-option-chain-${tsLabel}`;

  // Empty state
  if (chainData.length === 0) {
    return (
      <div className="terminal-panel overflow-hidden" ref={panelRef}>
        <div className="terminal-header flex items-center justify-between">
          <span>Option Chain</span>
          <ScreenshotButton targetRef={panelRef} filename={screenshotFilename} />
        </div>
        <div
          className="flex flex-col items-center justify-center py-16 px-4"
          aria-live="polite"
          aria-busy={isLoading}
        >
          {isLoading ? (
            <>
              <Loader2 className="w-8 h-8 text-terminal-atm mb-3 animate-spin" />
              <p className="text-sm font-mono text-terminal-text mb-1">Loading historical snapshot…</p>
              <p className="text-xs font-mono text-terminal-muted/60 text-center max-w-xl">
                Fetching the selected timestamp. The option chain will appear when the snapshot arrives.
              </p>
            </>
          ) : (
            <>
              <AlertTriangle className="w-8 h-8 text-terminal-muted mb-3" />
              <p className="text-sm font-mono text-terminal-muted mb-1">{emptyTitle}</p>
              <p className="text-xs font-mono text-terminal-muted/60 text-center max-w-xl">
                {emptyDescription}
              </p>
              <p className="text-xs font-mono text-terminal-muted/60 mt-1 text-center max-w-xl">
                {emptyFootnote}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  const totalMinWidth = visibleColumnCount >= 7 ? 'min-w-[900px]' : visibleColumnCount >= 5 ? 'min-w-[760px]' : 'min-w-[680px]';

  return (
    <div className="terminal-panel overflow-hidden" ref={panelRef}>
      <style>{`
        .terminal-scroll {
          overflow-y: auto;
          overscroll-behavior-y: contain;
          scrollbar-gutter: stable;
          scrollbar-width: thin;
          scrollbar-color: #4b5563 transparent;
        }
        .terminal-scroll::-webkit-scrollbar {
          width: 5px;
          height: 5px;
        }
        .terminal-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .terminal-scroll::-webkit-scrollbar-thumb {
          background: #4b5563;
          border-radius: 3px;
        }
        .terminal-scroll::-webkit-scrollbar-thumb:hover {
          background: #9ca3af;
        }
        .terminal-scroll::-webkit-scrollbar-corner {
          background: transparent;
        }
      `}</style>

      <div className="terminal-header flex items-center justify-between">
        <span className="text-xs sm:text-sm">Option Chain</span>
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-3 text-[10px]">
            <div className="flex items-center gap-1.5">
              <span className="w-5 h-4 rounded bg-red-800 text-white text-[8px] flex items-center justify-center font-bold">1</span>
              <span className="w-5 h-4 rounded bg-red-900/40 text-red-300 text-[8px] flex items-center justify-center font-semibold">2</span>
              <span className="w-5 h-4 rounded bg-red-950/30 text-red-400 text-[8px] flex items-center justify-center">3</span>
              <span className="text-terminal-muted">CE OI</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-5 h-4 rounded bg-green-800 text-white text-[8px] flex items-center justify-center font-bold">1</span>
              <span className="w-5 h-4 rounded bg-green-900/40 text-green-300 text-[8px] flex items-center justify-center font-semibold">2</span>
              <span className="w-5 h-4 rounded bg-green-950/30 text-green-400 text-[8px] flex items-center justify-center">3</span>
              <span className="text-terminal-muted">PE OI</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-white/10" />
              <span className="text-terminal-muted">ITM</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-yellow-500/40" />
              <span className="text-terminal-muted">ATM Spot</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-cyan-500/40" />
              <span className="text-terminal-muted">ATM Fut</span>
            </div>
            {showBuildup && (
              <div className="flex items-center gap-1" title={buildupError || buildupPayload?.reason || 'Premium and OI movement classification. Hover the LB/SB/SC/LU code for details.'}>
                <span className="text-terminal-muted mr-0.5">Build</span>
                {BUILDUP_INTERVALS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setBuildupInterval(item.value)}
                    aria-pressed={buildupInterval === item.value}
                    className={`px-1.5 py-0.5 rounded border text-[9px] font-mono transition-colors ${
                      buildupInterval === item.value
                        ? 'border-terminal-atm/40 bg-terminal-atm/10 text-terminal-atm'
                        : 'border-terminal-border/60 text-terminal-muted hover:text-terminal-text hover:bg-white/5'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
                {buildupError && <span className="text-amber-300 text-[9px]" title={buildupError}>!</span>}
              </div>
            )}
            <button
              type="button"
              onClick={() => setStrikeOrder(order => order === 'asc' ? 'desc' : 'asc')}
              className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border border-terminal-border/60 text-terminal-text hover:bg-white/5 transition-colors"
              title={strikeOrder === 'asc' ? 'Strike order ascending — click for descending' : 'Strike order descending — click for ascending'}
              aria-label={strikeOrder === 'asc' ? 'Switch to descending strike order' : 'Switch to ascending strike order'}
              aria-pressed={strikeOrder === 'desc'}
            >
              {strikeOrder === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
              Strike {strikeOrder === 'asc' ? 'Asc' : 'Desc'}
            </button>
            {atmSpot && (
              <button
                onClick={scrollToAtm}
                className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-terminal-atm/10 text-terminal-atm border border-terminal-atm/30 hover:bg-terminal-atm/20 transition-colors"
                title="Jump to ATM strike"
              >
                <ArrowDown className="w-3 h-3" />
                Jump to ATM
              </button>
            )}
          </div>
          <ScreenshotButton targetRef={panelRef} filename={screenshotFilename} />
        </div>
      </div>

      {/* MOBILE LEGEND — visible only on small screens */}
      <div className="sm:hidden flex flex-wrap items-center gap-2 px-2 py-1.5 text-[9px] font-mono text-terminal-muted border-b border-terminal-border bg-terminal-bg/95">
        <div className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-white/10" />
          <span>ITM</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-yellow-500/40" />
          <span>ATM</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-cyan-500/40" />
          <span>Fut</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-red-600" />
          <span>CE#1</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-green-600" />
          <span>PE#1</span>
        </div>
        {atmSpot && (
          <button
            onClick={scrollToAtm}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-terminal-atm/10 text-terminal-atm border border-terminal-atm/30"
          >
            <ArrowDown className="w-2.5 h-2.5" />
            ATM
          </button>
        )}
      </div>

      {/* ── HORIZONTAL SCROLL WRAPPER ── */}
      {watchError && <div role="alert" aria-live="polite" className="px-2 py-1 text-[10px] font-mono text-amber-300 bg-amber-500/[0.06] border-b border-amber-500/20">{watchError}</div>}
      <div className="overflow-x-auto terminal-scroll">
        <div className={totalMinWidth}>

          {/* Sticky Header */}
          <div className="sticky top-0 z-10 grid grid-cols-[1fr_64px_1fr] sm:grid-cols-[1fr_80px_1fr] gap-0 text-[9px] sm:text-[10px] font-mono text-terminal-muted border-b border-terminal-border bg-terminal-bg/95 backdrop-blur-sm">
            {/* CE Header */}
            <div className="grid" style={sideGridStyle}>
              {columnVisibility.oiChange && <div className="px-1 sm:px-2 py-1.5 text-center">Chg</div>}
              {columnVisibility.volume && <div className="px-1 sm:px-2 py-1.5 text-center">Vol</div>}
              {columnVisibility.ltp && <div className="px-1 sm:px-2 py-1.5 text-center">LTP</div>}
              {columnVisibility.iv && <div className="px-1 sm:px-2 py-1.5 text-center">IV</div>}
              {columnVisibility.delta && <div className="px-1 sm:px-2 py-1.5 text-center">Δ</div>}
              {columnVisibility.gamma && <div className="px-1 sm:px-2 py-1.5 text-center">Γ</div>}
              {columnVisibility.oi && <div className="px-1 sm:px-2 py-1.5 text-center">OI</div>}
            </div>
            {/* Strike Header */}
            <div className="px-1 sm:px-2 py-1.5 text-center font-bold">STRIKE</div>
            {/* PE Header */}
            <div className="grid" style={sideGridStyle}>
              {columnVisibility.oi && <div className="px-1 sm:px-2 py-1.5 text-center">OI</div>}
              {columnVisibility.ltp && <div className="px-1 sm:px-2 py-1.5 text-center">LTP</div>}
              {columnVisibility.volume && <div className="px-1 sm:px-2 py-1.5 text-center">Vol</div>}
              {columnVisibility.oiChange && <div className="px-1 sm:px-2 py-1.5 text-center">Chg</div>}
              {columnVisibility.gamma && <div className="px-1 sm:px-2 py-1.5 text-center">Γ</div>}
              {columnVisibility.delta && <div className="px-1 sm:px-2 py-1.5 text-center">Δ</div>}
              {columnVisibility.iv && <div className="px-1 sm:px-2 py-1.5 text-center">IV</div>}
            </div>
          </div>

          {/* Scrollable Rows */}
          <div
            ref={scrollContainerRef}
            className="max-h-[50vh] sm:max-h-[65vh] terminal-scroll"
          >
            {displayRows.map((row) => {
              const ce = row.CE;
              const pe = row.PE;
              const isSelected = row.strike === selectedStrike;
              const ceRank = ceOiRanks[row.strike];
              const peRank = peOiRanks[row.strike];
              const buildup = buildupByStrike.get(row.strike);
              const ceBuildup = buildup?.CE ?? null;
              const peBuildup = buildup?.PE ?? null;
              // FIX (ITM tint): CE is ITM below spot, PE is ITM above spot.
              const ceItm = spot != null && row.strike < spot;
              const peItm = spot != null && row.strike > spot;

              return (
                <div
                  key={row.strike}
                  data-strike={row.strike}
                  onClick={() => onSelectStrike(row.strike)}
                  className={`grid grid-cols-[1fr_64px_1fr] sm:grid-cols-[1fr_80px_1fr] gap-0 text-[10px] sm:text-xs font-mono cursor-pointer transition-colors hover:bg-white/5 ${
                    isSelected ? 'bg-white/10' : ''
                  } ${getGammaFlipClass(row.strike)}`}
                >
                  {/* CE Side */}
                  <div className="grid gap-0" style={sideGridStyle}>
                    {columnVisibility.oiChange && (
                      <div className={`px-1 sm:px-2 py-1 text-right flex items-center justify-end gap-1 min-w-0 ${(ce?.oi_change ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        <span className="truncate">{(ce?.oi_change ?? 0) > 0 ? '+' : ''}{fmt(ce?.oi_change)}</span>
                        {showBuildup && ceBuildup && BUILDUP_CODES[ceBuildup.classification] && BUILDUP_CODES[ceBuildup.classification] !== '—' && (
                          <span
                            title={buildupTooltip(ceBuildup, buildupPayload?.baseline_timestamp, buildupPayload?.as_of_timestamp)}
                            className={`shrink-0 text-[8px] font-bold tracking-tight ${BUILDUP_STYLES[ceBuildup.classification] || 'text-terminal-muted'}`}
                          >
                            {BUILDUP_CODES[ceBuildup.classification]}
                          </span>
                        )}
                      </div>
                    )}
                    {columnVisibility.volume && <div className="px-1 sm:px-2 py-1 text-right text-terminal-muted">{fmt(ce?.volume)}</div>}
                    {columnVisibility.ltp && <div className="px-1 sm:px-2 py-1 text-right text-terminal-ce font-semibold">{fmt(ce?.ltp, 2)}</div>}
                    {columnVisibility.iv && <div className="px-1 sm:px-2 py-1 text-right text-terminal-muted">{fmt(ce?.iv, 1)}</div>}
                    {columnVisibility.delta && <div className="px-1 sm:px-2 py-1 text-right text-terminal-muted">{fmt(ce?.delta, 3)}</div>}
                    {columnVisibility.gamma && <div className="px-1 sm:px-2 py-1 text-right text-terminal-muted">{fmt(ce?.gamma, 4)}</div>}
                    {columnVisibility.oi && (
                      <div
                        className={`group/ceoi relative px-1 sm:px-2 py-1 text-right flex items-center justify-end min-w-0 ${getCeOiClass(row.strike)}`}
                        onMouseEnter={currentWalls.CE === row.strike ? (event) => showWallHover('CE', row.strike, event.currentTarget) : undefined}
                        onMouseLeave={currentWalls.CE === row.strike ? hideWallHover : undefined}
                        onFocus={currentWalls.CE === row.strike ? (event) => showWallHover('CE', row.strike, event.currentTarget) : undefined}
                        onBlur={currentWalls.CE === row.strike ? hideWallHover : undefined}
                        tabIndex={currentWalls.CE === row.strike ? 0 : undefined}
                        aria-label={currentWalls.CE === row.strike ? `Call wall at ${fmt(row.strike)}. Hover or focus to view its last movement.` : undefined}
                      >
                        <OiRankBadge rank={ceRank} />
                        {currentWalls.CE === row.strike && (
                          <button
                            type="button"
                            onClick={(event) => void toggleWallWatch('CE', event)}
                            disabled={watchBusy === 'CE' || (!wallWatches.CE?.armed && !canArm)}
                            title={wallWatches.CE?.armed
                              ? `Disarm Call Wall watch at ${fmt(wallWatches.CE.watched_strike)}`
                              : canArm ? `Arm Call Wall watch at ${fmt(row.strike)}` : 'Wall watch requires a connected, non-stale live feed'}
                            aria-label={wallWatches.CE?.armed ? 'Disarm Call Wall alert' : 'Arm Call Wall alert'}
                            aria-busy={watchBusy === 'CE'}
                            className={`relative z-10 ml-0.5 inline-flex h-5 w-5 shrink-0 pointer-events-auto items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${wallWatches.CE?.armed ? 'text-amber-200 bg-amber-500/20 hover:bg-amber-500/30' : 'text-terminal-muted hover:text-amber-300 hover:bg-amber-500/10'} disabled:cursor-not-allowed disabled:opacity-40`}
                          >
                            {watchBusy === 'CE'
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : wallWatches.CE?.armed
                                ? <BellRing className="h-3.5 w-3.5" />
                                : <Bell className="h-3.5 w-3.5" />}
                          </button>
                        )}
                        <span className="ml-0.5">{fmt(ce?.oi)}</span>
                      </div>
                    )}
                  </div>

                  {/* Strike */}
                  <div className={`px-1 sm:px-2 py-1 text-center font-bold text-xs sm:text-sm ${getStrikeClass(row.strike)}`}>
                    {row.strike.toLocaleString('en-IN')}
                  </div>

                  {/* PE Side */}
                  <div className="grid gap-0" style={sideGridStyle}>
                    {columnVisibility.oi && (
                      <div
                        className={`group/peoi relative px-1 sm:px-2 py-1 text-left flex items-center min-w-0 ${getPeOiClass(row.strike)}`}
                        onMouseEnter={currentWalls.PE === row.strike ? (event) => showWallHover('PE', row.strike, event.currentTarget) : undefined}
                        onMouseLeave={currentWalls.PE === row.strike ? hideWallHover : undefined}
                        onFocus={currentWalls.PE === row.strike ? (event) => showWallHover('PE', row.strike, event.currentTarget) : undefined}
                        onBlur={currentWalls.PE === row.strike ? hideWallHover : undefined}
                        tabIndex={currentWalls.PE === row.strike ? 0 : undefined}
                        aria-label={currentWalls.PE === row.strike ? `Put wall at ${fmt(row.strike)}. Hover or focus to view its last movement.` : undefined}
                      >
                        <PeOiRankBadge rank={peRank} />
                        {currentWalls.PE === row.strike && (
                          <button
                            type="button"
                            onClick={(event) => void toggleWallWatch('PE', event)}
                            disabled={watchBusy === 'PE' || (!wallWatches.PE?.armed && !canArm)}
                            title={wallWatches.PE?.armed
                              ? `Disarm Put Wall watch at ${fmt(wallWatches.PE.watched_strike)}`
                              : canArm ? `Arm Put Wall watch at ${fmt(row.strike)}` : 'Wall watch requires a connected, non-stale live feed'}
                            aria-label={wallWatches.PE?.armed ? 'Disarm Put Wall alert' : 'Arm Put Wall alert'}
                            aria-busy={watchBusy === 'PE'}
                            className={`relative z-10 ml-0.5 inline-flex h-5 w-5 shrink-0 pointer-events-auto items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${wallWatches.PE?.armed ? 'text-amber-200 bg-amber-500/20 hover:bg-amber-500/30' : 'text-terminal-muted hover:text-amber-300 hover:bg-amber-500/10'} disabled:cursor-not-allowed disabled:opacity-40`}
                          >
                            {watchBusy === 'PE'
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : wallWatches.PE?.armed
                                ? <BellRing className="h-3.5 w-3.5" />
                                : <Bell className="h-3.5 w-3.5" />}
                          </button>
                        )}
                        <span className="ml-0.5">{fmt(pe?.oi)}</span>
                      </div>
                    )}
                    {columnVisibility.ltp && <div className="px-1 sm:px-2 py-1 text-left text-terminal-pe font-semibold">{fmt(pe?.ltp, 2)}</div>}
                    {columnVisibility.volume && <div className="px-1 sm:px-2 py-1 text-left text-terminal-muted">{fmt(pe?.volume)}</div>}
                    {columnVisibility.oiChange && (
                      <div className={`px-1 sm:px-2 py-1 text-left flex items-center gap-1 min-w-0 ${(pe?.oi_change ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        <span className="truncate">{(pe?.oi_change ?? 0) > 0 ? '+' : ''}{fmt(pe?.oi_change)}</span>
                        {showBuildup && peBuildup && BUILDUP_CODES[peBuildup.classification] && BUILDUP_CODES[peBuildup.classification] !== '—' && (
                          <span
                            title={buildupTooltip(peBuildup, buildupPayload?.baseline_timestamp, buildupPayload?.as_of_timestamp)}
                            className={`shrink-0 text-[8px] font-bold tracking-tight ${BUILDUP_STYLES[peBuildup.classification] || 'text-terminal-muted'}`}
                          >
                            {BUILDUP_CODES[peBuildup.classification]}
                          </span>
                        )}
                      </div>
                    )}
                    {columnVisibility.gamma && <div className="px-1 sm:px-2 py-1 text-left text-terminal-muted">{fmt(pe?.gamma, 4)}</div>}
                    {columnVisibility.delta && <div className="px-1 sm:px-2 py-1 text-left text-terminal-muted">{fmt(pe?.delta, 3)}</div>}
                    {columnVisibility.iv && <div className="px-1 sm:px-2 py-1 text-left text-terminal-muted">{fmt(pe?.iv, 1)}</div>}
                  </div>
                </div>
              );
            })}
            {/* Bottom fade */}
            <div className="sticky bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-terminal-bg to-transparent pointer-events-none" />
          </div>

        </div>
      </div>
      {wallHover && createPortal((() => {
        const event = lastWallMove[wallHover.side];
        const sideIsCe = wallHover.side === 'CE';
        return (
          <div
            role="tooltip"
            className={`pointer-events-none fixed z-[100] w-[292px] overflow-hidden rounded-lg border shadow-2xl shadow-black/50 ${sideIsCe ? 'border-red-400/70 bg-[#190D12]' : 'border-emerald-400/70 bg-[#081A15]'}`}
            style={{ left: wallHover.left, top: wallHover.top }}
          >
            <div className={`flex items-center justify-between gap-2 border-b px-3 py-2 ${sideIsCe ? 'border-red-400/25 bg-red-500/10' : 'border-emerald-400/25 bg-emerald-500/10'}`}>
              <span className={`text-[10px] font-mono font-bold tracking-wider ${sideIsCe ? 'text-red-200' : 'text-emerald-200'}`}>
                {wallHover.side} WALL · LAST MOVEMENT
              </span>
              <span className="text-[10px] font-mono tabular-nums text-white">
                {event ? event.timestamp.slice(11, 19) : '—'}
              </span>
            </div>
            <div className="p-3">
              {event ? (
                <>
                  <div className="grid grid-cols-[1fr_22px_1fr] items-center gap-2">
                    <div className="min-w-0 rounded-md border border-white/10 bg-white/[0.045] p-2">
                      <div className="text-[9px] font-mono text-slate-400">PREVIOUS WALL</div>
                      <div className="mt-1 whitespace-nowrap text-lg font-bold font-mono tabular-nums text-slate-100">
                        {fmt(event.from_strike)}
                      </div>
                    </div>
                    <ArrowDown className="h-4 w-4 rotate-[-90deg] text-slate-400" />
                    <div className={`min-w-0 rounded-md border p-2 ${sideIsCe ? 'border-red-400/35 bg-red-500/10' : 'border-emerald-400/35 bg-emerald-500/10'}`}>
                      <div className={`text-[9px] font-mono ${sideIsCe ? 'text-red-200/80' : 'text-emerald-200/80'}`}>CURRENT WALL</div>
                      <div className={`mt-1 whitespace-nowrap text-lg font-bold font-mono tabular-nums ${sideIsCe ? 'text-red-100' : 'text-emerald-100'}`}>
                        {fmt(event.to_strike)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 border-t border-white/10 pt-2">
                    <div>
                      <div className="text-[9px] font-mono text-slate-400">OI BEFORE</div>
                      <div className="mt-0.5 text-xs font-semibold font-mono tabular-nums text-slate-200">{fmt(event.from_oi)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] font-mono text-slate-400">OI AFTER</div>
                      <div className={`mt-0.5 text-xs font-semibold font-mono tabular-nums ${sideIsCe ? 'text-red-100' : 'text-emerald-100'}`}>{fmt(event.to_oi)}</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="py-2">
                  <div className="text-sm font-semibold font-mono text-white">{fmt(wallHover.strike)}</div>
                  <div className="mt-1 text-[10px] font-mono leading-relaxed text-slate-300">
                    {wallHistoryError
                      ? 'Wall history is temporarily unavailable.'
                      : 'No previous wall movement is recorded for this strike today.'}
                  </div>
                </div>
              )}
              <div className="mt-2 border-t border-white/10 pt-2 text-[9px] font-mono text-slate-500">
                Time is based on the first saved snapshot showing the new wall.
              </div>
            </div>
          </div>
        );
      })(), document.body)}
    </div>
  );
};

export const OptionChain = React.memo(OptionChainComponent);
