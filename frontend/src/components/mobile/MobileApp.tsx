import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertToastContainer } from "../AlertToast";
import type { AlertFiring } from "../../hooks/useAlerts";
import { fetchInstruments } from "../../instrumentsCache";
import MobileChain from "./MobileChain";
import MobileScanner from "./MobileScanner";
import MobileMap from "./MobileMap";
import MobileAlerts from "./MobileAlerts";
import MobileInstrumentSheet from "./MobileInstrumentSheet";
import MobileCalendar from "./MobileCalendar";
import MobileSettings from "./MobileSettings";
import MobileLevelsRail from "./MobileLevelsRail";
import MobileStrikeSheet from "./MobileStrikeSheet";
import { fmtExpiry, fmtPx, fmtGex, fmtNum } from "./mobileFormat";
import "./mobile.css";

const LS_KEY = "chainlens.mobile.selected";
const PROMOTE_SECS = 45;
const SNAP_CACHE_MAX = 80;
const DATES_TTL = 300000;

// One bad tab must never blank the app — catches render errors per surface.
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: any) { return { err: String(e?.message ?? e) }; }
  render() {
    if (this.state.err) {
      return <div className="mc-empty">This view hit an unexpected error.<br /><span style={{ fontSize: 11 }}>{this.state.err}</span></div>;
    }
    return this.props.children;
  }
}

type Tab = "watch" | "scan" | "map" | "alerts" | "more";
interface ReplayState { date: string; ts: string[]; idx: number; playing: boolean }
const SUBTITLES: Record<Exclude<Tab, "watch">, string> = { scan: "Scanner", map: "Map", alerts: "Alerts", more: "Settings" };

export default function MobileApp({ connected, lastMessage, toasts, removeToast, onInstrumentChange }: {
  connected: boolean;
  lastMessage: unknown;
  toasts: AlertFiring[];
  removeToast: (timestamp: string) => void;
  onInstrumentChange?: (name: string) => void;
}) {
  const [liveMap, setLiveMap] = useState<Record<string, any>>({});
  const [alertFeed, setAlertFeed] = useState<AlertFiring[]>([]);
  const [instList, setInstList] = useState<any[]>([]);
  const instRef = useRef<any[]>([]);
  instRef.current = instList;
  const [selected, setSelected] = useState<string>(() => localStorage.getItem(LS_KEY) || "NIFTY");
  const [tab, setTab] = useState<Tab>("watch");
  const [sheet, setSheet] = useState<null | "inst" | "strike" | "date">(null);
  const [strikePick, setStrikePick] = useState<{ strike: number; ce?: any; pe?: any } | null>(null);
  const [unseen, setUnseen] = useState(0);
  const [promoted, setPromoted] = useState<Record<string, { marketState: any; expiresAt: number }>>({});
  const [now, setNow] = useState(Date.now());
  const [recenterTick, setRecenterTick] = useState(0);
  // Replay (reuses the desktop replay endpoints — no backend change).
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [replaySnap, setReplaySnap] = useState<any>(null);
  const [availDates, setAvailDates] = useState<string[] | null>(null);
  const snapCache = useRef(new Map<string, any>());
  const datesCache = useRef(new Map<string, { at: number; dates: string[] }>());
  const snapSeq = useRef(0);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  useEffect(() => {
    const msg: any = lastMessage;
    if (!msg) return;
    if (msg.type === "tick" && msg.data?.index_name) {
      const name: string = msg.data.index_name;
      setLiveMap(prev => (prev[name] === msg.data ? prev : { ...prev, [name]: msg.data }));
    } else if (msg.type === "alert" && msg.data) {
      const a = msg.data;
      setAlertFeed(prev => [a, ...prev].slice(0, 60));
      setUnseen(u => u + 1);
      const inst = instRef.current.find(i => i.name === a.index_name);
      if ((inst?.tier ?? 3) === 3 && a.market_state) {
        setPromoted(prev => ({ ...prev, [a.index_name]: { marketState: a.market_state, expiresAt: Date.now() + PROMOTE_SECS * 1000 } }));
        setTab(t => (t === "watch" ? "scan" : t));
      }
    }
  }, [lastMessage]);

  useEffect(() => {
    let alive = true;
    const load = () => fetchInstruments().then((d: any) => {
      if (!alive || !d) return;
      const seen = new Map<string, any>();
      (d.tier1 || []).forEach((x: any) => seen.set(x.name, { name: x.name, kind: x.kind || "index", tier: 1 }));
      (d.instruments || []).forEach((x: any) => seen.set(x.name, { name: x.name, kind: x.kind || "stock", tier: x.tier ?? 2 }));
      (d.stocks || []).forEach((x: any) => { if (!seen.has(x.name)) seen.set(x.name, { name: x.name, kind: x.kind || "stock", tier: x.tier ?? 2 }); });
      setInstList([...seen.values()]);
    }).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_KEY, selected);
    onInstrumentChange?.(selected);
  }, [selected, onInstrumentChange]);

  // ── Replay ────────────────────────────────────────────────────────────
  const loadSnapshot = async (date: string, i: number, ts: string[]) => {
    const seq = ++snapSeq.current; // ignore out-of-order responses when scrubbing fast
    const t = ts[i];
    if (!t) return undefined;
    const key = selected + "|" + t;
    let snap = snapCache.current.get(key);
    if (!snap) {
      try {
        const r = await fetch(`/api/snapshot/${encodeURIComponent(t)}?index=${encodeURIComponent(selected)}`);
        if (!r.ok) return;
        snap = await r.json();
        if (snapCache.current.size >= SNAP_CACHE_MAX) snapCache.current.delete(snapCache.current.keys().next().value);
        snapCache.current.set(key, snap);
      } catch { return undefined; }
    }
    if (seq !== snapSeq.current) return undefined;
    setReplaySnap(snap);
    return snap;
  };

  const enterReplay = async (date: string) => {
    setSheet(null);
    try {
      const r = await fetch(`/api/snapshots?date=${encodeURIComponent(date)}&index=${encodeURIComponent(selected)}`);
      const d = await r.json();
      const ts: string[] = d?.timestamps ?? [];
      if (!ts.length) return;
      const snap = await loadSnapshot(date, 0, ts);
      if (!snap) return; // stay live if the snapshot can't load
      setReplay({ date, ts, idx: 0, playing: false });
    } catch { /* stay live */ }
  };

  const exitReplay = () => { snapSeq.current++; setReplay(null); setReplaySnap(null); };

  useEffect(() => { // load snapshot on scrub / play advance
    if (replay) loadSnapshot(replay.date, replay.idx, replay.ts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay?.idx, replay?.date, selected]);

  useEffect(() => { // playback clock
    if (!replay?.playing) return;
    const t = setInterval(() => {
      setReplay(r => {
        if (!r) return r;
        if (r.idx >= r.ts.length - 1) { clearInterval(t); return { ...r, playing: false }; }
        return { ...r, idx: r.idx + 1 };
      });
    }, 1500);
    return () => clearInterval(t);
  }, [replay?.playing]);

  useEffect(() => { // available replay dates (cached 5 min per instrument)
    if (sheet !== "date") return;
    const hit = datesCache.current.get(selected);
    if (hit && Date.now() - hit.at < DATES_TTL) { setAvailDates(hit.dates); return; }
    let alive = true;
    fetch(`/api/available-dates?index=${encodeURIComponent(selected)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const dates: string[] = d?.dates ?? [];
        datesCache.current.set(selected, { at: Date.now(), dates });
        if (alive) setAvailDates(dates);
      }).catch(() => { if (alive) setAvailDates([]); });
    return () => { alive = false; };
  }, [sheet, selected]);

  const data = liveMap[selected];
  const meta = instList.find(i => i.name === selected);
  const kind: string = data?.instrument_kind ?? meta?.kind ?? "index";
  const tier: number = data?.tier ?? meta?.tier ?? 1;
  const isScanner = !!data?.scanner || tier === 3;
  const viewData = replay ? replaySnap : data; // replay overrides live on Watch

  useEffect(() => { if (isScanner && tab === "watch") setTab("scan"); }, [isScanner, tab]);

  const watchList = useMemo(() => instList.filter(i => (i.tier ?? 3) < 3), [instList]);
  const scanners = useMemo(() => {
    const names = new Map<string, any>();
    instList.filter(i => (i.tier ?? 3) === 3).forEach(i => names.set(i.name, i));
    Object.entries(liveMap).forEach(([n, d]: [string, any]) => {
      if (d?.scanner && !names.has(n)) names.set(n, { name: n, kind: d.instrument_kind ?? "stock", tier: 3 });
    });
    return [...names.values()].map(i => ({ name: i.name, data: liveMap[i.name] }));
  }, [instList, liveMap]);

  const scanAttention = useMemo(() => scanners.reduce((acc, s) => {
    const d = s.data;
    if (!d) return acc;
    if (d.at_wall) return acc + 1;
    const strikes: number[] = (d.options ?? []).map((o: any) => o.strike);
    if (!strikes.length || d.spot == null) return acc;
    const atm = d.atm ?? strikes.reduce((b, x) => Math.abs(x - d.spot) < Math.abs(b - d.spot) ? x : b, strikes[0]);
    let ceW: number | null = d.ce_wall ?? null, peW: number | null = d.pe_wall ?? null;
    if (ceW == null || peW == null) {
      let cm = -1, pm = -1;
      (d.options ?? []).forEach((o: any) => {
        if (o.option_type === "CE" && o.oi > cm) { cm = o.oi; ceW = o.strike; }
        if (o.option_type === "PE" && o.oi > pm) { pm = o.oi; peW = o.strike; }
      });
    }
    const cands = [ceW, peW].filter((w): w is number => w != null);
    if (!cands.length) return acc;
    const dist = Math.min(...cands.map(w => Math.abs(w - atm)));
    const step = strikes.length > 1 ? strikes[1] - strikes[0] : 0;
    return acc + (step > 0 && dist <= step * 1.5 ? 1 : 0);
  }, 0), [scanners]);

  // Market levels: walls (argmax OI, same definition as the alert engine)
  // with their OI amounts, for the levels rail.
  const walls = useMemo(() => {
    let ceW: number | null = null, peW: number | null = null, ceOI: number | null = null, peOI: number | null = null, cm = -1, pm = -1;
    (viewData?.options ?? []).forEach((o: any) => {
      if (o.option_type === "CE" && o.oi > cm) { cm = o.oi; ceW = o.strike; ceOI = o.oi; }
      if (o.option_type === "PE" && o.oi > pm) { pm = o.oi; peW = o.strike; peOI = o.oi; }
    });
    return { ceWall: ceW, peWall: peW, ceOI, peOI };
  }, [viewData?.options]);
  const [focusStrike, setFocusStrike] = useState<number | null>(null);
  const [focusTickN, setFocusTickN] = useState(0);
  const focusStrikeReq = (s: number | null) => {
    if (s == null) { setRecenterTick(t => t + 1); return; } // spot marker → ATM
    setFocusStrike(s); setFocusTickN(t => t + 1);
  };
  const atmStrike = useMemo(() => {
    const strikes: number[] = (viewData?.options ?? []).map((o: any) => o.strike);
    if (!strikes.length || viewData?.spot == null) return null;
    return strikes.reduce((b, x) => Math.abs(x - viewData.spot) < Math.abs(b - viewData.spot) ? x : b, strikes[0]);
  }, [viewData]);

  const pick = (name: string) => {
    const inst = instList.find(i => i.name === name);
    setSelected(name);
    setSheet(null);
    exitReplay();
    setTab((inst?.tier ?? 3) === 3 ? "scan" : "watch");
  };

  const openStrike = (strike: number) => {
    const opts: any[] = viewData?.options ?? [];
    setStrikePick({
      strike,
      ce: opts.find(o => o.strike === strike && o.option_type === "CE"),
      pe: opts.find(o => o.strike === strike && o.option_type === "PE"),
    });
    setSheet("strike");
  };

  const basis = useMemo(() => {
    if (!viewData) return "";
    const lot = viewData.contract_multiplier ? " · lot " + viewData.contract_multiplier : "";
    if (viewData.futures == null) return (kind === "commodity" ? "futures basis n/a" : "") + lot;
    let pct = viewData.futures_spread_pct;
    if (pct == null && viewData.futures != null && viewData.spot) pct = ((viewData.futures - viewData.spot) / viewData.spot) * 100;
    const lbl = viewData.spread_label ? " " + String(viewData.spread_label).toLowerCase() : (pct != null && pct >= 0 ? " premium" : " discount");
    return "basis " + (pct != null ? ((pct >= 0 ? "+" : "") + Number(pct).toFixed(2) + "%") : "—") + lbl + lot;
  }, [viewData, kind]);

  const activePromoted = Object.fromEntries(Object.entries(promoted).filter(([, p]) => p.expiresAt > now));

  return (
    <div className="mc-root">
      {/* ── Header: Watch gets the full market header; other tabs get a compact bar ── */}
      {tab === "watch" ? (
        <>
          <header className="mc-hd">
            <button className="mc-instsel" onClick={() => setSheet("inst")}>
              <span className="mc-instsel-nm num">{selected}</span>
              <span className="mc-instsel-kind">{kind}</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" style={{ color: "var(--mfaint)" }}><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <div className={"mc-seg2 num" + (replay ? " rp" : "")}>
              <span className="mc-seg2-ind" />
              <button className={!replay ? "on" : ""} onClick={exitReplay}>Live</button>
              <button className={replay ? "on rp" : ""} onClick={() => { if (!replay) { setAvailDates(null); setSheet("date"); } }}>Replay</button>
            </div>
            {!replay && viewData?.expiry && <span className="mc-ason num"><i>As on</i><b>{fmtExpiry(viewData.expiry)}</b></span>}
            {replay && (() => { const d = new Date(replay.date + "T00:00:00"); return (
              <span className="mc-ason rp num"><i>As on</i><b>{isNaN(d.getTime()) ? replay.date : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</b></span>
            ); })()}
            <span className={connected ? "mc-live sm" : "mc-live sm off"}><i /></span>
          </header>
          <div className="mc-hero">
            <div className="mc-spot num">{viewData?.spot != null ? fmtPx(viewData.spot) : "—"}</div>
            <div className="mc-basis num">{basis}{replay && viewData?.timestamp ? " · " + String(viewData.timestamp).slice(11, 16) : ""}</div>
          </div>
          {!isScanner && viewData && (
            <MobileLevelsRail spot={viewData.spot ?? null} atm={atmStrike} ceWall={walls.ceWall} peWall={walls.peWall}
              ceOI={walls.ceOI} peOI={walls.peOI} onFocus={focusStrikeReq} />
          )}
          {!isScanner && (
            <div className="mc-stats num">
              <button className="mc-stat" onClick={() => setTab("map")}>
                <b style={{ color: (viewData?.net_gex ?? 0) >= 0 ? "var(--mblue)" : "var(--mdn)" }}>{fmtGex(viewData?.net_gex)}</b><span>Net gex</span>
              </button>
              <button className="mc-stat" onClick={() => setTab("map")}>
                <b>{viewData?.gamma_flip != null ? Number(viewData.gamma_flip).toLocaleString("en-IN") : "—"}</b><span>Gamma flip</span>
              </button>
              <button className="mc-stat" onClick={() => setTab("map")}>
                <b>{viewData?.max_pain != null ? Number(viewData.max_pain).toLocaleString("en-IN") : "—"}</b><span>Max pain</span>
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="mc-subhd">
          <span className="mc-subtitle">{SUBTITLES[tab]}</span>
          {tab !== "scan" && tab !== "more" && (
            <span className="mc-subctx num">{selected}{data?.spot != null ? " · " + fmtPx(data.spot) : ""}</span>
          )}
          {tab === "scan" && <span className="mc-subctx num">{scanners.length} scanners{scanAttention ? " · " + scanAttention + " need attention" : ""}</span>}
          {tab !== "scan" && <span className={connected ? "mc-live" : "mc-live off"} style={{ marginLeft: "auto" }}><i />{connected ? "Live" : "…"}</span>}
        </div>
      )}

      <main className="mc-main"><ErrorBoundary>
        {tab === "watch" && (
          isScanner
            ? <MobileScanner scanners={scanners} promoted={activePromoted} now={now} onPromoteEnd={(n) => setPromoted(p => { const c = { ...p }; delete c[n]; return c; })} />
            : <MobileChain data={viewData} onSelect={openStrike} floating={!replay} recenterTick={recenterTick} focusStrike={focusStrike} focusTick={focusTickN} />
        )}
        {tab === "scan" && (
          <MobileScanner scanners={scanners} promoted={activePromoted} now={now}
            onPromoteEnd={(n) => setPromoted(p => { const c = { ...p }; delete c[n]; return c; })} />
        )}
        {tab === "map" && <MobileMap data={replay ? viewData : data} isScanner={isScanner} />}
        {tab === "alerts" && <MobileAlerts feed={alertFeed} selected={selected} live={connected} />}
        {tab === "more" && <MobileSettings />}
      </ErrorBoundary></main>

      {/* Replay control bar — compact, only in Watch while replaying */}
      {tab === "watch" && replay && (
        <div className="mc-rbar num">
          <button onClick={() => setReplay(r => r && { ...r, idx: Math.max(0, r.idx - 1) })}>⏮</button>
          <button className="mc-rplay" onClick={() => setReplay(r => r && { ...r, playing: !r.playing })}>{replay.playing ? "❚❚" : "▶"}</button>
          <button onClick={() => setReplay(r => r && { ...r, idx: Math.min(r.ts.length - 1, r.idx + 1) })}>⏭</button>
          <input type="range" min={0} max={Math.max(0, replay.ts.length - 1)} value={replay.idx}
            onChange={e => setReplay(r => r && { ...r, idx: Number(e.target.value), playing: false })} />
          <span className="mc-rtime">{replay.ts[replay.idx] ? String(replay.ts[replay.idx]).slice(11, 16) : "--:--"}</span>
          <button className="mc-rlive" onClick={exitReplay}>Live</button>
        </div>
      )}

      <nav className="mc-nav">
        <button className={tab === "watch" ? "on" : ""} onClick={() => setTab("watch")}>Watch<i /></button>
        <button className={tab === "scan" ? "on" : ""} onClick={() => setTab("scan")}>
          Scan<span className={"mc-navdot" + (scanAttention ? " on" : "")}>{scanAttention || ""}</span><i />
        </button>
        <button className={tab === "map" ? "on" : ""} onClick={() => setTab("map")}>Map<i /></button>
        <button className={tab === "alerts" ? "on" : ""} onClick={() => { setTab("alerts"); setUnseen(0); }}>
          Alerts<span className={"mc-belldot" + (unseen ? " on" : "")} /><i />
        </button>
        <button className={tab === "more" ? "on" : ""} onClick={() => setTab("more")}>Settings<i /></button>
      </nav>

      {createPortal(<div className="mc-portal">
        {sheet && <div className="mc-shade on" onClick={() => setSheet(null)} />}
        {sheet === "inst" && (
          <MobileInstrumentSheet list={tab === "watch" ? watchList : instList} selected={selected} onPick={pick} analyticalOnly={tab === "watch"} />
        )}
        {sheet === "strike" && strikePick && (
          <MobileStrikeSheet pick={strikePick} label={selected} expiry={viewData?.expiry} lot={viewData?.contract_multiplier}
            date={replay?.date} onClose={() => setSheet(null)} />
        )}
        {sheet === "date" && (
          <div className="mc-sheet open">
            <div className="mc-grab" />
            <div className="mc-sheet-hd"><span style={{ fontSize: 16, fontWeight: 700 }}>Replay · {selected}</span>
              <button className="mc-sheet-x" onClick={() => setSheet(null)}>Close</button></div>
            <button className="mc-daterow live" onClick={exitReplay}>
              <span>Live</span><span className="num" style={{ color: "var(--mup)", fontWeight: 700 }}>resume</span>
            </button>
            {availDates === null && <div className="mc-note">Loading dates…</div>}
            {availDates !== null && availDates.length === 0 && <div className="mc-note">No snapshots for {selected} yet.</div>}
            {availDates !== null && availDates.length > 0 && (
              <MobileCalendar available={new Set(availDates)} selected={replay?.date ?? null} onPick={enterReplay} />
            )}
            <div className="mc-note">Replay drives the chain from stored snapshots — scrub, step or play the session.</div>
          </div>
        )}
      </div>, document.body)}

      <AlertToastContainer alerts={toasts} onDismiss={removeToast} />
    </div>
  );
}
