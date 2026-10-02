import React, { useMemo, useRef, useState, useLayoutEffect } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
  LabelList,
} from 'recharts';

interface GexData {
  strike: number;
  ce_gex: number;
  pe_gex: number;
  net_gex: number;
}

interface GexChartProps {
  data: GexData[];
  atmStrike: number | null;
  maxPain: number | null;
  gammaFlip: number | null;
  /** v3.10: max-CE-OI and max-PE-OI wall strikes (the "OI walls" used across
   *  the app — same definition as OptionChain's #1 CE/PE rank and the alert
   *  engine's max_ce_oi_strike / max_pe_oi_strike). Rendered as reference
   *  lines with the same label treatment as ATM/MAX PAIN/GAMMA FLIP.
   *  Optional: the chart is unchanged when they are omitted. */
  ceWall?: number | null;
  peWall?: number | null;
}

interface RefLineConfig {
  key: string;
  strike: number;
  color: string;
  text: string;
}

// ── OI-wall computation helper (exported for App.tsx wiring) ──────────
// Walls are max-OI strikes, NOT derivable from GEX values — the chart's
// `data` prop carries only GEX. Callers compute them once from the live
// options array and pass them down:
//
//   const { ceWall, peWall } = useMemo(() => computeOiWalls(options), [options]);
//   <GexChart ... ceWall={ceWall} peWall={peWall} />
//
// Mirrors alert_engine._calculate_walls exactly (strict `>` keeps the FIRST
// max on ties — deterministic, same wall the alerts report).
export interface OiWallInput {
  strike: number;
  option_type: string;
  oi?: number;
}

export function computeOiWalls(
  options: OiWallInput[] | undefined | null,
): { ceWall: number | null; peWall: number | null } {
  let ceWall: number | null = null;
  let peWall: number | null = null;
  let ceOi = -1;
  let peOi = -1;
  for (const o of options ?? []) {
    const oi = o.oi ?? 0;
    if (o.option_type === 'CE' && oi > ceOi) {
      ceOi = oi;
      ceWall = o.strike;
    } else if (o.option_type === 'PE' && oi > peOi) {
      peOi = oi;
      peWall = o.strike;
    }
  }
  return { ceWall, peWall };
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload || !payload.length) return null;
  const entry = payload[0]?.payload;
  if (!entry) return null;

  const net = entry.net_gex ?? 0;
  const ce = entry.ce_gex ?? 0;
  const pe = entry.pe_gex ?? 0;
  const sign = net >= 0 ? '+' : '';

  return (
    <div className="bg-terminal-panel/95 backdrop-blur-md border border-terminal-border/60 rounded-lg px-3 py-2 text-[11px] font-mono shadow-2xl pointer-events-none min-w-[180px]">
      <div className="font-bold text-terminal-text mb-1.5 border-b border-terminal-border/40 pb-1">
        Strike {label?.toLocaleString('en-IN')}
      </div>
      <div className="space-y-1">
        <div className="flex justify-between items-center">
          <span className="text-terminal-muted">Net GEX</span>
          <span className={`font-bold ${net >= 0 ? 'text-terminal-pe' : 'text-terminal-ce'}`}>
            {sign}{net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-red-500/80" />
            <span className="text-terminal-muted">CE GEX</span>
          </span>
          <span className="text-red-400">{ce.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-green-500/80" />
            <span className="text-terminal-muted">PE GEX</span>
          </span>
          <span className="text-green-400">{pe.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
        </div>
      </div>
    </div>
  );
};

// CE Wall = max CE OI strike (resistance — sellers' wall above spot).
// PE Wall = max PE OI strike (support — sellers' wall below spot).
// Colors match the OptionChain rank-1 badges and WallChart wall lines.
const CE_WALL_COLOR = '#f43f5e';
const PE_WALL_COLOR = '#22c55e';

function buildRefLineConfigs(
  atmStrike: number | null,
  maxPain: number | null,
  gammaFlip: number | null,
  ceWall: number | null,
  peWall: number | null,
): RefLineConfig[] {
  const raw = [
    { key: 'atm', strike: atmStrike, color: '#eab308', text: 'ATM' },
    { key: 'mp', strike: maxPain, color: '#d946ef', text: 'MAX PAIN' },
    { key: 'gf', strike: gammaFlip, color: '#06b6d4', text: 'GAMMA FLIP' },
    { key: 'cewall', strike: ceWall ?? null, color: CE_WALL_COLOR, text: 'CE WALL' },
    { key: 'pewall', strike: peWall ?? null, color: PE_WALL_COLOR, text: 'PE WALL' },
  ].filter((r): r is RefLineConfig => r.strike !== null);
  return raw;
}

const GexChartComponent: React.FC<GexChartProps> = ({ data, atmStrike, maxPain, gammaFlip, ceWall, peWall }) => {
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const widthRef = useRef(0);

  // ── Robust width measurement ────────────────────────────────────
  useLayoutEffect(() => {
    if (!chartWrapRef.current) return;
    const el = chartWrapRef.current;
    let rafId = 0;
    let timeoutId: ReturnType<typeof setTimeout>;
    let attempts = 0;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      if (w > 0 && w !== widthRef.current) {
        widthRef.current = w;
        setChartWidth(w);
      }
    };

    const retryLoop = () => {
      if (widthRef.current === 0 && attempts < 30) {
        attempts++;
        measure();
        rafId = requestAnimationFrame(retryLoop);
      }
    };

    measure();
    rafId = requestAnimationFrame(retryLoop);
    timeoutId = setTimeout(measure, 150);

    const ro = new ResizeObserver(measure);
    ro.observe(el);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(timeoutId);
    };
  }, [data?.length]);

  const isMobile = chartWidth > 0 && chartWidth < 768;

  // ── Compute chart data ──────────────────────────────────────────
  const memoized = useMemo(() => {
    if (!data || data.length === 0) {
      return {
        hasData: false,
        chartData: [] as GexData[],
        yDomain: [0, 0] as [number, number],
        yTickFormatter: (v: number) => String(v),
        barSize: 10,
        refLines: [] as RefLineConfig[],
      };
    }

    // 1. THRESHOLD FILTERING (identical to original)
    const maxAbsGex = Math.max(...data.map((d) => Math.abs(d.net_gex)), 1);
    const threshold = maxAbsGex * 0.015;

    let atmIdx = -1;
    if (atmStrike) {
      atmIdx = data.findIndex((d) => d.strike === atmStrike);
    }
    if (atmIdx < 0) {
      let maxVal = 0;
      data.forEach((d, i) => {
        const absG = Math.abs(d.net_gex);
        if (absG > maxVal) { maxVal = absG; atmIdx = i; }
      });
    }

    let filtered = data.filter((d, idx) => {
      const hasMeaningfulGex = Math.abs(d.net_gex) >= threshold;
      const nearAtm = atmIdx >= 0 ? Math.abs(idx - atmIdx) <= 10 : true;
      // Walls are KEY STRIKES: the threshold filter and the mobile window
      // must never drop them — a wall outside the plotted range would make
      // its reference line vanish exactly when it matters most.
      const isKeyStrike = d.strike === maxPain || d.strike === gammaFlip || d.strike === atmStrike
        || d.strike === ceWall || d.strike === peWall;
      return hasMeaningfulGex || nearAtm || isKeyStrike;
    });

    // 2. MOBILE ONLY: dynamic strike window
    if (isMobile && chartWidth > 0 && filtered.length > 0) {
      const plotLeft = 40;
      const plotRight = 15;
      const usableWidth = chartWidth - plotLeft - plotRight;
      const minPxPerBar = 22; // mobile minimum
      const maxBars = Math.max(7, Math.floor(usableWidth / minPxPerBar));

      if (filtered.length > maxBars) {
        const atmIdxF = atmStrike ? filtered.findIndex((d) => d.strike === atmStrike) : -1;
        const centerIdx = atmIdxF >= 0 ? atmIdxF : Math.floor(filtered.length / 2);
        const half = Math.floor(maxBars / 2);
        let start = Math.max(0, centerIdx - half);
        let end = Math.min(filtered.length, start + maxBars);
        if (end - start < maxBars) {
          start = Math.max(0, end - maxBars);
        }
        filtered = filtered.slice(start, end);
      }
    }

    // 3. Y-AXIS (identical to original)
    const gexValues = filtered.map((d) => d.net_gex);
    const minGex = Math.min(...gexValues, 0);
    const maxGex = Math.max(...gexValues, 0);
    const pad = Math.max((maxGex - minGex) * 0.08, maxAbsGex * 0.05);
    const domain: [number, number] = [minGex - pad, maxGex + pad];

    const absMax = Math.max(Math.abs(minGex), Math.abs(maxGex));
    let formatter: (v: number) => string;
    if (absMax >= 1_000_000) {
      formatter = (v: number) => (v / 1e6).toFixed(1) + 'M';
    } else if (absMax >= 1_000) {
      formatter = (v: number) => (v / 1e3).toFixed(1) + 'K';
    } else {
      formatter = (v: number) => v.toFixed(0);
    }

    // 4. BAR SIZE
    let barSize: number;
    if (isMobile) {
      const n = filtered.length;
      const plotLeft = 40;
      const plotRight = 15;
      const usableWidth = Math.max(chartWidth - plotLeft - plotRight, 1);
      const rawSize = Math.floor((usableWidth / Math.max(n, 1)) * 0.65);
      barSize = Math.max(3, Math.min(10, rawSize));
    } else {
      // ORIGINAL desktop formula — unchanged
      barSize = Math.min(32, Math.max(10, Math.floor(700 / filtered.length)));
    }

    // 5. REF LINES (ATM / MAX PAIN / GAMMA FLIP / CE WALL / PE WALL)
    const refLineConfigs = buildRefLineConfigs(atmStrike, maxPain, gammaFlip, ceWall ?? null, peWall ?? null);

    return {
      hasData: true,
      chartData: filtered,
      yDomain: domain,
      yTickFormatter: formatter,
      barSize,
      refLines: refLineConfigs,
    };
  }, [data, atmStrike, maxPain, gammaFlip, ceWall, peWall, chartWidth, isMobile]);

  // ── Compute label pixel positions (desktop only logic) ──────────
  const plotLeft = isMobile ? 40 : 60;
  const plotRight = 15;
  const plotWidth = Math.max(chartWidth - plotLeft - plotRight, 1);

  // v3.10.1: pills are stacked DOWNWARD from the chart's top edge. The
  // previous fixed 38px margin could not hold the stagger once CE/PE walls
  // joined ATM/MAX PAIN/GAMMA FLIP — pills sank into the plot and collided
  // with bar value labels (seen in production: ATM pill sitting on the
  // "+59.4K" label). Now the stagger depth is computed FIRST and the top
  // margin band grows to contain every pill above the plot area, so pills
  // and bar labels can never overlap, however many levels coincide.
  const labelPositions = useMemo(() => {
    if (!isMobile && chartWidth > 0 && memoized.chartData.length > 0) {
      const n = memoized.chartData.length;
      const positions = memoized.refLines.map((cfg) => {
        const idx = memoized.chartData.findIndex((d) => d.strike === cfg.strike);
        if (idx < 0) return null;
        const x = plotLeft + (idx / Math.max(n - 1, 1)) * plotWidth;
        return { ...cfg, x, idx };
      }).filter(Boolean) as Array<RefLineConfig & { x: number; idx: number }>;

      // Pill width ≈ 44–62px at 10px bold mono — 62px gap before stacking.
      const STAGGER_PX = 14;
      const MIN_GAP = 62;
      const sorted = [...positions].sort((a, b) => a.x - b.x);

      return sorted.map((item, i) => {
        let topOffset = 8;
        for (let j = 0; j < i; j++) {
          if (Math.abs(item.x - sorted[j].x) < MIN_GAP) {
            topOffset += STAGGER_PX;
          }
        }
        return { ...item, topOffset };
      });
    }
    return [];
  }, [isMobile, chartWidth, memoized.chartData, memoized.refLines, plotLeft, plotWidth]);

  // ── Conditional returns ─────────────────────────────────────────
  if (!memoized.hasData) {
    return (
      <div className="terminal-panel h-[280px] flex items-center justify-center">
        <span className="text-terminal-muted text-sm">No GEX data available</span>
      </div>
    );
  }

  if (memoized.chartData.length === 0) {
    return (
      <div className="terminal-panel h-[280px] flex items-center justify-center">
        <span className="text-terminal-muted text-sm">No significant GEX data</span>
      </div>
    );
  }

  const { chartData, yDomain, yTickFormatter, barSize, refLines } = memoized;

  // ── Desktop vs Mobile chart config ──────────────────────────────
  const chartHeight = isMobile ? 180 : 280;
  // Adaptive top band: holds every staggered pill ABOVE the plot. The plot
  // only gives up height when many levels genuinely coincide; with just
  // ATM + MAX PAIN (the old common case) it stays at the original 38px.
  const deepestPill = labelPositions.reduce((m, l) => Math.max(m, l.topOffset), 8);
  const marginTop = isMobile ? 4 : Math.max(38, deepestPill + 22);
  const margin = { top: marginTop, right: 15, left: 5, bottom: 5 };
  const categoryGap = isMobile ? '25%' : '20%';
  const axisFontSize = isMobile ? 8 : 10;
  const yAxisWidth = isMobile ? 38 : 55;
  const minTickGap = isMobile ? 12 : 30;
  const showBarLabels = !isMobile;
  const showOverlays = !isMobile;

  return (
    <div className="terminal-panel">
      <div className="terminal-header flex items-center justify-between">
        <span className="text-xs sm:text-sm">GEX by Strike</span>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-green-500/70" />
            <span className="text-terminal-muted">+GEX (Support)</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-red-500/70" />
            <span className="text-terminal-muted">−GEX (Resistance)</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: CE_WALL_COLOR, opacity: 0.7 }} />
            <span className="text-terminal-muted">CE Wall</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: PE_WALL_COLOR, opacity: 0.7 }} />
            <span className="text-terminal-muted">PE Wall</span>
          </span>
          <span className="text-terminal-muted/60 ml-2 hidden sm:inline">
            {chartData.length} of {data.length} strikes
          </span>
        </div>
      </div>

      <div ref={chartWrapRef} style={{ height: chartHeight }} className="relative">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            margin={margin}
            barCategoryGap={categoryGap}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" vertical={false} />
            <XAxis
              dataKey="strike"
              tick={{ fill: '#6b7280', fontSize: axisFontSize, fontFamily: 'JetBrains Mono' }}
              tickFormatter={(v) => v.toLocaleString('en-IN')}
              interval="preserveStartEnd"
              minTickGap={minTickGap}
            />
            <YAxis
              domain={yDomain}
              tick={{ fill: '#6b7280', fontSize: axisFontSize, fontFamily: 'JetBrains Mono' }}
              tickFormatter={yTickFormatter}
              width={yAxisWidth}
            />
            <Tooltip
              content={<CustomTooltip />}
              cursor={{ fill: 'rgba(234, 179, 8, 0.06)' }}
            />
            <ReferenceLine y={0} stroke="#374151" strokeWidth={1} />

            <Bar
              dataKey="net_gex"
              name="Net GEX"
              barSize={barSize}
              radius={[3, 3, 3, 3]}
              animationDuration={400}
            >
              {chartData.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={entry.net_gex >= 0 ? '#22c55e' : '#ef4444'}
                  fillOpacity={0.85}
                  stroke={entry.net_gex >= 0 ? '#16a34a' : '#dc2626'}
                  strokeWidth={1}
                />
              ))}
              {showBarLabels && (
                <LabelList
                  dataKey="net_gex"
                  position="top"
                  formatter={(v: number) => {
                    const absMax = Math.max(...chartData.map((d) => Math.abs(d.net_gex)));
                    if (Math.abs(v) < absMax * 0.25) return '';
                    const sign = v >= 0 ? '+' : '';
                    const div = absMax >= 1e6 ? 1e6 : absMax >= 1e3 ? 1e3 : 1;
                    const suffix = absMax >= 1e6 ? 'M' : absMax >= 1e3 ? 'K' : '';
                    return `${sign}${(v / div).toFixed(1)}${suffix}`;
                  }}
                  style={{
                    fill: '#9ca3af',
                    fontSize: 9,
                    fontFamily: 'JetBrains Mono',
                  }}
                />
              )}
            </Bar>

            {atmStrike && (
              <ReferenceLine x={atmStrike} stroke="#eab308" strokeDasharray="5 5" strokeWidth={2} />
            )}
            {maxPain && (
              <ReferenceLine x={maxPain} stroke="#d946ef" strokeDasharray="5 5" strokeWidth={2} />
            )}
            {gammaFlip && (
              <ReferenceLine x={gammaFlip} stroke="#06b6d4" strokeDasharray="5 5" strokeWidth={2} />
            )}
            {ceWall != null && (
              <ReferenceLine x={ceWall} stroke={CE_WALL_COLOR} strokeDasharray="5 5" strokeWidth={2} />
            )}
            {peWall != null && (
              <ReferenceLine x={peWall} stroke={PE_WALL_COLOR} strokeDasharray="5 5" strokeWidth={2} />
            )}
          </BarChart>
        </ResponsiveContainer>

        {/* ── Desktop HTML overlays only. Every pill lives INSIDE the top
            margin band (marginTop adapts to the stagger depth), so a pill
            can never reach the plot area or a bar value label. ── */}
        {showOverlays && chartWidth > 0 && labelPositions.map((cfg) => {
          const nearLeft = cfg.x < plotLeft + 30;
          const nearRight = cfg.x > chartWidth - plotRight - 30;
          let transform = 'translateX(-50%)';
          if (nearLeft) transform = 'translateX(0%)';
          if (nearRight) transform = 'translateX(-100%)';

          return (
            <div
              key={cfg.key}
              className="absolute pointer-events-none"
              style={{
                left: `${cfg.x}px`,
                top: `${cfg.topOffset}px`,
                transform,
                zIndex: 50,
              }}
            >
              <span
                className="text-[10px] font-mono font-bold whitespace-nowrap px-1.5 py-0.5 rounded"
                style={{
                  color: cfg.color,
                  backgroundColor: 'rgba(13, 13, 23, 0.9)',
                  textShadow: `0 0 8px ${cfg.color}60`,
                  border: `1px solid ${cfg.color}40`,
                }}
              >
                {cfg.text}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Bottom legend: mobile only (ATM / MAX PAIN / GAMMA FLIP / walls) ── */}
      {isMobile && refLines.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 px-2 sm:px-3 py-1.5 sm:py-2 border-t border-terminal-border text-[9px] sm:text-[10px] font-mono">
          {refLines.map((cfg) => (
            <span key={cfg.key} className="flex items-center gap-1">
              <span
                className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-sm"
                style={{ backgroundColor: cfg.color, opacity: 0.7 }}
              />
              <span style={{ color: cfg.color }}>{cfg.text}</span>
              <span className="text-terminal-muted">{cfg.strike.toLocaleString('en-IN')}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export const GexChart = React.memo(GexChartComponent);