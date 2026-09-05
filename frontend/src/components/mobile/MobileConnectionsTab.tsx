import React, { useEffect, useState } from "react";

/** Connections — mobile native: live health grade, WS slot capacity bars,
 *  per-instrument token usage. Polls the existing /api/ws/usage and
 *  /api/app-health endpoints. */
const GRADE_C: Record<string, string> = { ok: "var(--mup)", warning: "var(--mamber)", degraded: "var(--mdn)", idle: "var(--mfaint)" };
const GRADE_L: Record<string, string> = { ok: "OK", warning: "Warning", degraded: "Degraded", idle: "Idle" };

export default function MobileConnectionsTab() {
  const [usage, setUsage] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([
      fetch("/api/ws/usage").then(r => r.ok ? r.json() : null),
      fetch("/api/app-health").then(r => r.ok ? r.json() : null),
    ]).then(([u, h]) => { if (!alive) return; setUsage(u); setHealth(h); setErr(!u && !h); }).catch(() => { if (alive) setErr(true); });
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (err) return <div className="mc-note" style={{ padding: 20 }}>Couldn't load connection stats.</div>;
  if (!usage && !health) return <div className="mc-note" style={{ padding: 20 }}>Loading…</div>;

  const overall = health?.overall ?? "idle";
  const oc = GRADE_C[overall] ?? "var(--mfaint)";
  const slots: any[] = usage?.ws?.slots ?? [];
  const maxTok = Math.max(1, ...slots.map((s: any) => s.capacity ?? 0));
  const inst: [string, number][] = Object.entries(usage?.usage_by_instrument ?? {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 12) as [string, number][];
  const maxInst = Math.max(1, ...inst.map(i => i[1]));
  const grades: [string, any][] = Object.entries(health?.grades ?? {});

  return (
    <div className="mc-con">
      <div className="mc-con-banner" style={{ borderColor: oc }}>
        <span className="mc-con-grade" style={{ color: oc }}>{GRADE_L[overall] ?? overall}</span>
        <span className="mc-con-sub num">
          {health?.market_open ? "Market open" : "Market closed"} · {health?.stocks_tracked ?? 0} instruments · queue {health?.queue_depth ?? 0}
        </span>
      </div>

      <div className="mc-card">
        <h4>WebSocket slots</h4>
        {slots.length === 0 && <div className="mc-note" style={{ padding: "4px 0", textAlign: "left" }}>No live connections.</div>}
        {slots.map((s: any) => (
          <div className="mc-con-slot" key={s.slot_id}>
            <div className="mc-con-slot-hd num">
              <span>Slot {s.slot_id}</span>
              <span className={"mc-con-st " + s.status}>{s.status}</span>
              <span className="mc-con-cap">{s.subscribed}/{s.capacity}</span>
            </div>
            <div className="mc-con-bar"><i style={{ width: Math.min(100, (s.subscribed / maxTok) * 100) + "%" }} /></div>
          </div>
        ))}
        <div className="mc-con-total num">
          {usage?.ws?.total_subscribed ?? 0} / {usage?.ws?.total_capacity ?? 0} tokens ({usage?.ws?.max_connections ?? 3} connections max)
        </div>
      </div>

      {inst.length > 0 && (
        <div className="mc-card">
          <h4>Tokens by instrument</h4>
          {inst.map(([name, n]) => (
            <div className="mc-con-slot" key={name}>
              <div className="mc-con-slot-hd num"><span>{name}</span><span className="mc-con-cap">{n}</span></div>
              <div className="mc-con-bar"><i style={{ width: (n / maxInst) * 100 + "%", background: "var(--mblue)" }} /></div>
            </div>
          ))}
        </div>
      )}

      {grades.length > 0 && (
        <div className="mc-card">
          <h4>App health</h4>
          {grades.map(([k, g]: any) => (
            <div className="mc-con-grade-row" key={k}>
              <span className="mc-con-dot" style={{ background: GRADE_C[g] ?? "var(--mfaint)" }} />
              <span className="mc-con-gk">{k}</span>
              <span className="num" style={{ color: GRADE_C[g] ?? "var(--mfaint)", fontWeight: 700 }}>{GRADE_L[g] ?? g}</span>
            </div>
          ))}
          {health?.max_spot_age_sec != null && (
            <div className="mc-con-total num">Oldest underlying tick: {health.max_spot_age_sec}s {health?.oldest_feed ? `(${health.oldest_feed})` : ""}</div>
          )}
        </div>
      )}
    </div>
  );
}
