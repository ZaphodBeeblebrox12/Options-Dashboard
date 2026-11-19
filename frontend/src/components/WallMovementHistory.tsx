import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Clock3,
  Loader2,
  Lock,
  Unlock,
} from 'lucide-react';

type WallSide = 'CE' | 'PE';
type WallPoint = {
  timestamp: string;
  ce_wall: number | null;
  ce_oi: number | null;
  pe_wall: number | null;
  pe_oi: number | null;
};
type WallEvent = {
  side: WallSide;
  timestamp: string;
  from_strike: number;
  to_strike: number;
  from_oi: number | null;
  to_oi: number | null;
};
type WallHistoryPayload = {
  date: string;
  index_name: string;
  points: WallPoint[];
  events: WallEvent[];
};
type RangeKey = '1D' | '15m' | '5m';

interface WallMovementHistoryProps {
  date: string;
  indexName: string;
  liveMode: boolean;
  asOfTimestamp?: string | null;
}

const RANGE_MS: Record<RangeKey, number | null> = {
  '1D': null,
  '15m': 15 * 60 * 1000,
  '5m': 5 * 60 * 1000,
};

function canonicalTimestamp(value: string): string {
  return String(value || '').replace('T', ' ').slice(0, 19);
}

function timestampMs(value: string): number {
  const canonical = canonicalTimestamp(value);
  const parsed = Date.parse(canonical.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function timeLabel(value: string, withSeconds = false): string {
  const canonical = canonicalTimestamp(value);
  return canonical.length >= 19 ? canonical.slice(11, withSeconds ? 19 : 16) : canonical;
}

function fmtStrike(value: number | null | undefined): string {
  return value == null ? '—' : value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtOi(value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function eventKey(event: WallEvent): string {
  return `${event.side}|${canonicalTimestamp(event.timestamp)}|${event.from_strike}|${event.to_strike}`;
}

const WallMovementHistoryComponent: React.FC<WallMovementHistoryProps> = ({
  date,
  indexName,
  liveMode,
  asOfTimestamp,
}) => {
  const [payloadState, setPayloadState] = useState<{
    key: string;
    data: WallHistoryPayload | null;
    loading: boolean;
    error: string | null;
  }>({ key: '', data: null, loading: true, error: null });
  const [range, setRange] = useState<RangeKey>('1D');
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);
  const [hoveredEventKey, setHoveredEventKey] = useState<string | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number } | null>(null);
  const [pinnedEventKey, setPinnedEventKey] = useState<string | null>(null);
  const [pinnedPosition, setPinnedPosition] = useState<{ x: number; y: number } | null>(null);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const eventListRef = useRef<HTMLDivElement>(null);
  const eventRowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // As the replay cursor moves, re-focus the latest wall change at or before
  // that time. A manual event selection remains until the cursor changes again.
  useEffect(() => {
    setSelectedEventKey(null);
    setHoveredEventKey(null);
    setHoverPosition(null);
  }, [asOfTimestamp]);

  const requestKey = `${date}|${indexName}`;

  useEffect(() => {
    if (!date || !indexName) return;
    let alive = true;
    let controller: AbortController | null = null;

    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      if (alive) {
        setPayloadState((current) => ({
          key: requestKey,
          data: current.key === requestKey ? current.data : null,
          loading: current.key !== requestKey || !current.data,
          error: null,
        }));
      }
      try {
        const response = await fetch(
          `/api/wall-history?date=${encodeURIComponent(date)}&index=${encodeURIComponent(indexName)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`Wall history request failed (${response.status})`);
        const data = await response.json() as WallHistoryPayload;
        if (alive) setPayloadState({ key: requestKey, data, loading: false, error: null });
      } catch (error) {
        if (!alive || (error instanceof Error && error.name === 'AbortError')) return;
        setPayloadState((current) => ({
          key: requestKey,
          data: current.key === requestKey ? current.data : null,
          loading: false,
          error: error instanceof Error ? error.message : 'Could not load wall history',
        }));
      }
    };

    void load();
    const poll = liveMode ? window.setInterval(() => void load(), 30000) : null;
    return () => {
      alive = false;
      controller?.abort();
      if (poll != null) window.clearInterval(poll);
    };
  }, [date, indexName, liveMode, requestKey]);

  const payload = payloadState.key === requestKey ? payloadState.data : null;
  const cutoff = asOfTimestamp ? canonicalTimestamp(asOfTimestamp) : null;

  const visibleData = useMemo(() => {
    const rawPoints = payload?.points ?? [];
    if (rawPoints.length === 0) return { points: [], events: [], asOfPoint: null };

    // In replay's full-session (1D) view, keep the entire day on screen.
    // The replay time is a cursor inside that plot rather than the plot's end.
    // Short 15m/5m views remain anchored to the selected replay timestamp.
    const sessionLastMs = timestampMs(rawPoints[rawPoints.length - 1].timestamp);
    const replayAnchorMs = cutoff ? timestampMs(cutoff) : sessionLastMs;
    const rangeMs = RANGE_MS[range];
    const firstAllowed = rangeMs == null ? Number.NEGATIVE_INFINITY : replayAnchorMs - rangeMs;
    const lastAllowed = rangeMs == null ? Number.POSITIVE_INFINITY : replayAnchorMs;
    const points = rawPoints.filter((point) => {
      const ms = timestampMs(point.timestamp);
      return ms >= firstAllowed && ms <= lastAllowed;
    });
    const firstTime = points[0] ? canonicalTimestamp(points[0].timestamp) : '';
    const lastTime = points[points.length - 1] ? canonicalTimestamp(points[points.length - 1].timestamp) : '';
    const events = (payload?.events ?? []).filter((event) => {
      const ts = canonicalTimestamp(event.timestamp);
      return ts >= firstTime && ts <= lastTime;
    });
    const pointsAtReplayTime = cutoff
      ? rawPoints.filter((point) => canonicalTimestamp(point.timestamp) <= cutoff)
      : rawPoints;
    const asOfPoint = pointsAtReplayTime[pointsAtReplayTime.length - 1] ?? null;
    return { points, events, asOfPoint };
  }, [payload, cutoff, range]);

  const points = visibleData.points;
  const events = visibleData.events;
  const newestFirstEvents = useMemo(() => [...events].reverse(), [events]);
  // Summary values stay truthful to the replay cursor even though the 1D chart
  // deliberately includes the rest of the session as muted future context.
  const latestPoint = visibleData.asOfPoint;

  const lastCeEvent = useMemo(
    () => [...(payload?.events ?? [])].reverse().find((event) => event.side === 'CE' &&
      (!cutoff || canonicalTimestamp(event.timestamp) <= cutoff)),
    [payload, cutoff],
  );
  const lastPeEvent = useMemo(
    () => [...(payload?.events ?? [])].reverse().find((event) => event.side === 'PE' &&
      (!cutoff || canonicalTimestamp(event.timestamp) <= cutoff)),
    [payload, cutoff],
  );

  const selectedEvent = useMemo(() => {
    if (!events.length) return null;
    const manualSelection = events.find((event) => eventKey(event) === selectedEventKey);
    if (manualSelection && (!cutoff || canonicalTimestamp(manualSelection.timestamp) <= cutoff)) {
      return manualSelection;
    }
    if (cutoff) {
      // Keep the last wall transition at or before the replay cursor prominent.
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (canonicalTimestamp(events[i].timestamp) <= cutoff) return events[i];
      }
      return null;
    }
    return events[events.length - 1];
  }, [events, selectedEventKey, cutoff]);

  const chart = useMemo(() => {
    if (points.length === 0) return null;

    const width = 900;
    const height = 280;
    const left = 76;
    const right = 18;
    const top = 24;
    const bottom = 42;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;

    const allStrikes = points.flatMap((point) =>
      [point.ce_wall, point.pe_wall].filter((value): value is number => value != null),
    );
    if (allStrikes.length === 0) return null;
    const uniqueStrikes = [...new Set(allStrikes)].sort((a, b) => a - b);
    const increments = uniqueStrikes.slice(1)
      .map((value, index) => value - uniqueStrikes[index])
      .filter((value) => value > 0);
    const step = increments.length ? Math.min(...increments) : 50;
    const minRaw = Math.min(...allStrikes);
    const maxRaw = Math.max(...allStrikes);
    const minStrike = Math.floor(minRaw / step) * step - step;
    const maxStrike = Math.ceil(maxRaw / step) * step + step;
    const yRange = Math.max(step * 2, maxStrike - minStrike);

    const startMs = timestampMs(points[0].timestamp);
    const endMs = timestampMs(points[points.length - 1].timestamp);
    const timeRange = Math.max(1, endMs - startMs);
    const xFor = (value: string) => left + ((timestampMs(value) - startMs) / timeRange) * plotWidth;
    const yFor = (value: number) => top + ((maxStrike - value) / yRange) * plotHeight;

    const makeStepPath = (key: 'ce_wall' | 'pe_wall', sourcePoints = points) => {
      let path = '';
      let previousValue: number | null = null;
      sourcePoints.forEach((point) => {
        const value = point[key];
        if (value == null) return;
        const x = xFor(point.timestamp);
        const y = yFor(value);
        if (previousValue == null) path = `M ${x} ${y}`;
        else path += ` H ${x} V ${y}`;
        previousValue = value;
      });
      if (sourcePoints.length === 1 && previousValue != null) {
        const endX = cutoff && sourcePoints !== points
          ? Math.max(left, Math.min(xFor(cutoff), width - right))
          : width - right;
        path += ` H ${endX}`;
      }
      return path;
    };

    // Draw the complete session softly, then redraw the portion up to the
    // replay cursor at full strength. This keeps the current replay context
    // clear without hiding later wall movement.
    let replayPastPoints = points;
    if (cutoff) {
      replayPastPoints = points.filter((point) => canonicalTimestamp(point.timestamp) <= cutoff);
      const lastPastPoint = replayPastPoints[replayPastPoints.length - 1];
      if (lastPastPoint && canonicalTimestamp(lastPastPoint.timestamp) < cutoff) {
        replayPastPoints = [...replayPastPoints, {
          ...lastPastPoint,
          timestamp: cutoff,
        }];
      }
    }

    const yTicks = Array.from({ length: 5 }, (_, index) => maxStrike - (yRange * index) / 4);
    const tickCount = Math.min(6, points.length);
    const xTicks = Array.from({ length: tickCount }, (_, index) => {
      const pointIndex = tickCount === 1 ? 0 : Math.round((index * (points.length - 1)) / (tickCount - 1));
      return points[pointIndex];
    });

    return {
      width, height, left, right, top, bottom, plotWidth, plotHeight,
      xFor, yFor, yTicks, xTicks,
      cePath: makeStepPath('ce_wall'),
      pePath: makeStepPath('pe_wall'),
      cePastPath: cutoff ? makeStepPath('ce_wall', replayPastPoints) : null,
      pePastPath: cutoff ? makeStepPath('pe_wall', replayPastPoints) : null,
      replayX: cutoff && timestampMs(cutoff) >= startMs && timestampMs(cutoff) <= endMs
        ? xFor(cutoff)
        : null,
    };
  }, [points, cutoff]);

  const hoveredEvent = hoveredEventKey
    ? events.find((event) => eventKey(event) === hoveredEventKey) ?? null
    : null;
  const pinnedEvent = pinnedEventKey
    ? events.find((event) => eventKey(event) === pinnedEventKey) ?? null
    : null;
  const inspectorEvent = pinnedEvent ?? hoveredEvent;
  const inspectorPosition = pinnedEvent ? pinnedPosition : hoverPosition;
  const activeEvent = pinnedEvent ?? hoveredEvent ?? selectedEvent;
  const activeEventKey = activeEvent ? eventKey(activeEvent) : null;

  // Keep the active change visible inside the event panel. Scroll only its
  // own list viewport, not the page or the full dashboard.
  useEffect(() => {
    if (!activeEventKey) return;
    const container = eventListRef.current;
    const row = eventRowRefs.current.get(activeEventKey);
    if (!container || !row) return;

    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const fullyVisible =
      rowRect.top >= containerRect.top + 4 &&
      rowRect.bottom <= containerRect.bottom - 4;

    if (!fullyVisible) {
      const rowTop = container.scrollTop + rowRect.top - containerRect.top;
      const centeredTop = rowTop - (container.clientHeight - rowRect.height) / 2;
      container.scrollTo({
        top: Math.max(0, centeredTop),
        behavior: 'smooth',
      });
    }
  }, [activeEventKey, events]);

  const handleChartPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    // A pinned inspection is deliberately independent from pointer movement.
    if (pinnedEventKey || !chart || events.length === 0) return;
    const svg = event.currentTarget;
    const screenMatrix = svg.getScreenCTM();
    if (!screenMatrix) return;

    // Convert screen coordinates through the actual SVG transform. This
    // remains correct when the responsive SVG preserves its viewBox ratio
    // and leaves horizontal letterboxing at wider dashboard sizes.
    const screenPoint = svg.createSVGPoint();
    screenPoint.x = event.clientX;
    screenPoint.y = event.clientY;
    const chartPoint = screenPoint.matrixTransform(screenMatrix.inverse());
    const pointerX = chartPoint.x;
    const pointerY = chartPoint.y;
    if (pointerY < chart.top || pointerY > chart.height - chart.bottom) {
      setHoveredEventKey(null);
      setHoverPosition(null);
      return;
    }

    // A marker is a full-height timestamp line. Prefer the closest timestamp,
    // then use vertical distance from its strike-change dot to distinguish CE
    // and PE events that can share the same snapshot timestamp.
    const nearest = events
      .map((candidate) => {
        const dx = Math.abs(pointerX - chart.xFor(candidate.timestamp));
        const dy = Math.abs(pointerY - chart.yFor(candidate.to_strike));
        return { candidate, dx, dy, score: dx + dy * 0.08 };
      })
      .filter((item) => item.dx <= 14)
      .sort((a, b) => a.score - b.score)[0];

    if (!nearest) {
      setHoveredEventKey(null);
      setHoverPosition(null);
      return;
    }

    setHoveredEventKey(eventKey(nearest.candidate));
    const wrapperRect = chartWrapRef.current?.getBoundingClientRect();
    if (wrapperRect) {
      setHoverPosition({
        x: event.clientX - wrapperRect.left,
        y: event.clientY - wrapperRect.top,
      });
    }
  };

  const clearChartHover = () => {
    setHoveredEventKey(null);
    setHoverPosition(null);
  };

  const handleMarkerDoubleClick = (
    event: React.MouseEvent<SVGCircleElement>,
    markerEvent: WallEvent,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const key = eventKey(markerEvent);

    // Double-clicking the same marker toggles the pin off. Double-clicking
    // another marker moves the pin to that event for side-by-side study.
    if (pinnedEventKey === key) {
      setPinnedEventKey(null);
      setPinnedPosition(null);
      setHoveredEventKey(null);
      setHoverPosition(null);
      return;
    }

    const wrapperRect = chartWrapRef.current?.getBoundingClientRect();
    const markerRect = event.currentTarget.getBoundingClientRect();
    if (wrapperRect) {
      setPinnedPosition({
        x: markerRect.left + markerRect.width / 2 - wrapperRect.left,
        y: markerRect.top + markerRect.height / 2 - wrapperRect.top,
      });
    }
    setPinnedEventKey(key);
    setSelectedEventKey(key);
    setHoveredEventKey(null);
    setHoverPosition(null);
  };

  const unlockPinnedEvent = () => {
    setPinnedEventKey(null);
    setPinnedPosition(null);
    setHoveredEventKey(null);
    setHoverPosition(null);
  };

  const isLoading = payloadState.key !== requestKey || payloadState.loading;
  const error = payloadState.key === requestKey ? payloadState.error : null;

  return (
    <section className="terminal-panel overflow-hidden" aria-label="Wall movement history">
      <div className="terminal-header flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-terminal-atm" />
          <span>Wall Movement History</span>
          <span
            className="normal-case tracking-normal text-[9px] text-terminal-muted/70"
            title="The timestamp is the first saved option-chain snapshot in which the new dominant OI strike was recorded."
          >
            · SNAPSHOT-BASED
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {(['1D', '15m', '5m'] as RangeKey[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRange(option)}
              aria-pressed={range === option}
              className={`rounded px-2.5 py-1 text-[10px] font-mono transition-colors ${
                range === option
                  ? 'bg-terminal-atm text-slate-950 font-bold'
                  : 'border border-terminal-border/70 text-terminal-muted hover:text-terminal-text hover:bg-white/5'
              }`}
            >
              {option}
            </button>
          ))}
          <span className={`ml-1 rounded px-2 py-1 text-[9px] font-mono font-bold ${
            liveMode ? 'text-emerald-300 bg-emerald-500/10 border border-emerald-500/20' : 'text-terminal-muted bg-white/5 border border-terminal-border'
          }`}>
            {liveMode ? 'LIVE SESSION' : 'REPLAY'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 px-3 pt-3 sm:grid-cols-2">
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/[0.07] px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-2 w-2 shrink-0 rounded-full bg-red-400" />
            <span className="text-[10px] font-mono font-semibold text-red-300">CE WALL</span>
            <strong className="font-mono text-base tabular-nums text-red-200">{fmtStrike(latestPoint?.ce_wall)}</strong>
          </div>
          <span className="shrink-0 text-[9px] font-mono text-terminal-muted">
            {lastCeEvent ? `Last change: ${timeLabel(lastCeEvent.timestamp, true)}` : 'No change recorded'}
          </span>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/[0.07] px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <span className="text-[10px] font-mono font-semibold text-emerald-300">PE WALL</span>
            <strong className="font-mono text-base tabular-nums text-emerald-200">{fmtStrike(latestPoint?.pe_wall)}</strong>
          </div>
          <span className="shrink-0 text-[9px] font-mono text-terminal-muted">
            {lastPeEvent ? `Last change: ${timeLabel(lastPeEvent.timestamp, true)}` : 'No change recorded'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 rounded-md border border-terminal-border/70 bg-terminal-bg/60 p-2">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
            <span className="text-[9px] font-mono text-terminal-muted">STRIKE ↑</span>
            <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono">
              <span className="flex items-center gap-1.5 text-red-300"><span className="h-0.5 w-5 bg-red-400" />CE WALL</span>
              <span className="flex items-center gap-1.5 text-emerald-300"><span className="h-0.5 w-5 bg-emerald-400" />PE WALL</span>
              {cutoff && (
                <>
                  <span className="flex items-center gap-1.5 text-amber-300">
                    <span className="h-0.5 w-5 border-t-2 border-dashed border-amber-400" />REPLAY TIME
                  </span>
                  <span className="text-[9px] text-terminal-muted/70">Faded = later session</span>
                </>
              )}
            </div>
          </div>

          {isLoading && !payload ? (
            <div className="flex h-[250px] items-center justify-center gap-2 text-xs font-mono text-terminal-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading wall history…
            </div>
          ) : error && !payload ? (
            <div className="flex h-[250px] items-center justify-center px-4 text-center text-xs font-mono text-amber-300">
              {error}
            </div>
          ) : !chart ? (
            <div className="flex h-[250px] flex-col items-center justify-center gap-2 text-center">
              <Clock3 className="h-5 w-5 text-terminal-muted" />
              <span className="text-xs font-mono text-terminal-muted">No saved wall history for this date.</span>
              <span className="max-w-md text-[10px] font-mono text-terminal-muted/70">
                Wall transitions appear after option-chain snapshots have been recorded.
              </span>
            </div>
          ) : (
            <>
              <div ref={chartWrapRef} className="relative">
                <svg
                  viewBox={`0 0 ${chart.width} ${chart.height}`}
                  className="block h-[250px] w-full cursor-crosshair overflow-visible"
                  role="img"
                  aria-label="Step chart showing Call and Put open-interest wall strikes over time. Hover over a vertical event marker to inspect its timestamp and old and new wall strikes."
                  onPointerMove={handleChartPointerMove}
                  onPointerLeave={clearChartHover}
                >
                {chart.yTicks.map((tick) => (
                  <g key={tick}>
                    <line x1={chart.left} x2={chart.width - chart.right} y1={chart.yFor(tick)} y2={chart.yFor(tick)}
                      stroke="currentColor" strokeOpacity="0.14" strokeDasharray="3 5" />
                    <text x={chart.left - 10} y={chart.yFor(tick) + 3} fill="currentColor" opacity="0.65"
                      fontSize="11" textAnchor="end">{fmtStrike(Math.round(tick))}</text>
                  </g>
                ))}
                {chart.xTicks.map((point, index) => {
                  const x = chart.xFor(point.timestamp);
                  return (
                    <g key={`${point.timestamp}-${index}`}>
                      <line x1={x} x2={x} y1={chart.top} y2={chart.height - chart.bottom}
                        stroke="currentColor" strokeOpacity="0.08" />
                      <text x={x} y={chart.height - 13} fill="currentColor" opacity="0.65"
                        fontSize="10" textAnchor="middle">{timeLabel(point.timestamp)}</text>
                    </g>
                  );
                })}
                {/* Full-session wall paths remain visible; future portions are muted during replay. */}
                <path d={chart.cePath} fill="none" stroke="#f87171" strokeWidth="3"
                  strokeOpacity={cutoff ? 0.22 : 0.95} strokeLinejoin="round" strokeLinecap="round" />
                <path d={chart.pePath} fill="none" stroke="#34d399" strokeWidth="3"
                  strokeOpacity={cutoff ? 0.22 : 0.95} strokeLinejoin="round" strokeLinecap="round" />
                {cutoff && chart.cePastPath && (
                  <path d={chart.cePastPath} fill="none" stroke="#f87171" strokeWidth="3"
                    strokeOpacity="1" strokeLinejoin="round" strokeLinecap="round" />
                )}
                {cutoff && chart.pePastPath && (
                  <path d={chart.pePastPath} fill="none" stroke="#34d399" strokeWidth="3"
                    strokeOpacity="1" strokeLinejoin="round" strokeLinecap="round" />
                )}
                {events.map((event) => {
                  const x = chart.xFor(event.timestamp);
                  const y = chart.yFor(event.to_strike);
                  const markerKey = eventKey(event);
                  const selected = activeEvent && eventKey(activeEvent) === markerKey;
                  const pinned = pinnedEventKey === markerKey;
                  const isFuture = !!cutoff && canonicalTimestamp(event.timestamp) > cutoff;
                  const color = event.side === 'CE' ? '#f87171' : '#34d399';
                  const baseOpacity = isFuture ? 0.12 : 0.32;
                  return (
                    <g key={markerKey}>
                      <line x1={x} x2={x} y1={chart.top} y2={chart.height - chart.bottom}
                        stroke={color} strokeOpacity={selected ? 0.98 : baseOpacity}
                        strokeWidth={pinned ? 3 : selected ? 2.5 : 1} strokeDasharray="4 5" />
                      {pinned && (
                        <circle cx={x} cy={y} r="11" fill="none" stroke="#F8FAFC" strokeWidth="1.5" strokeOpacity="0.9" />
                      )}
                      <circle
                        cx={x}
                        cy={y}
                        r={pinned ? 8 : selected ? 7 : 4}
                        fill={color}
                        fillOpacity={selected ? 1 : baseOpacity}
                        stroke={selected ? '#F8FAFC' : '#111827'}
                        strokeWidth="2"
                      >
                        <title>{`${event.side} wall changed at ${timeLabel(event.timestamp, true)}: ${fmtStrike(event.from_strike)} to ${fmtStrike(event.to_strike)}${isFuture ? ' (after replay time)' : ''}. Double-click to pin this inspection.`}</title>
                      </circle>
                      <circle
                        cx={x}
                        cy={y}
                        r="12"
                        fill="transparent"
                        className="cursor-pointer"
                        onDoubleClick={(nativeEvent) => handleMarkerDoubleClick(nativeEvent, event)}
                        aria-label={`Double-click to pin ${event.side} wall change at ${timeLabel(event.timestamp, true)}`}
                      />
                    </g>
                  );
                })}
                {cutoff && chart.replayX != null && (
                  <g>
                    <rect
                      x={chart.replayX - 5}
                      y={chart.top}
                      width="10"
                      height={chart.height - chart.top - chart.bottom}
                      fill="#FBBF24"
                      fillOpacity="0.08"
                    />
                    <line x1={chart.replayX} x2={chart.replayX}
                      y1={chart.top} y2={chart.height - chart.bottom}
                      stroke="#FBBF24" strokeWidth="2.5" strokeDasharray="5 4" />
                    <rect x={Math.max(chart.left, Math.min(chart.replayX - 54, chart.width - chart.right - 108))}
                      y={4} width="108" height="16" rx="3" fill="#78350F" />
                    <text x={Math.max(chart.left + 54, Math.min(chart.replayX, chart.width - chart.right - 54))}
                      y={15} fill="#FDE68A" fontSize="9" fontWeight="700" textAnchor="middle">
                      REPLAY {timeLabel(cutoff, true)}
                    </text>
                  </g>
                )}
                <line x1={chart.left} x2={chart.width - chart.right}
                  y1={chart.height - chart.bottom} y2={chart.height - chart.bottom}
                  stroke="currentColor" strokeOpacity="0.35" />
                </svg>
                {inspectorEvent && inspectorPosition && (
                  <div
                    className={`absolute z-30 w-56 rounded-md border border-slate-500/70 bg-slate-950/95 px-3 py-2 shadow-xl shadow-black/50 backdrop-blur-sm ${
                      pinnedEvent ? 'pointer-events-auto ring-1 ring-amber-400/60' : 'pointer-events-none'
                    }`}
                    style={{
                      left: `clamp(8px, ${inspectorPosition.x + 14}px, calc(100% - 232px))`,
                      top: `clamp(8px, ${inspectorPosition.y - 58}px, calc(100% - 76px))`,
                    }}
                    role="status"
                    aria-live="polite"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[10px] font-mono font-bold ${inspectorEvent.side === 'CE' ? 'text-red-300' : 'text-emerald-300'}`}>
                        {inspectorEvent.side} WALL SHIFT
                      </span>
                      <span className="text-[10px] font-mono tabular-nums text-white">
                        {timeLabel(inspectorEvent.timestamp, true)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-xs font-mono tabular-nums">
                      <span className="text-slate-300">{fmtStrike(inspectorEvent.from_strike)}</span>
                      <span className={inspectorEvent.side === 'CE' ? 'text-red-300' : 'text-emerald-300'}>→</span>
                      <strong className={inspectorEvent.side === 'CE' ? 'text-red-200' : 'text-emerald-200'}>
                        {fmtStrike(inspectorEvent.to_strike)}
                      </strong>
                    </div>
                    <div className="mt-1 text-[9px] font-mono text-slate-400">
                      OI: {fmtOi(inspectorEvent.from_oi)} → {fmtOi(inspectorEvent.to_oi)}
                    </div>
                    <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-1.5">
                      {pinnedEvent ? (
                        <>
                          <span className="flex items-center gap-1 text-[9px] font-mono font-bold tracking-wide text-amber-300">
                            <Lock className="h-3 w-3" /> PINNED FOR STUDY
                          </span>
                          <button
                            type="button"
                            onClick={unlockPinnedEvent}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[9px] font-mono font-bold text-slate-200 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-300"
                            title="Unlock this wall inspection"
                          >
                            <Unlock className="h-3 w-3" /> UNLOCK
                          </button>
                        </>
                      ) : (
                        <span className="text-[9px] font-mono text-slate-500">DOUBLE-CLICK DOT TO PIN</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
              {activeEvent && (
                <div className={`mt-1 flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5 text-[10px] font-mono ${
                  activeEvent.side === 'CE'
                    ? 'border-red-500/35 bg-red-500/[0.10]'
                    : 'border-emerald-500/35 bg-emerald-500/[0.10]'
                }`}>
                  <span className={activeEvent.side === 'CE' ? 'text-red-200' : 'text-emerald-200'}>
                    {activeEvent.side} WALL · {timeLabel(activeEvent.timestamp, true)}
                  </span>
                  <span className="text-white tabular-nums">
                    {fmtStrike(activeEvent.from_strike)} → <strong>{fmtStrike(activeEvent.to_strike)}</strong>
                  </span>
                </div>
              )}
            </>
          )}
          <div className="mt-1 flex items-center justify-between px-1 text-[9px] font-mono text-terminal-muted/70">
            <span>TIME →</span>
            <span>Change time = first saved snapshot showing the new wall.</span>
          </div>
        </div>

        <aside className="min-w-0 rounded-md border border-terminal-border/70 bg-terminal-bg/60">
          <div className="flex items-center justify-between border-b border-terminal-border/70 px-3 py-2">
            <div>
              <h3 className="text-xs font-semibold text-terminal-text">Wall Change Events</h3>
              <p className="mt-0.5 text-[9px] font-mono text-terminal-muted">
                {events.length} changes · {date}{cutoff ? ' · dimmed events are after replay time' : ''}
              </p>
            </div>
            <Clock3 className="h-4 w-4 text-terminal-muted" />
          </div>
          <div ref={eventListRef} className="max-h-[272px] overflow-y-auto px-2 py-1">
            {newestFirstEvents.length === 0 ? (
              <div className="flex min-h-[115px] items-center justify-center px-3 text-center text-[11px] font-mono text-terminal-muted">
                No wall changes in this window.
              </div>
            ) : newestFirstEvents.map((event) => {
              const selected = activeEvent && eventKey(activeEvent) === eventKey(event);
              const isFuture = !!cutoff && canonicalTimestamp(event.timestamp) > cutoff;
              const rising = event.to_strike > event.from_strike;
              return (
                <button
                  key={eventKey(event)}
                  ref={(node) => {
                    const key = eventKey(event);
                    if (node) eventRowRefs.current.set(key, node);
                    else eventRowRefs.current.delete(key);
                  }}
                  type="button"
                  onClick={() => setSelectedEventKey(eventKey(event))}
                  onMouseEnter={() => setHoveredEventKey(eventKey(event))}
                  onMouseLeave={() => setHoveredEventKey(null)}
                  aria-pressed={!!selected}
                  aria-label={`${event.side} wall changed at ${timeLabel(event.timestamp, true)} from ${fmtStrike(event.from_strike)} to ${fmtStrike(event.to_strike)}`}
                  className={`flex w-full items-center justify-between gap-2 border-b border-terminal-border/50 border-l-2 px-2.5 py-2.5 text-left transition-colors last:border-b-0 ${
                    isFuture && !selected ? 'opacity-35 hover:opacity-75' : 'opacity-100'
                  } ${
                    selected
                      ? event.side === 'CE'
                        ? 'border-l-red-400 bg-red-500/[0.18] shadow-[inset_0_0_18px_rgba(248,113,113,0.08)]'
                        : 'border-l-emerald-400 bg-emerald-500/[0.18] shadow-[inset_0_0_18px_rgba(52,211,153,0.08)]'
                      : event.side === 'CE'
                        ? 'border-l-transparent hover:border-l-red-400/70 hover:bg-red-500/[0.10]'
                        : 'border-l-transparent hover:border-l-emerald-400/70 hover:bg-emerald-500/[0.10]'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className={`inline-flex h-6 min-w-9 items-center justify-center rounded px-1.5 text-[10px] font-extrabold ${
                      event.side === 'CE'
                        ? 'bg-red-500/35 text-red-50 ring-1 ring-red-300/60'
                        : 'bg-emerald-500/35 text-emerald-50 ring-1 ring-emerald-300/60'
                    }`}>{event.side}</span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-bold font-mono tabular-nums text-white">
                        {timeLabel(event.timestamp, true)}
                      </span>
                      <span className={`mt-1 block whitespace-nowrap text-[12px] font-semibold font-mono tabular-nums ${
                        event.side === 'CE' ? 'text-red-100' : 'text-emerald-100'
                      }`}>
                        {fmtStrike(event.from_strike)} <span className="px-1 text-slate-400">→</span> {fmtStrike(event.to_strike)}
                      </span>
                    </span>
                  </span>
                  {rising
                    ? <ArrowUpRight className={`h-5 w-5 shrink-0 ${event.side === 'CE' ? 'text-red-200' : 'text-emerald-200'}`} />
                    : <ArrowDownRight className={`h-5 w-5 shrink-0 ${event.side === 'CE' ? 'text-red-200' : 'text-emerald-200'}`} />}
                </button>
              );
            })}
          </div>
        </aside>
      </div>

      {error && payload && (
        <div className="border-t border-amber-500/20 px-3 py-1.5 text-[10px] font-mono text-amber-300">
          Refresh issue: {error}. Showing the last successfully loaded history.
        </div>
      )}
    </section>
  );
};

export const WallMovementHistory = React.memo(WallMovementHistoryComponent);
