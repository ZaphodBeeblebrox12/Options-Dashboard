import React, { useState, useEffect } from 'react';
import {
  Bell, Volume2, VolumeX, MessageSquare, Send,
  Clock, Check, ChevronDown, ChevronUp, Play, Timer,
} from 'lucide-react';
import { useAlertSettings, useSounds, AlertRuleConfig, AlertSettings as AlertSettingsType } from '../hooks/useAlerts';
import { SoundUploader } from './SoundUploader';

interface AlertSettingsPanelProps {
  onTestToast?: () => void;
}

const RULE_NAMES: Record<string, string> = {
  'atm_negative_gex_oi_wall': 'ATM + Negative GEX + OI Wall',
  'atm_max_ce_pe_wall': 'ATM Maximum CE/PE Wall',
};

const RULE_DESCRIPTIONS: Record<string, string> = {
  'atm_negative_gex_oi_wall': 'ATM is the max negative GEX wall AND ATM is either max CE or max PE OI wall',
  'atm_max_ce_pe_wall': 'ATM is either the maximum CE OI wall or maximum PE OI wall',
};

const BUILT_IN_SOUNDS = [
  { id: 'chime', name: 'Chime' },
  { id: 'bell', name: 'Bell' },
  { id: 'beep', name: 'Beep' },
  { id: 'alert', name: 'Alert' },
  { id: 'double_beep', name: 'Double Beep' },
];

export const AlertSettingsPanel: React.FC<AlertSettingsPanelProps> = ({ onTestToast }) => {
  const { settings, loading, saving, saveSettings } = useAlertSettings();
  const { sounds, playSound } = useSounds();
  const [localSettings, setLocalSettings] = useState<AlertSettingsType | null>(null);
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [telegramTestResult, setTelegramTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [testingTelegram, setTestingTelegram] = useState(false);

  useEffect(() => {
    if (settings) {
      setLocalSettings(JSON.parse(JSON.stringify(settings)));
    }
  }, [settings]);

  if (loading || !localSettings) {
    return (
      <div className="terminal-panel p-4">
        <div className="flex items-center gap-2 text-terminal-muted text-sm">
          <div className="w-4 h-4 border-2 border-terminal-muted border-t-transparent rounded-full animate-spin" />
          Loading alert settings...
        </div>
      </div>
    );
  }

  const updateRule = (ruleType: string, patch: Partial<AlertRuleConfig>) => {
    setLocalSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        rules: prev.rules.map((r) =>
          r.rule_type === ruleType ? { ...r, ...patch } : r
        ),
      };
    });
  };

  const toggleChannel = (ruleType: string, channel: string) => {
    setLocalSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        rules: prev.rules.map((r) => {
          if (r.rule_type !== ruleType) return r;
          const channels = r.channels.includes(channel)
            ? r.channels.filter((c) => c !== channel)
            : [...r.channels, channel];
          return { ...r, channels };
        }),
      };
    });
  };

  const handleSave = async () => {
    if (!localSettings) return;
    await saveSettings(localSettings);
  };

  const testTelegram = async () => {
    setTestingTelegram(true);
    setTelegramTestResult(null);
    try {
      const res = await fetch('/api/alerts/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localSettings?.telegram),
      });
      const data = await res.json();
      setTelegramTestResult(data);
    } finally {
      setTestingTelegram(false);
    }
  };

  const allSounds = [
    ...BUILT_IN_SOUNDS,
    ...sounds.filter((s) => s.type === 'custom').map((s) => ({ id: s.id, name: s.name })),
  ];

  const toastSec = Math.round((localSettings.toast_duration_ms ?? 6000) / 1000);

  return (
    <div className="terminal-panel space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border">
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4 text-terminal-atm" />
          <span className="text-sm font-bold">Alert Settings</span>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono font-semibold bg-terminal-pe/20 text-terminal-pe hover:bg-terminal-pe/30 transition-colors disabled:opacity-50"
        >
          {saving ? (
            <>
              <div className="w-3 h-3 border-2 border-terminal-pe border-t-transparent rounded-full animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check className="w-3.5 h-3.5" />
              Save
            </>
          )}
        </button>
      </div>

      {/* ── Toast Duration ── */}
      <div className="px-4">
        <div className="flex items-center gap-2 mb-2">
          <Timer className="w-3.5 h-3.5 text-terminal-muted" />
          <span className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">Toast Duration</span>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={3}
            max={15}
            step={1}
            value={toastSec}
            onChange={(e) =>
              setLocalSettings((prev) =>
                prev ? { ...prev, toast_duration_ms: Number(e.target.value) * 1000 } : prev
              )
            }
            className="flex-1 h-1.5 bg-terminal-border rounded-lg appearance-none cursor-pointer"
            style={{ accentColor: '#eab308' }}
          />
          <span className="text-[11px] font-mono text-terminal-text w-12 text-right">
            {toastSec}s
          </span>
        </div>
        <p className="text-[9px] font-mono text-terminal-muted/60 mt-1">
          How long toast notifications stay on screen before auto-dismissing.
        </p>
      </div>

      {/* Global Sound Controls */}
      <div className="px-4">
        <div className="flex items-center gap-3 mb-3">
          {localSettings.sound.master_enabled ? (
            <Volume2 className="w-4 h-4 text-terminal-pe" />
          ) : (
            <VolumeX className="w-4 h-4 text-terminal-muted" />
          )}
          <span className="text-xs font-semibold">Global Sound</span>
          <button
            onClick={() =>
              setLocalSettings((prev) =>
                prev ? { ...prev, sound: { ...prev.sound, master_enabled: !prev.sound.master_enabled } } : prev
              )
            }
            className={`relative w-9 h-5 rounded-full transition-colors ${
              localSettings.sound.master_enabled ? 'bg-terminal-pe' : 'bg-terminal-border'
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                localSettings.sound.master_enabled ? 'translate-x-4.5' : 'translate-x-0.5'
              }`}
            />
          </button>
          <span className="text-[10px] font-mono text-terminal-muted ml-2">
            {localSettings.sound.master_enabled ? 'ON' : 'OFF'}
          </span>
        </div>

        {localSettings.sound.master_enabled && (
          <div className="flex items-center gap-3 pl-7">
            <span className="text-[10px] font-mono text-terminal-muted">Volume</span>
            <input
              type="range"
              min={0}
              max={100}
              value={localSettings.sound.volume_percent}
              onChange={(e) =>
                setLocalSettings((prev) =>
                  prev
                    ? { ...prev, sound: { ...prev.sound, volume_percent: Number(e.target.value) } }
                    : prev
                )
              }
              className="w-32 h-1 bg-terminal-border rounded-lg appearance-none"
              style={{ accentColor: '#eab308' }}
            />
            <span className="text-[10px] font-mono text-terminal-muted w-8">
              {localSettings.sound.volume_percent}%
            </span>
          </div>
        )}
      </div>

      {/* Alert Rules */}
      <div className="px-4 space-y-3">
        <div className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">Alert Rules</div>

        {localSettings.rules.map((rule) => {
          const isExpanded = expandedRule === rule.rule_type;
          const ruleName = RULE_NAMES[rule.rule_type] || rule.rule_type;
          const ruleDesc = RULE_DESCRIPTIONS[rule.rule_type] || '';

          return (
            <div
              key={rule.rule_type}
              className={`border rounded-lg overflow-hidden transition-colors ${
                rule.enabled ? 'border-terminal-border' : 'border-terminal-border/50 opacity-70'
              }`}
            >
              {/* Rule Header */}
              <div
                className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-white/5"
                onClick={() => setExpandedRule(isExpanded ? null : rule.rule_type)}
              >
                <div className="flex items-center gap-2.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      updateRule(rule.rule_type, { enabled: !rule.enabled });
                    }}
                    className={`relative w-8 h-4.5 rounded-full transition-colors ${
                      rule.enabled ? 'bg-terminal-pe' : 'bg-terminal-border'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${
                        rule.enabled ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                  <div>
                    <div className="text-xs font-semibold">{ruleName}</div>
                    <div className="text-[10px] font-mono text-terminal-muted">{ruleDesc}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {rule.enabled && rule.channels.includes('toast') && (
                    <MessageSquare className="w-3.5 h-3.5 text-terminal-atm" title="Toast" />
                  )}
                  {rule.enabled && rule.sound_enabled && (
                    <Volume2 className="w-3.5 h-3.5 text-terminal-pe" title="Sound" />
                  )}
                  {rule.enabled && rule.telegram_enabled && (
                    <Send className="w-3.5 h-3.5 text-cyan-400" title="Telegram" />
                  )}
                  {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-terminal-muted" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-terminal-muted" />
                  )}
                </div>
              </div>

              {/* Expanded Config */}
              {isExpanded && (
                <div className="px-3 pb-3 space-y-3 border-t border-terminal-border/50">
                  {/* Cooldown */}
                  <div className="pt-2 flex items-center gap-3">
                    <Clock className="w-3.5 h-3.5 text-terminal-muted" />
                    <span className="text-[10px] font-mono text-terminal-muted">Cooldown</span>
                    <select
                      value={rule.cooldown_seconds}
                      onChange={(e) =>
                        updateRule(rule.rule_type, { cooldown_seconds: Number(e.target.value) })
                      }
                      className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-[10px] font-mono"
                    >
                      <option value={60}>1 min</option>
                      <option value={120}>2 min</option>
                      <option value={180}>3 min</option>
                      <option value={300}>5 min</option>
                      <option value={600}>10 min</option>
                      <option value={900}>15 min</option>
                    </select>
                  </div>

                  {/* Channels */}
                  <div className="space-y-2">
                    <div className="text-[10px] font-mono text-terminal-muted uppercase">Channels</div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => toggleChannel(rule.rule_type, 'toast')}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-mono transition-colors ${
                          rule.channels.includes('toast')
                            ? 'bg-terminal-atm/20 text-terminal-atm border border-terminal-atm/30'
                            : 'bg-terminal-bg text-terminal-muted border border-terminal-border'
                        }`}
                      >
                        <MessageSquare className="w-3 h-3" />
                        Toast
                      </button>

                      <button
                        onClick={() => {
                          updateRule(rule.rule_type, { sound_enabled: !rule.sound_enabled });
                          toggleChannel(rule.rule_type, 'sound');
                        }}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-mono transition-colors ${
                          rule.sound_enabled
                            ? 'bg-terminal-pe/20 text-terminal-pe border border-terminal-pe/30'
                            : 'bg-terminal-bg text-terminal-muted border border-terminal-border'
                        }`}
                      >
                        <Volume2 className="w-3 h-3" />
                        Sound
                      </button>

                      <button
                        onClick={() => {
                          updateRule(rule.rule_type, { telegram_enabled: !rule.telegram_enabled });
                          toggleChannel(rule.rule_type, 'telegram');
                        }}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-mono transition-colors ${
                          rule.telegram_enabled
                            ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                            : 'bg-terminal-bg text-terminal-muted border border-terminal-border'
                        }`}
                      >
                        <Send className="w-3 h-3" />
                        Telegram
                      </button>
                    </div>
                  </div>

                  {/* Sound Selection */}
                  {rule.sound_enabled && (
                    <div className="space-y-2">
                      <div className="text-[10px] font-mono text-terminal-muted uppercase">Sound</div>
                      <div className="flex items-center gap-2">
                        <select
                          value={rule.custom_sound_id || rule.sound_choice}
                          onChange={(e) => {
                            const val = e.target.value;
                            const isCustom = sounds.some((s) => s.id === val && s.type === 'custom');
                            if (isCustom) {
                              updateRule(rule.rule_type, { custom_sound_id: val, sound_choice: 'alert' });
                            } else {
                              updateRule(rule.rule_type, { sound_choice: val, custom_sound_id: null });
                            }
                          }}
                          className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-[10px] font-mono flex-1"
                        >
                          <optgroup label="Built-in">
                            {BUILT_IN_SOUNDS.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </optgroup>
                          {sounds.filter((s) => s.type === 'custom').length > 0 && (
                            <optgroup label="Custom">
                              {sounds
                                .filter((s) => s.type === 'custom')
                                .map((s) => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                            </optgroup>
                          )}
                        </select>
                        <button
                          onClick={() => {
                            const soundId = rule.custom_sound_id || rule.sound_choice;
                            const vol = (localSettings.sound.volume_percent || 80) / 100;
                            playSound(soundId, vol);
                          }}
                          className="p-1.5 rounded bg-terminal-bg border border-terminal-border hover:bg-white/5 text-terminal-muted"
                          title="Test sound"
                        >
                          <Play className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Telegram Config */}
      <div className="px-4 space-y-3">
        <div className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">Telegram</div>
        <div className="flex items-center gap-3">
          <button
            onClick={() =>
              setLocalSettings((prev) =>
                prev
                  ? { ...prev, telegram: { ...prev.telegram, enabled: !prev.telegram.enabled } }
                  : prev
              )
            }
            className={`relative w-9 h-5 rounded-full transition-colors ${
              localSettings.telegram.enabled ? 'bg-cyan-500' : 'bg-terminal-border'
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                localSettings.telegram.enabled ? 'translate-x-4.5' : 'translate-x-0.5'
              }`}
            />
          </button>
          <span className="text-[10px] font-mono text-terminal-muted">
            {localSettings.telegram.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>

        {localSettings.telegram.enabled && (
          <div className="space-y-2 pl-7">
            <input
              type="password"
              placeholder="Bot Token"
              value={localSettings.telegram.bot_token}
              onChange={(e) =>
                setLocalSettings((prev) =>
                  prev
                    ? { ...prev, telegram: { ...prev.telegram, bot_token: e.target.value } }
                    : prev
                )
              }
              className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-1.5 text-[10px] font-mono text-terminal-text placeholder-terminal-muted/50 focus:outline-none focus:border-cyan-500"
            />
            <input
              type="text"
              placeholder="Chat ID"
              value={localSettings.telegram.chat_id}
              onChange={(e) =>
                setLocalSettings((prev) =>
                  prev
                    ? { ...prev, telegram: { ...prev.telegram, chat_id: e.target.value } }
                    : prev
                )
              }
              className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-1.5 text-[10px] font-mono text-terminal-text placeholder-terminal-muted/50 focus:outline-none focus:border-cyan-500"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={testTelegram}
                disabled={testingTelegram}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-mono bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 transition-colors disabled:opacity-50"
              >
                <Send className="w-3 h-3" />
                {testingTelegram ? 'Testing...' : 'Test Message'}
              </button>
              {telegramTestResult && (
                <span
                  className={`text-[10px] font-mono ${
                    telegramTestResult.success ? 'text-terminal-pe' : 'text-terminal-ce'
                  }`}
                >
                  {telegramTestResult.message}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Custom Sounds Upload */}
      <div className="px-4 pb-4">
        <div className="text-xs font-semibold text-terminal-muted uppercase tracking-wider mb-2">Custom Sounds</div>
        <SoundUploader />
      </div>

      {/* Test Toast */}
      <div className="px-4 pb-4 space-y-2">
        <div className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">Test Notification</div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onTestToast?.()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-mono bg-terminal-atm/20 text-terminal-atm border border-terminal-atm/30 hover:bg-terminal-atm/30 transition-colors"
          >
            <Bell className="w-3 h-3" />
            Test Toast
          </button>
          <span className="text-[10px] font-mono text-terminal-muted">
            Triggers a real toast at the top-right with slide-in animation
          </span>
        </div>
      </div>
    </div>
  );
};
