import React, { useState, useEffect } from 'react';
import { X, Bell } from 'lucide-react';
import { AlertFiring } from '../hooks/useAlerts';

interface AlertToastProps {
  alerts: AlertFiring[];
  onDismiss: (timestamp: string) => void;
  duration?: number; // ms, defaults to 6000
}

const RULE_COLORS: Record<string, { accent: string; glow: string; text: string; bg: string }> = {
  'atm_negative_gex_oi_wall': {
    accent: 'border-l-cyan-400',
    glow: 'shadow-cyan-500/10',
    text: 'text-cyan-300',
    bg: 'bg-slate-900/90',
  },
  'atm_max_ce_pe_wall': {
    accent: 'border-l-amber-400',
    glow: 'shadow-amber-500/10',
    text: 'text-amber-300',
    bg: 'bg-slate-900/90',
  },
};

const ToastItem: React.FC<{
  alert: AlertFiring;
  onDismiss: (ts: string) => void;
  duration: number;
}> = ({ alert, onDismiss, duration }) => {
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));

    const interval = 50;
    const step = 100 / (duration / interval);
    const timer = setInterval(() => {
      setProgress((p) => {
        const next = p - step;
        if (next <= 0) { clearInterval(timer); return 0; }
        return next;
      });
    }, interval);

    const dismissTimer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(alert.timestamp), 300);
    }, duration);

    return () => { clearInterval(timer); clearTimeout(dismissTimer); };
  }, [alert.timestamp, onDismiss, duration]);

  const colors = RULE_COLORS[alert.rule_type] || {
    accent: 'border-l-slate-400',
    glow: 'shadow-black/30',
    text: 'text-slate-300',
    bg: 'bg-slate-900/90',
  };

  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    } catch { return ts; }
  };

  return (
    <div
      className={`${colors.bg} backdrop-blur-md border-l-[3px] ${colors.accent} rounded-md shadow-lg ${colors.glow} overflow-hidden pointer-events-auto transition-all duration-300 ease-out ${
        visible ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'
      }`}
    >
      {/* ── Compact Header ── */}
      <div className="flex items-center justify-between px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Bell className={`w-3 h-3 ${colors.text} shrink-0`} />
          <span className="text-[10px] font-bold text-slate-200 truncate">
            {alert.index_name} Alert
          </span>
          <span className="text-[9px] font-mono text-slate-500 shrink-0">
            {formatTime(alert.timestamp)}
          </span>
        </div>
        <button
          onClick={() => { setVisible(false); setTimeout(() => onDismiss(alert.timestamp), 300); }}
          className="p-0.5 rounded hover:bg-white/10 text-slate-500 hover:text-white transition-colors shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* ── Rule Name ── */}
      <div className={`px-2.5 pb-1 text-[11px] font-semibold ${colors.text} leading-tight`}>
        {alert.rule_name}
      </div>

      {/* ── Compact Metrics Row ── */}
      <div className="px-2.5 pb-1.5 flex items-center gap-3 text-[10px] font-mono">
        <div className="flex items-center gap-1">
          <span className="text-slate-500">S</span>
          <span className="text-slate-200 font-medium">
            {alert.spot !== null ? alert.spot.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-slate-500">A</span>
          <span className="text-slate-200 font-bold">
            {alert.atm_strike !== null ? alert.atm_strike.toLocaleString('en-IN') : '—'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-slate-500">CE</span>
          <span className="text-slate-200">
            {alert.max_ce_oi_strike !== null ? alert.max_ce_oi_strike.toLocaleString('en-IN') : '—'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-slate-500">PE</span>
          <span className="text-slate-200">
            {alert.max_pe_oi_strike !== null ? alert.max_pe_oi_strike.toLocaleString('en-IN') : '—'}
          </span>
        </div>
      </div>

      {/* ── Tiny Channel Dots ── */}
      <div className="px-2.5 pb-1.5 flex items-center gap-1.5">
        {alert.channels_fired.includes('toast') && (
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" title="Toast" />
        )}
        {alert.channels_fired.includes('sound') && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="Sound" />
        )}
        {alert.channels_fired.includes('telegram') && (
          <span className="w-1.5 h-1.5 rounded-full bg-sky-400" title="Telegram" />
        )}
      </div>

      {/* ── Thin Progress Bar ── */}
      <div className="h-[2px] bg-white/5">
        <div
          className="h-full bg-white/25 transition-none"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
};

export const AlertToastContainer: React.FC<AlertToastProps> = ({ alerts, onDismiss, duration = 6000 }) => {
  if (alerts.length === 0) return null;

  return (
    <div className="fixed top-3 right-2 z-[999] space-y-1.5 w-[260px] sm:w-[300px] pointer-events-none">
      {alerts.map((alert) => (
        <ToastItem key={alert.timestamp} alert={alert} onDismiss={onDismiss} duration={duration} />
      ))}
    </div>
  );
};
