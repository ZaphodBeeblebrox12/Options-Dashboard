import React, { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: React.ReactNode;
  /** Body content — plain text or a rich layout. */
  children?: React.ReactNode;
  /** Inline error line rendered above the footer (kept visible while open). */
  error?: string | null;
  confirmLabel?: string;
  cancelLabel?: string;
  /** May return a promise; the dialog shows a busy state and closes after it settles.
   *  Return `false` (or a promise resolving to false) to KEEP the dialog open —
   *  used when the action failed and the error should be shown inside the dialog. */
  onConfirm?: () => void | false | Promise<void | false>;
  /** Destructive action styling (red confirm button + warning icon). */
  danger?: boolean;
  /** Single-action mode (no cancel) — replaces window.alert. */
  alert?: boolean;
  /**
   * Enables a "Do not show again" checkbox. The preference is persisted in
   * localStorage under `confirm_dont_show_<key>`; while set, the dialog
   * renders nothing. Pass a stable per-dialog key (e.g. 'sound_upload_error').
   */
  dontShowAgainKey?: string;
}

const DONT_SHOW_PREFIX = 'confirm_dont_show_';

export function isDialogSuppressed(key: string): boolean {
  try { return localStorage.getItem(DONT_SHOW_PREFIX + key) === '1'; } catch { return false; }
}

/**
 * Application-native replacement for window.confirm / window.alert.
 * Shares the terminal design language with SettingsModal:
 * dark panel, backdrop blur, Escape to close, min 44px touch targets.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  onClose,
  title,
  icon,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  danger = false,
  alert = false,
  dontShowAgainKey,
  error,
}) => {
  const [busy, setBusy] = useState(false);
  const [dontShow, setDontShow] = useState(false);
  const suppressed = dontShowAgainKey ? isDialogSuppressed(dontShowAgainKey) : false;

  useEffect(() => {
    if (open) setBusy(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open || suppressed) return null;

  const handleConfirm = async () => {
    if (dontShowAgainKey && dontShow) {
      try { localStorage.setItem(DONT_SHOW_PREFIX + dontShowAgainKey, '1'); } catch {}
    }
    if (!onConfirm) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const keep = await onConfirm();
      if (keep === false) return;   // action failed — stay open, caller shows why
    } finally {
      setBusy(false);
    }
    onClose();
  };

  const confirmCls = danger
    ? 'bg-red-500/20 text-red-300 border border-red-500/40 hover:bg-red-500/30'
    : 'bg-terminal-pe/20 text-terminal-pe border border-terminal-pe/30 hover:bg-terminal-pe/30';

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center px-4 py-6">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => !busy && onClose()}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md terminal-panel rounded-lg overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-terminal-border">
          {icon ?? (danger ? (
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          ) : null)}
          <h2 className="text-sm font-bold tracking-wide flex-1 min-w-0 truncate">{title}</h2>
          <button
            onClick={() => !busy && onClose()}
            className="p-1.5 -mr-1 rounded hover:bg-white/10 text-terminal-muted hover:text-terminal-text transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        {children && (
          <div className="px-4 py-3.5 text-[13px] leading-relaxed text-terminal-muted">
            {children}
          </div>
        )}

        {/* Inline action error */}
        {error && (
          <div className="px-4 py-2 border-t border-red-500/30 bg-red-500/10 text-[12px] font-mono text-red-300 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        {/* Don't-show-again (only when a key is provided) */}
        {dontShowAgainKey && (
          <label className="flex items-center gap-2.5 px-4 py-2.5 border-t border-terminal-border/50 cursor-pointer select-none min-h-[44px]">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
              className="w-4 h-4 accent-terminal-pe"
            />
            <span className="text-[12px] text-terminal-muted">Do not show this again</span>
          </label>
        )}

        {/* Footer — 44px min touch targets */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-terminal-border bg-terminal-bg/40">
          {!alert && (
            <button
              onClick={() => !busy && onClose()}
              disabled={busy}
              className="px-4 py-2.5 min-h-[44px] rounded-lg border border-terminal-border text-[13px] font-medium text-terminal-muted hover:text-terminal-text hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              {cancelLabel}
            </button>
          )}
          <button
            onClick={handleConfirm}
            disabled={busy}
            className={`px-4 py-2.5 min-h-[44px] rounded-lg text-[13px] font-semibold transition-colors disabled:opacity-50 ${confirmCls}`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
