import React from 'react';
import { Play, Pause, SkipBack, SkipForward, RefreshCw } from 'lucide-react';
import { DatePicker } from './DatePicker';

interface ReplayControlsProps {
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
}) => {
  const currentTimestamp = timestamps[currentIndex] || '';
  const timeOnly = currentTimestamp ? currentTimestamp.split(' ')[1] || currentTimestamp : '—';
  const firstTime = timestamps[0]?.split(' ')[1] || '09:15:00';
  const lastTime = timestamps[timestamps.length - 1]?.split(' ')[1] || '15:30:00';

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSeek(Number(e.target.value));
  };

  const stepBack = () => {
    if (currentIndex > 0) onSeek(currentIndex - 1);
  };

  const stepForward = () => {
    if (currentIndex < timestamps.length - 1) onSeek(currentIndex + 1);
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

        {/* Custom Date Picker with highlighted dates */}
        <DatePicker
          selectedDate={selectedDate}
          onDateChange={onDateChange}
          availableDates={availableDates}
        />

        {/* Quick date pills */}
        {availableDates.length > 0 && (
          <div className="flex gap-1 flex-wrap max-w-[300px]">
            {availableDates.slice(0, 5).map((d) => (
              <button
                key={d}
                onClick={() => onDateChange(d)}
                className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
                  d === selectedDate
                    ? 'bg-terminal-pe/20 text-terminal-pe border border-terminal-pe/30'
                    : 'bg-terminal-bg text-terminal-muted border border-terminal-border hover:text-terminal-text'
                }`}
              >
                {d.slice(5)}
              </button>
            ))}
            {availableDates.length > 5 && (
              <span className="text-[10px] font-mono text-terminal-muted self-center">
                +{availableDates.length - 5}
              </span>
            )}
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

        {/* Time display */}
        <div className="font-mono text-sm font-bold text-terminal-atm min-w-[80px]">
          {timeOnly}
        </div>

        {/* Slider */}
        <div className="flex-1 flex items-center gap-2 min-w-[200px]">
          <span className="text-[10px] font-mono text-terminal-muted">{firstTime}</span>
          <input
            type="range"
            min={0}
            max={Math.max(timestamps.length - 1, 0)}
            value={currentIndex}
            onChange={handleSliderChange}
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
