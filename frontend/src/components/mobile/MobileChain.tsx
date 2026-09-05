import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { fmtOI, fmtDelta, fmtPx } from "./mobileFormat";

interface Opt {
  strike: number; option_type: string; oi: number; oi_change: number;
  volume: number; ltp: number; iv?: number | null; delta?: number | null;
  gamma?: number | null; theta?: number | null; vega?: number | null; gex?: number | null;
}
interface RowData { strike: number; ce?: Opt; pe?: Opt }

/**
 * Mobile option chain — columns: LTP | OI Δ | OI | STRIKE | OI | OI Δ | LTP
 * Walls: full-row inset border in the wall color + colored OI + bold strike.
 * ATM: centers on load / instrument / expiry; drift-recenter only when the
 * user has been idle 8s; the floating pill (live mode only — never over the
 * replay bar) and the walls-strip ATM chip both recenter.
 */
const ChainRow = React.memo(function ChainRow(props: {
  row: RowData; isATM: boolean; isCEWall: boolean; isPEWall: boolean;
  gL: number; gR: number; gMax: number;
  onSelect: (s: number) => void;
}) {
  const { row, isATM, isCEWall, isPEWall, gL, gR, gMax, onSelect } = props;
  const ce = row.ce, pe = row.pe;
  const ceD = ce ? ce.oi_change : null, peD = pe ? pe.oi_change : null;
  const cls = "mc-row" + (isATM ? " atm" : "") + (isCEWall ? " cewall" : "") + (isPEWall ? " pewall" : "");
  // GEX shading: per-side diverging bar anchored at the strike column,
  // growing outward; width ∝ |gex|/max, color by sign (blue+/red−).
  const wl = gMax > 0 ? Math.min(46, (Math.abs(gL) / gMax) * 46) : 0;
  const wr = gMax > 0 ? Math.min(46, (Math.abs(gR) / gMax) * 46) : 0;
  return (
    <div className={cls} data-s={row.strike} onClick={() => onSelect(row.strike)}>
      {wl > 0.5 && <div className="mc-gexb l" style={{ width: wl + "%", background: gL >= 0 ? "var(--mup)" : "var(--mdn)" }} />}
      {wr > 0.5 && <div className="mc-gexb r" style={{ width: wr + "%", background: gR >= 0 ? "var(--mup)" : "var(--mdn)" }} />}
      <div className="mc-c mc-lt num">{ce ? fmtPx(ce.ltp) : "—"}</div>
      <div className="mc-c"><span className={"mc-dl num " + (ceD == null ? "" : ceD >= 0 ? "mc-up" : "mc-dn")}>{fmtDelta(ceD)}</span></div>
      <div className="mc-c"><div className={"mc-oi num" + (isCEWall ? " mc-oi-ce" : "")}>{ce ? fmtOI(ce.oi) : "—"}</div></div>
      <div className={"mc-strk num" + (isCEWall ? " mc-strk-ce" : isPEWall ? " mc-strk-pe" : "")}>
        {isCEWall && <span className="mc-wn l" />}
        {isPEWall && <span className="mc-wn r" />}
        {row.strike.toLocaleString("en-IN")}
        {isATM && <span className="mc-tag">atm</span>}
        {!isATM && isCEWall && <span className="mc-tag ce">ce wall</span>}
        {!isATM && !isCEWall && isPEWall && <span className="mc-tag pe">pe wall</span>}
      </div>
      <div className="mc-p"><div className={"mc-oi num" + (isPEWall ? " mc-oi-pe" : "")}>{pe ? fmtOI(pe.oi) : "—"}</div></div>
      <div className="mc-p"><span className={"mc-dl num " + (peD == null ? "" : peD >= 0 ? "mc-up" : "mc-dn")}>{fmtDelta(peD)}</span></div>
      <div className="mc-p mc-lt num">{pe ? fmtPx(pe.ltp) : "—"}</div>
    </div>
  );
}, (a, b) =>
  a.row === b.row && a.isATM === b.isATM && a.isCEWall === b.isCEWall && a.isPEWall === b.isPEWall &&
  a.gL === b.gL && a.gR === b.gR && a.gMax === b.gMax
);

const IDLE_RECENTER_MS = 8000;

export default function MobileChain({ data, onSelect, floating = true, recenterTick = 0, focusStrike = null, focusTick = 0 }: {
  data: any;
  onSelect: (s: number) => void;
  /** false in Replay: no floating pill over the replay bar. */
  floating?: boolean;
  /** Increment to request a recenter (walls-strip ATM chip). */
  recenterTick?: number;
  /** Request scrolling to a specific strike (levels-rail markers). */
  focusStrike?: number | null;
  focusTick?: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const centeredFor = useRef<string>("");
  const lastUserScroll = useRef(0);
  const lastATM = useRef<number | null>(null);
  const [pillOn, setPillOn] = useState(false);

  const rows: RowData[] = useMemo(() => {
    const opts: Opt[] = data?.options ?? [];
    const byStrike = new Map<number, RowData>();
    for (const o of opts) {
      let r = byStrike.get(o.strike);
      if (!r) { r = { strike: o.strike }; byStrike.set(o.strike, r); }
      if (o.option_type === "CE") r.ce = o; else r.pe = o;
    }
    return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  }, [data?.options]);

  const spot: number | null = data?.spot ?? null;
  const atmStrike = useMemo(() => {
    if (spot == null || !rows.length) return null;
    const sorted = rows.map(r => r.strike).sort((a, b) => a - b);
    const step = sorted.length > 1 ? sorted[1] - sorted[0] : 0;
    // Ideal strike by rounding spot to the ladder; ties resolve to the HIGHER strike.
    const ideal = step > 0 ? Math.round(spot / step) * step : spot;
    return sorted.reduce((best, s) => {
      const dIdeal = Math.abs(s - ideal), bIdeal = Math.abs(best - ideal);
      if (dIdeal !== bIdeal) return dIdeal < bIdeal ? s : best;
      const dSpot = Math.abs(s - spot), bSpot = Math.abs(best - spot);
      return dSpot !== bSpot ? (dSpot < bSpot ? s : best) : Math.max(s, best);
    }, sorted[0]);
  }, [rows, spot]);

  const walls = useMemo(() => {
    let ceW: number | null = null, peW: number | null = null, ceM = -1, peM = -1;
    for (const r of rows) {
      if (r.ce && r.ce.oi > ceM) { ceM = r.ce.oi; ceW = r.strike; }
      if (r.pe && r.pe.oi > peM) { peM = r.pe.oi; peW = r.strike; }
    }
    return { ceWall: ceW, peWall: peW };
  }, [rows]);

  // GEX scale for the embedded shading (per side, shared across rows).
  const gMax = useMemo(() => rows.reduce((m, r) =>
    Math.max(m, Math.abs(r.ce?.gex ?? 0), Math.abs(r.pe?.gex ?? 0)), 0), [rows]);

  const scrollToATM = useCallback(() => {
    const el = listRef.current?.querySelector('.mc-row.atm') as HTMLElement | null;
    if (!el || !listRef.current) return;
    lastUserScroll.current = 0; // program scroll must not count as user scroll
    listRef.current.scrollTop = el.offsetTop - listRef.current.clientHeight / 2 + el.offsetHeight / 2;
  }, []);

  // External recenter requests (walls-strip ATM chip).
  useEffect(() => { if (recenterTick > 0) scrollToATM(); }, [recenterTick, scrollToATM]);

  // External focus requests (levels-rail markers) — scroll to that strike row.
  useEffect(() => {
    if (focusStrike == null || focusTick === 0 || !listRef.current) return;
    lastUserScroll.current = 0;
    const el = listRef.current.querySelector(`.mc-row[data-s="${focusStrike}"]`) as HTMLElement | null;
    if (el) listRef.current.scrollTop = el.offsetTop - listRef.current.clientHeight / 2 + el.offsetHeight / 2;
  }, [focusTick, focusStrike]);

  // Centering policy: load / instrument / expiry always; drift only when idle.
  const centerKey = (data?.index_name ?? "") + ":" + (data?.expiry ?? "");
  useEffect(() => {
    if (!rows.length) return;
    const isNewContext = centeredFor.current !== centerKey;
    const atmMoved = lastATM.current !== null && atmStrike !== null && atmStrike !== lastATM.current;
    const userIdle = Date.now() - lastUserScroll.current > IDLE_RECENTER_MS;
    if (isNewContext || (atmMoved && userIdle)) {
      centeredFor.current = centerKey;
      const t = setTimeout(scrollToATM, 60);
      lastATM.current = atmStrike;
      return () => clearTimeout(t);
    }
    lastATM.current = atmStrike;
  }, [centerKey, rows.length, atmStrike, scrollToATM]);

  // Pill visibility — depends on atmStrike too, so a data swap (replay,
  // instrument change) can never leave a stale pill on screen.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const check = () => {
      rafRef.current = 0;
      const row = el.querySelector('.mc-row.atm') as HTMLElement | null;
      if (!row) { setPillOn(false); return; }
      const lr = el.getBoundingClientRect(), rr = row.getBoundingClientRect();
      const visible = rr.top >= lr.top + 36 && rr.bottom <= lr.bottom - 4;
      setPillOn(!visible);
    };
    const onScroll = () => {
      lastUserScroll.current = Date.now();
      if (!rafRef.current) rafRef.current = requestAnimationFrame(check);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    check();
    return () => { el.removeEventListener("scroll", onScroll); if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [centerKey, rows.length, atmStrike]);

  if (!rows.length) {
    return (
      <div className="mc-empty">
        {data?.market_open === false
          ? <>Session closed for {data?.index_name ?? "this instrument"}.<br />Live chain resumes in the next session.</>
          : <>Waiting for option ticks on {data?.index_name ?? "…"}<br /><span style={{ fontSize: 11 }}>{data?.window_state ?? ""}</span></>}
      </div>
    );
  }

  return (
    <>
      <div className="mc-ladder" ref={listRef}>
        <div className="mc-lh">
          <div>LTP</div><div>Chg</div><div className="h-oi" style={{ textAlign: "right" }}>OI</div>
          <div>Strike</div><div className="h-oi">OI</div><div>Chg</div><div>LTP</div>
        </div>
        {rows.map(r => (
          <ChainRow key={r.strike} row={r}
            isATM={r.strike === atmStrike}
            isCEWall={r.strike === walls.ceWall}
            isPEWall={r.strike === walls.peWall}
            gL={r.ce?.gex ?? 0} gR={r.pe?.gex ?? 0} gMax={gMax}
            onSelect={onSelect} />
        ))}
      </div>
      {floating && (
        <button id="mcAtmPill" className={pillOn ? "on num" : "num"} onClick={scrollToATM}>
          ⌖ ATM {atmStrike != null ? atmStrike.toLocaleString("en-IN") : ""}
        </button>
      )}
    </>
  );
}
