import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Clock3,
  Loader2,
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
  const chartWrapRef = useRef<HTMLDivElement>(null);

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
    const pointsAtReplayTime = cutoff
      ? rawPoints.filter((point) => canonicalTimestamp(point.timestamp) <= cutoff)
      : rawPoints;
    if (pointsAtReplayTime.length === 0) return { points: [], events: [] };

    const rangeMs = RANGE_MS[range];
    const lastMs = timestampMs(pointsAtReplayTime[pointsAtReplayTime.length - 1].timestamp);
    const firstAllowed = rangeMs == null ? Number.NEGATIVE_INFINITY : lastMs - rangeMs;
    const points = pointsAtReplayTime.filter((point) => timestampMs(point.timestamp) >= firstAllowed);
    const firstTime = points[0] ? canonicalTimestamp(points[0].timestamp) : '';
    const lastTime = points[points.length - 1] ? canonicalTimestamp(points[points.length - 1].timestamp) : '';
    const events = (payload?.events ?? []).filter((event) => {
      const ts = canonicalTimestamp(event.timestamp);
      return ts >= firstTime && ts <= lastTime;
    });
    return { points, events };
  }, [payload, cutoff, range]);

  const points = visibleData.points;
  const events = visibleData.events;
  const newestFirstEvents = useMemo(() => [...events].reverse(), [events]);
  const latestPoint = points[points.length - 1] ?? null;

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
    return events.find((event) => eventKey(event) === selectedEventKey) ?? events[events.length - 1];
  }, [events, selectedEventKey]);

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

    const makeStepPath = (key: 'ce_wall' | 'pe_wall') => {
      let path = '';
      let previousValue: number | null = null;
      points.forEach((point, index) => {
        const value = point[key];
        if (value == null) return;
        const x = xFor(point.timestamp);
        const y = yFor(value);
        if (previousValue == null) path = `M ${x} ${y}`;
        else path += ` H ${x} V ${y}`;
        previousValue = value;
      });
      if (points.length === 1 && previousValue != null) path += ` H ${width - right}`;
      return path;
    };

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
    };
  }, [points]);

  const hoveredEvent = hoveredEventKey
    ? events.find((event) => eventKey(event) === hoveredEventKey) ?? null
    : null;
  const activeEvent = hoveredEvent ?? selectedEvent;

  const handleChartPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!chart || events.length === 0) return;
    const svgRect = event.currentTarget.getBoundingClientRect();
    if (!svgRect.width || !svgRect.height) return;

    // Convert the pointer into the SVG viewBox coordinate system so the
    // hit target remains accurate at every responsive chart width.
    const pointerX = ((event.clientX - svgRect.left) / svgRect.width) * chart.width;
    const pointerY = ((event.clientY - svgRect.top) / svgRect.height) * chart.height;
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
            <div className="flex items-center gap-3 text-[10px] font-mono">
              <span className="flex items-center gap-1.5 text-red-300"><span className="h-0.5 w-5 bg-red-400" />CE WALL</span>
              <span className="flex items-center gap-1.5 text-emerald-300"><span className="h-0.5 w-5 bg-emerald-400" />PE WALL</span>
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
                  className="block h-[250px] w-full overflow-visible"
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
                <path d={chart.cePath} fill="none" stroke="#f87171" strokeWidth="3"
                  strokeLinejoin="round" strokeLinecap="round" />
                <path d={chart.pePath} fill="none" stroke="#34d399" strokeWidth="3"
                  strokeLinejoin="round" strokeLinecap="round" />
                {events.map((event) => {
                  const x = chart.xFor(event.timestamp);
                  const y = chart.yFor(event.to_strike);
                  const selected = selectedEvent && eventKey(selectedEvent) === eventKey(event);
                  const color = event.side === 'CE' ? '#f87171' : '#34d399';
                  return (
                    <g key={eventKey(event)}>
                      <line x1={x} x2={x} y1={chart.top} y2={chart.height - chart.bottom}
                        stroke={color} strokeOpacity={selected ? 0.85 : 0.35}
                        strokeWidth={selected ? 2 : 1} strokeDasharray="4 5" />
                      <circle cx={x} cy={y} r={selected ? 6 : 4}
                        fill={color} stroke="#111827" strokeWidth="2">
                        <title>{`${event.side} wall changed at ${timeLabel(event.timestamp, true)}: ${fmtStrike(event.from_strike)} to ${fmtStrike(event.to_strike)}`}</title>
                      </circle>
                    </g>
                  );
                })}
                <line x1={chart.left} x2={chart.width - chart.right}
                  y1={chart.height - chart.bottom} y2={chart.height - chart.bottom}
                  stroke="currentColor" strokeOpacity="0.35" />
                </svg>
                {hoveredEvent && hoverPosition && (
                  <div
                    className="pointer-events-none absolute z-30 w-56 rounded-md border border-slate-500/70 bg-slate-950/95 px-3 py-2 shadow-xl shadow-black/40 backdrop-blur-sm"
                    style={{
                      left: `clamp(8px, ${hoverPosition.x + 14}px, calc(100% - 232px))`,
                      top: `clamp(8px, ${hoverPosition.y - 58}px, calc(100% - 76px))`,
                    }}
                    role="status"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[10px] font-mono font-bold ${hoveredEvent.side === 'CE' ? 'text-red-300' : 'text-emerald-300'}`}>
                        {hoveredEvent.side} WALL SHIFT
                      </span>
                      <span className="text-[10px] font-mono tabular-nums text-white">
                        {timeLabel(hoveredEvent.timestamp, true)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-xs font-mono tabular-nums">
                      <span className="text-slate-300">{fmtStrike(hoveredEvent.from_strike)}</span>
                      <span className={hoveredEvent.side === 'CE' ? 'text-red-300' : 'text-emerald-300'}>→</span>
                      <strong className={hoveredEvent.side === 'CE' ? 'text-red-200' : 'text-emerald-200'}>
                        {fmtStrike(hoveredEvent.to_strike)}
                      </strong>
                    </div>
                    <div className="mt-1 text-[9px] font-mono text-slate-400">
                      OI: {fmtOi(hoveredEvent.from_oi)} → {fmtOi(hoveredEvent.to_oi)}
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
              <p className="mt-0.5 text-[9px] font-mono text-terminal-muted">{events.length} changes · {date}</p>
            </div>
            <Clock3 className="h-4 w-4 text-terminal-muted" />
          </div>
          <div className="max-h-[272px] overflow-y-auto px-2 py-1">
            {newestFirstEvents.length === 0 ? (
              <div className="flex min-h-[115px] items-center justify-center px-3 text-center text-[10px] font-mono text-terminal-muted">
                No wall changes in this window.
              </div>
            ) : newestFirstEvents.map((event) => {
              const selected = selectedEvent && eventKey(selectedEvent) === eventKey(event);
              const rising = event.to_strike > event.from_strike;
              return (
                <button
                  key={eventKey(event)}
                  type="button"
                  onClick={() => setSelectedEventKey(eventKey(event))}
                  onMouseEnter={() => setHoveredEventKey(eventKey(event))}
                  onMouseLeave={() => setHoveredEventKey(null)}
                  aria-pressed={!!selected}
                  className={`flex w-full items-center justify-between gap-2 border-b border-terminal-border/50 border-l-2 px-2 py-2 text-left transition-colors last:border-b-0 ${
                    selected
                      ? event.side === 'CE'
                        ? 'border-l-red-400 bg-red-500/[0.18] shadow-[inset_0_0_18px_rgba(248,113,113,0.08)]'
                        : 'border-l-emerald-400 bg-emerald-500/[0.18] shadow-[inset_0_0_18px_rgba(52,211,153,0.08)]'
                      : event.side === 'CE'
                        ? 'border-l-transparent hover:border-l-red-400/70 hover:bg-red-500/[0.10]'
                        : 'border-l-transparent hover:border-l-emerald-400/70 hover:bg-emerald-500/[0.10]'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`inline-flex h-5 min-w-8 items-center justify-center rounded px-1 text-[9px] font-bold ${
                      event.side === 'CE' ? 'bg-red-500/30 text-red-100 ring-1 ring-red-400/50' : 'bg-emerald-500/30 text-emerald-100 ring-1 ring-emerald-400/50'
                    }`}>{event.side}</span>
                    <span className="min-w-0">
                      <span className="block text-[11px] font-bold font-mono tabular-nums text-white">
                        {timeLabel(event.timestamp, true)}
                      </span>
                      <span className={`mt-0.5 block whitespace-nowrap text-[10px] font-semibold font-mono tabular-nums ${
                        event.side === 'CE' ? 'text-red-100' : 'text-emerald-100'
                      }`}>
                        {fmtStrike(event.from_strike)} → {fmtStrike(event.to_strike)}
                      </span>
                    </span>
                  </span>
                  {rising
                    ? <ArrowUpRight className={`h-4 w-4 shrink-0 ${event.side === 'CE' ? 'text-red-300' : 'text-emerald-300'}`} />
                    : <ArrowDownRight className={`h-4 w-4 shrink-0 ${event.side === 'CE' ? 'text-red-300' : 'text-emerald-300'}`} />}
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
