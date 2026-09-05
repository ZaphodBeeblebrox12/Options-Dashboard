import React from 'react';
import { ArrowRight, Zap } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';

export interface TierChangeTarget {
  symbol: string;
  kind: string; // INDEX | STOCK | COMMODITY
  currentTier?: number;
}

const KIND_META: Record<string, { label: string; cls: string }> = {
  INDEX: { label: 'Index', cls: 'bg-terminal-atm/20 text-terminal-atm' },
  STOCK: { label: 'Stock', cls: 'bg-terminal-pe/20 text-terminal-pe' },
  COMMODITY: { label: 'Commodity', cls: 'bg-cyan-500/20 text-cyan-400' },
};

const TIER_DESC: Record<number, { title: string; desc: string; bar: string; badge: string }> = {
  1: {
    title: 'Tier 1 — Full / high-priority analytics',
    desc: 'Full option chain streamed · 5-second updates · sacred capacity that is never auto-evicted.',
    bar: 'bg-terminal-atm', badge: 'bg-terminal-atm/20 text-terminal-atm',
  },
  2: {
    title: 'Tier 2 — Full analytics',
    desc: '±20-strike window around the live ATM · full Greeks/GEX every 30s · eligible for capacity eviction when tokens run out.',
    bar: 'bg-terminal-pe', badge: 'bg-terminal-pe/20 text-terminal-pe',
  },
  3: {
    title: 'Tier 3 — Lightweight scanner',
    desc: 'Walls monitored continuously on a narrow, configurable window · full Greeks/GEX computed only when a wall touch is confirmed.',
    bar: 'bg-cyan-500', badge: 'bg-cyan-500/20 text-cyan-400',
  },
};

interface TierChangeDialogProps {
  open: boolean;
  /** One instrument (single move) or many (batch move). */
  instruments: TierChangeTarget[];
  /** Common current tier, or 'mixed' when the batch spans tiers. */
  currentTier: number | 'mixed';
  targetTier: number;
  onClose: () => void;
  onConfirm: () => void | false | Promise<void | false>;
  /** Backend/action error shown inside the dialog while open. */
  error?: string | null;
}

/**
 * Confirmation for tier moves (1↔2↔3), single or batch. Built on
 * ConfirmDialog; shows the transition and what the new tier means.
 * Applies immediately, no restart — surfaced explicitly in the copy.
 */
export const TierChangeDialog: React.FC<TierChangeDialogProps> = ({
  open,
  instruments,
  currentTier,
  targetTier,
  onClose,
  onConfirm,
  error,
}) => {
  const t = TIER_DESC[targetTier] ?? TIER_DESC[2];
  const batch = instruments.length > 1;

  // Kind breakdown for the batch summary, e.g. "4 Stocks · 1 Commodity"
  const kindCounts = instruments.reduce<Record<string, number>>((acc, i) => {
    const k = (i.kind || 'STOCK').toUpperCase();
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const kindSummary = Object.entries(kindCounts)
    .map(([k, n]) => `${n} ${KIND_META[k]?.label ?? k}${n > 1 ? 's' : ''}`)
    .join(' · ');

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={batch ? `Change tier — ${instruments.length} instruments` : 'Change tier'}
      confirmLabel={batch ? `Move ${instruments.length} to Tier ${targetTier}` : `Move to Tier ${targetTier}`}
      onConfirm={onConfirm}
      error={error}
    >
      {/* Instrument identity */}
      {batch ? (
        <div className="mb-4">
          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto terminal-scroll">
            {instruments.slice(0, 24).map((i) => {
              const k = KIND_META[(i.kind || 'STOCK').toUpperCase()] ?? KIND_META.STOCK;
              return (
                <span key={i.symbol} className={`px-2 py-0.5 rounded-full text-[11px] font-mono font-medium ${k.cls}`}>
                  {i.symbol}
                </span>
              );
            })}
            {instruments.length > 24 && (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-mono text-terminal-muted">
                +{instruments.length - 24} more
              </span>
            )}
          </div>
          <div className="mt-1.5 text-[11.5px] font-mono text-terminal-muted">{kindSummary}</div>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-4">
          <span className="font-mono font-semibold text-[15px] tracking-wide text-terminal-text">
            {instruments[0]?.symbol}
          </span>
          <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${KIND_META[(instruments[0]?.kind || 'STOCK').toUpperCase()]?.cls ?? KIND_META.STOCK.cls}`}>
            {KIND_META[(instruments[0]?.kind || 'STOCK').toUpperCase()]?.label ?? 'Stock'}
          </span>
        </div>
      )}

      {/* Tier transition */}
      <div className="flex items-center gap-3 mb-4">
        <span className="px-3 py-1.5 rounded-lg border border-terminal-border text-[13px] font-mono font-semibold text-terminal-muted">
          {currentTier === 'mixed' ? 'Mixed tiers' : `Tier ${currentTier}`}
        </span>
        <ArrowRight className="w-4 h-4 text-terminal-muted shrink-0" />
        <span className={`px-3 py-1.5 rounded-lg text-[13px] font-mono font-bold ${t.badge}`}>
          Tier {targetTier}
        </span>
      </div>

      {/* What the new tier means */}
      <div className="relative border border-terminal-border rounded-lg px-3.5 py-3 mb-4 bg-terminal-bg">
        <span className={`absolute left-0 top-2 bottom-2 w-1 rounded-full ${t.bar}`} />
        <div className="pl-2">
          <div className="text-[13px] font-semibold text-terminal-text mb-1">{t.title}</div>
          <div className="text-[12.5px] leading-relaxed text-[var(--st-text-3,#8d97ab)]">{t.desc}</div>
        </div>
      </div>

      {/* Immediacy */}
      <div className="flex items-start gap-2 text-[12.5px] text-terminal-muted">
        <Zap className="w-3.5 h-3.5 mt-0.5 shrink-0 text-terminal-pe" />
        <span>
          {batch
            ? `Each instrument is re-allocated as it processes — some may move before others if a request fails. `
            : 'Applies immediately — subscriptions are re-allocated live. '}
          <span className="text-terminal-text font-medium">No restart required.</span>
        </span>
      </div>
    </ConfirmDialog>
  );
};
