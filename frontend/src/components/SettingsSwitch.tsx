import React from 'react';

type SettingsSwitchTone = 'green' | 'violet' | 'cyan';

interface SettingsSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  tone?: SettingsSwitchTone;
  stopPropagation?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Shared settings switch with a fixed 36x20 track and 16x16 thumb.
 * The control never flex-shrinks, so text and icons cannot distort its geometry.
 */
export const SettingsSwitch: React.FC<SettingsSwitchProps> = ({
  checked,
  onChange,
  label,
  tone = 'green',
  stopPropagation = false,
  disabled = false,
  className = '',
}) => (
  <button
    type="button"
    role="switch"
    aria-label={label}
    aria-checked={checked}
    disabled={disabled}
    onClick={(event) => {
      if (stopPropagation) event.stopPropagation();
      onChange(!checked);
    }}
    className={`inline-flex h-5 w-9 min-w-[36px] flex-none items-center rounded-full p-0.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-atm focus-visible:ring-offset-2 focus-visible:ring-offset-terminal-panel disabled:cursor-not-allowed disabled:opacity-50 ${
      checked
        ? tone === 'violet'
          ? 'bg-violet-500'
          : tone === 'cyan'
            ? 'bg-cyan-500'
            : 'bg-terminal-pe'
        : 'bg-terminal-border'
    } ${className}`}
  >
    <span
      aria-hidden="true"
      className={`block h-4 w-4 shrink-0 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out ${
        checked ? 'translate-x-4' : 'translate-x-0'
      }`}
    />
  </button>
);

export default SettingsSwitch;
