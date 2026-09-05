import React, { useMemo, useState } from "react";

/** Mobile instrument picker — bottom sheet with a current-instrument hero,
 *  sticky search, kind-grouped sections (handles long lists), and an
 *  unmissable selected state. Rendered in a portal by the parent. */
export default function MobileInstrumentSheet({ list, selected, onPick, analyticalOnly }: {
  list: any[]; selected: string; onPick: (name: string) => void;
  analyticalOnly?: boolean;
}) {
  const [q, setQ] = useState("");
  const items = useMemo(() => analyticalOnly ? list.filter(i => (i.tier ?? 3) < 3) : list, [list, analyticalOnly]);
  const groups = useMemo(() => {
    const query = q.trim().toUpperCase();
    const src = query ? items.filter(i => i.name.includes(query)) : items;
    const sorted = [...src].sort((a, b) => (a.tier - b.tier) || a.name.localeCompare(b.name));
    const byKind = new Map<string, any[]>();
    sorted.forEach(i => {
      const k = i.kind || "stock";
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k)!.push(i);
    });
    return [...byKind.entries()];
  }, [items, q]);
  const current = items.find(i => i.name === selected);

  return (
    <div className="mc-sheet open">
      <div className="mc-grab" />
      <div className="mc-sheet-hd">
        <span style={{ fontSize: 16, fontWeight: 700 }}>{analyticalOnly ? "Watch instruments" : "Instruments"}</span>
        <button className="mc-sheet-x" onClick={() => onPick(selected)}>Close</button>
      </div>
      {current && (
        <div className="mc-curhero">
          <div>
            <div className="mc-curhero-nm num">{current.name}</div>
            <div className="mc-curhero-meta" style={{ textTransform: "capitalize" }}>{current.kind} · tier {current.tier}</div>
          </div>
          <span className="mc-badge t{current.tier}">t{current.tier}</span>
          <span className="mc-curhero-tag">current</span>
        </div>
      )}
      <div className="mc-searchwrap">
        <input className="mc-search" placeholder="Search symbol…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div>
        {groups.length === 0 && <div className="mc-note" style={{ padding: 14 }}>No matches</div>}
        {groups.map(([kind, arr]) => (
          <div key={kind}>
            <div className="mc-sech" style={{ marginTop: 10 }}>{kind} · {arr.length}</div>
            {arr.slice(0, 40).map(i => (
              <button key={i.name} className={"mc-isrow" + (i.name === selected ? " sel" : "")} onClick={() => onPick(i.name)}>
                <div><div className="sym num">{i.name}</div><div className="meta">tier {i.tier}</div></div>
                {i.name === selected
                  ? <span className="cur" style={{ fontSize: 11 }}>✓ current</span>
                  : <span className={"mc-badge t" + i.tier} style={{ marginLeft: "auto" }}>T{i.tier}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
      {analyticalOnly && <div className="mc-note" style={{ paddingTop: 8 }}>Tier-3 scanners live in the Scan tab.</div>}
    </div>
  );
}
