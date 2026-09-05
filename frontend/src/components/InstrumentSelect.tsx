import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { fetchInstruments } from '../instrumentsCache';

interface Instrument {
  name: string;
  tier: number;
  kind: string;
}

interface InstrumentSelectProps {
  value: string;
  onChange: (name: string) => void;
}

const DEFAULT_ITEMS: Instrument[] = [
  { name: 'NIFTY', tier: 1, kind: 'index' },
  { name: 'SENSEX', tier: 1, kind: 'index' },
];

const KIND_LABEL: Record<string, string> = { index: 'Indices', stock: 'Stocks', commodity: 'Commodities' };
const KIND_ORDER = ['index', 'stock', 'commodity'];

export const InstrumentSelect: React.FC<InstrumentSelectProps> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Instrument[]>(DEFAULT_ITEMS);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInstruments()
      .then((d) => {
        if (cancelled || !d) return;
        // Prefer the new typed payload; fall back to legacy tier1/stocks shape
        let list: Instrument[] = [];
        if (Array.isArray(d.instruments) && d.instruments.length > 0) {
          list = d.instruments.map((x: any) => ({ name: x.name, tier: x.tier ?? 2, kind: x.kind ?? 'stock' }));
          list.unshift(...(d.tier1 || []).map((x: any) =>
            typeof x === 'string' ? { name: x, tier: 1, kind: 'index' } : { name: x.name, tier: 1, kind: 'index' }));
        } else {
          const t1 = (d.tier1 || []).map((x: any) =>
            typeof x === 'string' ? { name: x, tier: 1, kind: 'index' } : { name: x.name, tier: 1, kind: x.kind ?? 'index' });
          const t2 = (d.stocks || []).map((x: any) =>
            typeof x === 'string' ? { name: x, tier: 2, kind: 'stock' } : { name: x.name, tier: 2, kind: x.kind ?? 'stock' });
          list = [...t1, ...t2];
        }
        if (list.length > 0) setItems(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return items;
    return items.filter((i) => i.name.toUpperCase().includes(q));
  }, [items, query]);

  const renderItem = (inst: Instrument) => {
    const isSelected = inst.name === value;
    return (
      <button
        key={inst.name}
        onClick={() => { onChange(inst.name); setOpen(false); }}
        className={`w-full flex items-center justify-between px-3 py-1.5 text-left text-xs font-mono transition-colors ${
          isSelected ? 'bg-terminal-atm/20 text-terminal-atm font-bold' : 'text-terminal-text hover:bg-white/5'
        }`}
      >
        <span className="flex items-center gap-2">
          <span>{inst.name}</span>
          <span className={`text-[8px] font-bold px-1 py-0.5 rounded uppercase tracking-wide ${
            inst.kind === 'index' ? 'bg-terminal-atm/15 text-terminal-atm'
            : inst.kind === 'commodity' ? 'bg-cyan-500/15 text-cyan-400'
            : 'bg-terminal-pe/15 text-terminal-pe'
          }`}>
            {inst.kind === 'index' ? 'Index' : inst.kind === 'commodity' ? 'MCX' : 'Stock'}
          </span>
        </span>
        {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-terminal-atm" />}
      </button>
    );
  };

  const groups = KIND_ORDER.map((k) => ({ kind: k, items: filtered.filter((i) => i.kind === k) }))
    .filter((g) => g.items.length > 0);
  const ungrouped = filtered.filter((i) => !KIND_ORDER.includes(i.kind));

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 bg-terminal-bg border border-terminal-border rounded px-3 py-1.5 text-xs font-mono font-bold text-terminal-text uppercase tracking-wider hover:border-terminal-atm/50 transition-colors min-w-[110px]"
      >
        <span>{value}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-terminal-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 w-64 bg-terminal-panel border border-terminal-border rounded-lg shadow-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-terminal-border bg-terminal-bg">
            <Search className="w-3.5 h-3.5 text-terminal-muted shrink-0" />
            <input
              ref={inputRef} type="text" value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search instruments..."
              className="flex-1 bg-transparent text-xs font-mono text-terminal-text placeholder-terminal-muted/50 focus:outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-terminal-muted hover:text-terminal-text">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto terminal-scroll py-1">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-center text-[10px] font-mono text-terminal-muted">
                No instruments match "{query}"
              </div>
            )}
            {groups.map((g) => (
              <React.Fragment key={g.kind}>
                <div className="px-3 pt-2 pb-0.5 text-[9px] font-mono font-bold text-terminal-muted uppercase tracking-wider">
                  {KIND_LABEL[g.kind]}
                </div>
                {g.items.map(renderItem)}
              </React.Fragment>
            ))}
            {ungrouped.map(renderItem)}
          </div>

          <div className="px-3 py-1.5 border-t border-terminal-border text-[9px] font-mono text-terminal-muted/70 flex items-center justify-between">
            <span>{items.length} instruments</span>
            <span>Type to filter · Esc to close</span>
          </div>
        </div>
      )}
    </div>
  );
};
