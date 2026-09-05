import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Pause, Play, X, Search } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';

interface StockStatus {
  symbol: string;
  state: string;
  paused: boolean;
  spot: number | null;
  atm: number | null;
  expiry: string | null;
  lot: number;
  tokens: number;
  msg_count: number;
}

interface WsStats {
  total_capacity: number;
  slots: { slot_id: number; status: string; subscribed: number; capacity: number }[];
}

const STATE_META: Record<string, { label: string; cls: string }> = {
  WINDOW_ACTIVE: { label: 'Streaming', cls: 'bg-terminal-pe/20 text-terminal-pe' },
  CASH_SUBSCRIBED: { label: 'Building', cls: 'bg-terminal-atm/20 text-terminal-atm' },
  WINDOW_PENDING: { label: 'Pending · capacity', cls: 'bg-terminal-atm/20 text-terminal-atm' },
  CASH_PENDING: { label: 'Pending · capacity', cls: 'bg-terminal-atm/20 text-terminal-atm' },
  PAUSED: { label: 'Paused', cls: 'bg-terminal-border/40 text-terminal-muted' },
  WINDOW_UNAVAILABLE: { label: 'No options', cls: 'bg-terminal-ce/20 text-terminal-ce' },
  ERROR: { label: 'Error', cls: 'bg-terminal-ce/20 text-terminal-ce' },
  IDLE: { label: 'Idle', cls: 'bg-terminal-border/40 text-terminal-muted' },
};

export const StocksTab: React.FC = () => {
  const [stocks, setStocks] = useState<StockStatus[]>([]);
  const [ws, setWs] = useState<WsStats | null>(null);
  const [query, setQuery] = useState('');
  const [sugg, setSugg] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(async () => {
    try {
      const [rs, rw] = await Promise.all([fetch('/api/stocks'), fetch('/api/ws/usage')]);
      if (rs.ok) setStocks((await rs.json()).stocks || []);
      if (rw.ok) setWs((await rw.json()).ws);
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) { setSugg([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/stocks/search?q=${encodeURIComponent(q)}`);
        if (r.ok) setSugg((await r.json()).matches || []);
      } catch {}
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const addStock = useCallback(async (sym: string) => {
    const symbol = sym.trim().toUpperCase();
    if (!symbol) return;
    setError('');
    try {
      const r = await fetch('/api/stocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.detail || 'Failed to add');
      }
      setQuery('');
      setSugg([]);
      refresh();
    } catch { setError('Network error'); }
  }, [refresh]);

  const act = useCallback(async (sym: string, action: 'pause' | 'resume' | 'remove') => {
    if (action === 'remove') { setRemoveTarget(sym); return; }
    try {
      await fetch(`/api/stocks/${sym}/${action}`, { method: 'POST' });
      refresh();
    } catch {}
  }, [refresh]);

  const confirmRemove = useCallback(async () => {
    if (!removeTarget) return;
    try {
      await fetch(`/api/stocks/${removeTarget}`, { method: 'DELETE' });
      refresh();
    } catch {}
  }, [removeTarget, refresh]);

  const stockTokens = stocks.reduce((a, s) => a + s.tokens, 0);
  const totalCap = ws?.total_capacity || 2970;
  const pct = Math.min(100, Math.round((stockTokens / totalCap) * 100));

  return (
    <div>
      <h3 className="st-section mb-1">Stocks</h3>
      <p className="st-helper mb-4">
        Tier-2 stocks stream a ±window of option strikes around the live ATM. Cash quote first, then the window builds — no restart.
      </p>

      {/* Add bar */}
      <div className="relative flex gap-2 mb-4 max-w-md">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-terminal-muted" />
          <input
            type="text" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addStock(query); }}
            placeholder="Search e.g. RELIANCE, TCS…"
            className="st-input w-full bg-terminal-bg border border-terminal-border rounded-lg pl-8 pr-3 py-2 text-terminal-text placeholder:text-[var(--st-text-3)] focus:outline-none focus:border-terminal-atm"
          />
          {sugg.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-terminal-panel border border-terminal-border rounded-lg shadow-xl z-20 overflow-hidden">
              {sugg.map((s) => (
                <button key={s} onClick={() => addStock(s)} className="st-input w-full text-left px-3 py-2 hover:bg-white/5">
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => addStock(query)} className="st-btn flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-semibold bg-terminal-pe/20 text-terminal-pe border border-terminal-pe/30 hover:bg-terminal-pe/30 transition-colors">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>
      {error && <div className="st-helper text-terminal-ce mb-3">{error}</div>}

      {/* Rows */}
      <div className="border border-terminal-border rounded-lg overflow-hidden">
        {stocks.length === 0 && (
          <div className="px-3 py-6 text-center st-helper">No stocks configured — add one above</div>
        )}
        {stocks.map((s) => {
          const meta = STATE_META[s.state] || STATE_META.IDLE;
          return (
            <div key={s.symbol} className="grid grid-cols-[1fr_auto_auto_auto] sm:grid-cols-[1.1fr_1fr_1.3fr_.6fr_auto] gap-2 sm:gap-3 items-center px-3 py-2.5 border-t border-terminal-border/50 first:border-t-0 hover:bg-white/5 group">
              <span className="st-sym">{s.symbol}</span>
              <span><span className={`st-pill ${meta.cls}`}>{meta.label}</span></span>
              <span className="st-num hidden sm:block">
                {s.atm != null ? `ATM ${s.atm.toLocaleString('en-IN')} · ${s.expiry || '—'} · lot ${s.lot}` : '—'}
              </span>
              <span className="st-num text-right">{s.tokens} tok</span>
              <span className="flex gap-1 justify-end sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                {s.state !== 'WINDOW_UNAVAILABLE' && s.state !== 'ERROR' && (
                  <button
                    onClick={() => act(s.symbol, s.paused ? 'resume' : 'pause')}
                    title={s.paused ? 'Resume streaming' : 'Pause (frees tokens, keeps config)'}
                    className="p-1 rounded hover:bg-white/10 text-terminal-muted hover:text-terminal-text"
                  >
                    {s.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                  </button>
                )}
                <button onClick={() => act(s.symbol, 'remove')} title="Remove (history kept)" className="p-1 rounded hover:bg-white/10 text-terminal-muted hover:text-terminal-ce">
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {/* Remove confirmation (app-native, replaces window.confirm) */}
      {removeTarget && (
        <ConfirmDialog
          open
          danger
          title={`Remove ${removeTarget}?`}
          confirmLabel="Remove"
          onClose={() => setRemoveTarget(null)}
          onConfirm={confirmRemove}
        >
          <p>
            The stock stops streaming immediately and its WebSocket tokens are freed.
            Snapshots and alert history are kept.
          </p>
        </ConfirmDialog>
      )}

      {/* Capacity strip */}
      <div className="flex items-center gap-3 mt-3 st-helper">
        <span>Stocks use <span className="st-num">{stockTokens}</span> / {totalCap.toLocaleString()} tokens ({pct}%)</span>
        <span className="flex-1 max-w-[140px] h-1.5 bg-terminal-border/40 rounded-full overflow-hidden">
          <span className="block h-full bg-terminal-pe rounded-full transition-all" style={{ width: `${pct}%` }} />
        </span>
      </div>
    </div>
  );
};
