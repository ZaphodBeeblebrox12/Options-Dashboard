import React from "react";

/** Display — mobile native. Compact/Full as a proper segmented control. */
export default function MobileDisplayTab({ fullMode, onFullModeChange }: {
  fullMode: boolean; onFullModeChange: (v: boolean) => void;
}) {
  return (
    <div className="mc-disp">
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
