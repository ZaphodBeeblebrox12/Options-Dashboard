import React, { useEffect, useRef, useState } from "react";

/** Instruments v2 — mobile-first. Each instrument is its own card; symbol
 *  dominates, metadata is a quiet line, actions are proper pill buttons.
 *  Same endpoints as before (add/pause/resume/remove/tier/search). */
const KIND_C: Record<string, string> = { index: "var(--mblue)", stock: "var(--mup)", commodity: "var(--mamber)" };
const STATE_TXT: Record<string, string> = {
  window_active: "Active", cash_subscribed: "Subscribed", window_pending: "Pending capacity",
  paused: "Paused", error: "Error", idle: "Idle",
};
const stateOf = (r: any) => r.paused ? "Paused" : (STATE_TXT[r.state] ?? r.state ?? "—");

export default function MobileInstrumentsTab() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<any[]>([]);
  const [busy, setBusy] = useState("");
  const timer = useRef<any>(null);

  const refresh = () => fetch("/api/stocks").then(r => r.ok ? r.json() : null)
    .then(d => setRows(d?.stocks ?? [])).catch(() => {});
  useEffect(() => { refresh(); const t = setInterval(refresh, 10000); return () => clearInterval(t); }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    const query = q.trim();
    if (!query) { setMatches([]); return; }
    timer.current = setTimeout(() => {
      fetch(`/api/instruments/search?q=${encodeURIComponent(query)}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => setMatches(d?.matches ?? [])).catch(() => {});
    }, 300);
    return () => clearTimeout(timer.current);
  }, [q]);

  const act = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    try { await fn(); await refresh(); } finally { setBusy(""); }
  };
  const add = (sym: string, kind: string) => act("add" + sym, () =>
    fetch("/api/instruments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: sym, kind, tier: 3 }) })
      .then(() => { setQ(""); setMatches([]); }));
  const cycleTier = (r: any) => act("tier" + r.symbol, () =>
    fetch(`/api/instruments/${encodeURIComponent(r.symbol)}/tier`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier: r.tier === 2 ? 3 : 2 }) }));
  const togglePause = (r: any) => act("pause" + r.symbol, () =>
    fetch(`/api/stocks/${encodeURIComponent(r.symbol)}/${r.paused ? "resume" : "pause"}`, { method: "POST" }));
  const remove = (r: any) => {
    if (!window.confirm(`Remove ${r.symbol}? Snapshots and history are kept.`)) return;
    act("rm" + r.symbol, () => fetch(`/api/stocks/${encodeURIComponent(r.symbol)}`, { method: "DELETE" }));
  };

  const card = (r: any) => (
    <div className="mc-iv" key={r.symbol}>
      <div className="mc-iv-top">
        <span className="mc-iv-nm num">{r.symbol}</span>
        <span className="mc-iv-kind" style={{ color: KIND_C[r.kind] ?? "var(--mdim)" }}>{r.kind}</span>
        <span className={"mc-iv-state" + (r.paused ? " off" : "")}>{stateOf(r)}</span>
      </div>
      <div className="mc-iv-meta num">{r.tokens != null ? `${r.tokens} tokens` : ""}{r.expiry ? ` · exp ${r.expiry}` : ""}</div>
      {!r.fixed && (
        <div className="mc-iv-acts">
          <button className="mc-iv-btn primary" disabled={busy === "pause" + r.symbol} onClick={() => togglePause(r)}>
            {r.paused ? "▶ Resume" : "❚❚ Pause"}
          </button>
          <button className="mc-iv-btn" disabled={busy === "tier" + r.symbol} onClick={() => cycleTier(r)}>
            {r.tier === 2 ? "To scanner" : "To Tier 2"}
          </button>
          <button className="mc-iv-btn rm" disabled={busy === "rm" + r.symbol} onClick={() => remove(r)}>Remove</button>
        </div>
      )}
    </div>
  );

  const groups: [number, string][] = [[1, "Tier 1"], [2, "Tier 2"], [3, "Tier 3"]];

  return (
    <div className="mc-ins2">
      <div className="mc-ins-searchwrap">
        <input className="mc-search" placeholder="Search symbol to add…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      {matches.length > 0 && (
        <div className="mc-card mc-iv-matchcard">
          {matches.slice(0, 8).map(m => (
            <div className="mc-ins-match" key={m.symbol}>
              <span className="num" style={{ fontWeight: 700 }}>{m.symbol}</span>
              <span className="mc-ins-kind" style={{ color: KIND_C[m.kind] ?? "var(--mdim)" }}>{m.kind}</span>
              <button className="mc-ins-btn add" disabled={busy === "add" + m.symbol} onClick={() => add(m.symbol, m.kind.toUpperCase())}>+ Add as Tier 3</button>
            </div>
          ))}
        </div>
      )}
      {rows === null && <div className="mc-note" style={{ padding: 14 }}>Loading instruments…</div>}
      {rows !== null && rows.length === 0 && <div className="mc-note" style={{ padding: 14 }}>No instruments yet — search above to add one.</div>}
      {rows !== null && groups.map(([t, label]) => {
        const items = rows.filter(r => (r.tier ?? 3) === t);
        if (!items.length) return null;
        return (
          <div key={t} className="mc-iv-group">
            <div className="mc-iv-ghd num">{label} · {items.length}</div>
            {items.map(card)}
          </div>
        );
      })}
      <div className="mc-note" style={{ paddingTop: 4 }}>New instruments start as Tier 3 scanners — promote to Tier 2 for continuous analytics.</div>
    </div>
  );
}
