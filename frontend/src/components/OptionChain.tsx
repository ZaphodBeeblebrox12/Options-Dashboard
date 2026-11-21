import React, { useMemo, useRef, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowDown, ArrowUp, Bell, BellRing, Loader2 } from 'lucide-react';
import { ScreenshotButton } from './ScreenshotButton';
import { COMPACT_OPTION_CHAIN_COLUMNS, hasEligibleVolumeContract, type OptionChainColumnVisibility } from './optionChainColumns';

interface OptionData {
  strike: number;
  option_type: string;
  oi: number;
  oi_change: number;
  oi_change_pct?: number | null;
  volume: number;
  volume_valid?: boolean | number | null;
  source_updated_at?: string | null;
  source_age_sec?: number | null;
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

// Filled, high-contrast tags keep buildup classifications readable in dense chain rows.
const BUILDUP_STYLES: Record<string, string> = {
  'LONG BUILDUP': 'bg-emerald-600 text-white ring-1 ring-emerald-400/30',
  'SHORT BUILDUP': 'bg-red-600 text-white ring-1 ring-red-400/30',
  'SHORT COVERING': 'bg-sky-600 text-white ring-1 ring-sky-400/30',
  'LONG UNWINDING': 'bg-amber-500 text-slate-950 ring-1 ring-amber-300/40',
  'MIXED': 'bg-slate-600 text-white ring-1 ring-slate-400/30',
  'NO CHANGE': 'bg-slate-700 text-slate-200',
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
  highlightHighestVolume?: boolean;
  hideZeroVolumeStrikes?: boolean;
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
  highlightHighestVolume = true,
  hideZeroVolumeStrikes = true,
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
  const showBuildup = columnVisibility.buildup;

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

  const toggleWallWatch = useCallback(async (side: 'CE' | 'PE', strike: number, event: React.MouseEvent) => {
    // Keep the strike-row selection click separate from the watch action.
    event.preventDefault();
    event.stopPropagation();
    // A side may still have a watch armed at an older wall. Only disarm when
    // the bell pressed belongs to that exact watched strike; otherwise re-arm
    // at the current wall selected by the backend.
    const watch = wallWatches[side];
    const isThisStrikeWatched = Boolean(watch?.armed && Number(watch.watched_strike) === strike);
    const action = isThisStrikeWatched ? 'disarm' : 'arm';
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

  // A strike participates in chain analysis when at least one side has
  // volume >= 2. CE and PE are tested independently.
  const volumeEligibleRows = useMemo(
    () => chainData.filter(
      (row) => hasEligibleVolumeContract(row.CE) || hasEligibleVolumeContract(row.PE)
    ),
    [chainData],
  );

  // ── Calculate ATM from contracts with meaningful traded volume ──
  const atmSpot = useMemo(() => {
    if (!spot || volumeEligibleRows.length === 0) return null;
    return volumeEligibleRows.reduce((closest, row) =>
      Math.abs(row.strike - spot) < Math.abs(closest.strike - spot) ? row : closest
    ).strike;
  }, [spot, volumeEligibleRows]);

  // ── FIX: rank only strikes within ±OI_RANK_WINDOW_PCT of spot ──
  const rankableRows = useMemo(() => {
    if (!spot) return volumeEligibleRows;
    const lo = spot * (1 - OI_RANK_WINDOW_PCT / 100);
    const hi = spot * (1 + OI_RANK_WINDOW_PCT / 100);
    const windowed = volumeEligibleRows.filter((r) => r.strike >= lo && r.strike <= hi);
    // Safety: if the spot window contains nothing, rank the eligible chain.
    return windowed.length > 0 ? windowed : volumeEligibleRows;
  }, [volumeEligibleRows, spot]);

  // ── CE/PE OI ranking — TOP 3 (within the spot window) ──
  const ceOiRanks = useMemo(() => {
    const sorted = rankableRows.filter(row => hasEligibleVolumeContract(row.CE))
      .sort((a, b) => (b.CE?.oi ?? 0) - (a.CE?.oi ?? 0));
    const ranks: Record<number, number> = {};
    sorted.slice(0, 3).forEach((row, i) => { ranks[row.strike] = i + 1; });
    return ranks;
  }, [rankableRows]);

  const peOiRanks = useMemo(() => {
    const sorted = rankableRows.filter(row => hasEligibleVolumeContract(row.PE))
      .sort((a, b) => (b.PE?.oi ?? 0) - (a.PE?.oi ?? 0));
    const ranks: Record<number, number> = {};
    sorted.slice(0, 3).forEach((row, i) => { ranks[row.strike] = i + 1; });
    return ranks;
  }, [rankableRows]);

  // Highlight the single highest-volume contract on each side using the same
  // near-spot ranking window as OI, so distant strikes cannot dominate the view.
  const highestVolumeStrikes = useMemo(() => {
    const find = (side: 'CE' | 'PE') => {
      const candidates = rankableRows.filter((row) => {
        return hasEligibleVolumeContract(row[side]);
      });
      candidates.sort((a, b) =>
        ((b[side]?.volume ?? 0) - (a[side]?.volume ?? 0)) || a.strike - b.strike
      );
      return candidates[0]?.strike ?? null;
    };
    return { CE: find('CE'), PE: find('PE') };
  }, [rankableRows]);

  // Walls are the strongest OI concentrations among contracts with volume >= 2.
  // Eligibility is independent: a quiet CE does not disqualify an active PE.
  const currentWalls = useMemo(() => {
    const find = (side: 'CE' | 'PE') => {
      const sideRows = volumeEligibleRows.filter(row =>
        hasEligibleVolumeContract(side === 'CE' ? row.CE : row.PE)
      );
      sideRows.sort((a, b) =>
        ((side === 'CE' ? b.CE?.oi ?? 0 : b.PE?.oi ?? 0) -
          (side === 'CE' ? a.CE?.oi ?? 0 : a.PE?.oi ?? 0)) ||
        a.strike - b.strike
      );
      return sideRows[0]?.strike ?? null;
    };
    return { CE: find('CE'), PE: find('PE') };
  }, [volumeEligibleRows]);

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
    const edge = 12;
    const tooltipWidth = Math.min(292, window.innerWidth - edge * 2);
    const tooltipHeight = 208;
    const gap = 10;
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
    let visibleRows = hideZeroVolumeStrikes ? volumeEligibleRows : chainData;
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

    // Keep the true whole-chain OI walls visible even when they sit outside
    // the 21-strike ATM window. The wall movement card and watch button are
    // attached to these exact backend wall levels, so hiding the row hides
    // both controls from the user.
    const requiredWallStrikes = new Set<number>();
    if (currentWalls.CE != null) requiredWallStrikes.add(currentWalls.CE);
    if (currentWalls.PE != null) requiredWallStrikes.add(currentWalls.PE);
    if (requiredWallStrikes.size > 0) {
      const visibleStrikes = new Set(visibleRows.map((row) => row.strike));
      for (const strike of requiredWallStrikes) visibleStrikes.add(strike);
      visibleRows = (hideZeroVolumeStrikes ? volumeEligibleRows : chainData)
        .filter((row) => visibleStrikes.has(row.strike));
    }

    // Never display low-volume values on an individual side. The row stays
    // when its opposite side has eligible volume; otherwise the default
    // setting removes the empty strike altogether.
    visibleRows = visibleRows.map((row) => ({
      ...row,
      CE: hasEligibleVolumeContract(row.CE) ? row.CE : undefined,
      PE: hasEligibleVolumeContract(row.PE) ? row.PE : undefined,
    }));

    return strikeOrder === 'asc' ? visibleRows : [...visibleRows].reverse();
  }, [chainData, volumeEligibleRows, atmSpot, strikeOrder, currentWalls, hideZeroVolumeStrikes]);

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

  // Keep a stable share for every visible metric; extra columns widen the
  // scroll surface rather than squeezing OI and Buildup into narrow slivers.
  const visibleColumnCount = [
    columnVisibility.oiChange,
    columnVisibility.oiChangePct,
    columnVisibility.buildup,
    columnVisibility.volume,
    columnVisibility.ltp,
    columnVisibility.iv,
    columnVisibility.delta,
    columnVisibility.gamma,
    columnVisibility.oi,
  ].filter(Boolean).length;
  const sideGridStyle = { gridTemplateColumns: `repeat(${Math.max(1, visibleColumnCount)}, minmax(0, 1fr))` };
  const totalMinWidthStyle = { minWidth: `${Math.max(760, 80 + visibleColumnCount * 128)}px` };

  const fmt = (n: number | undefined | null, digits = 0) => {
    if (n === undefined || n === null) return '—';
    if (digits === 0) return n.toLocaleString('en-IN');
    return n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };

  const fmtSignedPct = (n: number | null | undefined) => (
    n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${fmt(n, 2)}%`
  );

  const getStrikeClass = (strike: number) => {
    return strike === atmSpot
      ? 'tt-strike-spine-cell tt-strike-spine-cell--atm'
      : 'tt-strike-spine-cell';
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
    return strike === gammaFlip ? 'border-b-2 border-violet-400/80' : '';
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

  const totalMinWidth = totalMinWidthStyle;

  return (
    <div className="terminal-panel overflow-hidden" ref={panelRef}>
      <style>{`
        .terminal-scroll {
          overflow-x: auto;
          overflow-y: auto;
          overscroll-behavior: contain;
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

        /* TradeThesis option-chain system: Arctic strike spine with restrained side identities. */
        .tt-chain-head-ce {
          background-image: linear-gradient(90deg, rgba(124, 53, 70, 0.17), rgba(124, 53, 70, 0.025));
          color: #d9a1aa;
        }
        .tt-chain-head-pe {
          background-image: linear-gradient(270deg, rgba(42, 125, 91, 0.17), rgba(42, 125, 91, 0.025));
          color: #96d0ad;
        }
        .tt-strike-spine-head,
        .tt-strike-spine-cell {
          background: linear-gradient(180deg, #123641 0%, #0d2933 100%);
          border-left: 1px solid rgba(89, 194, 215, 0.34);
          border-right: 1px solid rgba(89, 194, 215, 0.34);
          color: #a9e6ef;
        }
        .tt-strike-spine-head {
          color: #82d9e7;
          letter-spacing: 0.11em;
          box-shadow: inset 0 1px 0 rgba(126, 218, 232, 0.12);
        }
        .tt-strike-spine-cell {
          border-bottom: 1px solid rgba(89, 194, 215, 0.085);
          font-weight: 700;
          text-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
        }
        .tt-strike-spine-cell--atm {
          background: linear-gradient(180deg, rgba(116, 83, 30, 0.96), rgba(69, 54, 29, 0.96));
          border-color: rgba(241, 190, 87, 0.62);
          color: #ffe1a0;
          box-shadow: inset 3px 0 0 rgba(241, 190, 87, 0.45), inset -3px 0 0 rgba(241, 190, 87, 0.45);
        }
        .tt-chain-side--ce {
          background-image: linear-gradient(90deg, rgba(124, 53, 70, 0.045), rgba(124, 53, 70, 0.008));
        }
        .tt-chain-side--pe {
          background-image: linear-gradient(270deg, rgba(42, 125, 91, 0.045), rgba(42, 125, 91, 0.008));
        }
        .tt-chain-row {
          position: relative;
          border-bottom: 1px solid rgba(148, 163, 184, 0.065);
          font-family: 'Inter', system-ui, sans-serif;
          font-variant-numeric: tabular-nums lining-nums;
        }
        .tt-chain-row--atm::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 1;
          pointer-events: none;
          background: linear-gradient(90deg, rgba(241, 190, 87, 0.035), rgba(241, 190, 87, 0.085) 50%, rgba(241, 190, 87, 0.035));
          border-top: 1px solid rgba(241, 190, 87, 0.42);
          border-bottom: 1px solid rgba(241, 190, 87, 0.42);
        }
        .tt-chain-row > .tt-chain-side,
        .tt-chain-row > .tt-strike-spine-cell {
          position: relative;
          z-index: 2;
        }
        .tt-volume-hit {
          font-weight: 600;
        }
        .tt-volume-hit--ce {
          background: rgba(177, 75, 93, 0.13);
          color: #efb3bb;
          box-shadow: inset 2px 0 0 rgba(215, 111, 129, 0.82);
        }
        .tt-volume-hit--pe {
          background: rgba(43, 145, 100, 0.13);
          color: #a2dfbd;
          box-shadow: inset 2px 0 0 rgba(84, 196, 139, 0.82);
        }

        /* Fluent-inspired wall movement surface: neutral frame, one active accent. */
        .tt-wall-tooltip {
          width: 292px;
          max-width: calc(100vw - 24px);
          overflow: hidden;
          color: #f2f6fa;
          font-family: "Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif;
          background: linear-gradient(180deg, rgba(28, 39, 50, 0.985), rgba(19, 28, 37, 0.99));
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 8px;
          box-shadow: 0 16px 38px rgba(0, 0, 0, 0.46), 0 2px 8px rgba(0, 0, 0, 0.26);
          backdrop-filter: blur(16px);
        }
        .tt-wall-topbar {
          min-height: 36px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 0 11px;
          background: rgba(255, 255, 255, 0.025);
          border-bottom: 1px solid rgba(255, 255, 255, 0.09);
        }
        .tt-wall-title-wrap {
          display: flex;
          align-items: center;
          gap: 7px;
          min-width: 0;
        }
        .tt-wall-pill {
          flex: 0 0 auto;
          padding: 0 6px;
          border: 1px solid transparent;
          border-radius: 4px;
          font-size: 8px;
          line-height: 16px;
          font-weight: 700;
          letter-spacing: 0.09em;
        }
        .tt-wall-pill--ce {
          color: #ffc0c5;
          background: rgba(214, 91, 108, 0.13);
          border-color: rgba(240, 139, 150, 0.2);
        }
        .tt-wall-pill--pe {
          color: #8ce7c0;
          background: rgba(42, 190, 130, 0.14);
          border-color: rgba(84, 214, 161, 0.2);
        }
        .tt-wall-heading {
          overflow: hidden;
          color: #edf4f8;
          font-size: 11px;
          font-weight: 650;
          letter-spacing: 0.015em;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
        .tt-wall-time {
          flex: 0 0 auto;
          padding: 3px 6px;
          color: #aebdca;
          background: rgba(255, 255, 255, 0.045);
          border: 1px solid rgba(255, 255, 255, 0.055);
          border-radius: 4px;
          font-size: 10px;
          letter-spacing: 0.015em;
          font-variant-numeric: tabular-nums;
        }
        .tt-wall-body {
          padding: 10px 11px 8px;
        }
        .tt-wall-movement {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 22px minmax(0, 1fr);
          align-items: center;
          gap: 5px;
        }
        .tt-wall-level {
          display: flex;
          min-width: 0;
          min-height: 62px;
          flex-direction: column;
          justify-content: space-between;
          padding: 8px 9px 9px;
          background: rgba(255, 255, 255, 0.035);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 5px;
        }
        .tt-wall-level--current-ce {
          background: linear-gradient(145deg, rgba(156, 38, 57, 0.68), rgba(91, 26, 38, 0.54));
          border-color: rgba(255, 133, 151, 0.92);
          box-shadow: inset 0 0 0 1px rgba(255, 133, 151, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.07);
        }
        .tt-wall-level--current-pe {
          background: linear-gradient(145deg, rgba(7, 112, 75, 0.70), rgba(5, 70, 52, 0.54));
          border-color: rgba(91, 235, 177, 0.94);
          box-shadow: inset 0 0 0 1px rgba(91, 235, 177, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.07);
        }
        .tt-wall-level-label {
          color: #a9b7c3;
          font-size: 8px;
          font-weight: 600;
          letter-spacing: 0.075em;
          text-transform: uppercase;
        }
        .tt-wall-level--current-ce .tt-wall-level-label { color: #ffc0c9; }
        .tt-wall-level--current-pe .tt-wall-level-label { color: #a4f2cf; }
        .tt-wall-level-value {
          color: #f5f8fa;
          font-size: 18px;
          line-height: 1.1;
          font-weight: 650;
          letter-spacing: -0.025em;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .tt-wall-level--current-ce .tt-wall-level-value { color: #ffe0e4; }
        .tt-wall-level--current-pe .tt-wall-level-value { color: #c5ffe5; }
        .tt-wall-arrow {
          display: grid;
          width: 22px;
          height: 22px;
          place-items: center;
          color: #8fa4b5;
          background: rgba(255, 255, 255, 0.035);
          border: 1px solid rgba(255, 255, 255, 0.09);
          border-radius: 50%;
        }
        .tt-wall-metrics {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          padding: 10px 1px 9px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.09);
        }
        .tt-wall-metric-label {
          margin-bottom: 4px;
          color: #93a3b0;
          font-size: 8px;
          font-weight: 600;
          letter-spacing: 0.075em;
          text-transform: uppercase;
        }
        .tt-wall-metric-value {
          color: #eaf1f6;
          font-size: 12px;
          line-height: 1.2;
          font-weight: 600;
          letter-spacing: -0.01em;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .tt-wall-metric--after-ce .tt-wall-metric-value { color: #f3b9c0; }
        .tt-wall-metric--after-pe .tt-wall-metric-value { color: #a8e8ca; }
        .tt-wall-footer {
          display: flex;
          align-items: flex-start;
          gap: 7px;
          padding: 8px 11px 9px;
          background: rgba(0, 0, 0, 0.12);
        }
        .tt-wall-info {
          display: grid;
          flex: 0 0 14px;
          width: 14px;
          height: 14px;
          margin-top: 1px;
          place-items: center;
          color: #60cdff;
          border: 1px solid rgba(96, 205, 255, 0.34);
          border-radius: 50%;
          font-family: Georgia, serif;
          font-size: 9px;
          font-weight: 600;
        }
        .tt-wall-footnote {
          color: #a2b1bd;
          font-size: 9px;
          line-height: 1.35;
        }
        .tt-wall-empty {
          padding: 4px 0 7px;
          color: #c9d4dd;
          font-size: 12px;
          line-height: 1.4;
        }
        .tt-wall-empty-value {
          margin-bottom: 5px;
          color: #f5f8fa;
          font-size: 16px;
          font-weight: 650;
          font-variant-numeric: tabular-nums;
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
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-[2px] rounded bg-violet-400" />
              <span className="text-terminal-muted">Γ Flip</span>
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
          <span className="w-2.5 h-0.5 rounded bg-violet-400" />
          <span>Γ Flip</span>
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
      <div
        ref={scrollContainerRef}
        className="max-h-[50vh] sm:max-h-[65vh] terminal-scroll"
      >
        <div style={totalMinWidth}>

          {/* Sticky Header */}
          <div className="tt-chain-head-row sticky top-0 z-10 grid grid-cols-[1fr_64px_1fr] sm:grid-cols-[1fr_80px_1fr] gap-0 text-[9px] sm:text-[10px] font-mono text-terminal-muted border-b border-terminal-border bg-terminal-bg/95 backdrop-blur-sm">
            {/* CE Header */}
            <div className="tt-chain-head-ce grid" style={sideGridStyle}>
              {columnVisibility.oiChange && <div className="px-1 sm:px-2 py-1.5 text-center">OI Chg</div>}
              {columnVisibility.oiChangePct && <div className="px-1 sm:px-2 py-1.5 text-center">Chg %</div>}
              {columnVisibility.buildup && <div className="px-1 sm:px-2 py-1.5 text-center">Build</div>}
              {columnVisibility.volume && <div className="px-1 sm:px-2 py-1.5 text-center">Vol</div>}
              {columnVisibility.ltp && <div className="px-1 sm:px-2 py-1.5 text-center">LTP</div>}
              {columnVisibility.iv && <div className="px-1 sm:px-2 py-1.5 text-center">IV</div>}
              {columnVisibility.delta && <div className="px-1 sm:px-2 py-1.5 text-center">Δ</div>}
              {columnVisibility.gamma && <div className="px-1 sm:px-2 py-1.5 text-center">Γ</div>}
              {columnVisibility.oi && <div className="px-1 sm:px-2 py-1.5 text-center">OI</div>}
            </div>
            {/* Strike Header */}
            <div className="tt-strike-spine-head px-1 sm:px-2 py-1.5 text-center font-bold">STRIKE</div>
            {/* PE Header */}
            <div className="tt-chain-head-pe grid" style={sideGridStyle}>
              {columnVisibility.oi && <div className="px-1 sm:px-2 py-1.5 text-center">OI</div>}
              {columnVisibility.ltp && <div className="px-1 sm:px-2 py-1.5 text-center">LTP</div>}
              {columnVisibility.volume && <div className="px-1 sm:px-2 py-1.5 text-center">Vol</div>}
              {columnVisibility.buildup && <div className="px-1 sm:px-2 py-1.5 text-center">Build</div>}
              {columnVisibility.oiChangePct && <div className="px-1 sm:px-2 py-1.5 text-center">Chg %</div>}
              {columnVisibility.oiChange && <div className="px-1 sm:px-2 py-1.5 text-center">OI Chg</div>}
              {columnVisibility.gamma && <div className="px-1 sm:px-2 py-1.5 text-center">Γ</div>}
              {columnVisibility.delta && <div className="px-1 sm:px-2 py-1.5 text-center">Δ</div>}
              {columnVisibility.iv && <div className="px-1 sm:px-2 py-1.5 text-center">IV</div>}
            </div>
          </div>

          {/* Option rows share the header's scroll container and width. */}
          <div>
            {displayRows.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs font-mono text-terminal-muted">
                No contracts meet the minimum volume of 2. Adjust Settings → Display to show inactive strike rows.
              </div>
            ) : displayRows.map((row) => {
              const ce = row.CE;
              const pe = row.PE;
              const ceWatchArmed = Boolean(wallWatches.CE?.armed && Number(wallWatches.CE.watched_strike) === row.strike);
              const peWatchArmed = Boolean(wallWatches.PE?.armed && Number(wallWatches.PE.watched_strike) === row.strike);
              const isSelected = row.strike === selectedStrike;
              const ceRank = ceOiRanks[row.strike];
              const peRank = peOiRanks[row.strike];
              const buildup = buildupByStrike.get(row.strike);
              const ceBuildup = hasEligibleVolumeContract(ce) ? buildup?.CE ?? null : null;
              const peBuildup = hasEligibleVolumeContract(pe) ? buildup?.PE ?? null : null;
              // FIX (ITM tint): CE is ITM below spot, PE is ITM above spot.
              const ceItm = spot != null && row.strike < spot;
              const peItm = spot != null && row.strike > spot;

              return (
                <div
                  key={row.strike}
                  data-strike={row.strike}
                  onClick={() => onSelectStrike(row.strike)}
                  className={`tt-chain-row grid grid-cols-[1fr_64px_1fr] sm:grid-cols-[1fr_80px_1fr] gap-0 text-[10px] sm:text-xs tabular-nums cursor-pointer transition-colors hover:bg-white/5 ${
                    isSelected ? 'bg-white/10' : ''
                  } ${row.strike === atmSpot ? 'tt-chain-row--atm' : ''} ${getGammaFlipClass(row.strike)}`}
                >
                  {/* CE Side */}
                  <div className={`tt-chain-side tt-chain-side--ce grid gap-0 ${ceItm ? ITM_TINT_CLASS : ''}`} style={sideGridStyle}>
                    {columnVisibility.oiChange && (
                      <div className={`px-1 sm:px-2 py-1 text-right flex items-center justify-end min-w-0 ${(ce?.oi_change ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        <span className="truncate">{(ce?.oi_change ?? 0) > 0 ? '+' : ''}{fmt(ce?.oi_change)}</span>
                      </div>
                    )}
                    {columnVisibility.oiChangePct && (
                      <div className={`px-1 sm:px-2 py-1 text-right min-w-0 font-medium ${(ce?.oi_change_pct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {fmtSignedPct(ce?.oi_change_pct)}
                      </div>
                    )}
                    {columnVisibility.buildup && (
                      <div className="min-w-0 px-0.5 py-1 flex flex-col items-center justify-center gap-0.5 text-center leading-none">
                        {showBuildup && ceBuildup ? (
                          <>
                            <span
                              title={buildupTooltip(ceBuildup, buildupPayload?.baseline_timestamp, buildupPayload?.as_of_timestamp)}
                              className={`inline-flex min-w-[24px] items-center justify-center rounded px-1 py-0.5 text-[9px] leading-none font-extrabold tracking-wide shadow-sm ${BUILDUP_STYLES[ceBuildup.classification] || 'bg-slate-700 text-slate-200'}`}
                            >
                              {BUILDUP_CODES[ceBuildup.classification] ?? '—'}
                            </span>
                            <span
                              title={ceBuildup.bias ? `${ceBuildup.bias} CE interpretation` : ceBuildup.classification}
                              className={`text-[7px] sm:text-[8px] font-bold tracking-wide ${ceBuildup.bias === 'BULLISH' ? 'text-emerald-300' : ceBuildup.bias === 'BEARISH' ? 'text-red-300' : 'text-terminal-muted'}`}
                            >
                              {ceBuildup.bias ?? (ceBuildup.classification === 'NO CHANGE' ? 'NEUTRAL' : 'MIXED')}
                            </span>
                          </>
                        ) : <span className="text-terminal-muted">—</span>}
                      </div>
                    )}
                    {columnVisibility.volume && (
                      <div className={`px-1 sm:px-2 py-1 text-right ${highlightHighestVolume && highestVolumeStrikes.CE === row.strike ? 'tt-volume-hit tt-volume-hit--ce' : 'text-terminal-muted'}`}>
                        {fmt(ce?.volume)}
                      </div>
                    )}
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
                            onClick={(event) => void toggleWallWatch('CE', row.strike, event)}
                            disabled={watchBusy === 'CE' || (!ceWatchArmed && !canArm)}
                            title={ceWatchArmed
                              ? `Disarm Call Wall watch at ${fmt(wallWatches.CE.watched_strike)}`
                              : canArm ? `Arm Call Wall watch at ${fmt(row.strike)}` : 'Wall watch requires a connected, non-stale live feed'}
                            aria-label={ceWatchArmed ? 'Disarm Call Wall alert' : 'Arm Call Wall alert'}
                            aria-busy={watchBusy === 'CE'}
                            className={`relative z-10 ml-0.5 inline-flex h-5 w-5 shrink-0 pointer-events-auto items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${ceWatchArmed ? 'text-amber-200 bg-amber-500/20 hover:bg-amber-500/30' : 'text-terminal-muted hover:text-amber-300 hover:bg-amber-500/10'} disabled:cursor-not-allowed disabled:opacity-40`}
                          >
                            {watchBusy === 'CE'
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : ceWatchArmed
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
                  <div className={`tt-chain-side tt-chain-side--pe grid gap-0 ${peItm ? ITM_TINT_CLASS : ''}`} style={sideGridStyle}>
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
                            onClick={(event) => void toggleWallWatch('PE', row.strike, event)}
                            disabled={watchBusy === 'PE' || (!peWatchArmed && !canArm)}
                            title={peWatchArmed
                              ? `Disarm Put Wall watch at ${fmt(wallWatches.PE.watched_strike)}`
                              : canArm ? `Arm Put Wall watch at ${fmt(row.strike)}` : 'Wall watch requires a connected, non-stale live feed'}
                            aria-label={peWatchArmed ? 'Disarm Put Wall alert' : 'Arm Put Wall alert'}
                            aria-busy={watchBusy === 'PE'}
                            className={`relative z-10 ml-0.5 inline-flex h-5 w-5 shrink-0 pointer-events-auto items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${peWatchArmed ? 'text-amber-200 bg-amber-500/20 hover:bg-amber-500/30' : 'text-terminal-muted hover:text-amber-300 hover:bg-amber-500/10'} disabled:cursor-not-allowed disabled:opacity-40`}
                          >
                            {watchBusy === 'PE'
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : peWatchArmed
                                ? <BellRing className="h-3.5 w-3.5" />
                                : <Bell className="h-3.5 w-3.5" />}
                          </button>
                        )}
                        <span className="ml-0.5">{fmt(pe?.oi)}</span>
                      </div>
                    )}
                    {columnVisibility.ltp && <div className="px-1 sm:px-2 py-1 text-left text-terminal-pe font-semibold">{fmt(pe?.ltp, 2)}</div>}
                    {columnVisibility.volume && (
                      <div className={`px-1 sm:px-2 py-1 text-left ${highlightHighestVolume && highestVolumeStrikes.PE === row.strike ? 'tt-volume-hit tt-volume-hit--pe' : 'text-terminal-muted'}`}>
                        {fmt(pe?.volume)}
                      </div>
                    )}
                    {columnVisibility.buildup && (
                      <div className="min-w-0 px-0.5 py-1 flex flex-col items-center justify-center gap-0.5 text-center leading-none">
                        {showBuildup && peBuildup ? (
                          <>
                            <span
                              title={buildupTooltip(peBuildup, buildupPayload?.baseline_timestamp, buildupPayload?.as_of_timestamp)}
                              className={`inline-flex min-w-[24px] items-center justify-center rounded px-1 py-0.5 text-[9px] leading-none font-extrabold tracking-wide shadow-sm ${BUILDUP_STYLES[peBuildup.classification] || 'bg-slate-700 text-slate-200'}`}
                            >
                              {BUILDUP_CODES[peBuildup.classification] ?? '—'}
                            </span>
                            <span
                              title={peBuildup.bias ? `${peBuildup.bias} PE interpretation` : peBuildup.classification}
                              className={`text-[7px] sm:text-[8px] font-bold tracking-wide ${peBuildup.bias === 'BULLISH' ? 'text-emerald-300' : peBuildup.bias === 'BEARISH' ? 'text-red-300' : 'text-terminal-muted'}`}
                            >
                              {peBuildup.bias ?? (peBuildup.classification === 'NO CHANGE' ? 'NEUTRAL' : 'MIXED')}
                            </span>
                          </>
                        ) : <span className="text-terminal-muted">—</span>}
                      </div>
                    )}
                    {columnVisibility.oiChangePct && (
                      <div className={`px-1 sm:px-2 py-1 text-left min-w-0 font-medium ${(pe?.oi_change_pct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {fmtSignedPct(pe?.oi_change_pct)}
                      </div>
                    )}
                    {columnVisibility.oiChange && (
                      <div className={`px-1 sm:px-2 py-1 text-left min-w-0 ${(pe?.oi_change ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        <span className="truncate">{(pe?.oi_change ?? 0) > 0 ? '+' : ''}{fmt(pe?.oi_change)}</span>
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
        const sideIsCe = wallHover.side === 'CE';
        const wallAccentClass = sideIsCe ? 'ce' : 'pe';
        const wallEvent = lastWallMove[wallHover.side];
        const eventTime = wallEvent?.timestamp;
        return (
          <div
            role="tooltip"
            className="tt-wall-tooltip pointer-events-none fixed z-[100]"
            style={{ left: wallHover.left, top: wallHover.top, width: Math.min(292, window.innerWidth - 24) }}
          >
            <header className="tt-wall-topbar">
              <div className="tt-wall-title-wrap">
                <span className={`tt-wall-pill tt-wall-pill--${wallAccentClass}`}>
                  {wallHover.side} WALL
                </span>
                <span className="tt-wall-heading">Last movement</span>
              </div>
              <time className="tt-wall-time">{eventTime ? eventTime.slice(11, 19) : '—'}</time>
            </header>
            {wallEvent ? (
              <>
                <div className="tt-wall-body">
                  <div className="tt-wall-movement">
                    <div className="tt-wall-level">
                      <span className="tt-wall-level-label">Previous wall</span>
                      <strong className="tt-wall-level-value">{fmt(wallEvent.from_strike)}</strong>
                    </div>
                    <div className="tt-wall-arrow" aria-hidden="true">
                      <ArrowDown className="h-3.5 w-3.5 rotate-[-90deg]" />
                    </div>
                    <div className={`tt-wall-level tt-wall-level--current-${wallAccentClass}`}>
                      <span className="tt-wall-level-label">Current wall</span>
                      <strong className="tt-wall-level-value">{fmt(wallEvent.to_strike)}</strong>
                    </div>
                  </div>
                  <div className="tt-wall-metrics">
                    <div>
                      <div className="tt-wall-metric-label">OI before</div>
                      <div className="tt-wall-metric-value">{fmt(wallEvent.from_oi)}</div>
                    </div>
                    <div className={`tt-wall-metric--after-${wallAccentClass}`}>
                      <div className="tt-wall-metric-label">OI after</div>
                      <div className="tt-wall-metric-value">{fmt(wallEvent.to_oi)}</div>
                    </div>
                  </div>
                </div>
                <footer className="tt-wall-footer">
                  <span className="tt-wall-info" aria-hidden="true">i</span>
                  <span className="tt-wall-footnote">Time is based on the first saved snapshot showing the new wall.</span>
                </footer>
              </>
            ) : (
              <>
                <div className="tt-wall-body">
                  <div className="tt-wall-empty">
                    <div className="tt-wall-empty-value">{fmt(wallHover.strike)}</div>
                    {wallHistoryError
                      ? 'Wall history is temporarily unavailable.'
                      : 'No previous wall movement is recorded for this strike today.'}
                  </div>
                </div>
                <footer className="tt-wall-footer">
                  <span className="tt-wall-info" aria-hidden="true">i</span>
                  <span className="tt-wall-footnote">Time is based on the first saved snapshot showing the new wall.</span>
                </footer>
              </>
            )}
          </div>
        );
      })(), document.body)}
    </div>
  );
};

export const OptionChain = React.memo(OptionChainComponent);
