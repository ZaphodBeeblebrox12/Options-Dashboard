import React, { useMemo } from 'react';
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

const GexChartComponent: React.FC<GexChartProps> = ({ data, atmStrike, maxPain, gammaFlip }) => {
  if (!data || data.length === 0) {
    return (
      <div className="terminal-panel h-[280px] flex items-center justify-center">
        <span className="text-terminal-muted text-sm">No GEX data available</span>
      </div>
    );
  }

  const { chartData, yDomain, yTickFormatter, barSize } = useMemo(() => {
    // 1. FIND MAX GEX FOR THRESHOLD FILTERING
    const maxAbsGex = Math.max(...data.map((d) => Math.abs(d.net_gex)), 1);
    const threshold = maxAbsGex * 0.015; // 1.5% of max — kills the noise

    // 2. FIND ATM INDEX FOR RANGE FILTERING
    let atmIdx = -1;
    if (atmStrike) {
      atmIdx = data.findIndex((d) => d.strike === atmStrike);
    }
    // Fallback: strike with max |net_gex| is usually near ATM
    if (atmIdx < 0) {
      let maxVal = 0;
      data.forEach((d, i) => {
        const absG = Math.abs(d.net_gex);
        if (absG > maxVal) { maxVal = absG; atmIdx = i; }
      });
    }

    // 3. FILTER: meaningful GEX OR near ATM
    const filtered = data.filter((d, idx) => {
      const hasMeaningfulGex = Math.abs(d.net_gex) >= threshold;
      const nearAtm = atmIdx >= 0 ? Math.abs(idx - atmIdx) <= 10 : true;
      const isKeyStrike = d.strike === maxPain || d.strike === gammaFlip || d.strike === atmStrike;
      return hasMeaningfulGex || nearAtm || isKeyStrike;
    });

    // 4. COMPUTE Y-AXIS DOMAIN WITH PADDING
    const gexValues = filtered.map((d) => d.net_gex);
    const minGex = Math.min(...gexValues, 0);
    const maxGex = Math.max(...gexValues, 0);
    const pad = Math.max((maxGex - minGex) * 0.08, maxAbsGex * 0.05);
    const domain: [number, number] = [minGex - pad, maxGex + pad];

    // 5. ADAPTIVE Y-AXIS FORMATTER
    const absMax = Math.max(Math.abs(minGex), Math.abs(maxGex));
    let formatter: (v: number) => string;
    if (absMax >= 1_000_000) {
      formatter = (v: number) => (v / 1e6).toFixed(1) + 'M';
    } else if (absMax >= 1_000) {
      formatter = (v: number) => (v / 1e3).toFixed(1) + 'K';
    } else {
      formatter = (v: number) => v.toFixed(0);
    }

    // 6. ADAPTIVE BAR SIZE
    const size = Math.min(32, Math.max(10, Math.floor(700 / filtered.length)));

    return {
      chartData: filtered,
      yDomain: domain,
      yTickFormatter: formatter,
      barSize: size,
    };
  }, [data, atmStrike, maxPain, gammaFlip]);

  if (chartData.length === 0) {
    return (
      <div className="terminal-panel h-[280px] flex items-center justify-center">
        <span className="text-terminal-muted text-sm">No significant GEX data</span>
      </div>
    );
  }

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
      <div className="h-[280px] p-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            margin={{ top: 30, right: 15, left: 5, bottom: 5 }}
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

            {/* Single diverging Net GEX bar */}
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
              {/* Show value on top of tallest bars only to avoid clutter */}
              <LabelList
                dataKey="net_gex"
                position="top"
                formatter={(v: number) => {
                  const absMax = Math.max(...chartData.map((d) => Math.abs(d.net_gex)));
                  if (Math.abs(v) < absMax * 0.25) return '';
                  const sign = v >= 0 ? '+' : '';
                  return `${sign}${(v / (absMax >= 1e6 ? 1e6 : absMax >= 1e3 ? 1e3 : 1)).toFixed(1)}${absMax >= 1e6 ? 'M' : absMax >= 1e3 ? 'K' : ''}`;
                }}
                style={{
                  fill: '#9ca3af',
                  fontSize: 9,
                  fontFamily: 'JetBrains Mono',
                }}
              />
            </Bar>

            {/* Reference lines — placed last so they render on top */}
            {atmStrike && (
              <ReferenceLine
                x={atmStrike}
                stroke="#eab308"
                strokeDasharray="5 5"
                strokeWidth={2}
                label={{
                  value: 'ATM',
                  fill: '#eab308',
                  fontSize: 10,
                  fontWeight: 'bold',
                  position: 'insideTopLeft',
                  offset: 10,
                }}
              />
            )}
            {maxPain && (
              <ReferenceLine
                x={maxPain}
                stroke="#d946ef"
                strokeDasharray="5 5"
                strokeWidth={2}
                label={{
                  value: 'MAX PAIN',
                  fill: '#d946ef',
                  fontSize: 10,
                  fontWeight: 'bold',
                  position: 'insideTop',
                  offset: 10,
                }}
              />
            )}
            {gammaFlip && (
              <ReferenceLine
                x={gammaFlip}
                stroke="#06b6d4"
                strokeDasharray="5 5"
                strokeWidth={2}
                label={{
                  value: 'GAMMA FLIP',
                  fill: '#06b6d4',
                  fontSize: 10,
                  fontWeight: 'bold',
                  position: 'insideTopRight',
                  offset: 10,
                }}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export const GexChart = React.memo(GexChartComponent);
