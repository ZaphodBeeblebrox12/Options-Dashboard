import React, { useState } from 'react';
import { History, ChevronDown, ChevronUp, Bell, Calendar, Target, TrendingUp, Activity } from 'lucide-react';
import { useAlertHistory, AlertHistoryEntry } from '../hooks/useAlerts';

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
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { history, total, loading } = useAlertHistory(indexName, selectedDate || undefined);

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
            {total} total
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-[10px] font-mono text-terminal-text"
          />
          {selectedDate && (
            <button
              onClick={() => setSelectedDate('')}
              className="text-[10px] font-mono text-terminal-muted hover:text-terminal-text"
            >
              Clear
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
      </div>
    </div>
  );
};
