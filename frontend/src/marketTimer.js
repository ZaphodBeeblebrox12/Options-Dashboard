/**
 * Session-aligned market candle countdowns.
 * Naive snapshot timestamps from the dashboard database are interpreted as
 * Asia/Kolkata. Explicitly zoned timestamps keep their supplied timezone.
 */
export const MARKET_TIMEFRAMES = Object.freeze([
  { label: "4H", minutes: 240 },
  { label: "1H", minutes: 60 },
  { label: "45M", minutes: 45 },
  { label: "30M", minutes: 30 },
  { label: "15M", minutes: 15 },
  { label: "5M", minutes: 5 },
]);

const IST_OFFSET_MINUTES = 330;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/**
 * Parse a market snapshot timestamp. Naive database values are treated as IST.
 * @param {string | number | Date | null | undefined} value
 * @returns {Date | null}
 */
export function parseMarketTimestamp(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;

  const trimmed = value.trim();
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const normalized = trimmed.includes(" ") ? trimmed.replace(" ", "T") : trimmed;
  const date = new Date(hasExplicitZone ? normalized : normalized + "+05:30");
  return Number.isFinite(date.getTime()) ? date : null;
}

function getISTParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
  };
}

export function formatISTClock(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "--:--:--";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function formatMarketDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / SECOND_MS));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function marketLocalTimeToEpoch(parts, hhmm) {
  const [hours, minutes] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return NaN;
  return Date.UTC(parts.year, parts.month - 1, parts.day, 0, hours * 60 + minutes - IST_OFFSET_MINUTES);
}

function emptyFrames() {
  return MARKET_TIMEFRAMES.map((frame) => ({
    ...frame,
    value: "--:--:--",
    remainingMs: null,
    tone: "muted",
  }));
}

/**
 * Compute countdowns from one reference instant.
 * marketOpen is only used inside nominal session hours (for backend-reported
 * holiday/closure states); historical replay ignores today's live status.
 */
/**
 * @typedef {"normal" | "warning" | "danger" | "muted"} MarketTimerTone
 * @typedef {Object} MarketTimerFrame
 * @property {string} label
 * @property {number} minutes
 * @property {string} value
 * @property {number | null} remainingMs
 * @property {MarketTimerTone} tone
 * @typedef {Object} MarketTimerState
 * @property {string} clock
 * @property {"WAITING" | "WEEKEND" | "UNCONFIGURED" | "PRE-OPEN" | "CLOSED" | "OPEN"} status
 * @property {string} footer
 * @property {string} sessionLabel
 * @property {number} closingSoon
 * @property {MarketTimerFrame[]} frames
 *
 * Compute countdowns from one reference instant.
 * marketOpen is only used inside nominal session hours (for backend-reported
 * holiday/closure states); historical replay ignores today's live status.
 * @param {Date | null | undefined} referenceDate
 * @param {[string, string] | undefined} sessionHours
 * @param {boolean | undefined} marketOpen
 * @returns {MarketTimerState}
 */
export function getMarketTimerState(referenceDate, sessionHours, marketOpen) {
  if (!(referenceDate instanceof Date) || !Number.isFinite(referenceDate.getTime())) {
    return {
      clock: "--:--:--",
      status: "WAITING",
      footer: "WAITING FOR MARKET TIMESTAMP",
      sessionLabel: "IST",
      closingSoon: 0,
      frames: emptyFrames(),
    };
  }

  const parts = getISTParts(referenceDate);
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const [sessionStart, sessionEnd] = sessionHours ?? ["09:15", "15:30"];
  const startMs = marketLocalTimeToEpoch(parts, sessionStart);
  const endMs = marketLocalTimeToEpoch(parts, sessionEnd);
  const nowMs = referenceDate.getTime();
  const sessionLabel = sessionStart + "–" + sessionEnd + " IST";
  const base = {
    clock: formatISTClock(referenceDate),
    sessionLabel,
    closingSoon: 0,
    frames: emptyFrames(),
  };

  if (weekday === 0 || weekday === 6) {
    return { ...base, status: "WEEKEND", footer: "WEEKEND · NO REGULAR SESSION" };
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ...base, status: "UNCONFIGURED", footer: "SESSION HOURS UNAVAILABLE" };
  }
  if (nowMs < startMs) {
    return {
      ...base,
      status: "PRE-OPEN",
      footer: "OPENS IN " + formatMarketDuration(startMs - nowMs),
    };
  }
  if (nowMs >= endMs || marketOpen === false) {
    return { ...base, status: "CLOSED", footer: "SESSION CLOSED" };
  }

  const elapsedMs = nowMs - startMs;
  let closingSoon = 0;
  const frames = MARKET_TIMEFRAMES.map((frame) => {
    const periodMs = frame.minutes * MINUTE_MS;
    let nextCloseMs = startMs + (Math.floor(elapsedMs / periodMs) + 1) * periodMs;
    if (nextCloseMs > endMs) nextCloseMs = endMs;
    const remainingMs = Math.max(0, nextCloseMs - nowMs);
    if (remainingMs <= 5 * MINUTE_MS) closingSoon += 1;
    return {
      ...frame,
      value: formatMarketDuration(remainingMs),
      remainingMs,
      tone: remainingMs <= MINUTE_MS ? "danger" : remainingMs <= 5 * MINUTE_MS ? "warning" : "normal",
    };
  });

  return {
    ...base,
    status: "OPEN",
    footer: closingSoon >= 3 ? closingSoon + " TIMEFRAMES CLOSING" : sessionLabel,
    closingSoon,
    frames,
  };
}
