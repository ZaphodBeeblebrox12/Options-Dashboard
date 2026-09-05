// Per-instrument trading sessions.
// Mirrors the backend contract: each instrument supplies its own session and
// every market-open decision goes through isSessionOpen() with those hours.
// Equity/MCX definitions live here only; a future instrument type just adds
// an entry to HOURS_BY_TYPE — no component should hardcode clock ranges.

export type SessionHours = [string, string]; // ["HH:MM", "HH:MM"] IST

export const EQUITY_HOURS: SessionHours = ["09:15", "15:30"]; // NIFTY / SENSEX / stocks
export const MCX_HOURS: SessionHours = ["09:00", "23:30"];     // commodities (matches scrip_master.mcx_hours)

// Kinds used by /api/instruments and InstrumentSelect.tsx.
// ("mcx" accepted as an alias for "commodity".)
export type InstrumentKind = "index" | "stock" | "commodity" | "mcx";

const HOURS_BY_TYPE: Record<string, SessionHours> = {
  index: EQUITY_HOURS,
  stock: EQUITY_HOURS,
  commodity: MCX_HOURS,
  mcx: MCX_HOURS,
};

export function hoursForType(type: string | undefined | null): SessionHours {
  return HOURS_BY_TYPE[type ?? ""] ?? EQUITY_HOURS;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Current time converted to IST, as minutes-since-midnight + weekday. */
function istNow(now: Date = new Date()): { mins: number; day: number } {
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  return { mins: ist.getHours() * 60 + ist.getMinutes(), day: ist.getDay() };
}

export function isSessionOpen(hours: SessionHours, now: Date = new Date()): boolean {
  const { mins, day } = istNow(now);
  if (day === 0 || day === 6) return false;
  return mins >= toMinutes(hours[0]) && mins <= toMinutes(hours[1]);
}

/** True once the clock has passed the session end. */
export function isPastSessionEnd(hours: SessionHours, now: Date = new Date()): boolean {
  const { mins, day } = istNow(now);
  if (day === 0 || day === 6) return false;
  return mins > toMinutes(hours[1]);
}

/** '09:00–23:30 IST' style label for banners. */
export function fmtSessionRange(hours: SessionHours): string {
  return `${hours[0]}–${hours[1]} IST`;
}
