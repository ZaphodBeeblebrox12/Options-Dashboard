import React, { useMemo, useState } from "react";

/** Reusable month calendar for picking a date that has data.
 *  - only days present in `available` (YYYY-MM-DD) are tappable
 *  - optional per-day count badges (alert counts) or a plain dot
 *  - today outlined, selected highlighted, month navigation */
const toISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function MobileCalendar({ available, counts, selected, onPick }: {
  available: Set<string>;
  counts?: Record<string, number>;
  selected?: string | null;
  onPick: (date: string) => void;
}) {
  const todayISO = toISO(new Date());
  const [ym, setYm] = useState(() => {
    const base = selected ? new Date(selected + "T00:00:00") : new Date();
    return { y: base.getFullYear(), m: base.getMonth() };
  });
  const cells = useMemo(() => {
    const startDow = new Date(ym.y, ym.m, 1).getDay();
    const daysIn = new Date(ym.y, ym.m + 1, 0).getDate();
    const out: ({ iso: string; day: number } | null)[] = [];
    for (let i = 0; i < startDow; i++) out.push(null);
    for (let d = 1; d <= daysIn; d++) out.push({ iso: toISO(new Date(ym.y, ym.m, d)), day: d });
    return out;
  }, [ym]);
  const move = (dir: number) => setYm(s => { const d = new Date(s.y, s.m + dir, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const monthName = new Date(ym.y, ym.m, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="mc-cal num">
      <div className="mc-cal-hd">
        <button onClick={() => move(-1)} aria-label="Previous month">‹</button>
        <span>{monthName}</span>
        <button onClick={() => move(1)} aria-label="Next month">›</button>
      </div>
      <div className="mc-cal-dow">{["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className="mc-cal-grid">
        {cells.map((c, i) => c === null ? <span key={i} /> : (
          <button key={c.iso} disabled={!available.has(c.iso)}
            className={"mc-cal-d" + (available.has(c.iso) ? " has" : "") + (selected === c.iso ? " sel" : "") + (todayISO === c.iso ? " today" : "")}
            onClick={() => onPick(c.iso)}>
            <span>{c.day}</span>
            {counts && counts[c.iso] ? <i>{counts[c.iso] > 99 ? "99+" : counts[c.iso]}</i> : available.has(c.iso) ? <i className="dot" /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
