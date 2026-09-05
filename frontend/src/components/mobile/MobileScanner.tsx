import React, { useMemo, useState } from "react";
import MobileChain from "./MobileChain";
import { fmtNum } from "./mobileFormat";

interface ScannerEntry { name: string; data: any }
interface PromotedEntry { marketState: any; expiresAt: number }

/**
 * Tier-3 = surveillance, not analysis. This list answers exactly five
 * questions per scanner: what instrument, where is ATM, is it at/near a
 * wall, what are the wall strikes, is a confirmation running.
 *
 * States per instrument:
 *   idle      -> one-line row under "Watching"
 *   near      -> full card (ATM within ~1 strike of a wall)
 *   wall      -> prominent card (at_wall from the tick payload)
 *   promoted  -> the scanner's Rule-1 alert arrived: render the NORMAL
 *                analytical chain from the alert's market_state snapshot,
 *                with a countdown, then fall back to the compact card.
 *
 * No option chain is shown for a scanner that has not fired.
 */
function strikesStep(data: any): number {
  const s = (data?.options ?? []).map((o: any) => o.strike);
  if (s.length < 2) return 0;
  const ds: number[] = [];
  for (let i = 1; i < s.length; i++) ds.push(s[i] - s[i - 1]);
  ds.sort((a, b) => a - b);
  return ds[Math.floor(ds.length / 2)] || 0;
}

function WallChips({ ce, pe }: { ce: number | null; pe: number | null }) {
  return (
    <div className="mc-walls">
      <div className="mc-wallchip ce">CE wall<b className="num">{ce != null ? fmtNum(ce) : "—"}</b></div>
      <div className="mc-wallchip pe">PE wall<b className="num">{pe != null ? fmtNum(pe) : "—"}</b></div>
    </div>
  );
}

export default function MobileScanner({ scanners, promoted, now, onPromoteEnd }: {
  scanners: ScannerEntry[];
  promoted: Record<string, PromotedEntry>;
  now: number;
  onPromoteEnd: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const analyzed = useMemo(() => scanners.map(e => {
    const d = e.data;
    if (!d) return { ...e, state: "nodata" as const, atm: null, ceWall: null, peWall: null, dist: null };
    const opts: any[] = d.options ?? [];
    const spot = d.spot ?? null;
    const strikes = opts.map((o: any) => o.strike);
    const atm: number | null = d.atm ?? (spot != null && strikes.length
      ? strikes.reduce((b: number, s: number) => Math.abs(s - spot) < Math.abs(b - spot) ? s : b, strikes[0])
      : null);
    let ceWall: number | null = d.ce_wall ?? null, peWall: number | null = d.pe_wall ?? null;
    if (ceWall == null || peWall == null) {
      let cm = -1, pm = -1;
      for (const o of opts) {
        if (o.option_type === "CE" && o.oi > cm) { cm = o.oi; ceWall = o.strike; }
        if (o.option_type === "PE" && o.oi > pm) { pm = o.oi; peWall = o.strike; }
      }
    }
    const step = strikesStep(d);
    let dist: number | null = null;
    if (atm != null) {
      const cands = [ceWall, peWall].filter((w): w is number => w != null);
      if (cands.length) dist = Math.min(...cands.map(w => Math.abs(w - atm)));
    }
    const isPromoted = !!promoted[e.name] && promoted[e.name].expiresAt > now;
    let state: "idle" | "near" | "wall" | "promoted" = "idle";
    if (isPromoted) state = "promoted";
    else if (d.at_wall) state = "wall";
    else if (dist != null && step > 0 && dist <= step * 1.5) state = "near";
    return { ...e, state, atm, ceWall, peWall, dist, step };
  }), [scanners, promoted, now]);

  const attention = analyzed.filter(a => a.state === "wall" || a.state === "promoted" || expanded === a.name);
  const near = analyzed.filter(a => a.state === "near" && expanded !== a.name);
  const idle = analyzed.filter(a => (a.state === "idle" || a.state === "nodata") && expanded !== a.name);

  const card = (a: any) => {
    const p = promoted[a.name];
    const secs = p ? Math.max(0, Math.ceil((p.expiresAt - now) / 1000)) : 0;
    return (
      <div key={a.name} className={"mc-acard" + (a.state === "wall" ? " wall" : a.state === "near" ? " near" : "")}>
        <div className="mc-acard-top">
          <span className="mc-acard-nm num">{a.name}</span>
          <span className="mc-badge t3">Tier 3</span>
          <span className="mc-acard-kind">{a.data?.instrument_kind ?? "stock"}</span>
          <span className={"mc-statepill " + (a.state === "wall" ? "hot" : a.state === "near" ? "warn" : a.state === "promoted" ? "cnf" : "arm")} style={{ marginLeft: "auto" }}>
            {a.state === "wall" ? "At wall" : a.state === "near" ? "Near wall" : a.state === "promoted" ? "Analytical" : "Armed"}
          </span>
        </div>

        {a.state === "promoted" && p ? (
          <>
            <MobileChain data={p.marketState} onSelect={() => {}} />
            <div className="mc-cnfbanner">
              <span>Wall confirmed — full-chain analytics from the alert snapshot</span>
              <b className="num" style={{ marginLeft: "auto" }}>0:{String(secs).padStart(2, "0")}</b>
              <button onClick={() => onPromoteEnd(a.name)} style={{ fontSize: 11, color: "var(--mdim)", marginLeft: 6 }}>dismiss</button>
            </div>
          </>
        ) : (
          <>
            <div className="mc-atmrow">
              <span className="mc-atm num">{a.atm != null ? fmtNum(a.atm) : "—"}</span>
              <span className="mc-dst num">{a.dist != null ? (a.dist === 0 ? "at wall" : a.dist + " pts to nearest wall") : ""}</span>
            </div>
            <WallChips ce={a.ceWall} pe={a.peWall} />
            {a.state === "wall" ? (
              <div className="mc-statline"><span className="mc-pulse" />Confirming chain-wide — the backend widens to the full chain at this trigger</div>
            ) : a.state === "near" ? (
              <div className="mc-statline" style={{ color: "var(--mamber)" }}>Near wall — {a.step > 0 ? Math.max(1, Math.round((a.dist ?? 0) / a.step)) : "?"} strike(s) away</div>
            ) : (
              <div className="mc-statline">Watching · no wall contact</div>
            )}
          </>
        )}
      </div>
    );
  };

  const idleRow = (a: any) => (
    <button key={a.name} className="mc-irow" onClick={() => setExpanded(a.name)}>
      <div>
        <div className="mc-irow-nm num">{a.name}</div>
        <div className="mc-irow-meta">{a.data?.instrument_kind ?? "stock"} · armed</div>
      </div>
      <div className="mc-irow-right num">
        ATM {a.atm != null ? fmtNum(a.atm) : "—"}<br />
        C {a.ceWall != null ? fmtNum(a.ceWall) : "—"} · P {a.peWall != null ? fmtNum(a.peWall) : "—"}
      </div>
    </button>
  );

  if (!scanners.length) {
    return <div className="mc-empty">No scanner instruments.<br /><span style={{ fontSize: 11 }}>Add one from the desktop app — it will appear here as a Tier-3 card.</span></div>;
  }

  return (
    <div className="mc-scrl">
      {attention.length > 0 && <><div className="mc-sech">Needs attention</div>{attention.map(card)}</>}
      {near.length > 0 && <><div className="mc-sech">Near wall</div>{near.map(card)}</>}
      {idle.length > 0 && <><div className="mc-sech">Watching · {idle.length}</div>{idle.map(idleRow)}</>}
      <div className="mc-note">Tier 3 is surveillance — analytics run only at wall triggers. Chain views live in Watch.</div>
    </div>
  );
}
