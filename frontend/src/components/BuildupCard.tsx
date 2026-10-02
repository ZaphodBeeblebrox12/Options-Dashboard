import React, { useEffect, useState } from 'react';

interface BuildupInfo {
  date: string;
  label: string;
  px?: number;
  px_chg?: number;
  futures_oi?: number | null;
  oi_chg?: number;
  oi_source?: string;
  live?: boolean;
  error?: string;
}

// Quadrant colors: Long Buildup green, Short Covering teal,
// Short Buildup red, Long Unwinding orange.
const LABEL_STYLE: Record<string, { color: string; bg: string }> = {
  'LONG BUILDUP':   { color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
  'SHORT COVERING': { color: '#2dd4bf', bg: 'rgba(45,212,191,0.12)' },
  'SHORT BUILDUP':  { color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  'LONG UNWINDING': { color: '#f97316', bg: 'rgba(249,115,22,0.12)' },
};

export const BuildupCard: React.FC<{ indexName: string; date: string; live: boolean }> = ({
  indexName, date, live,
}) => {
  const [data, setData] = useState<BuildupInfo | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`/api/buildup?index=${encodeURIComponent(indexName)}${live ? '' : `&date=${date}`}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return;
          const info = d?.[indexName];
          setData(info && info.label !== 'NO DATA' ? info : null);
          setGone(!info);
        })
        .catch(() => { if (!cancelled) setGone(true); });
    load();
    const t = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, [indexName, date, live]);

  // nothing to show (unknown index / no snapshots) — stay out of the layout
  if (gone || !data) return null;

  const style = LABEL_STYLE[data.label] ?? { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' };
  const pxUp = (data.px_chg ?? 0) >= 0;
  const oiUp = (data.oi_chg ?? 0) >= 0;
  const fmtPct = (v?: number) => (v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
  const barW = Math.min(Math.abs(data.oi_chg ?? 0), 100);

  return (
    <div className="terminal-panel px-3 sm:px-4 py-2">
      <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
        <span className="text-[9px] sm:text-[10px] font-mono uppercase tracking-wider text-terminal-muted">
          Buildup
        </span>
        <span
          className="px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-mono font-bold"
          style={{ color: style.color, background: style.bg }}
        >
          {data.label}
        </span>
        <span className="font-mono font-bold text-base" style={{ color: style.color }}>
          {(data.px ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          <span className="ml-2 text-xs font-normal opacity-90">
            {fmtPct(data.px_chg)} {pxUp ? '\u25b2' : '\u25bc'}
          </span>
        </span>
        <span className="text-[10px] sm:text-xs font-mono text-terminal-muted">
          FUT OI{' '}
          <span className="font-bold" style={{ color: style.color }}>
            {fmtPct(data.oi_chg)}
          </span>{' '}
          {oiUp ? '\u25b2' : '\u25bc'}
          {data.oi_source === 'options' && <span className="opacity-60"> (proxy)</span>}
        </span>
        {data.live && (
          <span className="flex items-center gap-1 text-[9px] font-mono text-terminal-pe">
            <span className="w-1.5 h-1.5 rounded-full bg-terminal-pe animate-pulse" />
            LIVE
          </span>
        )}
        {!live && (
          <span className="text-[9px] font-mono text-terminal-muted">
            since {data.baseline_ts ? data.baseline_ts.slice(11, 16) : '—'} ({data.date})
          </span>
        )}
      </div>
      {/* OI-change magnitude bar, colored by classification */}
      <div className="mt-1.5 h-1 rounded bg-white/5 overflow-hidden">
        <div
          className="h-full rounded transition-all duration-700"
          style={{ width: `${barW}%`, background: style.color }}
        />
      </div>
    </div>
  );
};
