import React, { useEffect, useMemo, useState } from "react";
import { Clock3 } from "lucide-react";
import {
  getMarketTimerState,
  parseMarketTimestamp,
} from "../marketTimer.js";
import type { InstrumentKind, SessionHours } from "../session";

interface MarketTimerProps {
  mode: "live" | "replay";
  referenceTimestamp?: string | null;
  sessionHours: SessionHours;
  instrumentKind?: InstrumentKind | string;
  marketOpen?: boolean;
  variant?: "desktop" | "mobile";
}

const TONE_CLASS: Record<string, string> = {
  normal: "text-terminal-text",
  warning: "text-amber-400",
  danger: "text-red-400",
  muted: "text-terminal-muted",
};

export const MarketTimer: React.FC<MarketTimerProps> = ({
  mode,
  referenceTimestamp,
  sessionHours,
  instrumentKind,
  marketOpen,
  variant = "desktop",
}) => {
  const [liveNow, setLiveNow] = useState(() => new Date());

  useEffect(() => {
    if (mode !== "live") return;
    const tick = () => setLiveNow(new Date());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [mode]);

  const replayDate = useMemo(
    () => (mode === "replay" ? parseMarketTimestamp(referenceTimestamp) : null),
    [mode, referenceTimestamp],
  );
  const referenceDate = mode === "live" ? liveNow : replayDate;
  const state = useMemo(
    () => getMarketTimerState(referenceDate, sessionHours, mode === "live" ? marketOpen : undefined),
    [referenceDate, sessionHours[0], sessionHours[1], marketOpen, mode],
  );

  const exchangeLabel = instrumentKind === "commodity" || instrumentKind === "mcx"
    ? "MCX"
    : "NSE / BSE";
  const statusLabel = state.status === "OPEN"
    ? mode.toUpperCase()
    : state.status === "WAITING" && mode === "replay"
      ? "REPLAY"
      : state.status;
  const statusClass = state.status === "OPEN"
    ? mode === "live" ? "text-emerald-400 bg-emerald-500/10" : "text-sky-300 bg-sky-500/10"
    : state.status === "PRE-OPEN" ? "text-amber-300 bg-amber-500/10"
      : "text-terminal-muted bg-white/5";

  if (variant === "mobile") {
    return (
      <section className="mc-market-timer num" aria-label="Market candle countdown">
        <div className="mc-mt-head">
          <span className="mc-mt-title">{exchangeLabel} · IST</span>
          <strong>{state.clock}</strong>
          <span className={"mc-mt-status " + (statusLabel === "LIVE" ? "live" : statusLabel === "REPLAY" ? "replay" : "")}>{statusLabel}</span>
        </div>
        <div className="mc-mt-frames">
          {state.frames.map((frame) => (
            <div className="mc-mt-frame" key={frame.label}>
              <span>{frame.label}</span>
              <strong className={frame.tone === "danger" ? "danger" : frame.tone === "warning" ? "warning" : ""}>{frame.value}</strong>
            </div>
          ))}
        </div>
        <div className="mc-mt-foot">{state.footer}</div>
      </section>
    );
  }

  return (
    <section className="terminal-panel sticky top-0 z-30 flex min-w-0 flex-wrap items-center gap-4 px-4 py-2.5 shadow-lg shadow-black/20"
      aria-label="Market candle countdown">
      <div className="flex min-w-[165px] shrink-0 items-center gap-2.5 border-r border-terminal-border pr-3">
        <Clock3 className="h-4 w-4 shrink-0 text-terminal-atm" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-wider text-terminal-muted">
            <span>Market timer</span>
            <span>·</span>
            <span>{exchangeLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            <strong className="font-mono text-base font-bold tabular-nums text-terminal-text">{state.clock}</strong>
            <span className="text-[9px] font-mono text-terminal-muted">IST</span>
            <span className={"rounded px-1.5 py-0.5 text-[10px] font-mono font-bold " + statusClass}>{statusLabel}</span>
          </div>
        </div>
      </div>
      <div className="grid min-w-[360px] flex-1 grid-cols-6 gap-1.5 sm:gap-3">
        {state.frames.map((frame) => (
          <div className="min-w-0 border-r border-terminal-border/60 px-1 last:border-r-0" key={frame.label}>
            <div className="text-[11px] font-mono font-bold tracking-wider text-slate-200">{frame.label}</div>
            <div className={"whitespace-nowrap font-mono text-[15px] font-bold tabular-nums sm:text-[17px] " + (TONE_CLASS[frame.tone] ?? TONE_CLASS.muted)}>{frame.value}</div>
          </div>
        ))}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2 text-right">
        <span className={"text-[10px] font-mono font-bold uppercase tracking-wide " + (state.closingSoon >= 3 ? "text-amber-400" : "text-terminal-muted")}>{state.footer}</span>
      </div>
    </section>
  );
};

export default MarketTimer;
