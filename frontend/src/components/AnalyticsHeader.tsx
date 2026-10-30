import React, { useRef } from 'react';
import { ScreenshotButton } from './ScreenshotButton';

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
  ceWall?: number | null;
  peWall?: number | null;
  atmStrike?: number | null;
  timestamp: string;
  isLive: boolean;
  isStale?: boolean;
  isFetching?: boolean;
}

const formatPrice = (value: number | null) =>
  value !== null
    ? value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';

const formatInt = (value: number | null | undefined) =>
  value != null ? value.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—';

const SummaryMetric: React.FC<{
  label: string;
  value: string;
  note: string;
  tone?: 'positive' | 'negative' | 'neutral' | 'call' | 'put';
}> = ({ label, value, note, tone = 'neutral' }) => (
  <div className={`premium-market-metric tone-${tone}`}>
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{note}</small>
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
  ceWall,
  peWall,
  atmStrike,
  timestamp,
  isLive,
  isStale = false,
  isFetching = false,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const tsLabel = timestamp
    ? timestamp.replace(/[:\\s]/g, '-')
    : new Date().toISOString().slice(0, 16).replace('T', '-');
  const screenshotFilename = `${indexName}-market-snapshot-${tsLabel}`;
  const status = isStale ? 'STALE FEED' : isLive ? 'LIVE VERIFIED' : 'SNAPSHOT';
  const spreadValue = futuresSpread !== null
    ? `${futuresSpread >= 0 ? '+' : ''}${futuresSpread.toFixed(2)}`
    : '—';
  const gexTone = netGex == null ? 'neutral' : netGex >= 0 ? 'positive' : 'negative';
  const spreadTone = spreadLabel === 'PREMIUM' ? 'positive' : spreadLabel === 'DISCOUNT' ? 'negative' : 'neutral';

  return (
    <section className="terminal-panel premium-market-card" ref={panelRef} aria-label={`${indexName} market summary`}>
      {isFetching && <div className="premium-sync-line" />}

      <div className="premium-market-heading">
        <div className="premium-market-heading-left">
          <span className="premium-market-eyebrow">MARKET SNAPSHOT</span>
          <strong>{indexName}</strong>
          <span className={`premium-market-status ${isStale ? 'is-stale' : isLive ? 'is-live' : 'is-snapshot'}`}>
            <i />
            {status}
          </span>
          {atmStrike != null && (
            <span className="premium-atm-chip">ATM <b>{formatInt(atmStrike)}</b></span>
          )}
        </div>
        <div className="premium-market-heading-right">
          <span>{timestamp ? new Date(timestamp).toLocaleString('en-IN') : 'Waiting for a market snapshot'}</span>
          <ScreenshotButton targetRef={panelRef} filename={screenshotFilename} />
        </div>
      </div>

      <div className="premium-market-body">
        <div className="premium-price-block">
          <span className="premium-price-label">SPOT INDEX</span>
          <strong>{formatPrice(spot)}</strong>
          <div className="premium-price-context">
            <span>FUTURES <b>{formatPrice(futures)}</b></span>
            <span className="premium-context-divider" />
            <span>BASIS <b className={`tone-${spreadTone}`}>{spreadValue} <i>{spreadLabel || ''}</i></b></span>
          </div>
        </div>

        <div className="premium-market-metrics">
          <SummaryMetric
            label="NET GEX"
            value={formatInt(netGex)}
            note={netGex == null ? 'Exposure unavailable' : netGex >= 0 ? 'Positive gamma' : 'Negative gamma'}
            tone={gexTone}
          />
          <SummaryMetric label="GAMMA FLIP" value={formatInt(gammaFlip)} note="Regime reference" />
          <SummaryMetric label="MAX GEX STRIKE" value={formatInt(maxGexStrike)} note="Peak exposure" />
          <SummaryMetric label="MAX PAIN" value={formatInt(maxPain)} note="Expiry reference" />
          <SummaryMetric label="CALL WALL" value={formatInt(ceWall)} note="Highest call OI" tone="call" />
          <SummaryMetric label="PUT WALL" value={formatInt(peWall)} note="Highest put OI" tone="put" />
        </div>
      </div>
    </section>
  );
};
