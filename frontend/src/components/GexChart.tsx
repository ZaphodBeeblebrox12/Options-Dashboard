import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
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
  if (!active || !payload) return null;
  return (
    <div className="bg-terminal-panel/80 backdrop-blur-sm border border-terminal-border/50 rounded px-2 py-1 text-[10px] font-mono shadow-lg pointer-events-none">
      <div className="font-bold text-terminal-text">Strike: {label?.toLocaleString('en-IN')}</div>
      {payload.map((entry: any) => (
        <div key={entry.dataKey} className="flex items-center gap-1.5 leading-tight" style={{ color: entry.color }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: entry.color }} />
          <span>{entry.name}: {entry.value?.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
        </div>
      ))}
    </div>
  );
};

export const GexChart: React.FC<GexChartProps> = ({ data, atmStrike, maxPain, gammaFlip }) => {
  if (!data || data.length === 0) {
    return (
      <div className="terminal-panel h-[280px] flex items-center justify-center">
        <span className="text-terminal-muted text-sm">No GEX data available</span>
      </div>
    );
  }

  // Sample data for performance if too many strikes
  const chartData = data.length > 50 ? data.filter((_, i) => i % 2 === 0) : data;

  return (
    <div className="terminal-panel">
      <div className="terminal-header">GEX by Strike</div>
      <div className="h-[280px] p-2">
        <ResponsiveContainer width="100%" height="100%">
          {/* margin.top increased to 25 so labels have room */}
          <BarChart data={chartData} margin={{ top: 25, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" />
            <XAxis
              dataKey="strike"
              tick={{ fill: '#6b7280', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              tickFormatter={(v) => v.toLocaleString('en-IN')}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: '#6b7280', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              tickFormatter={(v) => (v / 1e6).toFixed(1) + 'M'}
            />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="ce_gex" name="CE GEX" fill="#ef4444" opacity={0.7} />
            <Bar dataKey="pe_gex" name="PE GEX" fill="#22c55e" opacity={0.7} />
            <Bar dataKey="net_gex" name="Net GEX" fill="#3b82f6" opacity={0.5} />

            {/* Labels use insideTop* positions so they render inside chart area, not clipped */}
            {atmStrike && (
              <ReferenceLine 
                x={atmStrike} 
                stroke="#eab308" 
                strokeDasharray="4 4" 
                label={{ value: 'ATM', fill: '#eab308', fontSize: 10, position: 'insideTopLeft' }} 
              />
            )}
            {maxPain && (
              <ReferenceLine 
                x={maxPain} 
                stroke="#d946ef" 
                strokeDasharray="4 4" 
                label={{ value: 'MP', fill: '#d946ef', fontSize: 10, position: 'insideTop' }} 
              />
            )}
            {gammaFlip && (
              <ReferenceLine 
                x={gammaFlip} 
                stroke="#06b6d4" 
                strokeDasharray="4 4" 
                label={{ value: 'GF', fill: '#06b6d4', fontSize: 10, position: 'insideTopRight' }} 
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
