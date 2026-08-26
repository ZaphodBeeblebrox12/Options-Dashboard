import React, { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';

interface OptionData {
  strike: number;
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

interface OptionChainProps {
  options: OptionData[];
  spot: number | null;
  futures: number | null;
  maxPain: number | null;
  gammaFlip: number | null;
  fullMode: boolean;
  selectedStrike: number | null;
  onSelectStrike: (strike: number) => void;
}

const OptionChainComponent: React.FC<OptionChainProps> = ({
  options,
  spot,
  futures,
  maxPain,
  gammaFlip,
  fullMode,
  selectedStrike,
  onSelectStrike,
}) => {
  // Group options by strike
  const chainData = useMemo(() => {
    const grouped: Record<number, { CE?: OptionData; PE?: OptionData }> = {};
    options.forEach((opt) => {
      if (!grouped[opt.strike]) grouped[opt.strike] = {};
      grouped[opt.strike][opt.option_type as 'CE' | 'PE'] = opt;
    });
    return Object.entries(grouped)
      .map(([strike, data]) => ({ strike: Number(strike), ...data }))
      .sort((a, b) => a.strike - b.strike);
  }, [options]);

  // Calculate ATM
  const atmSpot = useMemo(() => {
    if (!spot || chainData.length === 0) return null;
    return chainData.reduce((closest, row) =>
      Math.abs(row.strike - spot) < Math.abs(closest.strike - spot) ? row : closest
    ).strike;
  }, [spot, chainData]);

  const atmFutures = useMemo(() => {
    if (!futures || chainData.length === 0) return null;
    return chainData.reduce((closest, row) =>
      Math.abs(row.strike - futures) < Math.abs(closest.strike - futures) ? row : closest
    ).strike;
  }, [futures, chainData]);

  // CE/PE OI ranking — TOP 3
  const ceOiRanks = useMemo(() => {
    const sorted = [...chainData].sort((a, b) => (b.CE?.oi ?? 0) - (a.CE?.oi ?? 0));
    const ranks: Record<number, number> = {};
    sorted.slice(0, 3).forEach((row, i) => { ranks[row.strike] = i + 1; });
    return ranks;
  }, [chainData]);

  const peOiRanks = useMemo(() => {
    const sorted = [...chainData].sort((a, b) => (b.PE?.oi ?? 0) - (a.PE?.oi ?? 0));
    const ranks: Record<number, number> = {};
    sorted.slice(0, 3).forEach((row, i) => { ranks[row.strike] = i + 1; });
    return ranks;
  }, [chainData]);

  // Center view around ATM
  const displayRows = useMemo(() => {
    const center = atmFutures ?? atmSpot;
    if (!center || chainData.length <= 21) return chainData;
    const centerIdx = chainData.findIndex((r) => r.strike === center);
    if (centerIdx < 0) return chainData.slice(0, 21);
    const start = Math.max(0, centerIdx - 10);
    const end = Math.min(chainData.length, centerIdx + 11);
    return chainData.slice(start, end);
  }, [chainData, atmSpot, atmFutures]);

  const fmt = (n: number | undefined | null, digits = 0) => {
    if (n === undefined || n === null) return '—';
    if (digits === 0) return n.toLocaleString('en-IN');
    return n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };

  const getStrikeClass = (strike: number) => {
    const isAtmSpot = strike === atmSpot;
    const isAtmFut = strike === atmFutures;
    const isMaxPain = strike === maxPain;

    if (isAtmSpot && isAtmFut) return 'bg-fuchsia-900/40 text-fuchsia-300 border border-fuchsia-500/50';
    if (isAtmSpot) return 'bg-yellow-900/30 text-yellow-300 border border-yellow-500/40';
    if (isAtmFut) return 'bg-cyan-900/30 text-cyan-300 border border-cyan-500/40';
    if (isMaxPain) return 'border border-fuchsia-500/50';
    return 'text-terminal-text border border-terminal-border/30';
  };

  const getCeOiClass = (strike: number) => {
    const rank = ceOiRanks[strike];
    if (rank === 1) return 'bg-red-800 text-red-100 font-bold shadow-sm shadow-red-900/50';
    if (rank === 2) return 'bg-red-900/40 text-red-300 font-semibold';
    if (rank === 3) return 'bg-red-950/30 text-red-400 font-medium';
    return 'text-terminal-text';
  };

  const getPeOiClass = (strike: number) => {
    const rank = peOiRanks[strike];
    if (rank === 1) return 'bg-green-800 text-green-100 font-bold shadow-sm shadow-green-900/50';
    if (rank === 2) return 'bg-green-900/40 text-green-300 font-semibold';
    if (rank === 3) return 'bg-green-950/30 text-green-400 font-medium';
    return 'text-terminal-text';
  };

  const getGammaFlipClass = (strike: number) => {
    return strike === gammaFlip ? 'border-b-2 border-cyan-500' : '';
  };

  const OiRankBadge = ({ rank }: { rank?: number }) => {
    if (!rank) return null;
    const colors = ['', 'bg-red-600', 'bg-red-500/70', 'bg-red-400/50'];
    const textColors = ['', 'text-white', 'text-red-100', 'text-red-200'];
    return (
      <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold ml-1 ${colors[rank]} ${textColors[rank]}`}>
        {rank}
      </span>
    );
  };

  const PeOiRankBadge = ({ rank }: { rank?: number }) => {
    if (!rank) return null;
    const colors = ['', 'bg-green-600', 'bg-green-500/70', 'bg-green-400/50'];
    const textColors = ['', 'text-white', 'text-green-100', 'text-green-200'];
    return (
      <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold mr-1 ${colors[rank]} ${textColors[rank]}`}>
        {rank}
      </span>
    );
  };

  // Empty state
  if (chainData.length === 0) {
    return (
      <div className="terminal-panel overflow-hidden">
        <div className="terminal-header flex items-center justify-between">
          <span>Option Chain</span>
        </div>
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <AlertTriangle className="w-8 h-8 text-terminal-muted mb-3" />
          <p className="text-sm font-mono text-terminal-muted mb-1">No option data available</p>
          <p className="text-xs font-mono text-terminal-muted/60">
            Waiting for live market data from Angel One...
          </p>
          <p className="text-xs font-mono text-terminal-muted/60 mt-1">
            Ensure backend/.env has valid API_KEY, CLIENT_CODE, PASSWORD, TOTP_SECRET
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-panel overflow-hidden">
      <div className="terminal-header flex items-center justify-between">
        <span>Option Chain</span>
        <div className="flex gap-4 text-[10px]">
          <div className="flex items-center gap-1.5">
            <span className="w-5 h-4 rounded bg-red-800 text-white text-[8px] flex items-center justify-center font-bold">1</span>
            <span className="w-5 h-4 rounded bg-red-900/40 text-red-300 text-[8px] flex items-center justify-center font-semibold">2</span>
            <span className="w-5 h-4 rounded bg-red-950/30 text-red-400 text-[8px] flex items-center justify-center">3</span>
            <span className="text-terminal-muted">CE OI</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-5 h-4 rounded bg-green-800 text-white text-[8px] flex items-center justify-center font-bold">1</span>
            <span className="w-5 h-4 rounded bg-green-900/40 text-green-300 text-[8px] flex items-center justify-center font-semibold">2</span>
            <span className="w-5 h-4 rounded bg-green-950/30 text-green-400 text-[8px] flex items-center justify-center">3</span>
            <span className="text-terminal-muted">PE OI</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-yellow-500/40" />
            <span className="text-terminal-muted">ATM Spot</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-cyan-500/40" />
            <span className="text-terminal-muted">ATM Fut</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-fuchsia-500/40" />
            <span className="text-terminal-muted">Max Pain</span>
          </div>
        </div>
      </div>

      {/* Header */}
      <div className="grid grid-cols-[1fr_80px_1fr] gap-0 text-[10px] font-mono text-terminal-muted border-b border-terminal-border bg-terminal-bg/50">
        <div className="grid" style={{ gridTemplateColumns: fullMode ? 'repeat(7, 1fr)' : 'repeat(4, 1fr)' }}>
          <div className="px-2 py-1.5 text-center">OI</div>
          <div className="px-2 py-1.5 text-center">Chg</div>
          <div className="px-2 py-1.5 text-center">Vol</div>
          <div className="px-2 py-1.5 text-center">LTP</div>
          {fullMode && <><div className="px-2 py-1.5 text-center">IV</div><div className="px-2 py-1.5 text-center">Δ</div><div className="px-2 py-1.5 text-center">Γ</div></>}
        </div>
        <div className="px-2 py-1.5 text-center font-bold">STRIKE</div>
        <div className="grid" style={{ gridTemplateColumns: fullMode ? 'repeat(7, 1fr)' : 'repeat(4, 1fr)' }}>
          <div className="px-2 py-1.5 text-center">LTP</div>
          <div className="px-2 py-1.5 text-center">Vol</div>
          <div className="px-2 py-1.5 text-center">Chg</div>
          <div className="px-2 py-1.5 text-center">OI</div>
          {fullMode && <><div className="px-2 py-1.5 text-center">Γ</div><div className="px-2 py-1.5 text-center">Δ</div><div className="px-2 py-1.5 text-center">IV</div></>}
        </div>
      </div>

      {/* Rows */}
      <div className="max-h-[500px] overflow-y-auto">
        {displayRows.map((row) => {
          const ce = row.CE;
          const pe = row.PE;
          const isSelected = row.strike === selectedStrike;
          const ceRank = ceOiRanks[row.strike];
          const peRank = peOiRanks[row.strike];

          return (
            <div
              key={row.strike}
              onClick={() => onSelectStrike(row.strike)}
              className={`grid grid-cols-[1fr_80px_1fr] gap-0 text-xs font-mono cursor-pointer transition-colors hover:bg-white/5 ${
                isSelected ? 'bg-white/10' : ''
              } ${getGammaFlipClass(row.strike)}`}
            >
              {/* CE Side */}
              <div className={`grid ${fullMode ? 'grid-cols-7' : 'grid-cols-4'} gap-0`}>
                <div className={`px-2 py-1 text-right flex items-center justify-end ${getCeOiClass(row.strike)}`}>
                  <span>{fmt(ce?.oi)}</span>
                  <OiRankBadge rank={ceRank} />
                </div>
                <div className={`px-2 py-1 text-right ${(ce?.oi_change ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {(ce?.oi_change ?? 0) > 0 ? '+' : ''}{fmt(ce?.oi_change)}
                </div>
                <div className="px-2 py-1 text-right text-terminal-muted">{fmt(ce?.volume)}</div>
                <div className="px-2 py-1 text-right text-terminal-ce font-semibold">{fmt(ce?.ltp, 2)}</div>
                {fullMode && (
                  <>
                    <div className="px-2 py-1 text-right text-terminal-muted">{fmt(ce?.iv, 1)}</div>
                    <div className="px-2 py-1 text-right text-terminal-muted">{fmt(ce?.delta, 3)}</div>
                    <div className="px-2 py-1 text-right text-terminal-muted">{fmt(ce?.gamma, 4)}</div>
                  </>
                )}
              </div>

              {/* Strike */}
              <div className={`px-2 py-1 text-center font-bold text-sm ${getStrikeClass(row.strike)}`}>
                {row.strike.toLocaleString('en-IN')}
              </div>

              {/* PE Side */}
              <div className={`grid ${fullMode ? 'grid-cols-7' : 'grid-cols-4'} gap-0`}>
                <div className="px-2 py-1 text-left text-terminal-pe font-semibold">{fmt(pe?.ltp, 2)}</div>
                <div className="px-2 py-1 text-left text-terminal-muted">{fmt(pe?.volume)}</div>
                <div className={`px-2 py-1 text-left ${(pe?.oi_change ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {(pe?.oi_change ?? 0) > 0 ? '+' : ''}{fmt(pe?.oi_change)}
                </div>
                <div className={`px-2 py-1 text-left flex items-center ${getPeOiClass(row.strike)}`}>
                  <PeOiRankBadge rank={peRank} />
                  <span>{fmt(pe?.oi)}</span>
                </div>
                {fullMode && (
                  <>
                    <div className="px-2 py-1 text-left text-terminal-muted">{fmt(pe?.gamma, 4)}</div>
                    <div className="px-2 py-1 text-left text-terminal-muted">{fmt(pe?.delta, 3)}</div>
                    <div className="px-2 py-1 text-left text-terminal-muted">{fmt(pe?.iv, 1)}</div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const OptionChain = React.memo(OptionChainComponent);
