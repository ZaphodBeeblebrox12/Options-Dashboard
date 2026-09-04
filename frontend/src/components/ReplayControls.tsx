import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Pause, SkipBack, SkipForward, RefreshCw } from 'lucide-react';
import { DatePicker } from './DatePicker';

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
}) => {
  // Local slider position for instant, smooth dragging
  // currentIndex = committed (data loaded), sliderIndex = visual preview
  const [sliderIndex, setSliderIndex] = useState(currentIndex);
  const isDraggingRef = useRef(false);

  // Sync slider when currentIndex changes externally (play button, step buttons, etc.)
  useEffect(() => {
    if (!isDraggingRef.current) {
      setSliderIndex(currentIndex);
    }
  }, [currentIndex]);

  // Time display comes from the local slider position (instant feedback)
  const previewTimestamp = timestamps[sliderIndex] || '';
  const timeOnly = previewTimestamp
    ? previewTimestamp.split(' ')[1] || previewTimestamp
    : '—';

  const firstTime = timestamps[0]?.split(' ')[1] || '09:15:00';
  const lastTime = timestamps[timestamps.length - 1]?.split(' ')[1] || '15:30:00';

  // ── Slider handlers: optimistic, no API calls while dragging ──
  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newIndex = Number(e.target.value);
    setSliderIndex(newIndex);
    isDraggingRef.current = true;
  }, []);

  const handleSliderRelease = useCallback(() => {
    isDraggingRef.current = false;
    // If user released near the end (within 2 snaps), snap to the actual latest
    // so they don't get stuck one-behind if a new snapshot arrived mid-drag
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

  // Helper: format date string as day name + short date (Mon, 29 Aug)
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
        {/* Index Selector */}
        <div className="flex items-center gap-2">
          <select
            value={selectedIndex}
            onChange={(e) => onIndexChange(e.target.value)}
            className="bg-terminal-bg border border-terminal-border rounded px-3 py-1.5 text-xs font-mono font-bold text-terminal-text focus:outline-none focus:border-terminal-atm uppercase tracking-wider"
          >
            <option value="NIFTY">NIFTY</option>
            <option value="SENSEX">SENSEX</option>
          </select>
        </div>

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
