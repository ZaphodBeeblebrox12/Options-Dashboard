import React, { useState, useRef, useEffect } from 'react';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from 'lucide-react';

interface DatePickerProps {
  selectedDate: string;
  onDateChange: (date: string) => void;
  availableDates: string[];
}

export const DatePicker: React.FC<DatePickerProps> = ({
  selectedDate,
  onDateChange,
  availableDates,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date(selectedDate);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const availableSet = new Set(availableDates);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  const prevMonth = () => {
    setCurrentMonth(new Date(year, month - 1, 1));
  };

  const nextMonth = () => {
    setCurrentMonth(new Date(year, month + 1, 1));
  };

  const selectDate = (day: number) => {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    onDateChange(dateStr);
    setIsOpen(false);
  };

  const isToday = (day: number) => {
    const today = new Date();
    return today.getDate() === day && today.getMonth() === month && today.getFullYear() === year;
  };

  const isSelected = (day: number) => {
    const d = new Date(selectedDate);
    return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year;
  };

  const isAvailable = (day: number) => {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return availableSet.has(dateStr);
  };

  const formatDisplay = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  // Build grid
  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 bg-terminal-bg border rounded px-3 py-1.5 text-xs font-mono transition-colors ${
          availableSet.has(selectedDate)
            ? 'border-terminal-pe/50 text-terminal-pe'
            : 'border-terminal-border text-terminal-text'
        }`}
      >
        <CalendarIcon className="w-3.5 h-3.5" />
        <span>{formatDisplay(selectedDate)}</span>
        {availableSet.has(selectedDate) && (
          <span className="w-1.5 h-1.5 bg-terminal-pe rounded-full" title="Data available" />
        )}
      </button>

      {/* Dropdown calendar */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-terminal-panel border border-terminal-border rounded-lg shadow-xl p-3 w-[280px]">
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={prevMonth}
              className="p-1 rounded hover:bg-white/10 transition-colors"
            >
              <ChevronLeft className="w-4 h-4 text-terminal-muted" />
            </button>
            <span className="text-sm font-mono font-bold text-terminal-text">
              {monthNames[month]} {year}
            </span>
            <button
              onClick={nextMonth}
              className="p-1 rounded hover:bg-white/10 transition-colors"
            >
              <ChevronRight className="w-4 h-4 text-terminal-muted" />
            </button>
          </div>

          {/* Day names */}
          <div className="grid grid-cols-7 gap-0 mb-1">
            {dayNames.map((d) => (
              <div key={d} className="text-center text-[10px] font-mono text-terminal-muted py-1">
                {d}
              </div>
            ))}
          </div>

          {/* Days grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {days.map((day, idx) => {
              if (day === null) {
                return <div key={`empty-${idx}`} className="h-8" />;
              }

              const hasData = isAvailable(day);
              const selected = isSelected(day);
              const today = isToday(day);

              return (
                <button
                  key={day}
                  onClick={() => selectDate(day)}
                  className={`relative h-8 w-8 mx-auto rounded text-xs font-mono flex items-center justify-center transition-all ${
                    selected
                      ? 'bg-terminal-atm text-terminal-bg font-bold'
                      : hasData
                      ? 'bg-terminal-pe/20 text-terminal-pe font-semibold hover:bg-terminal-pe/30'
                      : today
                      ? 'border border-terminal-muted text-terminal-text'
                      : 'text-terminal-muted hover:bg-white/5 hover:text-terminal-text'
                  }`}
                >
                  {day}
                  {hasData && !selected && (
                    <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 bg-terminal-pe rounded-full" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="mt-3 pt-2 border-t border-terminal-border flex items-center gap-3 text-[10px] font-mono text-terminal-muted">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-terminal-pe/20 rounded" /> Has data
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-terminal-atm rounded" /> Selected
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-1.5 border border-terminal-muted rounded" /> Today
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
