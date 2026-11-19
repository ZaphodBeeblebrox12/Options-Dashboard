import React, { useRef } from 'react';
import { TrendingUp, Crosshair, Zap, Layers, WifiOff } from 'lucide-react';
import { ScreenshotButton } from './ScreenshotButton';

interface AnalyticsHeaderProps {
  indexName: string;
  spot: number | null;
  futuresSpread: number | null;
  spreadLabel: string | null;
  maxGexStrike: number | null;
  maxPain: number | null;
  gammaFlip: number | null;
  timestamp: string;
  isLive: boolean;
  isStale?: boolean;
  isFetching?: boolean;
  children?: React.ReactNode;
}

const MetricCard: React.FC<{
  label: string;
  value: string | number;
  subValue?: string;
  icon: React.ReactNode;
  color?: string;
}> = ({ label, value, subValue, icon, color = 'text-terminal-text' }) => (
  <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 sm:gap-2 sm:px-3 sm:py-2 xl:min-w-0 xl:border-r xl:border-terminal-border">
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
  futuresSpread,
  spreadLabel,
  maxGexStrike,
  maxPain,
  gammaFlip,
  timestamp,
  isStale = false,
  isFetching,
  children,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);

  const formatPrice = (p: number | null) => p !== null ? p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  const formatInt = (n: number | null) => n !== null ? n.toLocaleString('en-IN') : '—';

  const spreadColor = spreadLabel === 'PREMIUM'
    ? 'text-terminal-pe'
    : spreadLabel === 'DISCOUNT'
    ? 'text-terminal-ce'
    : 'text-terminal-muted';

  const tsLabel = timestamp ? timestamp.replace(/[:\s]/g, '-') : new Date().toISOString().slice(0,16).replace(/T/g,'-');
  const screenshotFilename = `${indexName}-analytics-${tsLabel}`;

  return (
    <div className="terminal-panel relative min-w-0 overflow-hidden" ref={panelRef}>
      {isFetching && (
        <div
          className="absolute top-0 left-0 right-0 h-[2px] z-10"
          style={{
            background: 'linear-gradient(90deg, transparent 0%, #eab308 50%, transparent 100%)',
            animation: 'sweep 1.2s ease-in-out infinite',
          }}
        />
      )}

      <div className="flex flex-col xl:flex-row xl:items-center">
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:flex xl:flex-[1.05] xl:flex-nowrap xl:items-center xl:min-w-0">
          <MetricCard label="SPOT" value={formatPrice(spot)} icon={<TrendingUp className="w-4 h-4" />} color="text-terminal-atm" />
          <MetricCard
            label="SPREAD"
            value={futuresSpread !== null ? `${futuresSpread >= 0 ? '+' : ''}${futuresSpread.toFixed(2)}` : '—'}
            subValue={spreadLabel || ''}
            icon={<Layers className="w-4 h-4" />}
            color={spreadColor}
          />
          <MetricCard label="MAX GEX" value={formatInt(maxGexStrike)} icon={<Crosshair className="w-4 h-4" />} color="text-terminal-maxpain" />
          <MetricCard label="MAX PAIN" value={formatInt(maxPain)} icon={<Crosshair className="w-4 h-4" />} color="text-terminal-maxpain" />
          <MetricCard label="GAMMA FLIP" value={formatInt(gammaFlip)} icon={<Zap className="w-4 h-4" />} color="text-terminal-gammaflip" />
        </div>

        {children && (
          <div className="flex min-w-0 border-t border-terminal-border xl:min-w-[500px] xl:flex-[0.95] xl:border-l xl:border-t-0">
            <div className="min-w-0 flex-1">
              {children}
            </div>
          </div>
        )}

        <div className="flex shrink-0 items-center justify-end gap-2 px-2 py-1 xl:self-stretch xl:border-l xl:border-terminal-border">
          {isStale ? (
            <span
              className="flex items-center gap-1 text-[10px] font-mono text-amber-400"
              title="Live feed unavailable or stale — do not treat these values as current market data."
            >
              <WifiOff className="w-3 h-3" />
              STALE
            </span>
          ) : null}
          {isFetching && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-terminal-atm/70">
              <span className="w-1 h-1 rounded-full bg-terminal-atm animate-pulse" />
              syncing
            </span>
          )}
          <ScreenshotButton targetRef={panelRef} filename={screenshotFilename} />
        </div>
      </div>

      <style>{`
        @keyframes sweep {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
};
