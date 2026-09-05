import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from 'lucide-react';

/**
 * Reusable alert-activity calendar — generic date picker that knows which
 * dates carry records and how many.
 *
 * availability: { "2026-09-04": 7, ... } — dates with zero records are simply
 * absent. Dates NOT in the map stay selectable but render dimmed ("no data").
 *
 * Visual language (self-explanatory, no legend):
 *   has alerts → pe-colored numeral + small dot below it (never a number)
 *   selected   → amber-tinted cell with amber numeral
 *   today      → thin neutral ring only
 * The count for the selected date appears in the status line under the grid,
 * never inside the day cell (a count under a numeral reads as a two-digit date).
 */
interface HistoryCalendarProps {
  selectedDate: string; // "" = no filter (all dates)
  onSelect: (date: string | null) => void; // null clears the filter
  availability: Record<string, number>;
  /** Small label shown on the trigger when nothing is selected. */
  placeholder?: string;
  /** Accent for dates with records — defaults to terminal-pe. */
  accentClass?: string;
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW = ['Su','Mo','Tu','We','Th','Fr','Sa'];

const toKey = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export const HistoryCalendar: React.FC<HistoryCalendarProps> = ({
  selectedDate,
  onSelect,
  availability,
  placeholder = 'All dates',
  accentClass = 'text-terminal-pe',
}) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const base = selectedDate ? new Date(selectedDate + 'T00:00:00') : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const counts = useMemo(() => availability, [availability]);
  const totalDays = Object.keys(counts).length;
  const totalAlerts = Object.values(counts).reduce((a, b) => a + b, 0);
  const newest = useMemo(() => {
    const ks = Object.keys(counts).sort();
    return ks.length ? ks[ks.length - 1] : null;
  }, [counts]);

  const y = view.getFullYear();
  const mo = view.getMonth();
  const firstDow = new Date(y, mo, 1).getDay();
  const nDays = new Date(y, mo + 1, 0).getDate();
  const todayKey = toKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= nDays; d++) cells.push(d);

  const triggerLabel = selectedDate
    ? new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : placeholder;

  // Status line: what the selected date holds (count lives here, not in the cell)
  const selCount = selectedDate ? counts[selectedDate] : undefined;
  const selLabel = selectedDate
    ? new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    : null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 bg-terminal-bg border rounded px-3 py-1.5 text-xs font-mono transition-colors min-h-[36px] ${
          selectedDate ? 'border-terminal-pe/50 text-terminal-pe' : 'border-terminal-border text-terminal-text'
        }`}
      >
        <CalendarIcon className="w-3.5 h-3.5" />
        <span>{triggerLabel}</span>
        {selectedDate ? (
          <span
            role="button"
            tabIndex={0}
            className="flex items-center justify-center w-4 h-4 rounded-full hover:bg-white/10 text-terminal-muted"
            onClick={(e) => { e.stopPropagation(); onSelect(null); }}
            title="Clear date filter"
          >
            <X className="w-3 h-3" />
          </span>
        ) : totalDays > 0 && (
          <span className="px-1.5 rounded-full bg-terminal-pe/15 text-terminal-pe text-[9px] font-bold" title={`${totalAlerts} alerts across ${totalDays} days`}>
            {totalDays}d
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 sm:left-auto left-0 top-full mt-1 z-50 bg-terminal-panel border border-terminal-border rounded-lg shadow-2xl p-3 w-[300px] sm:w-[312px]">
          {/* Month nav + Latest */}
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() => setView(new Date(y, mo - 1, 1))}
              className="p-2 -m-1 rounded hover:bg-white/10 transition-colors min-w-[36px] min-h-[36px] flex items-center justify-center"
              aria-label="Previous month"
            >
              <ChevronLeft className="w-4 h-4 text-terminal-muted" />
            </button>
            <span className="text-[13px] font-mono font-bold text-terminal-text">{MONTHS[mo]} {y}</span>
            <div className="flex items-center">
              {newest && (
                <button
                  onClick={() => { onSelect(newest); setOpen(false); }}
                  className="px-2 py-1 mr-1 rounded text-[10px] font-mono bg-terminal-pe/15 text-terminal-pe hover:bg-terminal-pe/25 transition-colors"
                  title="Jump to the most recent alert day"
                >
                  Latest
                </button>
              )}
              <button
                onClick={() => setView(new Date(y, mo + 1, 1))}
                className="p-2 -m-1 rounded hover:bg-white/10 transition-colors min-w-[36px] min-h-[36px] flex items-center justify-center"
                aria-label="Next month"
              >
                <ChevronRight className="w-4 h-4 text-terminal-muted" />
              </button>
            </div>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 mb-1">
            {DOW.map(d => (
              <div key={d} className="text-center text-[9px] font-mono font-bold text-terminal-muted/70 py-1">{d}</div>
            ))}
          </div>

          {/* Day grid — 44px touch targets.
              Three mutually exclusive treatments:
              dot+pe numeral = has alerts · amber cell = selected · ring = today */}
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, idx) => {
              if (d === null) return <div key={`x${idx}`} className="h-11" />;
              const key = toKey(y, mo, d);
              const n = counts[key];
              const has = n !== undefined;
              const sel = key === selectedDate;
              const isToday = key === todayKey;
              return (
                <button
                  key={key}
                  onClick={() => { onSelect(sel ? null : key); if (!sel) setOpen(false); }}
                  className={`relative h-11 rounded flex flex-col items-center justify-center leading-none transition-colors font-mono ${
                    sel
                      ? 'bg-terminal-atm/15 ring-1 ring-inset ring-terminal-atm text-terminal-atm font-bold'
                      : has
                      ? `${accentClass} font-semibold hover:bg-white/10`
                      : 'text-terminal-muted/40 hover:bg-white/5 hover:text-terminal-muted'
                  } ${isToday && !sel ? 'ring-1 ring-inset ring-terminal-muted/40' : ''}`}
                  title={has ? `${n} alert${n === 1 ? '' : 's'} on ${key}` : `${key} — no alerts`}
                >
                  <span className="text-[13px]">{d}</span>
                  {/* activity dot: small, round, clearly NOT a digit */}
                  {has && (
                    <span className={`mt-1 w-1 h-1 rounded-full ${sel ? 'bg-terminal-atm' : 'bg-terminal-pe/70'}`} />
                  )}
                  {!has && <span className="mt-1 w-1 h-1" />}
                </button>
              );
            })}
          </div>

          {/* Status line: selected-date count lives here (never inside the cell) */}
          <div className="mt-2 pt-2 border-t border-terminal-border min-h-[24px] flex items-center text-[10.5px] font-mono">
            {selLabel && selCount !== undefined ? (
              <span className="text-terminal-pe">
                ● {selLabel} — {selCount} alert{selCount === 1 ? '' : 's'}
              </span>
            ) : selLabel ? (
              <span className="text-terminal-muted">{selLabel} — no alerts</span>
            ) : totalDays > 0 ? (
              <span className="text-terminal-muted">{totalAlerts} alerts across {totalDays} day{totalDays === 1 ? '' : 's'}</span>
            ) : (
              <span className="text-terminal-muted">No alert history recorded yet</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
