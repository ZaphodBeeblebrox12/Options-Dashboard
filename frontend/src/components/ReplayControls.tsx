import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Pause, SkipBack, SkipForward, RefreshCw } from 'lucide-react';
import { DatePicker } from './DatePicker';
import { SessionHours } from '../session';
import { InstrumentSelect } from './InstrumentSelect';

interface ReplayControlsProps {
  isFetching?: boolean;
  timestamps: string[];
  currentIndex: number;
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (index: number) => void;
  onRefresh: () => void;
  selectedDate: string;
  onDateChange: (date: string) => void;
  selectedIndex: string;
  onIndexChange: (index: string) => void;
  availableDates: string[];
  /** Selected instrument's session — fallback labels when no snapshots exist. */
  sessionHours?: SessionHours;
}

export const ReplayControls: React.FC<ReplayControlsProps> = ({
  timestamps,
  currentIndex,
  isPlaying,
  onPlay,
  onPause,
  onSeek,
  onRefresh,
  selectedDate,
  onDateChange,
  selectedIndex,
  onIndexChange,
  availableDates,
  isFetching,
  sessionHours = ['09:15', '15:30'],
}) => {
  const [sliderIndex, setSliderIndex] = useState(currentIndex);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (!isDraggingRef.current) {
      setSliderIndex(currentIndex);
    }
  }, [currentIndex]);

  const previewTimestamp = timestamps[sliderIndex] || '';
  const timeOnly = previewTimestamp
    ? previewTimestamp.split(' ')[1] || previewTimestamp
    : '—';

  // Fallback labels follow the SELECTED instrument's session
  // (equity 09:15–15:30, MCX 09:00–23:30) — only used when there are no timestamps.
  const firstTime = timestamps[0]?.split(' ')[1] || `${sessionHours[0]}:00`;
  const lastTime = timestamps[timestamps.length - 1]?.split(' ')[1] || `${sessionHours[1]}:00`;

  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newIndex = Number(e.target.value);
    setSliderIndex(newIndex);
    isDraggingRef.current = true;
  }, []);

  const handleSliderRelease = useCallback(() => {
    isDraggingRef.current = false;
    const target = (sliderIndex >= timestamps.length - 2 && timestamps.length > 0)
      ? timestamps.length - 1
      : sliderIndex;
    onSeek(target);
  }, [sliderIndex, onSeek, timestamps.length]);

  const stepBack = () => {
    if (currentIndex > 0) onSeek(currentIndex - 1);
  };

  const stepForward = () => {
    if (currentIndex < timestamps.length - 1) onSeek(currentIndex + 1);
  };

  const fmtDayPill = (dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
    const dateLabel = dateObj.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    return { dayName, dateLabel };
  };

  return (
    <div className="terminal-panel">
      <div className="flex items-center gap-4 px-4 py-3 flex-wrap">
        {/* Searchable Instrument Selector (Tier 1 indices + Tier 2 stocks) */}
        <InstrumentSelect value={selectedIndex} onChange={onIndexChange} />

        <div className="w-px h-6 bg-terminal-border" />

        {/* Custom Date Picker */}
        <DatePicker
          selectedDate={selectedDate}
          onDateChange={onDateChange}
          availableDates={availableDates}
        />

        {/* Quick date pills — last 5 trading days with day names */}
        {availableDates.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            {availableDates.slice(0, 5).map((d) => {
              const { dayName, dateLabel } = fmtDayPill(d);
              const isSelected = d === selectedDate;
              return (
                <button
                  key={d}
                  onClick={() => onDateChange(d)}
                  title={`${d} — ${dateLabel}`}
                  className={`flex flex-col items-center justify-center text-center px-2.5 py-1 rounded transition-colors min-w-[52px] ${
                    isSelected
                      ? 'bg-terminal-pe/20 text-terminal-pe border border-terminal-pe/30'
                      : 'bg-terminal-bg text-terminal-muted border border-terminal-border hover:text-terminal-text'
                  }`}
                >
                  <span className="text-[10px] font-mono font-bold leading-none uppercase tracking-wide">
                    {dayName}
                  </span>
                  <span className="text-[8px] font-mono opacity-60 leading-none mt-0.5">
                    {dateLabel}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="w-px h-6 bg-terminal-border" />

        {/* Playback controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={stepBack}
            disabled={currentIndex <= 0}
            className="p-1.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          {isPlaying ? (
            <button
              onClick={onPause}
              className="p-1.5 rounded bg-terminal-atm/20 hover:bg-terminal-atm/30 text-terminal-atm transition-colors"
            >
              <Pause className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={onPlay}
              disabled={timestamps.length === 0}
              className="p-1.5 rounded bg-terminal-pe/20 hover:bg-terminal-pe/30 text-terminal-pe transition-colors disabled:opacity-30"
            >
              <Play className="w-4 h-4" />
            </button>
          )}

          <button
            onClick={stepForward}
            disabled={currentIndex >= timestamps.length - 1}
            className="p-1.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <SkipForward className="w-4 h-4" />
          </button>
        </div>

        <div className="w-px h-6 bg-terminal-border" />

        {/* Time display — from local slider position (instant) */}
        <div className={`font-mono text-sm font-bold min-w-[80px] flex items-center gap-1.5 transition-colors duration-200 ${
          isFetching ? 'text-terminal-atm/50' : 'text-terminal-atm'
        }`}>
          {timeOnly}
          {isFetching && (
            <span className="w-1 h-1 rounded-full bg-terminal-atm animate-pulse" title="Fetching snapshot..." />
          )}
        </div>

        {/* Slider — optimistic, only seeks on release */}
        <div className="flex-1 flex items-center gap-2 min-w-[200px]">
          <span className="text-[10px] font-mono text-terminal-muted">{firstTime}</span>
          <input
            type="range"
            min={0}
            max={Math.max(timestamps.length - 1, 0)}
            value={sliderIndex}
            onChange={handleSliderChange}
            onMouseUp={handleSliderRelease}
            onTouchEnd={handleSliderRelease}
            className="flex-1 h-1.5 bg-terminal-border rounded-lg appearance-none cursor-pointer"
            style={{ accentColor: '#eab308' }}
          />
          <span className="text-[10px] font-mono text-terminal-muted">{lastTime}</span>
        </div>

        <div className="w-px h-6 bg-terminal-border" />

        {/* Refresh */}
        <button
          onClick={onRefresh}
          className="p-1.5 rounded hover:bg-white/10 transition-colors"
          title="Refresh data"
        >
          <RefreshCw className="w-4 h-4 text-terminal-muted" />
        </button>

        {/* Snapshot count */}
        <div className="text-[10px] font-mono text-terminal-muted">
          {timestamps.length} snapshots
        </div>
      </div>
    </div>
  );
};
