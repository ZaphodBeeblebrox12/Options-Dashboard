import React, { useEffect, useState } from "react";

/** Alert settings — mobile native. Real switches (track + knob, full-row hit
 *  area), segmented cooldowns, channel chips, telegram config + test.
 *  Same payload as the desktop panel: GET/POST /api/alerts/settings. */
const RULE_META: Record<string, { name: string; desc: string }> = {
  atm_negative_gex_oi_wall: { name: "ATM + Negative GEX + OI Wall", desc: "ATM is the max negative-GEX strike and also the CE or PE OI wall." },
  atm_max_ce_pe_wall: { name: "ATM Maximum CE/PE Wall", desc: "ATM is either the maximum CE OI wall or the maximum PE OI wall." },
};
const COOLDOWNS = [60, 300, 600, 900, 1800];
const cdFmt = (s: number) => s < 60 ? s + "s" : (s / 60) + "m";
const CHANNELS = ["toast", "sound", "telegram"] as const;

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button className={"mc-sw" + (on ? " on" : "")} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="mc-sw-track"><span className="mc-sw-knob" /></span>
      {label && <span className="mc-sw-lab">{label}</span>}
    </button>
  );
}

export default function MobileAlertsSettingsTab() {
  const [s, setS] = useState<any>(null);
  const [sounds, setSounds] = useState<any[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [flash, setFlash] = useState<"idle" | "saving" | "saved">("idle");
  const [tgTest, setTgTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [tgBusy, setTgBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/alerts/settings").then(r => r.ok ? r.json() : null),
      fetch("/api/alerts/sounds").then(r => r.ok ? r.json() : null),
    ]).then(([st, so]) => {
      if (!alive) return;
      if (st) { setS(st); setStatus("ready"); } else setStatus("error");
      setSounds(so?.sounds ?? []);
    }).catch(() => { if (alive) setStatus("error"); });
    return () => { alive = false; };
  }, []);

  const upd = (fn: (p: any) => any) => setS((p: any) => fn(p));
  const updRule = (rt: string, patch: any) => upd(p => ({ ...p, rules: p.rules.map((r: any) => r.rule_type === rt ? { ...r, ...patch } : r) }));
  const toggleChannel = (rt: string, ch: string) => updRule(rt, {
    channels: (s.rules.find((r: any) => r.rule_type === rt)?.channels ?? []).includes(ch)
      ? s.rules.find((r: any) => r.rule_type === rt).channels.filter((c: string) => c !== ch)
      : [...(s.rules.find((r: any) => r.rule_type === rt)?.channels ?? []), ch],
  });

  const save = async () => {
    setFlash("saving");
    try {
      const r = await fetch("/api/alerts/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
      if (r.ok) { setFlash("saved"); setTimeout(() => setFlash("idle"), 2000); } else setFlash("idle");
    } catch { setFlash("idle"); }
  };

  const testTelegram = async () => {
    setTgBusy(true); setTgTest(null);
    try {
      const r = await fetch("/api/alerts/telegram/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s.telegram) });
      const d = await r.json();
      setTgTest({ ok: !!d?.success, msg: d?.message ?? "No response" });
    } catch { setTgTest({ ok: false, msg: "Request failed" }); }
    setTgBusy(false);
  };

  if (status === "loading") return <div className="mc-note" style={{ padding: 20 }}>Loading alert settings…</div>;
  if (status === "error" || !s) return <div className="mc-note" style={{ padding: 20 }}>Couldn't load alert settings.</div>;

  const toastSec = Math.round((s.toast_duration_ms ?? 6000) / 1000);

  return (
    <div className="mc-als">
      <div className="mc-card">
        <h4>Notifications</h4>
        <div className="mc-anl-row">
          <div className="mc-anl-lab">Toast duration <div className="mc-anl-hint">How long toasts stay on screen</div></div>
          <div className="mc-anl-ctl num">
            <input type="range" min={2} max={30} step={1} value={toastSec} className="mc-range"
              onChange={e => upd(p => ({ ...p, toast_duration_ms: Number(e.target.value) * 1000 }))} />
            <span className="mc-range-v">{toastSec}s</span>
          </div>
        </div>
        <div className="mc-anl-row">
          <div className="mc-anl-lab">Global sound</div>
          <Switch on={!!s.sound?.master_enabled} onChange={v => upd(p => ({ ...p, sound: { ...p.sound, master_enabled: v } }))} label={s.sound?.master_enabled ? "On" : "Off"} />
        </div>
        {s.sound?.master_enabled && (
          <div className="mc-anl-row">
            <div className="mc-anl-lab">Volume</div>
            <div className="mc-anl-ctl num">
              <input type="range" min={0} max={100} step={5} value={s.sound.volume_percent} className="mc-range"
                onChange={e => upd(p => ({ ...p, sound: { ...p.sound, volume_percent: Number(e.target.value) } }))} />
              <span className="mc-range-v">{s.sound.volume_percent}%</span>
            </div>
          </div>
        )}
      </div>

      <div className="mc-sech" style={{ marginTop: 12 }}>Rules</div>
      {s.rules.map((r: any) => {
        const meta = RULE_META[r.rule_type] ?? { name: r.rule_type, desc: "" };
        return (
          <div className={"mc-rule" + (r.enabled ? " on" : "")} key={r.rule_type}>
            <div className="mc-rule-hd">
              <Switch on={!!r.enabled} onChange={v => updRule(r.rule_type, { enabled: v })} />
              <div className="mc-rule-tx">
                <div className="mc-rule-nm">{meta.name}</div>
                <div className="mc-rule-ds">{meta.desc}</div>
              </div>
            </div>
            {r.enabled && (
              <div className="mc-rule-body">
                <div className="mc-anl-lab" style={{ fontSize: 12 }}>Cooldown</div>
                <div className="mc-anl-seg num">
                  {COOLDOWNS.map(c => (
                    <button key={c} className={r.cooldown_seconds === c ? "on" : ""} onClick={() => updRule(r.rule_type, { cooldown_seconds: c })}>{cdFmt(c)}</button>
                  ))}
                </div>
                <div className="mc-anl-lab" style={{ fontSize: 12, marginTop: 8 }}>Channels</div>
                <div className="mc-anl-seg">
                  {CHANNELS.map(c => (
                    <button key={c} className={((r.channels ?? []).includes(c)) ? "on" : ""}
                      onClick={() => toggleChannel(r.rule_type, c)}>{c[0].toUpperCase() + c.slice(1)}</button>
                  ))}
                </div>
                {(r.channels ?? []).includes("sound") && (
                  <>
                    <div className="mc-anl-lab" style={{ fontSize: 12, marginTop: 8 }}>Sound</div>
                    <select className="mc-sel" value={r.custom_sound_id || r.sound_choice || "alert"}
                      onChange={e => {
                        const v = e.target.value;
                        const isCustom = sounds.some((x: any) => x.id === v && x.type === "custom");
                        updRule(r.rule_type, isCustom ? { custom_sound_id: v, sound_choice: "alert" } : { sound_choice: v, custom_sound_id: null });
                      }}>
                      {sounds.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </>
                )}
                {(r.channels ?? []).includes("telegram") && (
                  <div style={{ marginTop: 8 }}>
                    <Switch on={!!r.telegram_enabled} onChange={v => updRule(r.rule_type, { telegram_enabled: v })} label={r.telegram_enabled ? "Telegram on" : "Telegram off"} />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="mc-sech" style={{ marginTop: 12 }}>Telegram</div>
      <div className="mc-card">
        <div className="mc-anl-row">
          <div className="mc-anl-lab">Telegram alerts</div>
          <Switch on={!!s.telegram?.enabled} onChange={v => upd(p => ({ ...p, telegram: { ...p.telegram, enabled: v } }))} label={s.telegram?.enabled ? "On" : "Off"} />
        </div>
        {s.telegram?.enabled && (
          <>
            <div className="mc-anl-row">
              <div className="mc-anl-lab">Bot token <div className="mc-anl-hint">From @BotFather</div></div>
              <input className="mc-txt num" type="text" value={s.telegram.bot_token ?? ""} placeholder="123456:ABC…"
                onChange={e => upd(p => ({ ...p, telegram: { ...p.telegram, bot_token: e.target.value } }))} />
            </div>
            <div className="mc-anl-row">
              <div className="mc-anl-lab">Chat ID <div className="mc-anl-hint">User or group ID</div></div>
              <input className="mc-txt num" type="text" value={s.telegram.chat_id ?? ""} placeholder="-100…"
                onChange={e => upd(p => ({ ...p, telegram: { ...p.telegram, chat_id: e.target.value } }))} />
            </div>
            <button className="mc-iv-btn" style={{ width: "100%", marginTop: 6 }} disabled={tgBusy} onClick={testTelegram}>
              {tgBusy ? "Testing…" : "Send test message"}
            </button>
            {tgTest && (
              <div className="mc-tg-res" style={{ color: tgTest.ok ? "var(--mup)" : "var(--mdn)" }}>{tgTest.ok ? "✓ " : "✕ "}{tgTest.msg}</div>
            )}
          </>
        )}
      </div>

      <div className="mc-anl-savewrap">
        <button className="mc-anl-save" disabled={flash === "saving"} onClick={save}>
          {flash === "saving" ? "Saving…" : flash === "saved" ? "Saved ✓" : "Save alert settings"}
        </button>
      </div>
    </div>
  );
}
