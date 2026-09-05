import React from 'react';

interface DisplayTabProps {
  fullMode: boolean;
  onFullModeChange: (v: boolean) => void;
}

export const DisplayTab: React.FC<DisplayTabProps> = ({ fullMode, onFullModeChange }) => {
  return (
    <div>
      <h3 className="st-section mb-1">Display</h3>
      <p className="st-helper mb-5">Preferences apply to this browser only.</p>

      <div className="border border-terminal-border rounded-lg p-5">
        <div className="flex flex-wrap items-center gap-3">
          <label className="st-label w-48">Option chain density</label>
          <div className="inline-flex border border-terminal-border rounded-lg overflow-hidden">
            <button
              onClick={() => onFullModeChange(false)}
              className={`st-seg px-4 py-2 transition-colors ${!fullMode ? 'bg-white/10 text-terminal-text font-semibold' : 'text-[var(--st-text-2)] hover:bg-white/5'}`}
            >
              Compact
            </button>
            <button
              onClick={() => onFullModeChange(true)}
              className={`st-seg px-4 py-2 transition-colors ${fullMode ? 'bg-white/10 text-terminal-text font-semibold' : 'text-[var(--st-text-2)] hover:bg-white/5'}`}
            >
              Full
            </button>
          </div>
        </div>
        <p className="st-helper mt-4">
          Full shows IV / delta / gamma columns. The eye button was removed from the top bar — this is its new home.
        </p>
      </div>
    </div>
  );
};
