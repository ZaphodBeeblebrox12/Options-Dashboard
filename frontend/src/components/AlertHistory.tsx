import React, { useState, useEffect, useCallback } from 'react';
import { History, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Bell, Calendar, Target, TrendingUp, Activity, RefreshCw, Loader2, AlertTriangle } from 'lucide-react';
import { useAlertHistory, useAlertSettings, AlertHistoryEntry } from '../hooks/useAlerts';

// Canonical rule_type values (alert_models.AlertRuleType). Only these two
// strings are ever sent to the backend; anything else means All Alerts.
const RULE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Alerts' },
  { value: 'atm_negative_gex_oi_wall', label: 'Strong Signal — ATM + Negative GEX + OI Wall' },
  { value: 'atm_max_ce_pe_wall', label: 'Wall Alignment — ATM Maximum CE/PE Wall' },
];
import { HistoryCalendar } from './HistoryCalendar';

// 'ALL' is a local sentinel — it makes the hook OMIT the index param entirely
// (backend then returns every symbol). Never sent to the API as a value.
const ALL = '__ALL__';
const PAGE_SIZE = 50;

interface AlertHistoryPanelProps {
  indexName: string;
}

const RULE_BADGE_COLORS: Record<string, string> = {
  'atm_negative_gex_oi_wall': 'bg-red-500/20 text-red-400 border-red-500/30',
  'atm_max_ce_pe_wall': 'bg-amber-500/20 text-amber-400 border-amber-500/30',
};

const RULE_NAMES: Record<string, string> = {
  'atm_negative_gex_oi_wall': 'Strong Signal',
  'atm_max_ce_pe_wall': 'Wall Alignment',
};

export const AlertHistoryPanel: React.FC<AlertHistoryPanelProps> = ({ indexName }) => {
  // Alert Type filter. DEFAULT comes from the persisted Settings value
  // (history_default_rule_type); the user's manual choice is a TEMPORARY
  // override for this open panel. Init happens ONCE at mount (next-open only):
  // a Settings change while History is open never alters the visible filter —
  // closing and reopening picks up the new default. Missing/invalid -> All.
  const { settings: alertSettings } = useAlertSettings();
  const [ruleFilter, setRuleFilter] = useState<string>(() => {
    const d = alertSettings?.history_default_rule_type;
    return RULE_OPTIONS.some((o) => o.value && o.value === d) ? d : '';
  });
  const [ruleTouched, setRuleTouched] = useState(false);
  useEffect(() => {
    if (ruleTouched) return;                 // manual override wins this session
    const d = alertSettings?.history_default_rule_type;
    setRuleFilter(RULE_OPTIONS.some((o) => o.value && o.value === d) ? d : '');
    // only adopt a new default for a not-yet-touched panel; page reset keeps
    // the list coherent if the default changed between opens
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertSettings]);

  const [symbolFilter, setSymbolFilter] = useState<string>(indexName); // ALL = every symbol
  const [page, setPage] = useState(1);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [dateCounts, setDateCounts] = useState<Record<string, number>>({});
  const [symbolOptions, setSymbolOptions] = useState<string[]>([]);

  // The panel is bound to the main dropdown instrument by default (existing
  // UX). When that instrument changes, follow it — unless the user has
  // explicitly chosen All Symbols.
  useEffect(() => {
    setSymbolFilter((prev) => (prev === ALL ? ALL : indexName));
    setPage(1);
  }, [indexName]);

  const activeSymbol = symbolFilter === ALL ? undefined : symbolFilter;
  const activeRule = ruleFilter || undefined;
  const { history, total, loading } = useAlertHistory(activeSymbol, selectedDate || undefined, page, activeRule);

  // Symbol options: configured instruments + whatever symbols appear in the
  // current page (covers symbols no longer configured).
  useEffect(() => {
    let alive = true;
    fetch('/api/instruments')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        const names = new Set<string>();
        (d.tier1 || []).forEach((x: any) => names.add(x.name));
        (d.instruments || []).forEach((x: any) => names.add(x.name));
        (d.stocks || []).forEach((x: any) => names.add(x.name));
        setSymbolOptions([...names].sort());
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const pageSymbols = Array.from(new Set(history.map((e) => e.index_name)));
  const options = Array.from(new Set([...symbolOptions, ...pageSymbols, ...(activeSymbol ? [activeSymbol] : [])])).sort();

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  // Day-level availability for the calendar — one tiny query, not the full history.
  // Explicit loading / error states: a failed availability request must NEVER
  // look identical to "this index has no alert history".
  const [availStatus, setAvailStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const loadDateCounts = useCallback(() => {
    setAvailStatus('loading');
    // same semantics as the list: omit index entirely for All Symbols
    const q = activeSymbol ? `?index=${encodeURIComponent(activeSymbol)}` : '';
    fetch(`/api/alerts/history/dates${q}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        const map: Record<string, number> = {};
        for (const row of d?.dates ?? []) map[row.date] = row.count;
        setDateCounts(map);
        setAvailStatus('ok');
      })
      .catch((e) => {
        console.warn('[AlertHistory] availability fetch failed:', e);
        setAvailStatus('error');
      });
  }, [activeSymbol]);
  useEffect(() => { loadDateCounts(); }, [loadDateCounts]);

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return ts;
    }
  };

  const formatDate = (ts: string) => {
    try {
      const d = new Date(ts);
      return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    } catch {
      return ts;
    }
  };

  const parseChannels = (channelsJson: string): string[] => {
    try {
      return JSON.parse(channelsJson);
    } catch {
      return [];
    }
  };

  return (
    <div className="terminal-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-terminal-atm" />
          <span className="text-sm font-bold">Alert History</span>
          <span className="text-[10px] font-mono text-terminal-muted bg-terminal-bg px-2 py-0.5 rounded">
            {activeSymbol ?? 'All Symbols'} · {total} total
          </span>
          {/* Explicit History symbol selector — independent of Settings'
              notification scope. All Symbols omits the index param so the
              backend returns every symbol. */}
          <select
            value={symbolFilter}
            onChange={(e) => { setSymbolFilter(e.target.value); setPage(1); }}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text"
          >
            <option value={ALL}>All Symbols</option>
            {options.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {/* Alert Type: independent of Symbol/Date. Manual selection is a
              session override of the persisted Settings default. */}
          <select
            value={ruleFilter}
            onChange={(e) => { setRuleFilter(e.target.value); setRuleTouched(true); setPage(1); }}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text"
          >
            {RULE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <HistoryCalendar
            selectedDate={selectedDate}
            onSelect={(d) => setSelectedDate(d ?? '')}
            availability={dateCounts}
            placeholder="All dates"
          />
          {availStatus === 'loading' && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-terminal-muted" title="Loading available dates…">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="hidden sm:inline">dates…</span>
            </span>
          )}
          {availStatus === 'error' && (
            <button
              onClick={loadDateCounts}
              className="flex items-center gap-1 px-2 py-1 rounded bg-terminal-atm/15 border border-terminal-atm/40 text-[10px] font-mono text-terminal-atm hover:bg-terminal-atm/25 transition-colors"
              title="Available-date lookup failed (backend may need a restart to serve /api/alerts/history/dates). Click to retry."
            >
              <AlertTriangle className="w-3 h-3" />
              <span className="hidden sm:inline">dates unavailable</span>
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-4 h-4 border-2 border-terminal-muted border-t-transparent rounded-full animate-spin" />
          </div>
        ) : history.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-terminal-muted">
            <Bell className="w-6 h-6 mb-2 opacity-50" />
            <span className="text-xs font-mono">No alerts fired yet</span>
            <span className="text-[10px] font-mono opacity-60">Alerts appear here when rules trigger</span>
          </div>
        ) : (
          <table className="w-full text-[10px] sm:text-xs font-mono">
            <thead>
              <tr className="text-terminal-muted border-b border-terminal-border">
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">Index</th>
                <th className="px-3 py-2 text-left">Rule</th>
                <th className="px-3 py-2 text-right">Spot</th>
                <th className="px-3 py-2 text-right">ATM</th>
                <th className="px-3 py-2 text-center">Channels</th>
                <th className="px-3 py-2 text-center w-8"></th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => {
                const isExpanded = expandedId === entry.id;
                const channels = parseChannels(entry.channels_fired);
                const badgeClass = RULE_BADGE_COLORS[entry.rule_type] || 'bg-terminal-bg text-terminal-muted border-terminal-border';

                return (
                  <React.Fragment key={entry.id}>
                    <tr
                      className={`border-b border-terminal-border/30 cursor-pointer hover:bg-white/5 transition-colors ${
                        isExpanded ? 'bg-white/5' : ''
                      }`}
                      onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    >
                      <td className="px-3 py-2 text-terminal-muted">{formatDate(entry.timestamp)}</td>
                      <td className="px-3 py-2 text-terminal-text font-semibold">{formatTime(entry.timestamp)}</td>
                      <td className="px-3 py-2">
                        <span className="px-1.5 py-0.5 rounded bg-terminal-bg text-terminal-muted text-[10px]">
                          {entry.index_name}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded border text-[10px] ${badgeClass}`}>
                          {RULE_NAMES[entry.rule_type] || entry.rule_type}
                        </span>
                        {entry.instrument_tier === 4 && (
                          <span className="ml-1 px-1 py-0.5 rounded border text-[10px] bg-violet-500/20 text-violet-300 border-violet-500/30">
                            T4
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-terminal-text">
                        {entry.spot !== null ? entry.spot.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {entry.atm_strike !== null ? entry.atm_strike.toLocaleString('en-IN') : '—'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {channels.includes('toast') && (
                            <span className="w-2 h-2 rounded-full bg-terminal-atm" title="Toast" />
                          )}
                          {channels.includes('sound') && (
                            <span className="w-2 h-2 rounded-full bg-terminal-pe" title="Sound" />
                          )}
                          {channels.includes('telegram') && (
                            <span className="w-2 h-2 rounded-full bg-cyan-400" title="Telegram" />
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {isExpanded ? (
                          <ChevronUp className="w-3.5 h-3.5 text-terminal-muted" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-terminal-muted" />
                        )}
                      </td>
                    </tr>

                    {/* Expanded Detail */}
                    {isExpanded && (
                      <tr>
                        <td colSpan={8} className="px-3 py-3 bg-terminal-bg/50">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[10px] font-mono">
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 text-terminal-muted">
                                <TrendingUp className="w-3 h-3" />
                                Spot
                              </div>
                              <div className="text-terminal-text font-semibold">
                                {entry.spot !== null ? entry.spot.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}
                              </div>
                            </div>
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 text-terminal-muted">
                                <Target className="w-3 h-3" />
                                ATM Strike
                              </div>
                              <div className="text-terminal-text font-semibold">
                                {entry.atm_strike !== null ? entry.atm_strike.toLocaleString('en-IN') : '—'}
                              </div>
                            </div>
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 text-terminal-muted">
                                <Activity className="w-3 h-3" />
                                Max CE Wall
                              </div>
                              <div className="text-terminal-text font-semibold">
                                {entry.max_ce_oi_strike !== null ? entry.max_ce_oi_strike.toLocaleString('en-IN') : '—'}
                              </div>
                            </div>
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 text-terminal-muted">
                                <Activity className="w-3 h-3" />
                                Max PE Wall
                              </div>
                              <div className="text-terminal-text font-semibold">
                                {entry.max_pe_oi_strike !== null ? entry.max_pe_oi_strike.toLocaleString('en-IN') : '—'}
                              </div>
                            </div>
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 text-terminal-muted">
                                <Activity className="w-3 h-3" />
                                Neg GEX Wall
                              </div>
                              <div className="text-terminal-text font-semibold">
                                {entry.max_negative_gex_strike !== null
                                  ? entry.max_negative_gex_strike.toLocaleString('en-IN')
                                  : '—'}
                              </div>
                            </div>
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 text-terminal-muted">
                                <Activity className="w-3 h-3" />
                                Net GEX
                              </div>
                              <div className={`font-semibold ${(entry.net_gex ?? 0) >= 0 ? 'text-terminal-pe' : 'text-terminal-ce'}`}>
                                {entry.net_gex !== null ? entry.net_gex.toLocaleString('en-IN') : '—'}
                              </div>
                            </div>
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 text-terminal-muted">
                                <Calendar className="w-3 h-3" />
                                Futures Spread
                              </div>
                              <div className="text-terminal-text font-semibold">
                                {entry.futures_spread !== null ? entry.futures_spread.toFixed(2) : '—'}
                              </div>
                            </div>
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 text-terminal-muted">
                                <Bell className="w-3 h-3" />
                                Channels
                              </div>
                              <div className="flex items-center gap-1">
                                {channels.map((c) => (
                                  <span
                                    key={c}
                                    className={`px-1 py-0.5 rounded text-[9px] ${
                                      c === 'toast'
                                        ? 'bg-terminal-atm/20 text-terminal-atm'
                                        : c === 'sound'
                                        ? 'bg-terminal-pe/20 text-terminal-pe'
                                        : 'bg-cyan-500/20 text-cyan-400'
                                    }`}
                                  >
                                    {c}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Pagination — the API pages at page_size; without controls rows
            beyond the first page were unreachable. */}
        {total > 0 && (
          <div className="flex items-center justify-between pt-3 border-t border-terminal-border">
            <span className="text-[10px] font-mono text-terminal-muted">
              {rangeStart}–{rangeEnd} of {total}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono bg-terminal-bg text-terminal-muted hover:text-terminal-text disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Prev
              </button>
              <span className="text-[10px] font-mono text-terminal-muted">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || loading}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono bg-terminal-bg text-terminal-muted hover:text-terminal-text disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
