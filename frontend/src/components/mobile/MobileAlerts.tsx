import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { AlertFiring } from "../../hooks/useAlerts";
import MobileCalendar from "./MobileCalendar";
import { fmtNum, fmtPx } from "./mobileFormat";

/** Today's alerts as a real-time trading feed — not an archive. */
const normChannels = (c: any): string[] => {
  if (Array.isArray(c)) return c.map(String);
  if (typeof c === "string") { try { const p = JSON.parse(c); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
  return [];
};
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const cache = new Map<string, { at: number; entries: any[] }>();
const TTL = 15000;
let inflight: Promise<void> | null = null;
async function fetchHistory(key: string, url: string): Promise<any[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.entries;
  if (!inflight) {
    inflight = (async () => {
      const r = await fetch(url);
      const d = r.ok ? await r.json() : null;
      cache.set(key, { at: Date.now(), entries: d?.entries ?? [] });
    })().catch(() => {}).finally(() => { inflight = null; });
  }
  await inflight;
  return cache.get(key)?.entries ?? [];
}
const RULE_META: Record<string, { short: string; tags: string[] }> = {
  atm_negative_gex_oi_wall: { short: "Rule 1", tags: ["Negative GEX", "OI Wall"] },
  atm_max_ce_pe_wall: { short: "Rule 2", tags: ["OI Wall"] },
};
const timeOf = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
};

export default function MobileAlerts({ feed, selected, live }: { feed: AlertFiring[]; selected: string; live?: boolean }) {
  const [today, setToday] = useState<any[]>([]);
  const [dates, setDates] = useState<{ date: string; count: number }[] | null>(null);
  const [histDate, setHistDate] = useState<string | null>(null);
  const [hist, setHist] = useState<any[]>([]);
  const [showDates, setShowDates] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let alive = true;
    setStatus("loading");
    setHistDate(null);
    fetchHistory(`${selected}|today`, `/api/alerts/history?index=${encodeURIComponent(selected)}&date=${todayISO()}&page_size=50`)
      .then(e => { if (alive) { setToday(e); setStatus("ready"); } })
      .catch(() => { if (alive) setStatus("error"); });
    return () => { alive = false; };
  }, [selected]);

  const merged = (() => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const a of [...feed, ...today]) {
      const k = (a.timestamp ?? "") + "|" + (a.rule_type ?? "");
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a);
    }
    return out.sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
  })();
  const n = merged.length;

  const openDates = () => {
    setShowDates(true);
    if (dates === null) {
      fetch(`/api/alerts/history/dates?index=${encodeURIComponent(selected)}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => setDates(d?.dates ?? []))
        .catch(() => setDates([]));
    }
  };
  const openHist = (date: string) => {
    setShowDates(false);
    setHistDate(date);
    fetchHistory(`${selected}|${date}`, `/api/alerts/history?index=${encodeURIComponent(selected)}&date=${date}&page_size=50`)
      .then(e => setHist(e));
  };

  const card = (a: any) => {
    const m = RULE_META[a.rule_type] ?? { short: "Rule", tags: [] };
    const r1 = a.rule_type === "atm_negative_gex_oi_wall";
    const chans = normChannels(a.channels_fired);
    return (
      <div className={"mc-altc" + (r1 ? " r1" : " r2")} key={(a.timestamp ?? "") + (a.rule_type ?? "")}>
        <div className="mc-altc-hd">
          {r1 && <span className="mc-altc-bolt">⚡</span>}
          <span className="mc-altc-rule">{m.short}</span>
          <span className="mc-altc-inst">{a.index_name}</span>
          <span className="mc-altc-time num">{timeOf(a.timestamp)}</span>
        </div>
        <div className="mc-altc-name">{a.rule_name}</div>
        <div className="mc-altc-lv num">
          <div><span>Spot</span><b>{fmtPx(a.spot)}</b></div>
          <div><span>ATM</span><b>{a.atm_strike != null ? fmtNum(a.atm_strike) : "—"}</b></div>
          <div><span>CE wall</span><b>{a.max_ce_oi_strike != null ? fmtNum(a.max_ce_oi_strike) : "—"}</b></div>
          <div><span>PE wall</span><b>{a.max_pe_oi_strike != null ? fmtNum(a.max_pe_oi_strike) : "—"}</b></div>
        </div>
        <div className="mc-altc-tags">
          {m.tags.map(t => <span key={t} className="mc-altc-tag">{t}</span>)}
          {chans.map(c => <span key={c} className="mc-ch">{c}</span>)}
        </div>
      </div>
    );
  };

  return (
    <div className="mc-scrl mc-alt">
      <div className="mc-alt-sum">
        <span className={"mc-alt-n num" + (n ? " hot" : "")}>{n}</span>
        <div className="mc-alt-sumtx">
          <div className="t">Alerts today</div>
          <div className="s">Monitoring {selected} · {live === false ? "offline" : "Live"}</div>
        </div>
        {n > 0 && <span className="mc-alt-livex"><i />live feed</span>}
      </div>
      {status === "loading" && n === 0 && <div className="mc-alt-empty">Loading today's alerts…</div>}
      {status === "error" && n === 0 && (
        <div className="mc-alt-empty"><div className="t">Couldn't reach the server</div><div className="s">Alerts work without the live socket — retry shortly.</div></div>
      )}
      {status === "ready" && n === 0 && (
        <div className="mc-alt-empty">
          <div className="t">No alerts yet today</div>
          <div className="s">Monitoring {selected} · {live === false ? "offline" : "Live"}<br />You'll see triggered conditions here.</div>
        </div>
      )}
      {merged.map(card)}
      <button className="mc-mrow mc-alt-hist" onClick={openDates}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--mblue)", flex: "none" }}>
          <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></svg>
        <div><div className="nm">History</div><div className="mt">Browse previous days</div></div>
        <span style={{ marginLeft: "auto", color: "var(--mfaint)" }}>›</span>
      </button>
      {histDate && (
        <>
          <div className="mc-sech">History · {histDate}<button className="mc-alt-clr" onClick={() => setHistDate(null)}>clear</button></div>
          {hist.length === 0 && <div className="mc-alt-empty sm">No alerts on this date.</div>}
          {hist.map(card)}
        </>
      )}
      {createPortal(<div className="mc-portal">
        {showDates && <div className="mc-shade on" onClick={() => setShowDates(false)} />}
        {showDates && (
          <div className="mc-sheet open">
            <div className="mc-grab" />
            <div className="mc-sheet-hd"><span style={{ fontSize: 16, fontWeight: 700 }}>Alert history · {selected}</span>
              <button className="mc-sheet-x" onClick={() => setShowDates(false)}>Close</button></div>
            {dates === null && <div className="mc-note">Loading dates…</div>}
            {dates !== null && dates.length === 0 && <div className="mc-note">No alerts recorded for {selected}.</div>}
            {dates !== null && dates.length > 0 && (
              <MobileCalendar
                available={new Set(dates.map(d => d.date))}
                counts={Object.fromEntries(dates.map(d => [d.date, d.count]))}
                selected={histDate}
                onPick={openHist} />
            )}
          </div>
        )}
      </div>, document.body)}
    </div>
  );
}
