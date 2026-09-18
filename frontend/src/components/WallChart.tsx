import { useCallback, useEffect, useRef, useState } from 'react';

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

interface WallChartProps {
  symbol: string; tier: number;
  atm: number | null; ceWall: number | null; peWall: number | null; negGex: number | null;
  replayDate?: string | null;
  /** MOBILE-ONLY VARIANT (default false = the unchanged desktop rendering):
   *  chrome-less, chart fills its container, axis annotations reduced to
   *  prevent label collisions, marker taps reported via onAlertSelect.
   *  Every behavioral branch below resolves to the original desktop value
   *  when this flag is false. */
  mobile?: boolean;
  tf?: TF;
  onTfChange?: (t: TF) => void;
  onAlertSelect?: (alert: any) => void;
}

export function WallChart({ symbol, tier, atm, ceWall, peWall, negGex, replayDate,
                            mobile = false, tf: tfProp, onTfChange, onAlertSelect }: WallChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [tfInt, setTfInt] = useState<TF>('15m');
  const tf = tfProp ?? tfInt;
  const setTf = (t: TF) => { setTfInt(t); onTfChange?.(t); };
  const [alerts, setAlerts] = useState<ScannerAlert[]>([]);
  const [sel, setSel] = useState<ScannerAlert | null>(null);
  const [state, setState] = useState<'loading' | 'empty' | 'data'>('loading');
  const [chartReady, setChartReady] = useState(0);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const chartRef = useRef<any>(null);
  // Desktop visible-range state: the left-edge timestamp the viewport was
  // last fitted to, and whether the user has taken over the viewport (pan/
  // zoom). Drives fit-only-when-appropriate in refresh() — never re-fit
  // routine live updates over a user-controlled viewport.
  const rangeStateRef = useRef<{ fittedFrom: number | null; userInteracted: boolean }>(
    { fittedFrom: null, userInteracted: false });
  // ── Mobile annotation overlay (mobile only): colored filled badges, level
  // name at the left end of each line, price at the right — with a guaranteed
  // minimum separation so labels can NEVER overlap (the old price-axis pile).
  const annRef = useRef<HTMLDivElement>(null);
  const levelsRef = useRef<{ key: string; price: number; color: string }[]>([]);
  const positionBadges = useCallback(() => {
    const ann = annRef.current;
    const ch: any = chartRef.current;
    if (!ann || !ch) return;
    const cs = ch.series?.[0];
    if (!cs || !cs.priceToCoordinate) { ann.innerHTML = ''; return; }
    // Derive the PLOT AREA's pixel bounds from the price→coordinate mapping
    // itself — pane getHeight/getPosition are NOT in v4.2.0's API (reading them
    // returned undefined/0, which is why the previous fix still overflowed).
    // Two anchor prices bracket the plot; their pixel span gives the plot
    // height, the minimum maps to the plot's top offset within the overlay.
    // priceToCoordinate is affine across ALL prices (global pane coords), so
    // off-range levels (e.g. CE Wall above the anchors) are still mapped and
    // then clamped to the plot edge — never dropped.
    const ref = levelsRef.current;
    let plotH = ann.clientHeight || 0;
    let plotTop = 0;
    if (ref.length >= 2) {
      const p1 = ref[0].price, p2 = ref[ref.length - 1].price;
      const y1 = cs.priceToCoordinate(p1) as number | null;
      const y2 = cs.priceToCoordinate(p2) as number | null;
      if (y1 != null && y2 != null && y1 !== y2) {
        plotH = Math.abs(y2 - y1);
        plotTop = Math.min(y1 as number, y2 as number);
      }
    }
    const H = plotH;
    const topPad = 10;
    const items = levelsRef.current
      .map(l => ({ ...l, y: cs.priceToCoordinate(l.price) as number | null }))
      .filter((l): l is typeof l & { y: number } => l.y != null)
      .sort((a, b) => (a.y as number) - (b.y as number));
    const MIN = 22;                       // px — badge height + margin
    for (let i = 1; i < items.length; i++) {
      if ((items[i].y as number) - (items[i - 1].y as number) < MIN)
        (items[i] as any).y = (items[i - 1].y as number) + MIN;
    }
    for (let i = items.length - 2; i >= 0; i--) {   // keep the LAST (lowest) item at its true price
      if ((items[i].y as number) > (items[i + 1].y as number) - MIN)
        (items[i] as any).y = (items[i + 1].y as number) - MIN;
    }
    for (let i = 0; i < items.length; i++) {        // clamp INSIDE the pane only
      if ((items[i].y as number) < topPad) (items[i] as any).y = topPad;
      if ((items[i].y as number) > H - 12) (items[i] as any).y = H - 12;
    }
    ann.innerHTML = items.map(l => {
      const y = Math.round((l.y as number) + plotTop) - 9;   // plot→overlay coords
      const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
      return `<span class="mc-ann-l" style="top:${y}px;background:${l.color}">${l.key}</span>` +
             `<span class="mc-ann-r num" style="top:${y}px;background:${l.color}">${fmt(l.price)}</span>`;
    }).join('');
  }, []);

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
      const times = candles.map(c => istToUnix(c.ts_minute));
      cs.setData(candles.map((c, i) => ({ time: times[i], open: c.open, high: c.high, low: c.low, close: c.close })));
      if (mobile && ch.timeScale && candles.length) ch.timeScale().fitContent();
      // ── Desktop visible-range management (mobile behavior above is
      // byte-identical to before). Re-fit ONLY on initial load, on
      // symbol/tf/replay change (rangeStateRef reset by the effect below),
      // or when genuinely new HISTORICAL candles appear at the left edge.
      // Routine live refreshes that merely append the newest candle keep the
      // current viewport, so user zoom/pan is never fought.
      if (!mobile && ch.timeScale && times.length) {
        const rs = rangeStateRef.current;
        const NEW_HISTORY_SEC = 60;   // material left-edge expansion only
        const newHistory = rs.fittedFrom === null || times[0] < rs.fittedFrom - NEW_HISTORY_SEC;
        if (newHistory || !rs.userInteracted) {
          ch.timeScale().fitContent();
          rs.fittedFrom = times[0];
        }
      }
      if (mobile) {
        const last = candles.length ? candles[candles.length - 1].close : null;
        levelsRef.current = ([
          { key: 'CE WALL', price: ceWall, color: '#f4566c' },
          ...(tier === 1 && negGex != null ? [{ key: 'NEG GEX', price: negGex, color: '#a78bfa' }] : []),
          { key: 'ATM', price: atm, color: '#5aa2f0' },
          { key: 'PE WALL', price: peWall, color: '#34d399' },
          ...(last != null ? [{ key: 'Spot', price: last, color: '#ff4757' }] : []),
        ] as any[]).filter(l => l.price != null);
        positionBadges();
      }
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
        // Desktop (mobile=false): labels ON, titles ON — byte-identical to before.
        // Mobile: every price line is a thin unlabeled dashed line (values live
        // in the MobileWalls level strip); only the series' own last-price badge
        // remains on the axis, so labels can never collide.
        const mk = (price: number, color: string, title: string) =>
          cs.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2,
                               axisLabelVisible: mobile ? false : true,
                               title: mobile ? '' : title });
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

  // Reset the desktop range state on instrument / timeframe / replay change
  // so the next refresh re-fits the FULL available range (validation case:
  // 15m -> 30m -> 1H each show the whole session).
  useEffect(() => {
    rangeStateRef.current = { fittedFrom: null, userInteracted: false };
  }, [symbol, tf, replayDate]);

  // Desktop only: the first pan/zoom gesture hands viewport control to the
  // user — after that, routine refreshes stop re-fitting. (Mobile fits every
  // refresh by design and is untouched by this effect.)
  useEffect(() => {
    if (mobile) return;
    const el = ref.current;
    if (!el) return;
    const mark = () => { rangeStateRef.current.userInteracted = true; };
    el.addEventListener('wheel', mark, { passive: true });
    el.addEventListener('pointerdown', mark);
    return () => {
      el.removeEventListener('wheel', mark);
      el.removeEventListener('pointerdown', mark);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile]);

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
          // Fallback chain: prefer the deployment-correct path, but NEVER die
          // silently — the other location is tried before failing. (Desktop's
          // first choice is its original path; mobile's first choice is
          // public/vendor, falling back to the tree's existing src/vendor.)
          const trySrcs = mobile
            ? ['/vendor/lightweight-charts.standalone.production.js',
               '/src/vendor/lightweight-charts/dist/lightweight-charts.standalone.production.js']
            : ['/src/vendor/lightweight-charts/dist/lightweight-charts.standalone.production.js',
               '/vendor/lightweight-charts.standalone.production.js'];
          const load = (i: number) => {
            if (i >= trySrcs.length) return reject(new Error('standalone builds unavailable'));
            const s = document.createElement('script');
            s.onload = () => resolve((window as any).LightweightCharts);
            s.onerror = () => load(i + 1);
            s.src = trySrcs[i];
            document.head.appendChild(s);
          };
          load(0);
        });
        if (disposed || !ref.current) return;
        const chart = lc.createChart(ref.current, {
          layout: { background: { color: 'transparent' }, textColor: '#94a3b8' },
          grid: { vertLines: { color: 'rgba(148,163,184,0.08)' }, horzLines: { color: 'rgba(148,163,184,0.08)' } },
          timeScale: { timeVisible: true, secondsVisible: false, borderColor: 'rgba(148,163,184,0.2)' },
          rightPriceScale: { borderColor: 'rgba(148,163,184,0.2)' },
          width: ref.current.clientWidth,
          height: mobile ? Math.max(ref.current.clientHeight, 240) : 280,
        });
        const cs = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#f43f5e', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#f43f5e',
          lastValueVisible: !mobile,   // desktop: default true (unchanged); mobile: Spot badge via overlay
          priceLineVisible: true });
        (chart as any).cs = cs;
        chartRef.current = chart as any;
        (chartRef.current as any).series = [cs];
        const ro = new ResizeObserver(() => {
          if (!ref.current) return;
          chart.applyOptions({ width: ref.current.clientWidth,
                               height: mobile ? ref.current.clientHeight : 280 });
          positionBadges();
        });
        ro.observe(ref.current!);
        (chart as any)._ro = ro;
        chart.subscribeClick((param: any) => {
          const t = (param as any)?.time as number | undefined;
          if (!t || !chartRef.current) return;
          const marks = (chartRef.current as any)._marks ?? [];
          const hit = marks.find((m: any) => Math.abs((m.time as number) - t) < 1);
          if (hit?.alert) {
            setSel(hit.alert);
            onAlertSelect?.(hit.alert);   // no-op on desktop (no callback)
          }
        });
        positionBadges();
        const annTimer = setInterval(() => positionBadges(), 2000);
        (chart as any)._annTimer = annTimer;
        refresh();
        setTimeout(() => { refresh(); setChartReady(1); }, 50);
      } catch (e) {
        console.error('WallChart init failed', e);
        setLoadErr('chart library failed to load — check the /vendor asset');
      }
    })();
    return () => { disposed = true; if (chartRef.current) { try { clearInterval((chartRef.current as any)._annTimer); (chartRef.current as any)._ro?.disconnect(); (chartRef.current as any).remove(); } catch {} chartRef.current = null; } };  }, []);

  const lvl = (v: number | null | undefined, tag: string, color: string) =>
    v != null ? <span className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color, background: 'rgba(148,163,184,0.08)' }}>{tag} {v}</span> : null;

  return (
    <div className={mobile ? "mc-wsc-chartfill" : "mt-2 border border-terminal-border rounded-lg bg-black/30 p-2"}>
      {!mobile && (
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
      )}
      {mobile ? (
        <div className="relative flex-1 min-h-0">
          <div ref={ref} className="w-full mc-wsc-canvas" />
          <div ref={annRef} className="mc-wsc-ann" />
        </div>
      ) : (
        <div ref={ref} className="w-full" />
      )}
      {state === 'loading' && <div className="text-[10px] font-mono text-terminal-muted py-2">Loading candles…</div>}
      {state === 'empty' && <div className="text-[10px] font-mono text-terminal-muted py-2">No candles yet for {symbol} on {tf}{replayDate ? ` (${replayDate})` : ''}.</div>}
      {loadErr && <div className="text-[10px] font-mono text-terminal-ce py-2">⚠ {loadErr}</div>}
      {sel && !mobile && (
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
