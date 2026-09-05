import React, { useState, useEffect } from 'react';
import { X, Bell, Send, Volume2, Settings, Plus, Trash2, ToggleLeft, ToggleRight, Check, History } from 'lucide-react';
import { AlertRule, TelegramSettings } from '../hooks/useAlerts';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  rules: AlertRule[];
  history: any[];
  telegramSettings: TelegramSettings;
  soundEnabled: boolean;
  volume: number;
  selectedSound: string;
  onUpdateRule: (id: number, updates: Partial<AlertRule>) => void;
  onCreateRule: (data: Partial<AlertRule>) => void;
  onDeleteRule: (id: number) => void;
  onSaveTelegram: (settings: TelegramSettings) => void;
  onTestTelegram: () => Promise<boolean>;
  onSetSoundEnabled: (v: boolean) => void;
  onSetVolume: (v: number) => void;
  onSetSelectedSound: (v: string) => void;
  onTestSound: () => void;
  onFetchHistory: () => void;
}

type Tab = 'alerts' | 'telegram' | 'sound' | 'history';

const CONDITIONS = [
  { value: 'max_oi_ce_atm', label: 'Max OI CE = ATM Strike' },
  { value: 'max_oi_pe_atm', label: 'Max OI PE = ATM Strike' },
  { value: 'max_oi_pe_or_ce_atm', label: 'Max OI (CE or PE) = ATM' },
  { value: 'max_negative_gex_strike', label: 'Max Negative GEX Strike' },
  { value: 'net_gex_threshold', label: 'Net GEX Threshold' },
  { value: 'atm_max_oi_and_negative_gex', label: 'ATM Max OI + Negative GEX' },
];

const SOUNDS = [
  { value: 'chime', label: 'Chime' },
  { value: 'bell', label: 'Bell' },
  { value: 'beep', label: 'Beep' },
];

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  isOpen, onClose, rules, history, telegramSettings, soundEnabled, volume, selectedSound,
  onUpdateRule, onCreateRule, onDeleteRule, onSaveTelegram, onTestTelegram,
  onSetSoundEnabled, onSetVolume, onSetSelectedSound, onTestSound, onFetchHistory,
}) => {
  const [tab, setTab] = useState<Tab>('alerts');
  const [tgForm, setTgForm] = useState<TelegramSettings>(telegramSettings);
  const [tgStatus, setTgStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [newOpen, setNewOpen] = useState(false);
  const [newRule, setNewRule] = useState<Partial<AlertRule>>({
    name: '', condition_type: 'max_oi_ce_atm', index_name: 'NIFTY',
    cooldown_seconds: 300, enabled: true, sound_enabled: true, telegram_enabled: false, parameters: {},
  });

  useEffect(() => { setTgForm(telegramSettings); }, [telegramSettings]);
  useEffect(() => { if (tab === 'history') onFetchHistory(); }, [tab, onFetchHistory]);
  if (!isOpen) return null;

  const handleTestTg = async () => {
    setTgStatus('sending');
    const ok = await onTestTelegram();
    setTgStatus(ok ? 'success' : 'error');
    setTimeout(() => setTgStatus('idle'), 3000);
  };

  const handleCreate = () => {
    if (!newRule.name) return;
    onCreateRule(newRule);
    setNewOpen(false);
    setNewRule({ name: '', condition_type: 'max_oi_ce_atm', index_name: 'NIFTY', cooldown_seconds: 300, enabled: true, sound_enabled: true, telegram_enabled: false, parameters: {} });
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-terminal-panel border border-terminal-border rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-terminal-atm" />
            <h2 className="text-sm font-bold tracking-wide">Settings</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10 transition-colors">
            <X className="w-4 h-4 text-terminal-muted" />
          </button>
        </div>

        <div className="flex border-b border-terminal-border">
          {[
            { id: 'alerts' as Tab, label: 'Alerts', icon: Bell },
            { id: 'telegram' as Tab, label: 'Telegram', icon: Send },
            { id: 'sound' as Tab, label: 'Sound', icon: Volume2 },
            { id: 'history' as Tab, label: 'History', icon: History },
          ].map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-mono font-semibold transition-colors border-b-2 ${
                tab === t.id ? 'text-terminal-atm border-terminal-atm' : 'text-terminal-muted border-transparent hover:text-terminal-text'
              }`}>
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'alerts' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-terminal-text uppercase tracking-wider">Alert Rules</h3>
                <button onClick={() => setNewOpen(true)}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-terminal-pe/20 text-terminal-pe text-xs font-mono hover:bg-terminal-pe/30 transition-colors">
                  <Plus className="w-3 h-3" /> Add Rule
                </button>
              </div>

              {newOpen && (
                <div className="bg-terminal-bg border border-terminal-border rounded-lg p-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-mono text-terminal-muted uppercase">Name</label>
                      <input type="text" value={newRule.name}
                        onChange={(e) => setNewRule({ ...newRule, name: e.target.value })}
                        className="w-full bg-terminal-panel border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text focus:outline-none focus:border-terminal-atm"
                        placeholder="Alert name" />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-terminal-muted uppercase">Condition</label>
                      <select value={newRule.condition_type}
                        onChange={(e) => setNewRule({ ...newRule, condition_type: e.target.value })}
                        className="w-full bg-terminal-panel border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text focus:outline-none focus:border-terminal-atm">
                        {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-terminal-muted uppercase">Index</label>
                      <select value={newRule.index_name}
                        onChange={(e) => setNewRule({ ...newRule, index_name: e.target.value })}
                        className="w-full bg-terminal-panel border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text focus:outline-none focus:border-terminal-atm">
                        <option value="NIFTY">NIFTY</option>
                        <option value="SENSEX">SENSEX</option>
                        <option value="ALL">All Indices</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-terminal-muted uppercase">Cooldown (sec)</label>
                      <input type="number" value={newRule.cooldown_seconds}
                        onChange={(e) => setNewRule({ ...newRule, cooldown_seconds: Number(e.target.value) })}
                        className="w-full bg-terminal-panel border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text focus:outline-none focus:border-terminal-atm" />
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-1.5 text-xs font-mono text-terminal-text cursor-pointer">
                      <input type="checkbox" checked={newRule.sound_enabled}
                        onChange={(e) => setNewRule({ ...newRule, sound_enabled: e.target.checked })} className="accent-terminal-pe" /> Sound
                    </label>
                    <label className="flex items-center gap-1.5 text-xs font-mono text-terminal-text cursor-pointer">
                      <input type="checkbox" checked={newRule.telegram_enabled}
                        onChange={(e) => setNewRule({ ...newRule, telegram_enabled: e.target.checked })} className="accent-terminal-pe" /> Telegram
                    </label>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setNewOpen(false)} className="px-3 py-1 rounded text-xs font-mono text-terminal-muted hover:text-terminal-text transition-colors">Cancel</button>
                    <button onClick={handleCreate} className="px-3 py-1 rounded bg-terminal-pe/20 text-terminal-pe text-xs font-mono hover:bg-terminal-pe/30 transition-colors">Create</button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {rules.map((rule) => (
                  <div key={rule.id}
                    className={`flex items-center justify-between bg-terminal-bg border rounded-lg px-3 py-2.5 transition-colors ${
                      rule.enabled ? 'border-terminal-border' : 'border-terminal-border/50 opacity-60'
                    }`}>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-terminal-text">{rule.name}</div>
                      <div className="text-[10px] font-mono text-terminal-muted">
                        {CONDITIONS.find((c) => c.value === rule.condition_type)?.label || rule.condition_type} • {rule.index_name} • {rule.cooldown_seconds}s cooldown
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => onUpdateRule(rule.id, { telegram_enabled: !rule.telegram_enabled })}
                        className={`p-1 rounded transition-colors ${rule.telegram_enabled ? 'text-terminal-pe' : 'text-terminal-muted'}`} title="Toggle Telegram">
                        <Send className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => onUpdateRule(rule.id, { sound_enabled: !rule.sound_enabled })}
                        className={`p-1 rounded transition-colors ${rule.sound_enabled ? 'text-terminal-pe' : 'text-terminal-muted'}`} title="Toggle Sound">
                        <Volume2 className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => onUpdateRule(rule.id, { enabled: !rule.enabled })}
                        className="p-1 rounded transition-colors" title="Toggle Enabled">
                        {rule.enabled ? <ToggleRight className="w-5 h-5 text-terminal-pe" /> : <ToggleLeft className="w-5 h-5 text-terminal-muted" />}
                      </button>
                      <button onClick={() => onDeleteRule(rule.id)}
                        className="p-1 rounded hover:bg-terminal-ce/20 text-terminal-muted hover:text-terminal-ce transition-colors" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
                {rules.length === 0 && (
                  <div className="text-center py-8 text-terminal-muted text-xs font-mono">No alert rules configured</div>
                )}
              </div>
            </div>
          )}

          {tab === 'telegram' && (
            <div className="space-y-4">
              <div className="bg-terminal-bg border border-terminal-border rounded-lg p-3 space-y-3">
                <h3 className="text-xs font-bold text-terminal-text uppercase tracking-wider mb-3">Telegram Bot</h3>
                <div>
                  <label className="text-[10px] font-mono text-terminal-muted uppercase">Bot Token</label>
                  <input type="password" value={tgForm.bot_token}
                    onChange={(e) => setTgForm({ ...tgForm, bot_token: e.target.value })}
                    className="w-full bg-terminal-panel border border-terminal-border rounded px-2 py-1.5 text-xs font-mono text-terminal-text focus:outline-none focus:border-terminal-atm"
                    placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-terminal-muted uppercase">Chat ID</label>
                  <input type="text" value={tgForm.chat_id}
                    onChange={(e) => setTgForm({ ...tgForm, chat_id: e.target.value })}
                    className="w-full bg-terminal-panel border border-terminal-border rounded px-2 py-1.5 text-xs font-mono text-terminal-text focus:outline-none focus:border-terminal-atm"
                    placeholder="-1001234567890" />
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs font-mono text-terminal-text cursor-pointer">
                    <input type="checkbox" checked={tgForm.enabled}
                      onChange={(e) => setTgForm({ ...tgForm, enabled: e.target.checked })} className="accent-terminal-pe" /> Enabled
                  </label>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => onSaveTelegram(tgForm)}
                    className="px-3 py-1.5 rounded bg-terminal-pe/20 text-terminal-pe text-xs font-mono hover:bg-terminal-pe/30 transition-colors">Save</button>
                  <button onClick={handleTestTg} disabled={tgStatus === 'sending'}
                    className="flex items-center gap-1 px-3 py-1.5 rounded bg-terminal-atm/20 text-terminal-atm text-xs font-mono hover:bg-terminal-atm/30 transition-colors disabled:opacity-50">
                    {tgStatus === 'success' ? <Check className="w-3 h-3" /> : <Send className="w-3 h-3" />}
                    {tgStatus === 'sending' ? 'Sending...' : tgStatus === 'success' ? 'Sent!' : tgStatus === 'error' ? 'Failed' : 'Test Message'}
                  </button>
                </div>
                <p className="text-[10px] font-mono text-terminal-muted leading-relaxed">
                  1. Create bot with <a href="https://t.me/BotFather" target="_blank" rel="noopener" className="text-terminal-atm hover:underline">@BotFather</a><br/>
                  2. Get Chat ID from <a href="https://t.me/userinfobot" target="_blank" rel="noopener" className="text-terminal-atm hover:underline">@userinfobot</a>
                </p>
              </div>
            </div>
          )}

          {tab === 'sound' && (
            <div className="space-y-4">
              <div className="bg-terminal-bg border border-terminal-border rounded-lg p-3 space-y-4">
                <h3 className="text-xs font-bold text-terminal-text uppercase tracking-wider">Sound Alerts</h3>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs font-mono text-terminal-text cursor-pointer">
                    <input type="checkbox" checked={soundEnabled}
                      onChange={(e) => onSetSoundEnabled(e.target.checked)} className="accent-terminal-pe" /> Enable Sound Alerts
                  </label>
                </div>
                <div>
                  <label className="text-[10px] font-mono text-terminal-muted uppercase">Alert Sound</label>
                  <div className="flex gap-2 mt-1">
                    {SOUNDS.map((s) => (
                      <button key={s.value} onClick={() => onSetSelectedSound(s.value)}
                        className={`px-3 py-1.5 rounded text-xs font-mono transition-colors ${
                          selectedSound === s.value ? 'bg-terminal-pe/20 text-terminal-pe border border-terminal-pe/30' : 'bg-terminal-panel text-terminal-muted border border-terminal-border hover:text-terminal-text'
                        }`}>{s.label}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-mono text-terminal-muted uppercase">Volume: {Math.round(volume * 100)}%</label>
                  <input type="range" min={0} max={1} step={0.05} value={volume}
                    onChange={(e) => onSetVolume(Number(e.target.value))}
                    className="w-full h-1.5 bg-terminal-border rounded-lg appearance-none cursor-pointer mt-2" style={{ accentColor: '#eab308' }} />
                </div>
                <button onClick={onTestSound}
                  className="px-3 py-1.5 rounded bg-terminal-atm/20 text-terminal-atm text-xs font-mono hover:bg-terminal-atm/30 transition-colors">Test Sound</button>
              </div>
            </div>
          )}

          {tab === 'history' && (
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-terminal-text uppercase tracking-wider">Alert History</h3>
              <div className="space-y-2">
                {history.map((h) => (
                  <div key={h.id} className="bg-terminal-bg border border-terminal-border rounded-lg px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-terminal-text">{h.rule_name}</span>
                      <span className="text-[9px] font-mono text-terminal-muted">{new Date(h.created_at).toLocaleString('en-IN')}</span>
                    </div>
                    <div className="text-[10px] font-mono text-terminal-muted mt-1">{h.index_name}</div>
                    <div className="text-[10px] font-mono text-terminal-text mt-1">
                      {h.sent_telegram ? '✓ Telegram' : '— Telegram'}
                    </div>
                  </div>
                ))}
                {history.length === 0 && (
                  <div className="text-center py-8 text-terminal-muted text-xs font-mono">No alert history yet</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
