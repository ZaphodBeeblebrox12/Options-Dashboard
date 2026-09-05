import React, { useState, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import { AlertSettingsPanel } from './AlertSettings';
import { InstrumentsTab } from './InstrumentsTab';
import { ConnectionsTab } from './ConnectionsTab';
import { AnalyticsTab } from './AnalyticsTab';
import { DisplayTab } from './DisplayTab';
import './settings-typography.css';

type Tab = 'stocks' | 'alerts' | 'analytics' | 'display' | 'connections';

interface SettingsModalProps {
  onClose: () => void;
  fullMode: boolean;
  onFullModeChange: (v: boolean) => void;
  onTestToast: () => void;
}

const CONFIGURE_TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'stocks', label: 'Instruments', icon: '📈' },
  { id: 'alerts', label: 'Alerts', icon: '🔔' },
  { id: 'analytics', label: 'Analytics', icon: '∑' },
  { id: 'display', label: 'Display', icon: '🖥' },
];
const MONITOR_TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'connections', label: 'Connections', icon: '🔌' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, fullMode, onFullModeChange, onTestToast }) => {
  const [tab, setTab] = useState<Tab>('stocks');
  const [armed, setArmed] = useState(true);
  const [scope, setScope] = useState<'viewed' | 'all'>('viewed');
  const [rearm, setRearm] = useState(300);
  const [flash, setFlash] = useState('');

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setArmed(d.alerts_armed !== false);
        setScope(d.alert_scope === 'all' ? 'all' : 'viewed');
        setRearm(d.alert_rearm_seconds ?? 300);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const flashSaved = useCallback(() => {
    setFlash('Saved');
    setTimeout(() => setFlash(''), 1500);
  }, []);

  const toggleArmed = async () => {
    const next = !armed;
    setArmed(next);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alerts_armed: next }),
      });
      flashSaved();
    } catch {}
  };

  const setScopeAndSave = async (v: 'viewed' | 'all') => {
    setScope(v);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert_scope: v }),
      });
      // tell App.tsx to re-read the scope immediately
      window.dispatchEvent(new CustomEvent('app-settings-changed'));
      flashSaved();
    } catch {}
  };

  const saveRearm = async () => {
    const v = Math.max(0, Math.min(3600, parseInt(String(rearm)) || 60));
    setRearm(v);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert_rearm_seconds: v }),
      });
      flashSaved();
    } catch {}
  };

  const renderTab = () => {
    switch (tab) {
      case 'stocks':
        return <InstrumentsTab />;
      case 'alerts':
        return (
          <div className="space-y-3">
            <div className="border border-terminal-border rounded-lg px-4 py-3 flex items-center justify-between bg-terminal-bg">
              <div>
                <div className="st-card-title">Alerts master switch</div>
                <div className="st-helper mt-0.5">Disarms all rules without losing their configuration</div>
              </div>
              <button
                onClick={toggleArmed}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${armed ? 'bg-terminal-pe' : 'bg-terminal-border'}`}
              >
                <span className={`absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${armed ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
            </div>
            <div className="border border-terminal-border rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3 bg-terminal-bg">
              <div className="min-w-[220px]">
                <div className="st-card-title">Notification scope</div>
                <div className="st-helper mt-0.5">Toasts and sounds fire for the symbol you are viewing, or for every symbol</div>
              </div>
              <div className="inline-flex border border-terminal-border rounded-lg overflow-hidden shrink-0">
                <button
                  onClick={() => setScopeAndSave('viewed')}
                  className={`st-seg px-3.5 py-2 transition-colors ${scope === 'viewed' ? 'bg-white/10 text-terminal-text font-semibold' : 'text-[var(--st-text-2)] hover:bg-white/5'}`}
                >
                  Viewed symbol
                </button>
                <button
                  onClick={() => setScopeAndSave('all')}
                  className={`st-seg px-3.5 py-2 transition-colors ${scope === 'all' ? 'bg-white/10 text-terminal-text font-semibold' : 'text-[var(--st-text-2)] hover:bg-white/5'}`}
                >
                  All symbols
                </button>
              </div>
            </div>
            <div className="border border-terminal-border rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3 bg-terminal-bg">
              <div className="min-w-[220px]">
                <div className="st-card-title">Alert rearm</div>
                <div className="st-helper mt-0.5">
                  After a rule fires it stays silent while the condition holds — it never re-alerts the same condition. Once the condition clears, the rule re-arms after this many seconds (0 = immediately).
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <input
                  type="number" min={0} max={3600} step={30} value={rearm}
                  onChange={(e) => setRearm(Number(e.target.value))}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveRearm(); }}
                  className="st-input w-24 bg-terminal-bg border border-terminal-border rounded-lg px-3 py-2 text-terminal-text focus:outline-none focus:border-terminal-atm"
                />
                <span className="st-num">sec</span>
                <button onClick={saveRearm} className="st-btn px-3 py-2 rounded-lg border border-terminal-border hover:bg-white/5">
                  Save
                </button>
              </div>
            </div>
            <div className="border border-terminal-border rounded-lg overflow-hidden">
              <AlertSettingsPanel onTestToast={onTestToast} />
            </div>
          </div>
        );
      case 'analytics':
        return <AnalyticsTab onSaved={flashSaved} />;
      case 'display':
        return <DisplayTab fullMode={fullMode} onFullModeChange={onFullModeChange} />;
      case 'connections':
        return <ConnectionsTab />;
    }
  };

  const tabBtn = (t: { id: Tab; label: string; icon: string }, isMonitor = false) => (
    <button
      key={t.id}
      onClick={() => setTab(t.id)}
      className={`st-nav w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
        tab === t.id ? 'on bg-white/10' : 'hover:bg-white/5'
      }`}
    >
      <span className="w-4 text-center text-[13px]">{t.icon}</span>
      {t.label}
      {isMonitor && tab !== 'connections' && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-terminal-pe animate-pulse" />}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-4 sm:pt-8 px-2 sm:px-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-4xl h-[86vh] flex terminal-panel overflow-hidden rounded-lg settings-scope">
        <nav className="w-44 sm:w-48 shrink-0 border-r border-terminal-border p-2 space-y-0.5 overflow-y-auto">
          <div className="st-nav-group px-3 pt-2 pb-1.5">Configure</div>
          {CONFIGURE_TABS.map((t) => tabBtn(t))}
          <div className="st-nav-group px-3 pt-3 pb-1.5">Monitor</div>
          {MONITOR_TABS.map((t) => tabBtn(t, true))}
        </nav>
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto p-4 pr-12">{renderTab()}</div>
          <footer className="st-foot flex items-center gap-2 px-4 py-2.5 border-t border-terminal-border">
            <span className={flash ? 'text-terminal-pe' : ''}>{flash || 'Autosaves on change'}</span>
            <span className="ml-auto">Esc to close · Ctrl+, reopens</span>
          </footer>
        </div>
        <button onClick={onClose} className="absolute top-3 right-3 p-1 rounded hover:bg-white/10 text-terminal-muted z-10">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
