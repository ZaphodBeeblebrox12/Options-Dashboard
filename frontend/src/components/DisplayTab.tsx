import React from 'react';
import { SettingsSwitch } from './SettingsSwitch';
import {
  COMPACT_OPTION_CHAIN_COLUMNS,
  FULL_OPTION_CHAIN_COLUMNS,
  OPTION_CHAIN_COLUMN_LABELS,
  type OptionChainColumnKey,
  type OptionChainColumnVisibility,
} from './optionChainColumns';

interface DisplayTabProps {
  fullMode: boolean;
  onFullModeChange: (v: boolean) => void;
  columnVisibility: OptionChainColumnVisibility;
  onColumnVisibilityChange: (next: OptionChainColumnVisibility) => void;
  highlightHighestVolume: boolean;
  onHighlightHighestVolumeChange: (enabled: boolean) => void;
  hideZeroVolumeStrikes: boolean;
  onHideZeroVolumeStrikesChange: (enabled: boolean) => void;
}

const CORE_COLUMNS: OptionChainColumnKey[] = ['oiChange', 'oiChangePct', 'volume', 'ltp', 'oi'];
const GREEK_COLUMNS: OptionChainColumnKey[] = ['iv', 'delta', 'gamma'];

export const DisplayTab: React.FC<DisplayTabProps> = ({
  fullMode,
  onFullModeChange,
  columnVisibility,
  onColumnVisibilityChange,
  highlightHighestVolume,
  onHighlightHighestVolumeChange,
  hideZeroVolumeStrikes,
  onHideZeroVolumeStrikesChange,
}) => {
  const matchesPreset = (preset: OptionChainColumnVisibility) =>
    (Object.keys(preset) as OptionChainColumnKey[]).every((key) => columnVisibility[key] === preset[key]);
  const compactActive = !fullMode && matchesPreset(COMPACT_OPTION_CHAIN_COLUMNS);
  const fullActive = fullMode && matchesPreset(FULL_OPTION_CHAIN_COLUMNS);

  const toggleColumn = (key: OptionChainColumnKey, checked: boolean) => {
    const next = { ...columnVisibility, [key]: checked };
    // Keep at least one market-data field visible on each side of the chain.
    if (CORE_COLUMNS.every((coreKey) => !next[coreKey])) return;
    onColumnVisibilityChange(next);
  };

  const renderColumn = (key: OptionChainColumnKey, description?: string) => (
      <label
        key={key}
        className="flex cursor-pointer items-center justify-between gap-4 py-2.5"
      >
        <span className="min-w-0">
          <span className="block st-label">{OPTION_CHAIN_COLUMN_LABELS[key]}</span>
          {description && <span className="block st-helper mt-0.5">{description}</span>}
        </span>
        <input
          type="checkbox"
          checked={columnVisibility[key]}
          onChange={(event) => toggleColumn(key, event.target.checked)}
          className="h-4 w-4 shrink-0 accent-yellow-500"
        />
      </label>
    );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="st-section mb-1">Display</h3>
        <p className="st-helper">Column preferences are saved in this browser and apply to the desktop option chain.</p>
      </div>

      <div className="border border-terminal-border rounded-lg p-4">
        <div className="st-card-title mb-3">Option chain presets</div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => { onFullModeChange(false); onColumnVisibilityChange({ ...COMPACT_OPTION_CHAIN_COLUMNS }); }}
            aria-pressed={compactActive}
            className={`st-seg px-4 py-2 rounded-lg border transition-colors ${compactActive ? 'border-terminal-atm/40 bg-terminal-atm/10 text-terminal-atm font-semibold' : 'border-terminal-border text-[var(--st-text-2)] hover:bg-white/5'}`}
          >
            Compact
          </button>
          <button
            onClick={() => { onFullModeChange(true); onColumnVisibilityChange({ ...FULL_OPTION_CHAIN_COLUMNS }); }}
            aria-pressed={fullActive}
            className={`st-seg px-4 py-2 rounded-lg border transition-colors ${fullActive ? 'border-terminal-atm/40 bg-terminal-atm/10 text-terminal-atm font-semibold' : 'border-terminal-border text-[var(--st-text-2)] hover:bg-white/5'}`}
          >
            Full
          </button>
          {!compactActive && !fullActive && (
            <span className="inline-flex items-center px-2 text-[10px] font-mono text-terminal-muted">Custom</span>
          )}
        </div>
        <p className="st-helper mt-3">Presets are starting points. You can turn individual metrics on or off below.</p>
      </div>

      <div className="border border-terminal-border rounded-lg p-4">
        <div className="st-card-title mb-1">Core columns</div>
        <p className="st-helper mb-2">These metrics appear symmetrically on both CE and PE sides.</p>
        {CORE_COLUMNS.map((key) => renderColumn(key))}
      </div>

      <div className="border border-terminal-border rounded-lg p-4">
        <div className="st-card-title mb-1">Greeks</div>
        <p className="st-helper mb-2">Add only the Greeks you need; the chain reflows automatically.</p>
        {GREEK_COLUMNS.map((key) => renderColumn(key))}
      </div>

      <div className="border border-terminal-border rounded-lg p-4">
        <div className="st-card-title mb-1">Cell highlights</div>
        <div className="flex items-center justify-between gap-4 py-2.5">
          <span className="min-w-0">
            <span className="block st-label">Highlight highest volume</span>
            <span className="block st-helper mt-0.5">Highlight the highest-volume CE and PE cell within ±5% of spot.</span>
          </span>
          <SettingsSwitch
            checked={highlightHighestVolume}
            onChange={onHighlightHighestVolumeChange}
            label="Highlight highest volume"
            tone="cyan"
          />
        </div>
      </div>

      <div className="border border-terminal-border rounded-lg p-4">
        <div className="st-card-title mb-1">Chain filtering</div>
        <div className="flex items-center justify-between gap-4 py-2.5">
          <span className="min-w-0">
            <span className="block st-label">Hide zero-volume strikes</span>
            <span className="block st-helper mt-0.5">Hide a strike only when both sides qualify as zero. Older replay rows need positive OI and LTP on each side; unverified live values remain visible. This changes display only; stored and analytical data are untouched.</span>
          </span>
          <SettingsSwitch
            checked={hideZeroVolumeStrikes}
            onChange={onHideZeroVolumeStrikesChange}
            label="Hide zero-volume strikes"
            tone="cyan"
          />
        </div>
      </div>

      <div className="border border-terminal-border rounded-lg p-4">
        <div className="st-card-title mb-1">Analysis</div>
        {renderColumn('buildup', 'Show a dedicated classification column with its bullish/bearish interpretation. Hover for premium, OI, volume and comparison timestamps.')}
      </div>
    </div>
  );
};
