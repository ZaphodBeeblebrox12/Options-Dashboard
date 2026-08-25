import React from 'react';
import { Activity, TrendingUp, BarChart3, Crosshair, Zap, Layers } from 'lucide-react';

interface AnalyticsHeaderProps {
  spot: number | null;
  futures: number | null;
  futuresSpread: number | null;
  spreadLabel: string | null;
  netGex: number | null;
  maxGexStrike: number | null;
  maxPain: number | null;
  gammaFlip: number | null;
  timestamp: string;
  isLive: boolean;
}

const MetricCard: React.FC<{
  label: string;
  value: string | number;
  subValue?: string;
  icon: React.ReactNode;
  color?: string;
}> = ({ label, value, subValue, icon, color = 'text-terminal-text' }) => (
  <div className="flex items-center gap-3 px-4 py-2 border-r border-terminal-border last:border-r-0 min-w-[160px]">
    <div className={`${color} opacity-60`}>{icon}</div>
    <div>
      <div className="text-[10px] font-mono uppercase tracking-wider text-terminal-muted">{label}</div>
      <div className={`font-mono font-bold text-lg ${color}`}>{value}</div>
      {subValue && <div className="text-[10px] font-mono text-terminal-muted">{subValue}</div>}
    </div>
  </div>
);

export const AnalyticsHeader: React.FC<AnalyticsHeaderProps> = ({
  spot,
  futures,
  futuresSpread,
  spreadLabel,
  netGex,
  maxGexStrike,
  maxPain,
  gammaFlip,
  timestamp,
  isLive,
}) => {
  const formatPrice = (p: number | null) => p !== null ? p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  const formatInt = (n: number | null) => n !== null ? n.toLocaleString('en-IN') : '—';

  const spreadColor = spreadLabel === 'PREMIUM' ? 'text-terminal-pe' : spreadLabel === 'DISCOUNT' ? 'text-terminal-ce' : 'text-terminal-muted';
  const gexColor = (netGex ?? 0) >= 0 ? 'text-terminal-pe' : 'text-terminal-ce';

  return (
    <div className="terminal-panel">
      <div className="flex items-center justify-between px-4 py-2 border-b border-terminal-border">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-terminal-atm" />
          <span className="text-sm font-semibold tracking-wide">NIFTY 50</span>
          {isLive && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-terminal-pe">
              <span className="w-1.5 h-1.5 rounded-full bg-terminal-pe animate-pulse" />
              LIVE
            </span>
          )}
        </div>
        <div className="text-[10px] font-mono text-terminal-muted">
          {timestamp ? new Date(timestamp).toLocaleString('en-IN') : '—'}
        </div>
      </div>
      <div className="flex flex-wrap items-center">
        <MetricCard label="SPOT" value={formatPrice(spot)} icon={<TrendingUp className="w-4 h-4" />} color="text-terminal-atm" />
        <MetricCard label="FUTURES" value={formatPrice(futures)} icon={<BarChart3 className="w-4 h-4" />} color="text-terminal-futures" />
        <MetricCard 
          label="SPREAD" 
          value={futuresSpread !== null ? `${futuresSpread >= 0 ? '+' : ''}${futuresSpread.toFixed(2)}` : '—'} 
          subValue={spreadLabel || ''}
          icon={<Layers className="w-4 h-4" />} 
          color={spreadColor}
        />
        <MetricCard label="NET GEX" value={formatInt(netGex)} icon={<Zap className="w-4 h-4" />} color={gexColor} />
        <MetricCard label="MAX GEX" value={formatInt(maxGexStrike)} icon={<Crosshair className="w-4 h-4" />} color="text-terminal-maxpain" />
        <MetricCard label="MAX PAIN" value={formatInt(maxPain)} icon={<Crosshair className="w-4 h-4" />} color="text-terminal-maxpain" />
        <MetricCard label="GAMMA FLIP" value={formatInt(gammaFlip)} icon={<Zap className="w-4 h-4" />} color="text-terminal-gammaflip" />
      </div>
    </div>
  );
};
