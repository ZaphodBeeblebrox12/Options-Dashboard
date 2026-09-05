import React, { useState, useEffect, useCallback } from 'react';

interface StockRo { symbol: string; lot: number; expiry: string | null; }

const WINDOW_OPTIONS = [10, 15, 20, 25, 30];

export const AnalyticsTab: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const [rate, setRate] = useState('6.5');
  const [win, setWin] = useState(20);
  const [t3win, setT3win] = useState(8);
  const [ro, setRo] = useState<StockRo[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setRate(String(d.risk_free_rate ?? 6.5));
        setWin(d.window_half_width ?? 20);
        setT3win(d.tier3_window_half_width ?? 8);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/stocks')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setRo(d.stocks || []); })
      .catch(() => {});
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          risk_free_rate: parseFloat(rate) || 6.5,
          window_half_width: win,
          tier3_window_half_width: t3win,
        }),
      });
      onSaved();
    } catch {}
    setSaving(false);
  }, [rate, win, onSaved]);

  return (
    <div>
      <h3 className="st-section mb-1">Analytics</h3>
      <p className="st-helper mb-5">
        Parameters feed the Greeks, IV, and GEX engines. Changes apply to new calculations within ~30 seconds (analytics cache).
      </p>

      <div className="border border-terminal-border rounded-lg p-5 space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <label className="st-label w-48">Risk-free interest rate</label>
          <input
            type="number" step="0.1" min="0" max="20" value={rate}
            onChange={(e) => setRate(e.target.value)}
            className="st-input w-24 bg-terminal-bg border border-terminal-border rounded-lg px-3 py-2 text-terminal-text focus:outline-none focus:border-terminal-atm"
          />
          <span className="st-num">%</span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="st-label w-48">Stock window half-width</label>
          <div className="inline-flex border border-terminal-border rounded-lg overflow-hidden">
            {WINDOW_OPTIONS.map((w) => (
              <button
                key={w} onClick={() => setWin(w)}
                className={`st-seg px-3.5 py-2 transition-colors ${win === w ? 'bg-white/10 text-terminal-text font-semibold' : 'text-[var(--st-text-2)] hover:bg-white/5'}`}
              >
                ±{w}
              </button>
            ))}
          </div>
          <span className="st-helper" style={{ fontSize: 11.5 }}>rebuilds all stock windows on save</span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="st-label w-48">Tier 3 scanner window</label>
          <div className="inline-flex border border-terminal-border rounded-lg overflow-hidden">
            {[4, 6, 8, 10, 12].map((w) => (
              <button
                key={w} onClick={() => setT3win(w)}
                className={`st-seg px-3.5 py-2 transition-colors ${t3win === w ? 'bg-white/10 text-terminal-text font-semibold' : 'text-[var(--st-text-2)] hover:bg-white/5'}`}
              >
                ±{w}
              </button>
            ))}
          </div>
          <span className="st-helper" style={{ fontSize: 11.5 }}>scanner windows rebuild on save</span>
        </div>

        <div className="pt-1">
          <button
            onClick={save} disabled={saving}
            className="st-btn px-4 py-2 rounded-lg font-semibold bg-terminal-pe/20 text-terminal-pe border border-terminal-pe/30 hover:bg-terminal-pe/30 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save and apply'}
          </button>
        </div>
      </div>

      <div className="mt-5 border-t border-dashed border-terminal-border pt-4">
        <div className="st-nav-group mb-2.5" style={{ letterSpacing: '0.1em' }}>From scrip master (read-only)</div>
        {ro.map((s) => (
          <div key={s.symbol} className="flex items-center gap-4 py-1">
            <span className="st-sym w-28">{s.symbol}</span>
            <span className="st-num">lot {s.lot}</span>
            <span className="st-num">expiry {s.expiry || '—'}</span>
          </div>
        ))}
        {ro.length === 0 && <div className="st-helper">No stocks configured</div>}
      </div>
    </div>
  );
};
