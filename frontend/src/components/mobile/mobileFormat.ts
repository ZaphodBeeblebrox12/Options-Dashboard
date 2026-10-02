// Formatting helpers for the mobile shell.
// Conventions: en-IN grouping, tabular rendering via CSS class, compact
// forms only where the column genuinely cannot fit full numbers.

export const fmtNum = (n: number): string => Math.round(n).toLocaleString("en-IN");

export const fmtPx = (n: number | null | undefined): string =>
  n == null ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Hero OI column: full grouping below 1M, compact lakhs above (a 7+ digit
 * number will not fit a ~70px column on a phone). */
export const fmtOI = (n: number | null | undefined): string => {
  if (n == null) return "—";
  return Math.abs(n) >= 1e6 ? (n / 1e5).toFixed(1) + " L" : fmtNum(n);
};

/** OI change column: ALWAYS compact + ALWAYS signed (vs the day baseline,
 * exactly what the backend's oi_change field carries). */
export const fmtDelta = (n: number | null | undefined): string => {
  if (n == null) return "—";
  const a = Math.abs(n);
  const body =
    a >= 1e5 ? (a / 1e5).toFixed(1) + "L" : a >= 1e3 ? (a / 1e3).toFixed(1) + "k" : String(Math.round(a));
  return (n >= 0 ? "+" : "−") + body;
};

/** Percentage form of OI change — reserved for the strike drill-down. */
export const fmtDeltaPct = (delta: number | null | undefined, base: number | null | undefined): string => {
  if (delta == null || !base) return "—";
  const pct = (delta / base) * 100;
  return (pct >= 0 ? "+" : "−") + Math.abs(pct).toFixed(1) + "%";
};

/** Backend sends expiry as "09SEP2026" -> "09 sep". */
export const fmtExpiry = (exp: string | null | undefined): string => {
  if (!exp) return "";
  const m = String(exp).match(/^(\d{2})([A-Za-z]{3})(\d{4})$/);
  return m ? `${m[1]} ${m[2].toLowerCase()}` : String(exp);
};

export const fmtGex = (n: number | null | undefined): string => {
  if (n == null) return "—";
  const a = Math.abs(n);
  const body =
    a >= 1e7 ? (a / 1e7).toFixed(2) + " Cr"
    : a >= 1e5 ? (a / 1e5).toFixed(1) + " L"
    : a >= 1e3 ? (a / 1e3).toFixed(1) + "k"
    : fmtNum(a);
  return (n >= 0 ? "+" : "−") + body;
};

export const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
};
