import { useEffect, useRef, useState } from 'react';

// ── types (match backend /api/scanner/* payloads) ────────────
interface Candle { ts_minute: string; open: number; high: number; low: number; close: number; volume?: number | null; }
interface ScannerAlert {
  id?: number; timestamp?: string; kind: 'SETUP_FORMING' | 'CONFIRMED';
  direction: 'CE' | 'PE'; timeframe: string; symbol: string;
  wall: number; atm?: number | null; neg_gex?: number | null;
  c2_high: number; c2_low: number; five_m_ts?: string | null; five_m_close?: number | null;
  c3_ts?: string | null; c3_close?: number | null;
}
type TF = '15m' | '30m' | '1H';

const TF_LABEL: Record<TF, string> = { '15m': '15m', '30m': '30m', '1H': '1H' };
const TF_MIN: Record<TF, number> = { '15m': 15, '30m': 30, '1H': 60 };

// market-open anchor (09:15 IST) for 15m/30m/1H buckets, mirrors wall_scanner
function bucketStart(ts: string, tf: TF): number {
  const d = new Date(ts.replace(' ', 'T'));
  const m = d.getHours() * 60 + d.getMinutes();
  const anchor = 9 * 60 + 15;
  const tfMin = TF_MIN[tf];
  if (m < anchor || m > 15 * 60 + 30) return m;
  return anchor + Math.floor((m - anchor) / tfMin) * tfMin;
}
const minsToTs = (datePart: string, mins: number) =>
  `${datePart} ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`;


// Backend ts_minute is IST wall-clock ("2026-09-08 14:30:00"). lightweight-charts
// renders UNIX timestamps on a UTC axis. Parse as UTC ("...Z") so the UTC axis
// displays the intended IST wall-clock time. Without this, IST 14:30 renders as
// 08:45 UTC — a 5h30m shift that made the chart show 8:45-10:00 for 14:15-15:30 data.
const istToUnix = (ts: string) => Math.floor(new Date(ts.replace(' ', 'T') + 'Z').getTime() / 1000);

export function WallChart({ symbol, tier, atm, ceWall, peWall, negGex, replayDate }: {
  symbol: string; tier: number;
  atm: number | null; ceWall: number | null; peWall: number | null; negGex: number | null;
  replayDate?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tf, setTf] = useState<TF>('15m');
  const [alerts, setAlerts] = useState<ScannerAlert[]>([]);
  const [sel, setSel] = useState<ScannerAlert | null>(null);
  const [state, setState] = useState<'loading' | 'empty' | 'data'>('loading');
  const [chartReady, setChartReady] = useState(0);
  const chartRef = useRef<any>(null);

  const refresh = () => {
    if (!chartRef.current || !ref.current) return;
    if (!(chartRef.current as any).series?.[0]) return;   // chart not yet created
    const cu = new URL('/api/scanner/candles', window.location.origin);
    cu.searchParams.set('symbol', symbol); cu.searchParams.set('tf', tf);
    if (replayDate) cu.searchParams.set('date', replayDate);
    fetch(cu.toString()).then(r => {
      if (!r.ok) console.error('scanner/candles HTTP', r.status);
      return r.json();
    }).then(d => {
      const ch: any = chartRef.current; if (!ch) return;
      const cs = ch.series?.[0]; if (!cs || !cs.setData) return;
      const candles: Candle[] = d.candles ?? [];
      setState(candles.length ? 'data' : 'empty');
      if (!Array.isArray(d.candles)) console.error('scanner/candles bad payload', d);
      cs.setData(candles.map(c => ({ time: istToUnix(c.ts_minute), open: c.open, high: c.high, low: c.low, close: c.close })));
      const marks = alerts.filter(a => a.timeframe === tf).map(a => {
        const ts = a.kind === 'SETUP_FORMING' ? (a.five_m_ts ?? a.c2_ts) : (a.c3_ts ?? a.c2_ts);
        if (!ts) return null;
        const b = bucketStart(ts, tf);
        const tss = minsToTs(ts.slice(0, 10), b);
        return { time: istToUnix(tss),
                 position: a.kind === 'CONFIRMED' ? 'belowBar' : 'aboveBar',
                 color: a.direction === 'CE' ? '#f43f5e' : '#22c55e',
                 shape: a.kind === 'CONFIRMED' ? 'arrowDown' : 'circle',
                 text: a.kind === 'CONFIRMED' ? 'CONF' : 'FORM', alert: a };
      }).filter(Boolean);
      if (ch.setMarkers) ch.setMarkers(marks);
      ch._marks = marks;
      if (cs.createPriceLine) {
        if (ch._lines) ch._lines.forEach((l: any) => cs.removePriceLine(l));
        const mk = (price: number, color: string, title: string) =>
          cs.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title });
        const lines: any[] = [];
        if (atm != null) lines.push(mk(atm, '#e2b93d', 'ATM'));
        if (ceWall != null) lines.push(mk(ceWall, '#f43f5e', 'CE Wall'));
        if (peWall != null) lines.push(mk(peWall, '#22c55e', 'PE Wall'));
        if (tier === 1 && negGex != null) lines.push(mk(negGex, '#a78bfa', 'Neg GEX'));
        ch._lines = lines;
      }
    }).catch(() => {});
  };

  // fetch persisted alerts (markers) — never recomputed (query-only)
  useEffect(() => {
    let live = true;
    const load = () => {
      const u = new URL('/api/scanner/alerts', window.location.origin);
      u.searchParams.set('symbol', symbol);
      if (replayDate) u.searchParams.set('date', replayDate);
      fetch(u.toString()).then(r => r.json()).then(d => { if (live) setAlerts(d.alerts ?? []); }).catch(() => {});
    };
    load();
    const iv = setInterval(load, 30000);
    return () => { live = false; clearInterval(iv); };
  }, [symbol, replayDate]);

  // refresh chart whenever inputs or alerts change; poll on cadence
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30000);
    return () => clearInterval(iv);
  }, [symbol, tf, replayDate, tier, atm, ceWall, peWall, negGex, alerts, chartReady]);

  // create chart once
  useEffect(() => {
    if (!ref.current) return;
    let disposed = false;
    (async () => {
      try {
        // BULLETPROOF: load the standalone UMD build via <script> tag → global
        // window.LightweightCharts. Zero module resolution, zero Vite dep
        // optimizer involvement, zero bare-specifier resolution. The root cause
        // of every previous failure was module-resolution (bare 'fancy-canvas'
        // import inside the .mjs) or stale transforms. A script tag cannot fail.
        const lc: any = await new Promise((resolve, reject) => {
          if ((window as any).LightweightCharts) return resolve((window as any).LightweightCharts);
          const s = document.createElement('script');
          s.src = '/src/vendor/lightweight-charts/dist/lightweight-charts.standalone.production.js';
          s.onload = () => resolve((window as any).LightweightCharts);
          s.onerror = () => reject(new Error('standalone script load failed'));
          document.head.appendChild(s);
        });
        if (disposed || !ref.current) return;
        const chart = lc.createChart(ref.current, {
          layout: { background: { color: 'transparent' }, textColor: '#94a3b8' },
          grid: { vertLines: { color: 'rgba(148,163,184,0.08)' }, horzLines: { color: 'rgba(148,163,184,0.08)' } },
          timeScale: { timeVisible: true, secondsVisible: false, borderColor: 'rgba(148,163,184,0.2)' },
          rightPriceScale: { borderColor: 'rgba(148,163,184,0.2)' },
          width: ref.current.clientWidth, height: 280,
        });
        const cs = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#f43f5e', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#f43f5e' });
        (chart as any).cs = cs;
        chartRef.current = chart as any;
        (chartRef.current as any).series = [cs];
        const ro = new ResizeObserver(() => { if (ref.current) chart.applyOptions({ width: ref.current.clientWidth }); });
        ro.observe(ref.current!);
        (chart as any)._ro = ro;
        chart.subscribeClick((param: any) => {
          const t = (param as any)?.time as number | undefined;
          if (!t || !chartRef.current) return;
          const marks = (chartRef.current as any)._marks ?? [];
          const hit = marks.find((m: any) => Math.abs((m.time as number) - t) < 1);
          if (hit?.alert) setSel(hit.alert);
        });
        refresh();
        setTimeout(() => { refresh(); setChartReady(1); }, 50);
      } catch (e) {
        console.error('WallChart init failed', e);
      }
    })();
    return () => { disposed = true; if (chartRef.current) { try { (chartRef.current as any)._ro?.disconnect(); (chartRef.current as any).remove(); } catch {} chartRef.current = null; } };  }, []);

  const lvl = (v: number | null | undefined, tag: string, color: string) =>
    v != null ? <span className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color, background: 'rgba(148,163,184,0.08)' }}>{tag} {v}</span> : null;

  return (
    <div className="mt-2 border border-terminal-border rounded-lg bg-black/30 p-2">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <span className="text-[11px] font-mono text-terminal-muted uppercase tracking-wide">Wall Reversal</span>
        <div className="inline-flex border border-terminal-border rounded overflow-hidden">
          {(Object.keys(TF_LABEL) as TF[]).map(t => (
            <button key={t} onClick={() => setTf(t)}
              className={`px-3 py-1 text-[11px] font-mono transition-colors ${tf === t ? 'bg-white/10 text-terminal-text' : 'text-[var(--st-text-2)] hover:bg-white/5'}`}>
              {TF_LABEL[t]}
            </button>
          ))}
        </div>
        {lvl(atm, 'ATM', '#e2b93d')}
        {lvl(ceWall, 'CE Wall', '#f43f5e')}
        {lvl(peWall, 'PE Wall', '#22c55e')}
        {tier === 1 && lvl(negGex, 'Neg GEX', '#a78bfa')}
        <span className="ml-auto text-[10px] font-mono text-terminal-muted">{symbol}</span>
      </div>
      <div ref={ref} className="w-full" />
      {state === 'loading' && <div className="text-[10px] font-mono text-terminal-muted py-2">Loading candles…</div>}
      {state === 'empty' && <div className="text-[10px] font-mono text-terminal-muted py-2">No candles yet for {symbol} on {tf}{replayDate ? ` (${replayDate})` : ''}.</div>}
      {sel && (
        <div className="mt-1 text-[10px] font-mono text-terminal-muted border-t border-terminal-border pt-1 flex gap-3 flex-wrap">
          <span>{sel.kind === 'SETUP_FORMING' ? '🟡 SETUP FORMING' : (sel.direction === 'CE' ? '🔴 CONFIRMED BEARISH' : '🟢 CONFIRMED BULLISH')}</span>
          <span>{sel.timeframe}</span>
          <span>wall {sel.wall}</span>
          {sel.atm != null && <span>ATM {sel.atm}</span>}
          {tier === 1 && sel.neg_gex != null && <span>negGEX {sel.neg_gex}</span>}
          <span>C2 H/L {sel.c2_high}/{sel.c2_low}</span>
          {sel.five_m_close != null && <span>5m close {sel.five_m_close}</span>}
          {sel.c3_close != null && <span>C3 close {sel.c3_close}</span>}
          <span>{sel.timestamp ?? ''}</span>
          <button className="underline" onClick={() => setSel(null)}>close</button>
        </div>
      )}
    </div>
  );
}
