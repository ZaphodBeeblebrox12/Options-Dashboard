import React, { useMemo } from "react";
import { GexChart } from "../GexChart";
import { fmtGex, fmtNum } from "./mobileFormat";

/**
 * Mobile Map — reuses the DESKTOP GexChart component (which already adapts
 * to narrow widths: ATM-windowed bars, per-strike labels, ATM / max-pain /
 * gamma-flip reference lines, tooltip on tap). We only build the same
 * gexByStrike shape the desktop builds from /api/gex-by-strike, live from
 * the tick payload. Walls (argmax OI, same definition as the alert engine)
 * are surfaced as chips below — the desktop chart itself has no wall prop.
 */
export default function MobileMap({ data, isScanner }: { data: any; isScanner: boolean }) {
  const gexByStrike = useMemo(() => {
    const by = new Map<number, { strike: number; ce_gex: number; pe_gex: number; net_gex: number }>();
    (data?.options ?? []).forEach((o: any) => {
      let r = by.get(o.strike);
      if (!r) { r = { strike: o.strike, ce_gex: 0, pe_gex: 0, net_gex: 0 }; by.set(o.strike, r); }
      if (o.option_type === "CE") r.ce_gex += o.gex ?? 0; else r.pe_gex += o.gex ?? 0;
      r.net_gex = r.ce_gex + r.pe_gex;
    });
    return [...by.values()].sort((a, b) => a.strike - b.strike);
  }, [data?.options]);

  const walls = useMemo(() => {
    let ceW: number | null = null, peW: number | null = null, cm = -1, pm = -1;
    (data?.options ?? []).forEach((o: any) => {
      if (o.option_type === "CE" && o.oi > cm) { cm = o.oi; ceW = o.strike; }
      if (o.option_type === "PE" && o.oi > pm) { pm = o.oi; peW = o.strike; }
    });
    return { ceWall: ceW, peWall: peW };
  }, [data?.options]);

  if (!data) return <div className="mc-empty">Waiting for data…</div>;

  if (isScanner) {
    return (
      <div className="mc-scrl">
        <div className="mc-title">Map</div>
        <div className="mc-card">
          <h4>GEX map unavailable on Tier 3</h4>
          <div style={{ fontSize: 12.5, color: "var(--mdim)", lineHeight: 1.6 }}>
            Scanner instruments carry no per-strike GEX. Promote {data.index_name} to Tier 2 to unlock this view.
          </div>
        </div>
      </div>
    );
  }

  const atmStrike = data.spot != null && gexByStrike.length
    ? gexByStrike.reduce((b, r) => Math.abs(r.strike - data.spot) < Math.abs(b - data.spot) ? r : b, gexByStrike[0]).strike
    : null;

  return (
    <div className="mc-scrl">
      <div className="mc-title">Map · {data.index_name}</div>
      <div className="mc-card" style={{ padding: "10px 6px 4px" }}>
        <GexChart
          data={gexByStrike}
          atmStrike={atmStrike}
          maxPain={data.max_pain ?? null}
          gammaFlip={data.gamma_flip ?? null}
        />
        <div className="mc-note" style={{ padding: "4px 20px 8px" }}>Tap a bar for strike, CE/PE GEX and net values.</div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <div className="mc-wallchip ce">CE wall<b className="num">{walls.ceWall != null ? fmtNum(walls.ceWall) : "—"}</b></div>
        <div className="mc-wallchip" style={{ borderColor: "color-mix(in srgb,var(--mblue) 40%,transparent)" }}>ATM<b className="num" style={{ color: "var(--mblue)" }}>{atmStrike != null ? fmtNum(atmStrike) : "—"}</b></div>
        <div className="mc-wallchip pe">PE wall<b className="num">{walls.peWall != null ? fmtNum(walls.peWall) : "—"}</b></div>
      </div>
      <div className="mc-card">
        <h4>Levels</h4>
        <div className="mc-kv num">
          <div><span>Net gex</span><b style={{ color: (data.net_gex ?? 0) >= 0 ? "var(--mblue)" : "var(--mdn)" }}>{fmtGex(data.net_gex)}</b></div>
          <div><span>Gamma flip</span><b>{data.gamma_flip != null ? fmtNum(data.gamma_flip) : "—"}</b></div>
          <div><span>Max gex strike</span><b>{data.max_gex_strike != null ? fmtNum(data.max_gex_strike) : "—"}</b></div>
          <div><span>Max pain</span><b>{data.max_pain != null ? fmtNum(data.max_pain) : "—"}</b></div>
        </div>
      </div>
    </div>
  );
}
