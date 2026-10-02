import React, { useMemo } from "react";
import { fmtOI } from "./mobileFormat";

/** Market Levels rail — one compact, price-proportional visualization.
 *  Markers sit at their TRUE price x. Text stacks are collision-resolved
 *  (min separation, sliding apart) with leader lines back to their marker,
 *  so adjacent levels (ATM vs CE wall) never overlap while the rail stays
 *  honest about distance. Tap a marker to focus that strike in the chain. */
const W = 360, M = 16, GAP = 64, EDGE = 38; // EDGE = half max label width

/** Push stack centers apart to >= GAP px, clamped to the canvas; returns
 *  text-x per level in the ORIGINAL order [ce, atm, pe]. */
function resolveStacks(xs: number[]): number[] {
  const order = [0, 1, 2].sort((a, b) => xs[a] - xs[b]);
  const pos = [...xs];
  for (let i = 1; i < 3; i++) if (pos[order[i]] < pos[order[i - 1]] + GAP) pos[order[i]] = pos[order[i - 1]] + GAP;
  if (pos[order[2]] > W - EDGE) { pos[order[2]] = W - EDGE; pos[order[1]] = Math.min(pos[order[1]], pos[order[2]] - GAP); pos[order[0]] = Math.min(pos[order[0]], pos[order[1]] - GAP); }
  return pos.map(p => Math.max(EDGE, Math.min(W - EDGE, p)));
}
const fmtK = (v: number) => v >= 1000 ? (v / 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 }) + "k" : String(Math.round(v));

export default function MobileLevelsRail({ spot, atm, ceWall, peWall, ceOI, peOI, onFocus }: {
  spot: number | null; atm: number | null; ceWall: number | null; peWall: number | null;
  ceOI: number | null; peOI: number | null;
  onFocus?: (strike: number | null) => void;
}) {
  const geo = useMemo(() => {
    if (ceWall == null || peWall == null || atm == null || spot == null) return null;
    const lo = Math.min(peWall, spot, atm, ceWall), hi = Math.max(peWall, spot, atm, ceWall);
    const pad = Math.max((hi - lo) * 0.14, 1);
    const dLo = lo - pad, dHi = hi + pad;
    const x = (v: number) => M + ((v - dLo) / (dHi - dLo)) * (W - M * 2);
    const raw = (dHi - dLo) / 5, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = mag * (raw / mag < 1.5 ? 1 : raw / mag < 3.5 ? 2 : raw / mag < 7.5 ? 5 : 10);
    const ticks: number[] = [];
    for (let t = Math.ceil(dLo / step) * step; t <= dHi; t += step) ticks.push(t);
    const mx = [x(ceWall), x(atm), x(peWall)];
    return { x, ticks, mx, tx: resolveStacks(mx) };
  }, [spot, atm, ceWall, peWall]);

  if (!geo) return null;
  const { x, ticks, mx, tx } = geo;
  const pts = (v: number) => { const d = v - (spot as number); return (d >= 0 ? "+" : "−") + Math.abs(Math.round(d)); };
  const LBL = ["var(--mce)", "var(--mblue)", "var(--mpe)"];
  const FILL = ["var(--mce)", "var(--mblue)", "var(--mpe)"];
  const vals = [ceWall, atm, peWall] as number[];
  const names = ["CE WALL", "ATM", "PE WALL"];

  const onTap = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onFocus) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const cands = [{ v: mx[0], s: vals[0] }, { v: mx[1], s: vals[1] }, { v: mx[2], s: vals[2] }, { v: x(spot as number), s: null }];
    let best: typeof cands[0] | null = null;
    for (const c of cands) if (!best || Math.abs(c.v - vx) < Math.abs(best.v - vx)) best = c;
    if (best && Math.abs(best.v - vx) < 30) onFocus(best.s);
  };

  return (
    <div className="mc-rail num">
      <svg viewBox={`0 0 ${W} 118`} style={{ width: "100%", height: "auto", display: "block" }} onClick={onTap}>
        {[0, 1, 2].map(i => (
          <g key={i}>
            {/* leader line from true marker x up to the displaced text stack */}
            {Math.abs(tx[i] - mx[i]) > 4 && (
              <path d={`M ${mx[i]} 64 L ${mx[i]} 56 L ${tx[i]} 56`} fill="none" style={{ stroke: "#2c3850", strokeWidth: 1 }} />
            )}
            <text x={tx[i]} y={11} textAnchor="middle" className="mc-rail-lbl" style={{ fill: LBL[i] }}>{names[i]}</text>
            <text x={tx[i]} y={27} textAnchor="middle" className="mc-rail-val" style={{ fill: FILL[i] }}>{vals[i].toLocaleString("en-IN")}</text>
            <text x={tx[i]} y={40} textAnchor="middle" className="mc-rail-sub" style={{ fill: LBL[i] }}>{pts(vals[i])} pts</text>
            {(i === 0 ? ceOI : i === 2 ? peOI : null) != null && (
              <text x={tx[i]} y={51} textAnchor="middle" className="mc-rail-oi" style={{ fill: "var(--mfaint)" }}>{fmtOI(i === 0 ? ceOI : peOI)} OI</text>
            )}
          </g>
        ))}
        <line x1={M} y1={66} x2={W - M} y2={66} style={{ stroke: "#2c3850", strokeWidth: 1 }} />
        <circle cx={mx[2]} cy={66} r={4} style={{ fill: "var(--mpe)", stroke: "var(--mbg)", strokeWidth: 1.5 }} />
        <circle cx={mx[1]} cy={66} r={4} style={{ fill: "var(--mblue)", stroke: "var(--mbg)", strokeWidth: 1.5 }} />
        <circle cx={mx[0]} cy={66} r={4} style={{ fill: "var(--mce)", stroke: "var(--mbg)", strokeWidth: 1.5 }} />
        {ticks.map(t => (
          <g key={t}>
            <line x1={x(t)} y1={66} x2={x(t)} y2={70} style={{ stroke: "#2c3850", strokeWidth: 1 }} />
            <text x={Math.max(M + 6, Math.min(W - M - 6, x(t)))} y={80} textAnchor="middle" className="mc-rail-tick" style={{ fill: "var(--mfaint)" }}>{fmtK(t)}</text>
          </g>
        ))}
        <path d={`M ${x(spot as number) - 4} 90 L ${x(spot as number) + 4} 90 L ${x(spot as number)} 96 Z`} style={{ fill: "var(--mtx)" }} />
        <text x={Math.max(52, Math.min(W - 52, x(spot as number)))} y={108} textAnchor="middle" className="mc-rail-spot" style={{ fill: "var(--mtx)" }}>
          SPOT {(spot as number).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
        </text>
      </svg>
    </div>
  );
}
