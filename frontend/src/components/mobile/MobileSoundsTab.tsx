import React, { useEffect, useRef, useState } from "react";

/** Mobile-native Sounds: compact add + per-sound player cards with
 *  play/pause, duration and progress — preview without leaving Settings.
 *  Same endpoints: GET/POST/DELETE /api/alerts/sounds, base64 audio. */
const MIME: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4" };
const fmtT = (s: number) => { if (!isFinite(s)) return "0:00"; const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };

export default function MobileSoundsTab() {
  const [sounds, setSounds] = useState<any[] | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [prog, setProg] = useState(0);
  const [dur, setDur] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const b64Cache = useRef(new Map<string, string>());
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => fetch("/api/alerts/sounds").then(r => r.ok ? r.json() : null)
    .then(d => setSounds(d?.sounds ?? [])).catch(() => {});
  useEffect(() => { refresh(); return () => { audioRef.current?.pause(); }; }, []);

  const stop = () => { audioRef.current?.pause(); audioRef.current = null; setPlaying(null); setProg(0); };

  const toggle = async (s: any) => {
    if (playing === s.id) { stop(); return; }
    stop();
    try {
      let b64 = b64Cache.current.get(s.id);
      if (!b64) {
        const r = await fetch(`/api/alerts/sounds/${encodeURIComponent(s.id)}`);
        if (!r.ok) return;
        const d = await r.json();
        b64 = d?.base64;
        if (!b64) return;
        b64Cache.current.set(s.id, b64);
      }
      const ext = (s.filename ?? "").split(".").pop()?.toLowerCase() ?? "mp3";
      const a = new Audio(`data:${MIME[ext] ?? "audio/mpeg"};base64,${b64}`);
      audioRef.current = a;
      a.ontimeupdate = () => { if (a.duration) setProg(a.currentTime / a.duration); };
      a.onloadedmetadata = () => setDur(p => ({ ...p, [s.id]: a.duration }));
      a.onended = () => { setPlaying(null); setProg(0); };
      await a.play();
      setPlaying(s.id);
    } catch { setPlaying(null); }
  };

  const del = (s: any) => {
    if (!window.confirm(`Delete "${s.name}"?`)) return;
    setBusy(s.id);
    fetch(`/api/alerts/sounds/${encodeURIComponent(s.id)}`, { method: "DELETE" })
      .then(() => { if (playing === s.id) stop(); return refresh(); })
      .finally(() => setBusy(""));
  };

  const upload = (f: File) => {
    if (!f) return;
    setBusy("up");
    const fd = new FormData();
    fd.append("name", f.name.replace(/\.[^.]+$/, ""));
    fd.append("file", f);
    fetch("/api/alerts/sounds/upload", { method: "POST", body: fd })
      .then(() => refresh()).finally(() => { setBusy(""); if (fileRef.current) fileRef.current.value = ""; });
  };

  return (
    <div className="mc-snd">
      <input ref={fileRef} type="file" accept="audio/*" style={{ display: "none" }}
        onChange={e => upload(e.target.files?.[0] as File)} />
      <button className="mc-snd-add" disabled={busy === "up"} onClick={() => fileRef.current?.click()}>
        {busy === "up" ? "Uploading…" : "+ Add sound"}
      </button>

      {sounds === null && <div className="mc-note" style={{ padding: 14 }}>Loading sounds…</div>}
      {sounds !== null && sounds.length === 0 && <div className="mc-note" style={{ padding: 14 }}>No sounds yet — add one above.</div>}
      {sounds?.map(s => {
        const isP = playing === s.id;
        const d = dur[s.id];
        return (
          <div className="mc-snd-card" key={s.id}>
            <button className={"mc-snd-play" + (isP ? " on" : "")} onClick={() => toggle(s)} disabled={busy === s.id}>
              {isP ? "❚❚" : "▶"}
            </button>
            <div className="mc-snd-info">
              <div className="mc-snd-nm">{s.name}</div>
              <div className="mc-snd-sub num">{s.type === "custom" ? `${(s.size_bytes / 1024).toFixed(0)} KB` : "built-in"}{d ? ` · ${fmtT(d)}` : ""}</div>
              <div className="mc-snd-bar"><i style={{ width: (isP ? prog * 100 : 0) + "%" }} /></div>
            </div>
            {s.type === "custom" && (
              <button className="mc-snd-del" disabled={busy === s.id} onClick={() => del(s)}>Delete</button>
            )}
          </div>
        );
      })}
      <div className="mc-note" style={{ paddingTop: 4 }}>MP3, WAV or OGG · max 5 MB. Preview plays right here.</div>
    </div>
  );
}
