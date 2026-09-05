import React, { useEffect, useState } from "react";

/** Mobile-native Analytics settings — same /api/settings contract as the
 *  desktop tab, but designed for a phone: grouped cards, thumb-sized
 *  segmented controls, one sticky Save bar with confirmation. */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mc-anl-row">
      <div className="mc-anl-lab">{label}{hint && <div className="mc-anl-hint">{hint}</div>}</div>
      <div className="mc-anl-ctl">{children}</div>
    </div>
  );
}
function Seg({ value, options, onChange, fmt }: { value: any; options: any[]; onChange: (v: any) => void; fmt?: (v: any) => string }) {
  return (
    <div className="mc-anl-seg num">
      {options.map(o => (
        <button key={o} className={value === o ? "on" : ""} onClick={() => onChange(o)}>{fmt ? fmt(o) : o}</button>
      ))}
    </div>
  );
}

export default function MobileAnalyticsTab() {
  const [s, setS] = useState<any>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [flash, setFlash] = useState<"idle" | "saving" | "saved">("idle");
  const patch = (k: string, v: any) => setS((p: any) => ({ ...p, [k]: v }));

  useEffect(() => {
    let alive = true;
    fetch("/api/settings").then(r => r.ok ? r.json() : null)
      .then(d => { if (alive) { setS(d); setStatus("ready"); } })
      .catch(() => { if (alive) setStatus("error"); });
    return () => { alive = false; };
  }, []);

  const save = async () => {
    setFlash("saving");
    try {
      const r = await fetch("/api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          risk_free_rate: Number(s.risk_free_rate),
          window_half_width: Number(s.window_half_width),
          tier3_window_half_width: Number(s.tier3_window_half_width),
          snapshot_interval_seconds: Number(s.snapshot_interval_seconds),
          alert_rearm_seconds: Number(s.alert_rearm_seconds),
          alert_scope: s.alert_scope,
          alerts_armed: !!s.alerts_armed,
        }),
      });
      if (r.ok) { setFlash("saved"); setTimeout(() => setFlash("idle"), 2000); }
      else setFlash("idle");
    } catch { setFlash("idle"); }
  };

  if (status === "loading") return <div className="mc-note" style={{ padding: 20 }}>Loading settings…</div>;
  if (status === "error" || !s) return <div className="mc-note" style={{ padding: 20 }}>Couldn't load settings.</div>;

  return (
    <div className="mc-anl">
      <div className="mc-card">
        <h4>Greeks</h4>
        <Row label="Risk-free rate" hint="Used for IV / Greeks (%)">
          <div className="mc-anl-numwrap num">
            <input type="number" step="0.1" min="0" max="20" value={s.risk_free_rate}
              onChange={e => patch("risk_free_rate", e.target.value)} />
            <span>%</span>
          </div>
        </Row>
      </div>
      <div className="mc-card">
        <h4>Windows</h4>
        <Row label="Tier 2 window" hint="ATM ± strikes · full analytics">
          <Seg value={s.window_half_width} options={[10, 15, 20, 25, 30]} onChange={v => patch("window_half_width", v)} fmt={v => "±" + v} />
        </Row>
        <Row label="Tier 3 scanner window" hint="ATM ± strikes · surveillance">
          <Seg value={s.tier3_window_half_width} options={[4, 6, 8, 10, 12]} onChange={v => patch("tier3_window_half_width", v)} fmt={v => "±" + v} />
        </Row>
      </div>
      <div className="mc-card">
        <h4>Capture &amp; alerts</h4>
        <Row label="Snapshot interval" hint="Seconds between captures">
          <Seg value={s.snapshot_interval_seconds} options={[15, 30, 60, 120]} onChange={v => patch("snapshot_interval_seconds", v)} fmt={v => v + "s"} />
        </Row>
        <Row label="Re-arm debounce" hint="After the condition clears">
          <Seg value={s.alert_rearm_seconds} options={[0, 30, 60, 300]} onChange={v => patch("alert_rearm_seconds", v)} fmt={v => v === 0 ? "off" : v + "s"} />
        </Row>
        <Row label="Alert scope" hint="Which instruments can notify">
          <Seg value={s.alert_scope} options={["viewed", "all"]} onChange={v => patch("alert_scope", v)} fmt={v => v === "viewed" ? "Viewed" : "All"} />
        </Row>
        <Row label="Alerts armed" hint="Master switch for firing">
          <button className={"mc-anl-toggle" + (s.alerts_armed ? " on" : "")} onClick={() => patch("alerts_armed", !s.alerts_armed)}>
            <span className="knob" />{s.alerts_armed ? "Armed" : "Disarmed"}
          </button>
        </Row>
      </div>
      <div className="mc-anl-savewrap">
        <button className="mc-anl-save" disabled={flash === "saving"} onClick={save}>
          {flash === "saving" ? "Saving…" : flash === "saved" ? "Saved ✓" : "Save and apply"}
        </button>
      </div>
    </div>
  );
}
