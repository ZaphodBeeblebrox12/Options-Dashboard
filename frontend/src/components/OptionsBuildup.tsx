import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

type Interval = '5m' | '15m' | '30m' | '1h' | 'session';

interface BuildupSide {
  classification: string;
  bias: 'BULLISH' | 'BEARISH' | null;
  premium_change: number | null;
  premium_change_pct: number | null;
  oi_change: number | null;
  oi_change_pct: number | null;
  volume_change: number | null;
}

interface BuildupRow {
  strike: number;
  CE: BuildupSide | null;
  PE: BuildupSide | null;
}

interface BuildupPayload {
  ready: boolean;
  reason?: string;
  index_name: string;
  date: string;
  interval: Interval;
  as_of_timestamp?: string;
  baseline_timestamp?: string;
  elapsed_seconds?: number;
  source?: 'live' | 'snapshot';
  rows: BuildupRow[];
}

interface OptionsBuildupProps {
  indexName: string;
  date: string;
  timestamp?: string;
  liveMode: boolean;
  spot: number | null;
  selectedStrike: number | null;
  onSelectStrike: (strike: number) => void;
}

const INTERVALS: Array<{ value: Interval; label: string }> = [
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
  { value: '1h', label: '1H' },
  { value: 'session', label: 'Session' },
];

const STATUS_STYLES: Record<string, string> = {
  'LONG BUILDUP': 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  'SHORT BUILDUP': 'border-red-500/30 bg-red-500/10 text-red-300',
  'SHORT COVERING': 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  'LONG UNWINDING': 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  'MIXED': 'border-white/10 bg-white/5 text-terminal-muted',
  'NO CHANGE': 'border-white/10 bg-white/[0.03] text-terminal-muted',
  'UNAVAILABLE': 'border-white/10 bg-white/[0.03] text-terminal-muted',
};

function formatTime(value?: string): string {
  return value && value.length >= 16 ? value.slice(11, 16) : '—';
}

function formatSigned(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const formatted = value.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${value > 0 ? '+' : ''}${formatted}`;
}

function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 10_000_000) return `${formatSigned(value / 10_000_000, 2)}Cr`;
  if (abs >= 100_000) return `${formatSigned(value / 100_000, 2)}L`;
  if (abs >= 1_000) return `${formatSigned(value / 1_000, 1)}K`;
  return formatSigned(value);
}

const SideCell: React.FC<{ data: BuildupSide | null }> = ({ data }) => {
  if (!data) {
    return <div className="min-w-0 px-2 sm:px-3 py-2 text-[10px] font-mono text-terminal-muted">No matching baseline</div>;
  }

  const style = STATUS_STYLES[data.classification] ?? STATUS_STYLES.UNAVAILABLE;
  return (
    <div className="min-w-0 px-2 sm:px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`inline-flex rounded border px-1.5 py-0.5 text-[9px] sm:text-[10px] font-mono font-bold whitespace-nowrap ${style}`}>
          {data.classification}
        </span>
        {data.bias && (
          <span className={`text-[8px] font-mono font-semibold tracking-wide ${data.bias === 'BULLISH' ? 'text-emerald-300/80' : 'text-red-300/80'}`}>
            {data.bias}
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] sm:text-[10px] font-mono tabular-nums text-terminal-muted">
        <span title="Premium change over the selected interval">LTP {formatSigned(data.premium_change_pct, 2)}%</span>
        <span title="Open-interest change, absolute and percentage">OI {formatCompact(data.oi_change)} ({formatSigned(data.oi_change_pct, 2)}%)</span>
        <span title="Traded-volume change over the selected interval">Vol {formatCompact(data.volume_change)}</span>
      </div>
    </div>
  );
};

export const OptionsBuildup: React.FC<OptionsBuildupProps> = ({
  indexName,
  date,
  timestamp,
  liveMode,
  spot,
  selectedStrike,
  onSelectStrike,
}) => {
  const [interval, setIntervalValue] = useState<Interval>('15m');
  const [payload, setPayload] = useState<BuildupPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!indexName || !date) {
      setPayload(null);
      return;
    }

    let alive = true;
    let controller: AbortController | null = null;

    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      setLoading(true);
      try {
        const params = new URLSearchParams({
          index: indexName,
          date,
          interval,
        });
        if (!liveMode && timestamp) params.set('timestamp', timestamp);

        const response = await fetch(`/api/options-buildup?${params.toString()}`, {
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.detail || `Buildup request failed (HTTP ${response.status})`);
        if (!alive) return;
        setPayload(body as BuildupPayload);
        setError(null);
      } catch (err) {
        if (!alive || (err instanceof Error && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : 'Unable to load options buildup');
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();
    const poll = liveMode ? window.setInterval(() => void load(), 30000) : null;
    return () => {
      alive = false;
      controller?.abort();
      if (poll !== null) window.clearInterval(poll);
    };
  }, [indexName, date, timestamp, liveMode, interval]);

  const visibleRows = useMemo(() => {
    const rows = payload?.rows ?? [];
    if (showAll || rows.length <= 21) return [...rows].sort((a, b) => b.strike - a.strike);
    const nearest = [...rows]
      .sort((a, b) => Math.abs(a.strike - (spot ?? a.strike)) - Math.abs(b.strike - (spot ?? b.strike)))
      .slice(0, 21);
    return nearest.sort((a, b) => b.strike - a.strike);
  }, [payload, showAll, spot]);

  return (
    <div className="border-b border-terminal-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-terminal-border/70 bg-terminal-bg/60 px-2 sm:px-3 py-2">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="flex items-center gap-2 text-left">
            <span className="text-[10px] font-mono font-bold tracking-wider text-terminal-text">{expanded ? '▾' : '▸'} OPTIONS BUILDUP</span>
            <span className="text-[9px] font-mono text-terminal-muted">CE / PE by strike</span>
          </button>
          {loading && payload && (
            <RefreshCw className="h-3 w-3 animate-spin text-terminal-muted" aria-label="Updating buildup" />
          )}
        </div>
        {expanded && <div className="flex flex-wrap items-center gap-1">
          {INTERVALS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setIntervalValue(item.value)}
              aria-pressed={interval === item.value}
              className={`rounded border px-2 py-1 text-[9px] sm:text-[10px] font-mono transition-colors ${
                interval === item.value
                  ? 'border-terminal-atm/40 bg-terminal-atm/10 text-terminal-atm'
                  : 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:bg-white/5'
              }`}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            aria-pressed={showAll}
            className="ml-1 rounded border border-terminal-border px-2 py-1 text-[9px] sm:text-[10px] font-mono text-terminal-muted hover:text-terminal-text hover:bg-white/5"
          >
            {showAll ? 'ATM view' : 'All strikes'}
          </button>
        </div>}
      </div>

      {expanded && (
      <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 sm:px-3 py-1.5 text-[9px] font-mono text-terminal-muted">
        <span>
          {liveMode ? 'LIVE SNAPSHOT' : 'REPLAY SNAPSHOT'}
          {payload?.as_of_timestamp ? ` · AS OF ${formatTime(payload.as_of_timestamp)}` : ''}
          {payload?.baseline_timestamp ? ` · BASE ${formatTime(payload.baseline_timestamp)}` : ''}
        </span>
        <span>Premium change + OI change determine classification · volume is confirmation</span>
      </div>

      {error && (
        <div role="alert" className="mx-2 sm:mx-3 my-2 rounded border border-amber-500/20 bg-amber-500/[0.06] px-2 py-1.5 text-[10px] font-mono text-amber-300">
          {error}
        </div>
      )}

      {!payload?.ready ? (
        <div className="flex items-center justify-center gap-2 px-4 py-10 text-center text-[11px] font-mono text-terminal-muted" aria-live="polite">
          {loading ? <Loader2 className="h-4 w-4 animate-spin text-terminal-atm" /> : null}
          <span>{payload?.reason || (error ? 'Buildup data is temporarily unavailable.' : 'Waiting for enough saved snapshots to compare this interval.')}</span>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto terminal-scroll">
            <div className="min-w-[650px]">
              <div className="grid grid-cols-[76px_minmax(0,1fr)_minmax(0,1fr)] border-b border-terminal-border bg-terminal-bg/80 text-[9px] font-mono font-bold tracking-wide text-terminal-muted">
                <div className="px-2 py-2 text-center">STRIKE</div>
                <div className="px-2 py-2 border-l border-terminal-border/70 text-center text-terminal-ce">CALL · CE</div>
                <div className="px-2 py-2 border-l border-terminal-border/70 text-center text-terminal-pe">PUT · PE</div>
              </div>
              <div className="max-h-[48vh] overflow-y-auto terminal-scroll">
                {visibleRows.map((row) => (
                  <button
                    type="button"
                    key={row.strike}
                    onClick={() => onSelectStrike(row.strike)}
                    className={`grid w-full grid-cols-[76px_minmax(0,1fr)_minmax(0,1fr)] border-b border-terminal-border/40 text-left transition-colors hover:bg-white/[0.035] ${
                      selectedStrike === row.strike ? 'bg-white/[0.07]' : ''
                    }`}
                    title={`Select ${row.strike.toLocaleString('en-IN')} in the option chain`}
                  >
                    <span className={`flex items-center justify-center px-1 py-2 text-[10px] sm:text-xs font-mono font-bold tabular-nums ${
                      selectedStrike === row.strike ? 'text-terminal-atm' : 'text-terminal-text'
                    }`}>
                      {row.strike.toLocaleString('en-IN')}
                    </span>
                    <span className="border-l border-terminal-border/50">
                      <SideCell data={row.CE} />
                    </span>
                    <span className="border-l border-terminal-border/50">
                      <SideCell data={row.PE} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="px-2 sm:px-3 py-2 text-[9px] leading-relaxed font-mono text-terminal-muted">
            Classifications describe observed premium/OI movement, not confirmed buyer or seller identity. CE and PE bias labels are option-side interpretations, not trade signals.
          </div>
        </>
      )}
      </>
      )}
    </div>
  );
};
