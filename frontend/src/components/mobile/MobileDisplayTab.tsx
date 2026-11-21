
/** Display — mobile native. Compact/Full as a proper segmented control. */
export default function MobileDisplayTab({ fullMode, onFullModeChange, hideZeroVolumeStrikes, onHideZeroVolumeStrikesChange }: {
  fullMode: boolean; onFullModeChange: (v: boolean) => void;
  hideZeroVolumeStrikes: boolean; onHideZeroVolumeStrikesChange: (v: boolean) => void;
}) {
  return (
    <div className="mc-disp">
      <div className="mc-card">
        <h4>Option chain filtering</h4>
        <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 0" }}>
          <span style={{ minWidth: 0 }}>
            <b style={{ display: "block" }}>Hide zero-volume strikes</b>
            <span className="mc-note">Hide strikes at least 10% away from spot when both CE and PE volume are zero. Live and replay; display only.</span>
          </span>
          <input type="checkbox" checked={hideZeroVolumeStrikes}
            onChange={(event) => onHideZeroVolumeStrikesChange(event.target.checked)} />
        </label>
      </div>
      <div className="mc-card">
        <h4>Option chain density</h4>
        <div className="mc-disp-seg">
          <button className={!fullMode ? "on" : ""} onClick={() => onFullModeChange(false)}>
            <b>Compact</b><span>LTP · ΔOI · OI per side</span>
          </button>
          <button className={fullMode ? "on" : ""} onClick={() => onFullModeChange(true)}>
            <b>Full</b><span>adds IV / delta / gamma</span>
          </button>
        </div>
        <div className="mc-note" style={{ padding: "8px 2px 2px", textAlign: "left" }}>
          Full shows the Greeks columns. Preferences apply to this browser only.
        </div>
      </div>
    </div>
  );
}
