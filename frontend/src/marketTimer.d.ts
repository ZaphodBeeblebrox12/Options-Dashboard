export type MarketTimerTone = "normal" | "warning" | "danger" | "muted";
export type MarketTimerStatus = "WAITING" | "WEEKEND" | "UNCONFIGURED" | "PRE-OPEN" | "CLOSED" | "OPEN";

export interface MarketTimerFrame {
  label: string;
  minutes: number;
  value: string;
  remainingMs: number | null;
  tone: MarketTimerTone;
}

export interface MarketTimerState {
  clock: string;
  status: MarketTimerStatus;
  footer: string;
  sessionLabel: string;
  closingSoon: number;
  frames: MarketTimerFrame[];
}

export const MARKET_TIMEFRAMES: ReadonlyArray<{ label: string; minutes: number }>;

export function parseMarketTimestamp(value: string | number | Date | null | undefined): Date | null;
export function formatISTClock(date: Date): string;
export function formatMarketDuration(milliseconds: number): string;
export function getMarketTimerState(
  referenceDate: Date | null | undefined,
  sessionHours?: [string, string],
  marketOpen?: boolean,
): MarketTimerState;
