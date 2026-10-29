import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BellRing, BellOff, Loader2 } from 'lucide-react';

type Side = 'CE' | 'PE';
interface OptionRow { strike: number; option_type: Side; oi: number; }
interface WallWatch {
  symbol: string;
  side: Side;
  armed: boolean;
  watched_strike: number | null;
  last_wall_strike: number | null;
  new_wall_strike: number | null;
  last_event: 'moved' | 'vacated' | null;
  last_triggered_at: string | null;
}
interface Props {
  symbol: string;
  spot: number | null;
  options: unknown;
  canArm: boolean;
}

const EMPTY_WATCH = (symbol: string, side: Side): WallWatch => ({
  symbol, side, armed: false, watched_strike: null, last_wall_strike: null,
  new_wall_strike: null, last_event: null, last_triggered_at: null,
});

function normalizeOptions(input: unknown): OptionRow[] {
  const rows: OptionRow[] = [];
  const add = (strikeValue: unknown, sideValue: unknown, contract: any) => {
    const strike = Number(contract?.strike ?? strikeValue);
    const side = String(contract?.option_type ?? sideValue ?? '').toUpperCase();
    const oi = Number(contract?.oi ?? 0);
    if (Number.isFinite(strike) && (side === 'CE' || side === 'PE')) {
      rows.push({ strike, option_type: side, oi: Number.isFinite(oi) ? oi : 0 });
    }
  };
  if (Array.isArray(input)) {
    input.forEach((option: any) => add(option?.strike, option?.option_type, option));
  } else if (input && typeof input === 'object') {
    Object.entries(input as Record<string, any>).forEach(([strike, contracts]) => {
      if (!contracts || typeof contracts !== 'object') return;
      if (contracts.option_type) {
        add(contracts.strike ?? strike, contracts.option_type, contracts);
      } else {
        (['CE', 'PE'] as Side[]).forEach(side => {
          if (contracts[side]) add(contracts[side].strike ?? strike, side, contracts[side]);
        });
      }
    });
  }
  return rows;
}

function findWalls(options: unknown, spot: number | null): Record<Side, number | null> {
  const rows = normalizeOptions(options);
  const walls: Record<Side, number | null> = { CE: null, PE: null };
  (['CE', 'PE'] as Side[]).forEach(side => {
    const eligible = rows.filter(row => row.option_type === side && (
      spot == null || (side === 'CE' ? row.strike >= spot : row.strike <= spot)
    ));
    eligible.sort((a, b) => b.oi - a.oi || a.strike - b.strike);
    if (eligible.length) walls[side] = eligible[0].strike;
  });
  return walls;
}

function fmtStrike(strike: number | null | undefined): string {
  if (strike == null || !Number.isFinite(Number(strike))) return '—';
  return Number(strike).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export const WallWatchControls: React.FC<Props> = ({ symbol, spot, options, canArm }) => {
  const [watches, setWatches] = useState<Record<Side, WallWatch>>({
    CE: EMPTY_WATCH(symbol, 'CE'),
    PE: EMPTY_WATCH(symbol, 'PE'),
  });
  const [busy, setBusy] = useState<Side | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const walls = useMemo(() => findWalls(options, spot), [options, spot]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/wall-watches?index=${encodeURIComponent(symbol)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || 'Could not load wall watches');
      setWatches({
        CE: payload.watches?.CE ?? EMPTY_WATCH(symbol, 'CE'),
        PE: payload.watches?.PE ?? EMPTY_WATCH(symbol, 'PE'),
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load wall watches');
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    let alive = true;
    const run = async () => { if (alive) await refresh(); };
    void run();
    const timer = window.setInterval(() => { void run(); }, 4000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [refresh]);

  const toggle = async (side: Side) => {
    const watch = watches[side];
    setBusy(side);
    setError(null);
    try {
      const action = watch.armed ? 'disarm' : 'arm';
      const response = await fetch(
        `/api/wall-watches/${encodeURIComponent(symbol)}/${side}/${action}`,
        { method: 'POST' }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `Could not ${action} wall watch`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wall watch update failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="terminal-panel overflow-hidden" aria-label="Manual wall-departure alerts">
      <div className="terminal-header flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs sm:text-sm flex items-center gap-2">
          <BellRing className="w-3.5 h-3.5 text-terminal-atm" />
          Wall Departure Alerts
        </span>
        <span className="text-[9px] sm:text-[10px] font-mono text-terminal-muted">
          Manual · one-shot · disarmed by default
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2">
        {(['CE', 'PE'] as Side[]).map(side => {
          const watch = watches[side] ?? EMPTY_WATCH(symbol, side);
          const currentWall = walls[side];
          const label = side === 'CE' ? 'Call Wall' : 'Put Wall';
          const isBusy = busy === side;
          return (
            <div key={side} className={`rounded border p-2.5 min-w-0 ${watch.armed ? 'border-amber-500/60 bg-amber-500/[0.06]' : 'border-terminal-border/60 bg-terminal-bg/30'}`}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs font-semibold text-terminal-text">{label}</span>
                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${watch.armed ? 'bg-amber-500/15 text-amber-300' : 'bg-terminal-border/50 text-terminal-muted'}`}>
                  {watch.armed ? 'ARMED' : 'DISARMED'}
                </span>
              </div>
              <div className="flex justify-between gap-2 text-[10px] font-mono mb-1">
                <span className="text-terminal-muted">Current wall</span>
                <span className="text-terminal-text font-semibold">{fmtStrike(currentWall)}</span>
              </div>
              {watch.armed && (
                <div className="flex justify-between gap-2 text-[10px] font-mono mb-1">
                  <span className="text-amber-300">Watching strike</span>
                  <span className="text-amber-200 font-semibold">{fmtStrike(watch.watched_strike)}</span>
                </div>
              )}
              {!watch.armed && watch.last_event && watch.watched_strike != null && (
                <p className="text-[9px] font-mono text-terminal-muted mb-1">
                  Last: {watch.last_event === 'vacated'
                    ? `${fmtStrike(watch.watched_strike)} vacated`
                    : `${fmtStrike(watch.watched_strike)} → ${fmtStrike(watch.new_wall_strike)}`}
                </p>
              )}
              <button
                type="button"
                onClick={() => void toggle(side)}
                disabled={isBusy || loading || (!watch.armed && (!canArm || currentWall == null))}
                className={`mt-2 w-full rounded px-2 py-1.5 text-[10px] font-mono font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${watch.armed ? 'bg-amber-500/15 text-amber-200 hover:bg-amber-500/25' : 'bg-terminal-border/50 text-terminal-text hover:bg-terminal-border'}`}
                aria-label={watch.armed ? `Disarm ${label} alert` : `Arm ${label} alert`}
              >
                {isBusy ? <Loader2 className="w-3 h-3 inline animate-spin mr-1" /> : watch.armed ? <BellOff className="w-3 h-3 inline mr-1" /> : <BellRing className="w-3 h-3 inline mr-1" />}
                {isBusy ? 'SAVING…' : watch.armed ? 'DISARM WATCH' : currentWall == null ? 'NO WALL TO ARM' : `ARM AT ${fmtStrike(currentWall)}`}
              </button>
            </div>
          );
        })}
      </div>
      {!canArm && (
        <p className="px-3 pb-2 text-[10px] font-mono text-terminal-muted">
          Switch to the live, open-market feed to arm a wall. Existing watches can still be disarmed.
        </p>
      )}
      {error && <p role="status" className="px-3 pb-2 text-[10px] font-mono text-amber-300">{error}</p>}
    </section>
  );
};
