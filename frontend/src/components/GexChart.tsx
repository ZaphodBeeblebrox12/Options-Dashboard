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
}

interface RefLineConfig {
  key: string;
  strike: number;
  color: string;
  text: string;
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

function buildRefLineConfigs(
  atmStrike: number | null,
  maxPain: number | null,
  gammaFlip: number | null
): RefLineConfig[] {
  const raw = [
    { key: 'atm', strike: atmStrike, color: '#eab308', text: 'ATM' },
    { key: 'mp', strike: maxPain, color: '#d946ef', text: 'MAX PAIN' },
    { key: 'gf', strike: gammaFlip, color: '#06b6d4', text: 'GAMMA FLIP' },
  ].filter((r): r is RefLineConfig => r.strike !== null);
  return raw;
}

const GexChartComponent: React.FC<GexChartProps> = ({ data, atmStrike, maxPain, gammaFlip }) => {
  // ── ALL HOOKS MUST RUN UNCONDITIONALLY ───────────────────────────
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const widthRef = useRef(0);

  // Robust measurement: retries with rAF until width > 0, re-runs when data arrives
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
  }, [data?.length]); // <-- re-measure when data arrives

  // ── Compute chart data (runs even if data is empty) ───────────────
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

    // 1. THRESHOLD FILTERING
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

    const filtered = data.filter((d, idx) => {
      const hasMeaningfulGex = Math.abs(d.net_gex) >= threshold;
      const nearAtm = atmIdx >= 0 ? Math.abs(idx - atmIdx) <= 10 : true;
      const isKeyStrike = d.strike === maxPain || d.strike === gammaFlip || d.strike === atmStrike;
      return hasMeaningfulGex || nearAtm || isKeyStrike;
    });

    // 2. Y-AXIS
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

    // 3. BAR SIZE
    const size = Math.min(32, Math.max(10, Math.floor(700 / filtered.length)));

    // 4. REF LINES
    const refLineConfigs = buildRefLineConfigs(atmStrike, maxPain, gammaFlip);

    return {
      hasData: true,
      chartData: filtered,
      yDomain: domain,
      yTickFormatter: formatter,
      barSize: size,
      refLines: refLineConfigs,
    };
  }, [data, atmStrike, maxPain, gammaFlip]);

  // ── Compute label pixel positions ─────────────────────────────────
  const plotLeft = 60;
  const plotRight = 15;
  const plotWidth = Math.max(chartWidth - plotLeft - plotRight, 1);

  const labelPositions = useMemo(() => {
    if (chartWidth === 0 || memoized.chartData.length === 0) return [];

    const n = memoized.chartData.length;
    const positions = memoized.refLines.map((cfg) => {
      const idx = memoized.chartData.findIndex((d) => d.strike === cfg.strike);
      if (idx < 0) return null;
      const x = plotLeft + (idx / Math.max(n - 1, 1)) * plotWidth;
      return { ...cfg, x, idx };
    }).filter(Boolean) as Array<RefLineConfig & { x: number; idx: number }>;

    // Collision stagger
    const STAGGER_PX = 14;
    const MIN_GAP = 55;
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
  }, [chartWidth, memoized.chartData, memoized.refLines, plotLeft, plotWidth]);

  // ── NOW safe to do conditional returns ─────────────────────────────
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

  return (
    <div className="terminal-panel">
      <div className="terminal-header flex items-center justify-between">
        <span>GEX by Strike</span>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-green-500/70" />
            <span className="text-terminal-muted">+GEX (Support)</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-red-500/70" />
            <span className="text-terminal-muted">−GEX (Resistance)</span>
          </span>
          <span className="text-terminal-muted/60 ml-2">
            {chartData.length} of {data.length} strikes
          </span>
        </div>
      </div>

      {/* Chart + label overlay wrapper */}
      <div ref={chartWrapRef} className="relative h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            margin={{ top: 38, right: 15, left: 5, bottom: 5 }}
            barCategoryGap="20%"
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" vertical={false} />
            <XAxis
              dataKey="strike"
              tick={{ fill: '#6b7280', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              tickFormatter={(v) => v.toLocaleString('en-IN')}
              interval="preserveStartEnd"
              minTickGap={30}
            />
            <YAxis
              domain={yDomain}
              tick={{ fill: '#6b7280', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              tickFormatter={yTickFormatter}
              width={55}
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
            </Bar>

            {/* Dashed lines only — no Recharts labels */}
            {atmStrike && (
              <ReferenceLine x={atmStrike} stroke="#eab308" strokeDasharray="5 5" strokeWidth={2} />
            )}
            {maxPain && (
              <ReferenceLine x={maxPain} stroke="#d946ef" strokeDasharray="5 5" strokeWidth={2} />
            )}
            {gammaFlip && (
              <ReferenceLine x={gammaFlip} stroke="#06b6d4" strokeDasharray="5 5" strokeWidth={2} />
            )}
          </BarChart>
        </ResponsiveContainer>

        {/* ── Custom HTML label overlay ───────────────────────────── */}
        {chartWidth > 0 && labelPositions.map((cfg) => {
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
    </div>
  );
};

export const GexChart = React.memo(GexChartComponent);
