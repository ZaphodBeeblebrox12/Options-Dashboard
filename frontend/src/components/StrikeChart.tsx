import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

interface StrikeHistoryPoint {
  timestamp: string;
  option_type: string;
  oi: number;
  oi_change: number;
  volume: number;
  ltp: number;
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  gex?: number;
}

interface StrikeChartProps {
  data: StrikeHistoryPoint[];
  strike: number;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload) return null;
  return (
    <div className="bg-terminal-panel/80 backdrop-blur-sm border border-terminal-border/50 rounded px-2 py-1 text-[10px] font-mono shadow-lg pointer-events-none">
      <div className="font-bold text-terminal-text">{label}</div>
      {payload.map((entry: any) => (
        <div key={entry.dataKey} className="flex items-center gap-1.5 leading-tight" style={{ color: entry.color }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: entry.color }} />
          <span>{entry.name}: {entry.value?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
        </div>
      ))}
    </div>
  );
};

export const StrikeChart: React.FC<StrikeChartProps> = ({ data, strike }) => {
  const chartData = useMemo(() => {
    // Group by timestamp, split CE/PE
    const grouped: Record<string, any> = {};
    data.forEach((point) => {
      const time = point.timestamp.split(' ')[1] || point.timestamp;
      if (!grouped[time]) grouped[time] = { time };
      if (point.option_type === 'CE') {
        grouped[time].ce_ltp = point.ltp;
        grouped[time].ce_oi = point.oi;
        grouped[time].ce_gamma = point.gamma;
      } else {
        grouped[time].pe_ltp = point.ltp;
        grouped[time].pe_oi = point.oi;
        grouped[time].pe_gamma = point.gamma;
      }
    });
    return Object.values(grouped);
  }, [data]);

  if (chartData.length === 0) {
    return (
      <div className="terminal-panel h-[200px] flex items-center justify-center">
        <span className="text-terminal-muted text-sm">Select a strike to view history</span>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">Strike {strike.toLocaleString('en-IN')} — Time Series</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 p-2">
        {/* LTP Chart */}
        <div className="h-[180px]">
          <div className="text-[10px] font-mono text-terminal-muted mb-1 text-center">LTP</div>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" />
              <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 9, fontFamily: 'JetBrains Mono' }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: '#6b7280', fontSize: 9, fontFamily: 'JetBrains Mono' }} width={50} />
              <Tooltip content={<CustomTooltip />} cursor={{ stroke: "rgba(234,179,8,0.4)", strokeWidth: 1, strokeDasharray: "4 4" }} />
              <Line type="monotone" dataKey="ce_ltp" name="CE LTP" stroke="#ef4444" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="pe_ltp" name="PE LTP" stroke="#22c55e" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* OI Chart */}
        <div className="h-[180px]">
          <div className="text-[10px] font-mono text-terminal-muted mb-1 text-center">Open Interest</div>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" />
              <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 9, fontFamily: 'JetBrains Mono' }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: '#6b7280', fontSize: 9, fontFamily: 'JetBrains Mono' }} width={50} tickFormatter={(v) => (v / 1000).toFixed(0) + 'K'} />
              <Tooltip content={<CustomTooltip />} cursor={{ stroke: "rgba(234,179,8,0.4)", strokeWidth: 1, strokeDasharray: "4 4" }} />
              <Line type="monotone" dataKey="ce_oi" name="CE OI" stroke="#ef4444" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="pe_oi" name="PE OI" stroke="#22c55e" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Gamma Chart */}
        <div className="h-[180px]">
          <div className="text-[10px] font-mono text-terminal-muted mb-1 text-center">Gamma</div>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" />
              <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 9, fontFamily: 'JetBrains Mono' }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: '#6b7280', fontSize: 9, fontFamily: 'JetBrains Mono' }} width={50} />
              <Tooltip content={<CustomTooltip />} cursor={{ stroke: "rgba(234,179,8,0.4)", strokeWidth: 1, strokeDasharray: "4 4" }} />
              <Line type="monotone" dataKey="ce_gamma" name="CE Γ" stroke="#ef4444" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="pe_gamma" name="PE Γ" stroke="#22c55e" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};
