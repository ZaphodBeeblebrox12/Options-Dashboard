import React, { useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

interface GexPoint {
  timestamp: string;
  net_gex: number;
}

interface NetGexChartProps {
  data: GexPoint[];
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload) return null;
  return (
    <div className="bg-terminal-panel/80 backdrop-blur-sm border border-terminal-border/50 rounded px-2 py-1 text-[10px] font-mono shadow-lg pointer-events-none">
      <div className="font-bold text-terminal-text">{label}</div>
      <div className="text-terminal-pe leading-tight">
        Net GEX: {payload[0]?.value?.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
      </div>
    </div>
  );
};

const NetGexChartComponent: React.FC<NetGexChartProps> = ({ data }) => {
  if (!data || data.length === 0) {
    return (
      <div className="terminal-panel h-[200px] flex items-center justify-center">
        <span className="text-terminal-muted text-sm">No GEX history available</span>
      </div>
    );
  }

  const chartData = useMemo(() =>
    data.map((d) => ({
      time: d.timestamp.split(' ')[1] || d.timestamp,
      net_gex: d.net_gex,
    })),
  [data]);

  return (
    <div className="terminal-panel">
      <div className="terminal-header">Net GEX — Full Trading Day</div>
      <div className="h-[200px] p-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gexGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" />
            <XAxis
              dataKey="time"
              tick={{ fill: '#6b7280', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: '#6b7280', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              tickFormatter={(v) => (v / 1e6).toFixed(1) + 'M'}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="3 3" />
            <Area
              type="monotone"
              dataKey="net_gex"
              stroke="#3b82f6"
              strokeWidth={2}
              fill="url(#gexGradient)"
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export const NetGexChart = React.memo(NetGexChartComponent);
