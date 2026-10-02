import React, { useState } from "react";
import { WallChart } from "../WallChart";
import { fmtNum, fmtPx } from "./mobileFormat";

type TF = '15m' | '30m' | '1H';

/**
 * Mobile-first Walls screen (mobile viewport ONLY — the desktop Walls view is
 * unchanged and renders WallChart directly with mobile=false).
 *
 * ONE chrome row: symbol + spot + as-of time (tap → switch symbol) | TF
 * segmented | LIVE/REPLAY pill. No duplicate subheader on this tab.
 * Then: level strip (ATM / CE Wall / PE Wall / [Neg GEX]) → optional session
 * chip (only when the market is closed) → chart fills ALL remaining viewport
 * → alert banner appears only on marker tap.
 */
export default function MobileWalls({ symbol, spot, asof, live, marketOpen, sessionRange,
                                      tier, atm, ceWall, peWall, negGex, replayDate, onSymbolTap }: {
  symbol: string; spot: number | null; asof?: string | null; live?: boolean;
  marketOpen?: boolean | null; sessionRange?: string;
  tier: number;
  atm: number | null; ceWall: number | null; peWall: number | null; negGex: number | null;
  replayDate?: string | null;
  onSymbolTap?: () => void;
}) {
  const [tf, setTf] = useState<TF>('15m');
  const [alert, setAlert] = useState<any | null>(null);

  const levels = [
    { k: 'ATM', v: atm, cls: 'atm' },
    { k: 'CE Wall', v: ceWall, cls: 'ce' },
    { k: 'PE Wall', v: peWall, cls: 'pe' },
    ...(tier === 1 ? [{ k: 'Neg GEX', v: negGex, cls: 'gex' }] : []),
  ];

  return (
    <div className="mc-wsc">
      <div className="mc-wsc-top">
        <button className="mc-wsc-sym num" onClick={onSymbolTap}>
          <b>{symbol} <i className="mc-wsc-chev">⌄</i></b>
          <span>{spot != null ? fmtPx(spot) : '—'}{asof ? ` · ${asof}` : ''}</span>
        </button>
        <div className="mc-wsc-tf num">
          {(['15m', '30m', '1H'] as TF[]).map(t => (
            <button key={t} className={tf === t ? 'on' : ''}
                    onClick={() => { setTf(t); setAlert(null); }}>{t}</button>
          ))}
        </div>
        {replayDate
          ? <span className="mc-wsc-live rp num">REPLAY</span>
          : <span className={"mc-wsc-live num" + (live ? "" : " off")}><i />LIVE</span>}
      </div>

      <div className="mc-wsc-levels num">
        {levels.map(c => (
          <div key={c.k} className={`mc-wl ${c.cls}`}>
            <span>{c.k}</span>
            <b>{c.v != null ? fmtNum(c.v) : '—'}</b>
          </div>
        ))}
      </div>

      {marketOpen === false && (
        <div className="mc-wsc-sess num">◷ Market Closed · {sessionRange} · last known data</div>
      )}

      <div className="mc-wsc-chart">
        <WallChart mobile tf={tf} onTfChange={(t) => { setTf(t); setAlert(null); }}
                   onAlertSelect={setAlert}
                   symbol={symbol} tier={tier} atm={atm}
                   ceWall={ceWall} peWall={peWall} negGex={negGex}
                   replayDate={replayDate ?? null} />
      </div>

      {alert && (
        <button className="mc-wsc-alert num" onClick={() => setAlert(null)}>
          {alert.kind === 'SETUP_FORMING'
            ? '🟡 SETUP FORMING'
            : (alert.direction === 'CE' ? '🔴 CONFIRMED BEARISH' : '🟢 CONFIRMED BULLISH')}
          {' · '}{alert.timeframe}{' · wall '}{alert.wall != null ? fmtNum(alert.wall) : '—'}
          {' · C2 '}{alert.c2_high}/{alert.c2_low}
          {alert.c3_close != null ? ` · C3 ${alert.c3_close}` : ''}
          <span className="mc-wsc-alert-x">✕</span>
        </button>
      )}
    </div>
  );
}
