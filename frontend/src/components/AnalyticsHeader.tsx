import React from 'react';
import { Activity, TrendingUp, BarChart3, Crosshair, Zap, Layers } from 'lucide-react';

interface AnalyticsHeaderProps {
  indexName: string;
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
  isFetching?: boolean;
}

const MetricCard: React.FC<{
  label: string;
  value: string | number;
  subValue?: string;
  icon: React.ReactNode;
  color?: string;
}> = ({ label, value, subValue, icon, color = 'text-terminal-text' }) => (
  <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-4 py-1.5 sm:py-2 sm:border-r sm:border-terminal-border last:sm:border-r-0 sm:min-w-[160px]">
    <div className={`hidden sm:block ${color} opacity-60 shrink-0`}>{icon}</div>
    <div className="min-w-0">
      <div className="text-[9px] sm:text-[10px] font-mono uppercase tracking-wider text-terminal-muted">{label}</div>
      <div className={`font-mono font-bold text-base sm:text-lg ${color}`}>{value}</div>
      {subValue && <div className="text-[9px] sm:text-[10px] font-mono text-terminal-muted">{subValue}</div>}
    </div>
  </div>
);

export const AnalyticsHeader: React.FC<AnalyticsHeaderProps> = ({
  indexName,
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
  isFetching,
}) => {
  const formatPrice = (p: number | null) => p !== null ? p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  const formatInt = (n: number | null) => n !== null ? n.toLocaleString('en-IN') : '—';

  const spreadColor = spreadLabel === 'PREMIUM' 
    ? 'text-terminal-pe' 
    : spreadLabel === 'DISCOUNT' 
    ? 'text-terminal-ce' 
    : 'text-terminal-muted';
  const gexColor = (netGex ?? 0) >= 0 ? 'text-terminal-pe' : 'text-terminal-ce';

  return (
    <div className="terminal-panel relative overflow-hidden">
      {/* Subtle sweep bar — indicates data is being fetched */}
      {isFetching && (
        <div
          className="absolute top-0 left-0 right-0 h-[2px] z-10"
          style={{
            background: 'linear-gradient(90deg, transparent 0%, #eab308 50%, transparent 100%)',
            animation: 'sweep 1.2s ease-in-out infinite',
          }}
        />
      )}

      <div className="flex items-center justify-between px-3 sm:px-4 py-2 border-b border-terminal-border">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 sm:w-4 sm:h-4 text-terminal-atm" />
          <span className="text-sm font-semibold tracking-wide">{indexName}</span>
          {isLive && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-terminal-pe">
              <span className="w-1.5 h-1.5 rounded-full bg-terminal-pe animate-pulse" />
              LIVE
            </span>
          )}
          {isFetching && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-terminal-atm/70">
              <span className="w-1 h-1 rounded-full bg-terminal-atm animate-pulse" />
              syncing
            </span>
          )}
        </div>
        <div className={`text-[10px] font-mono transition-opacity duration-300 ${isFetching ? 'opacity-40' : 'opacity-100 text-terminal-muted'}`}>
          {timestamp ? new Date(timestamp).toLocaleString('en-IN') : '—'}
        </div>
      </div>

      {/* Desktop: flex row (unchanged). Mobile: 2-column grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:flex lg:flex-wrap lg:items-center">
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

      {/* CSS keyframe for sweep animation */}
      <style>{`
        @keyframes sweep {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
};
