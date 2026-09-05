import React, { useEffect, useRef, useState } from "react";
import { fmtPx, fmtOI, fmtDelta, fmtDeltaPct, fmtExpiry, fmtNum } from "./mobileFormat";

/** Strike drill-down: current values + ALL THREE session charts (OI, LTP,
 *  Gamma) stacked with a LINKED crosshair — dragging any chart moves the
 *  cursor on all three for direct comparison.
 *  Data: existing /api/history/{strike} endpoint (same source as desktop).
 *  If the requested date has no snapshots (e.g. today is a non-trading day
 *  or the backend hasn't recorded yet), it automatically falls back to the
 *  most recent date that does — and says so. `date` lets replay show that
 *  session; strokes use inline style (CSS vars don't work in SVG attrs). */
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const W = 340, H = 84, PAD = 6;

function Chart({ title, ce, pe, hover, setHover, fmtY, timeAt }: {
  title: string; ce: number[]; pe: number[]; hover: number | null;
  setHover: (i: number | null) => void; fmtY: (n: number) => string;
  timeAt: (i: number) => string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const all = [...ce, ...pe].filter(v => v != null && isFinite(v));
  const n = Math.max(ce.length, pe.length);
  const onPointer = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || n < 2) return;
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setHover(Math.round(f * (n - 1)));
  };
  if (!all.length || n < 2) return null;
  const mn = Math.min(...all), mx = Math.max(...all), rg = mx - mn || 1;
  const xAt = (i: number) => PAD + (i / (n - 1)) * (W - PAD * 2);
  const yAt = (v: number) => H - 16 - ((v - mn) / rg) * (H - 30);
  const path = (arr: number[]) => arr.length > 1
    ? arr.map((v, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ") : "";
  const vAt = (arr: number[], i: number) => (i != null && arr[i] != null ? fmtY(arr[i]) : "—");
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="mc-cht-t">
        <span>{title}</span>
        <span className="num" style={{ color: "var(--mce)" }}>C {vAt(ce, hover ?? ce.length - 1)}</span>
        <span className="num" style={{ color: "var(--mpe)" }}>P {vAt(pe, hover ?? pe.length - 1)}</span>
        <span className="num" style={{ color: "var(--mfaint)" }}>{hover != null ? timeAt(hover) : ""}</span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block", touchAction: "none" }}
        onMouseMove={e => onPointer(e.clientX)} onMouseLeave={() => setHover(null)}
        onTouchStart={e => onPointer(e.touches[0].clientX)} onTouchMove={e => onPointer(e.touches[0].clientX)}>
        {[0.3, 0.6].map(f => <line key={f} x1={PAD} x2={W - PAD} y1={H * f} y2={H * f} style={{ stroke: "var(--mborder)", strokeWidth: 0.5 }} />)}
        {ce.length > 1 && <path d={path(ce)} fill="none" style={{ stroke: "var(--mce)", strokeWidth: 1.6 }} />}
        {pe.length > 1 && <path d={path(pe)} fill="none" style={{ stroke: "var(--mpe)", strokeWidth: 1.6 }} />}
        {hover != null && (
          <g>
            <line x1={xAt(hover)} x2={xAt(hover)} y1={6} y2={H - 12} style={{ stroke: "var(--mdim)", strokeWidth: 0.8, strokeDasharray: "3 3" }} />
            {ce[hover] != null && <circle cx={xAt(hover)} cy={yAt(ce[hover])} r={3} style={{ fill: "var(--mce)" }} />}
            {pe[hover] != null && <circle cx={xAt(hover)} cy={yAt(pe[hover])} r={3} style={{ fill: "var(--mpe)" }} />}
          </g>
        )}
      </svg>
    </div>
  );
}

export default function MobileStrikeSheet({ pick, label, expiry, lot, date, onClose }: {
  pick: { strike: number; ce?: any; pe?: any };
  label: string; expiry?: string; lot?: number; date?: string; onClose: () => void;
}) {
  const [hist, setHist] = useState<{ ce: any[]; pe: any[]; shownDate: string } | null>(null);
  const [hstat, setHstat] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [fallback, setFallback] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setHstat("loading");
    setHover(null);
    setFallback(false);
    const load = async (d: string, isFallback: boolean) => {
      const r = await fetch(`/api/history/${pick.strike}?index=${encodeURIComponent(label)}&date=${encodeURIComponent(d)}`);
      if (!r.ok) { if (alive) setHstat("error"); return; }
      const data = await r.json();
      if (!alive) return;
      const rows = data?.timeseries ?? [];
      if (!rows.length && !isFallback) {
        // Nothing for this date — fall back to the most recent date with data.
        try {
          const dr = await fetch(`/api/available-dates?index=${encodeURIComponent(label)}`);
          const dd = dr.ok ? await dr.json() : null;
          const dates: string[] = (dd?.dates ?? []).filter((x: string) => x !== d);
          if (dates.length) { if (alive) setFallback(true); await load(dates[0], true); return; }
        } catch { /* fall through */ }
        if (alive) setHstat("empty");
        return;
      }
      const stride = Math.max(1, Math.ceil(rows.length / 160));
      const ce = rows.filter((x: any) => x.option_type === "CE").filter((_: any, i: number) => i % stride === 0);
      const pe = rows.filter((x: any) => x.option_type === "PE").filter((_: any, i: number) => i % stride === 0);
      if (alive) { setHist({ ce, pe, shownDate: d }); setHstat("ready"); }
    };
    load(date ?? todayISO(), false).catch(() => { if (alive) setHstat("error"); });
    return () => { alive = false; };
  }, [pick.strike, label, date]);

  const series = (key: string): [number[], number[]] => hist
    ? [hist.ce.map(r => r[key]).filter(v => v != null), hist.pe.map(r => r[key]).filter(v => v != null)]
    : [[], []];
  const [oiC, oiP] = series("oi");
  const [ltpC, ltpP] = series("ltp");
  const [gmC, gmP] = series("gamma");
  const n = Math.max(hist?.ce.length ?? 0, hist?.pe.length ?? 0);
  const timeAt = (i: number) => {
    const r = hist?.ce[i] ?? hist?.pe[i];
    return r?.timestamp ? String(r.timestamp).slice(11, 16) : "";
  };

  const kv = (pairs: [string, string][]) => (
    <div>{pairs.map(([k, v]) => (
      <div key={k} style={{ marginBottom: 6 }}><span style={{ fontSize: 10, color: "var(--mfaint)", display: "block" }}>{k}</span><b className="num">{v}</b></div>
    ))}</div>
  );
  const core = (o?: any) => kv([
    ["LTP", o ? "₹" + fmtPx(o.ltp) : "—"],
    ["OI", fmtOI(o?.oi)],
    ["OI chg", fmtDelta(o?.oi_change)],
    ["OI chg %", fmtDeltaPct(o?.oi_change ?? null, o?.oi ?? null)],
    ["Gamma", o?.gamma != null ? o.gamma.toFixed(5) : "—"],
  ]);

  return (
    <div className="mc-sheet open">
      <div className="mc-grab" />
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }} className="num">{pick.strike.toLocaleString("en-IN")}</div>
        <div style={{ fontSize: 11, color: "var(--mfaint)" }} className="num">
          {label}{expiry ? " · exp " + fmtExpiry(expiry) : ""}{lot ? " · lot " + lot : ""}
        </div>
        <button style={{ marginLeft: "auto", fontSize: 13, color: "var(--mdim)" }} onClick={onClose}>Close</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 12 }}>
        <div><div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: .5, color: "var(--mce)", marginBottom: 7 }}>CALL</div>{core(pick.ce)}</div>
        <div><div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: .5, color: "var(--mpe)", marginBottom: 7 }}>PUT</div>{core(pick.pe)}</div>
      </div>
      <div style={{ fontSize: 10, color: "var(--mfaint)", margin: "8px 0 10px", paddingTop: 8, borderTop: "1px solid var(--mborder)" }}>
        Session history · {hist?.shownDate ?? date ?? "today"}{fallback ? " (latest available — nothing recorded for the requested date)" : ""}
      </div>
      {hstat === "loading" && <div className="mc-note" style={{ padding: "6px 0" }}>Loading history…</div>}
      {hstat === "error" && <div className="mc-note" style={{ padding: "6px 0" }}>Couldn't load history — the server returned an error or is unreachable.</div>}
      {hstat === "empty" && <div className="mc-note" style={{ padding: "6px 0" }}>No snapshots for this strike on the requested date, and no earlier dates have data either.</div>}
      {hstat === "ready" && hist && (n < 2 || (!oiC.length && !ltpC.length && !gmC.length)) && (
        <div className="mc-note" style={{ padding: "6px 0" }}>Only {n} snapshot(s) on {hist.shownDate} — not enough to plot.</div>
      )}
      {hstat === "ready" && hist && n > 1 && (
        <>
          <Chart title="OI" ce={oiC} pe={oiP} hover={hover} setHover={setHover} timeAt={timeAt} fmtY={x => fmtOI(x)} />
          <Chart title="LTP" ce={ltpC} pe={ltpP} hover={hover} setHover={setHover} timeAt={timeAt} fmtY={x => "₹" + fmtPx(x)} />
          <Chart title="Gamma" ce={gmC} pe={gmP} hover={hover} setHover={setHover} timeAt={timeAt} fmtY={x => Number(x).toFixed(5)} />
          <div className="mc-note" style={{ padding: "2px 0 6px" }}>Drag across any chart — the cursor is linked across all three.</div>
        </>
      )}
    </div>
  );
}
