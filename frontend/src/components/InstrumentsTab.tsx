import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Plus, Pause, Play, X, Search, ChevronDown, ChevronRight } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { TierChangeDialog } from './TierChangeDialog';

type Kind = 'INDEX' | 'STOCK' | 'COMMODITY';

interface InstrumentStatus {
  symbol: string;
  kind: string;
  tier: number;
  fixed?: boolean;
  state: string;
  paused: boolean;
  spot: number | null;
  atm: number | null;
  expiry: string | null;
  lot: number;
  tokens: number;
  msg_count: number;
  ce_wall?: number | null;
  pe_wall?: number | null;
  at_wall?: boolean | null;
}

interface WsStats {
  total_capacity: number;
  slots: { slot_id: number; status: string; subscribed: number; capacity: number }[];
}

const KIND_META: Record<string, { label: string; cls: string }> = {
  INDEX: { label: 'Index', cls: 'bg-terminal-atm/20 text-terminal-atm' },
  STOCK: { label: 'Stock', cls: 'bg-terminal-pe/20 text-terminal-pe' },
  COMMODITY: { label: 'Commodity', cls: 'bg-cyan-500/20 text-cyan-400' },
};

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

const TIER_GROUPS = [
  { tier: 1, title: 'Tier 1', desc: 'Full / high-priority analytics · 5s updates · sacred capacity',
    bar: 'bg-terminal-atm', badge: 'bg-terminal-atm/20 text-terminal-atm' },
  { tier: 2, title: 'Tier 2', desc: 'Full analytics · Greeks/GEX every 30s · ±20 window',
    bar: 'bg-terminal-pe', badge: 'bg-terminal-pe/20 text-terminal-pe' },
  { tier: 3, title: 'Tier 3', desc: 'Lightweight scanner · walls only · analytics at triggers · configurable window',
    bar: 'bg-cyan-500', badge: 'bg-cyan-500/20 text-cyan-400' },
];

const TIER_ACTIVE: Record<number, string> = {
  1: 'bg-terminal-atm/30 text-terminal-atm font-bold',
  2: 'bg-terminal-pe/30 text-terminal-pe font-bold',
  3: 'bg-cyan-500/30 text-cyan-400 font-bold',
};

const TIER_NAMES: Record<number, string> = {
  1: 'Tier 1 — full/high-priority analytics',
  2: 'Tier 2 — full analytics',
  3: 'Tier 3 — lightweight scanner',
};

const COLLAPSE_KEY = 'instruments_sections_collapsed';
const KINDS: (Kind | 'ALL')[] = ['ALL', 'INDEX', 'STOCK', 'COMMODITY'];

const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-IN'));

export const InstrumentsTab: React.FC = () => {
  const [instruments, setInstruments] = useState<InstrumentStatus[]>([]);
  const [ws, setWs] = useState<WsStats | null>(null);
  const [query, setQuery] = useState('');
  const [sugg, setSugg] = useState<{ symbol: string; kind: string }[]>([]);
  const [kindFilter, setKindFilter] = useState<Kind | 'ALL'>('ALL');
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); } catch { return {}; }
  });
  const [error, setError] = useState('');
  const [tierMove, setTierMove] = useState<{ inst: InstrumentStatus; tier: number } | null>(null);
  const [batchMove, setBatchMove] = useState<{ instruments: InstrumentStatus[]; tier: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchError, setBatchError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(async () => {
    try {
      const [rs, rw] = await Promise.all([fetch('/api/stocks'), fetch('/api/ws/usage')]);
      if (rs.ok) setInstruments((await rs.json()).stocks || []);
      if (rw.ok) setWs((await rw.json()).ws);
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)); } catch {}
  }, [collapsed]);

  // kind-aware typeahead (250 ms debounce)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) { setSugg([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}`);
        if (r.ok) setSugg((await r.json()).matches || []);
      } catch {}
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const addInstrument = useCallback(async (symbol: string, kind?: string) => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setError('');
    try {
      const r = await fetch('/api/instruments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym, kind }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.detail || 'Failed to add');
      }
      setQuery(''); setSugg([]);
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



  // deliberate tier selection (not a cycle) — confirmed via TierChangeDialog
  const moveTier = useCallback((inst: InstrumentStatus, tier: number) => {
    if (inst.tier === tier || inst.fixed) return;
    setTierMove({ inst, tier });
  }, []);

  const [tierError, setTierError] = useState<string | null>(null);
  const confirmTierMove = useCallback(async (): Promise<false | void> => {
    if (!tierMove) return;
    const { inst, tier } = tierMove;
    setTierError(null);
    setError('');
    try {
      const r = await fetch(`/api/instruments/${inst.symbol}/tier`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        const msg = d.detail || `Tier change failed (HTTP ${r.status})`;
        setTierError(msg);       // shown inside the dialog — cannot be missed
        setError(msg);
        refresh();
        return false;            // keep dialog open
      }
      // optimistic: row moves to the destination group immediately
      setInstruments((prev) => prev.map((i) => (i.symbol === inst.symbol ? { ...i, tier } : i)));
      refresh();
    } catch (e) {
      setTierError('Network error — is the backend running?');
      setError('Network error');
      return false;
    }
  }, [tierMove, refresh]);

  // filtering + grouping
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return instruments.filter((i) => {
      if (kindFilter !== 'ALL' && i.kind !== kindFilter) return false;
      if (q && !i.symbol.includes(q)) return false;
      return true;
    });
  }, [instruments, query, kindFilter]);

  const groups = useMemo(() => {
    return TIER_GROUPS.map((g) => ({
      ...g,
      rows: filtered.filter((i) => i.tier === g.tier).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    }));
  }, [filtered]);

  const toggleSelect = useCallback((sym: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym); else next.add(sym);
      return next;
    });
  }, []);

  const selectedInstruments = useMemo(
    () => filtered.filter((i) => selected.has(i.symbol) && !i.fixed),
    [filtered, selected],
  );

  // batch tier move — opens the same confirmation dialog with all targets
  const startBatchMove = useCallback((tier: number) => {
    const targets = selectedInstruments.filter((i) => i.tier !== tier);
    if (targets.length === 0) {
      setError(`All selected instruments are already at Tier ${tier}`);
      return;
    }
    setBatchError(null);
    setBatchMove({ instruments: targets, tier });
  }, [selectedInstruments]);

  const confirmBatchMove = useCallback(async (): Promise<false | void> => {
    if (!batchMove) return;
    const { instruments, tier } = batchMove;
    const failures: string[] = [];
    for (const inst of instruments) {
      try {
        const r = await fetch(`/api/instruments/${inst.symbol}/tier`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          failures.push(`${inst.symbol}: ${d.detail || `HTTP ${r.status}`}`);
          continue;
        }
        setInstruments((prev) => prev.map((i) => (i.symbol === inst.symbol ? { ...i, tier } : i)));
      } catch {
        failures.push(`${inst.symbol}: network error`);
      }
    }
    setSelected(new Set());
    refresh();
    if (failures.length > 0) {
      const msg = `${failures.length}/${instruments.length} failed — ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '…' : ''}`;
      setBatchError(msg);
      setError(msg);
      return false;
    }
  }, [batchMove, refresh]);

  const stockTokens = instruments.reduce((a, s) => a + (s.fixed ? 0 : s.tokens), 0);
  const totalCap = ws?.total_capacity || 2970;
  const pct = Math.min(100, Math.round((stockTokens / totalCap) * 100));

  const renderRow = (s: InstrumentStatus) => {
    const st = STATE_META[s.state] || STATE_META.IDLE;
    const kind = KIND_META[s.kind?.toUpperCase()] || KIND_META.STOCK;
    return (
      <div key={s.symbol} className="grid grid-cols-[auto_1fr_auto_auto_auto] sm:grid-cols-[auto_1fr_.7fr_1.1fr_1.4fr_.6fr_auto_auto] gap-2 sm:gap-3 items-center px-3 py-2 border-t border-terminal-border/40 first:border-t-0 hover:bg-white/5 group">
        {!s.fixed && (
          <input
            type="checkbox"
            checked={selected.has(s.symbol)}
            onChange={() => toggleSelect(s.symbol)}
            onClick={(e) => e.stopPropagation()}
            className="w-4 h-4 accent-terminal-pe cursor-pointer"
            aria-label={`Select ${s.symbol}`}
          />
        )}
        <span className="st-sym">{s.symbol}</span>
        <span><span className={`st-pill ${kind.cls}`}>{kind.label}</span></span>
        <span className="hidden sm:flex items-center gap-1.5">
          <span className={`st-pill ${st.cls}`}>{st.label}</span>
          {s.tier === 3 && s.at_wall && <span className="st-pill bg-terminal-ce/20 text-terminal-ce">AT WALL</span>}
        </span>
        <span className="st-num hidden sm:block">
          {s.tier === 3 && s.atm != null
            ? `ATM ${fmt(s.atm)} · CE ${fmt(s.ce_wall)} · PE ${fmt(s.pe_wall)}`
            : s.atm != null ? `ATM ${fmt(s.atm)} · ${s.expiry || '—'} · lot ${s.lot}` : '—'}
        </span>
        <span className="st-num text-right hidden sm:block">{s.tokens} tok</span>
        <span>
          {s.fixed ? (
            <span className="st-pill bg-terminal-border/40 text-terminal-muted">Fixed</span>
          ) : (
            <span className="inline-flex border border-terminal-border rounded overflow-hidden" onClick={(e) => e.stopPropagation()}>
              {[1, 2, 3].map((t) => (
                <button
                  key={t}
                  onClick={() => moveTier(s, t)}
                  title={`Move to ${TIER_NAMES[t]}`}
                  className={`px-2 py-0.5 text-[10px] font-mono transition-colors ${
                    s.tier === t ? TIER_ACTIVE[t] : 'text-terminal-muted hover:bg-white/5'
                  }`}
                >
                  {t}
                </button>
              ))}
            </span>
          )}
        </span>
        <span className="flex gap-1 justify-end sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
          {!s.fixed && s.state !== 'WINDOW_UNAVAILABLE' && s.state !== 'ERROR' && (
            <button
              onClick={() => act(s.symbol, s.paused ? 'resume' : 'pause')}
              title={s.paused ? 'Resume streaming' : 'Pause (frees tokens, keeps config)'}
              className="p-1 rounded hover:bg-white/10 text-terminal-muted hover:text-terminal-text"
            >
              {s.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            </button>
          )}
          {!s.fixed && (
            <button onClick={() => act(s.symbol, 'remove')} title="Remove (history kept)" className="p-1 rounded hover:bg-white/10 text-terminal-muted hover:text-terminal-ce">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </span>
      </div>
    );
  };

  return (
    <div>
      <h3 className="st-section mb-1">Instruments</h3>
      <p className="st-helper mb-4">
        Organized by tier — new instruments start at Tier 3. Use the row controls to move an instrument
        to any tier directly; changes apply live, no restart.
      </p>

      {/* Add bar */}
      <div className="relative flex gap-2 mb-3 max-w-md">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-terminal-muted" />
          <input
            type="text" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addInstrument(query); }}
            placeholder="Search BANKNIFTY, RELIANCE, CRUDEOIL…"
            className="st-input w-full bg-terminal-bg border border-terminal-border rounded-lg pl-8 pr-3 py-2 text-terminal-text placeholder:text-[var(--st-text-3)] focus:outline-none focus:border-terminal-atm"
          />
          {sugg.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-terminal-panel border border-terminal-border rounded-lg shadow-xl z-20 overflow-hidden">
              {sugg.map((s) => (
                <button key={`${s.kind}-${s.symbol}`} onClick={() => addInstrument(s.symbol, s.kind)}
                  className="st-input w-full flex items-center justify-between px-3 py-2 hover:bg-white/5">
                  <span>{s.symbol}</span>
                  <span className={`st-pill ${KIND_META[s.kind]?.cls || ''}`}>{KIND_META[s.kind]?.label || s.kind}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => addInstrument(query)} className="st-btn flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-semibold bg-terminal-pe/20 text-terminal-pe border border-terminal-pe/30 hover:bg-terminal-pe/30 transition-colors">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      {/* Filter row */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="st-helper" style={{ fontSize: 11.5 }}>Filter:</span>
        {KINDS.map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            className={`st-pill transition-colors ${kindFilter === k ? 'bg-white/10 text-terminal-text font-semibold' : 'text-terminal-muted hover:bg-white/5'}`}
          >
            {k === 'ALL' ? 'All kinds' : KIND_META[k].label + 's'}
          </button>
        ))}
      </div>
      {error && <div className="st-helper text-terminal-ce mb-3">{error}</div>}

      {/* Batch action bar */}
      {selectedInstruments.length > 0 && (
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 px-3 py-2 mb-3 rounded-lg border border-terminal-pe/40 bg-terminal-panel/95 backdrop-blur-sm shadow-lg">
          <span className="text-[12px] font-mono font-semibold text-terminal-pe">
            {selectedInstruments.length} selected
          </span>
          <span className="text-[11px] font-mono text-terminal-muted hidden sm:inline">
            ({selectedInstruments.map(i => `T${i.tier}`).sort().join(' · ')})
          </span>
          <span className="text-[11px] font-mono text-terminal-muted ml-1">Move to:</span>
          {[1, 2, 3].map((t) => (
            <button
              key={t}
              onClick={() => startBatchMove(t)}
              disabled={selectedInstruments.every((i) => i.tier === t)}
              className={`px-2.5 py-1.5 min-h-[36px] rounded text-[11px] font-mono font-semibold transition-colors disabled:opacity-30 border ${
                [1, 2, 3].includes(t) && t === 1 ? 'bg-terminal-atm/20 text-terminal-atm border-terminal-atm/40 hover:bg-terminal-atm/30'
                : t === 2 ? 'bg-terminal-pe/20 text-terminal-pe border-terminal-pe/40 hover:bg-terminal-pe/30'
                : 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40 hover:bg-cyan-500/30'
              }`}
            >
              Tier {t}
            </button>
          ))}
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto px-2.5 py-1.5 min-h-[36px] rounded text-[11px] font-mono text-terminal-muted border border-terminal-border hover:text-terminal-text hover:bg-white/5 transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Tier groups */}
      <div className="space-y-3">
        {groups.map((g) => {
          const isCollapsed = !!collapsed[g.tier];
          const groupTokens = g.rows.reduce((a, r) => a + r.tokens, 0);
          return (
            <div key={g.tier} className="border border-terminal-border rounded-lg overflow-hidden">
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/5 transition-colors text-left select-none"
                onClick={() => setCollapsed((c) => ({ ...c, [g.tier]: !c[g.tier] }))}
              >
                <span className={`w-1 self-stretch rounded-full ${g.bar}`} />
                {isCollapsed
                  ? <ChevronRight className="w-3.5 h-3.5 text-terminal-muted shrink-0" />
                  : <ChevronDown className="w-3.5 h-3.5 text-terminal-muted shrink-0" />}
                <span className="st-card-title">{g.title}</span>
                <span className={`st-pill ${g.badge}`}>{g.rows.length}</span>
                <span className="st-helper hidden md:inline" style={{ fontSize: 11.5 }}>{g.desc}</span>
                <span className="ml-auto st-num">{groupTokens} tok</span>
              </button>
              {!isCollapsed && (
                <div className={g.rows.length > 8 ? 'max-h-[38vh] overflow-y-auto terminal-scroll' : ''}>
                  {g.rows.length === 0 && (
                    <div className="px-3 py-4 text-center st-helper">
                      {g.tier === 3 ? 'No scanners yet — newly added instruments land here.' : 'No instruments in this tier.'}
                    </div>
                  )}
                  {g.rows.map(renderRow)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Tier-change + remove confirmations (app-native, replaces window.confirm) */}
      {tierMove && (
        <TierChangeDialog
          open
          instruments={[{ symbol: tierMove.inst.symbol, kind: tierMove.inst.kind, currentTier: tierMove.inst.tier }]}
          currentTier={tierMove.inst.tier}
          targetTier={tierMove.tier}
          onClose={() => { setTierMove(null); setTierError(null); }}
          onConfirm={confirmTierMove}
        />
      )}
      {batchMove && (
        <TierChangeDialog
          open
          instruments={batchMove.instruments.map((i) => ({ symbol: i.symbol, kind: i.kind, currentTier: i.tier }))}
          currentTier={batchMove.instruments.every((i) => i.tier === batchMove.instruments[0].tier)
            ? batchMove.instruments[0].tier
            : 'mixed'}
          targetTier={batchMove.tier}
          onClose={() => { setBatchMove(null); setBatchError(null); }}
          onConfirm={confirmBatchMove}
          error={batchError}
        />
      )}
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
            The instrument stops streaming immediately and its WebSocket tokens are freed.
            Snapshots and alert history are kept.
          </p>
        </ConfirmDialog>
      )}

      {/* Capacity strip */}
      <div className="flex items-center gap-3 mt-3 st-helper">
        <span>Configured instruments use <span className="st-num">{stockTokens}</span> / {totalCap.toLocaleString()} tokens ({pct}%)</span>
        <span className="flex-1 max-w-[140px] h-1.5 bg-terminal-border/40 rounded-full overflow-hidden">
          <span className="block h-full bg-terminal-pe rounded-full transition-all" style={{ width: `${pct}%` }} />
        </span>
      </div>
    </div>
  );
};
