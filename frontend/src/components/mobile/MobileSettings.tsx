import React, { useState } from "react";
import MobileDisplayTab from "./MobileDisplayTab";
import MobileAnalyticsTab from "./MobileAnalyticsTab";
import MobileAlertsSettingsTab from "./MobileAlertsSettingsTab";
import MobileInstrumentsTab from "./MobileInstrumentsTab";
import MobileConnectionsTab from "./MobileConnectionsTab";
import MobileSoundsTab from "./MobileSoundsTab";

/** Mobile Settings — every tab is now native (no hosted desktop forms).
 *  Top tab bar, content below. Same endpoints as desktop throughout. */
export default function MobileSettings() {
  const [tab, setTab] = useState("display");
  const [fullMode, setFullMode] = useState(false);
  const tabs = [
    { id: "display", label: "Display", el: <MobileDisplayTab fullMode={fullMode} onFullModeChange={setFullMode} /> },
    { id: "analytics", label: "Analytics", el: <MobileAnalyticsTab /> },
    { id: "alerts", label: "Alerts", el: <MobileAlertsSettingsTab /> },
    { id: "instruments", label: "Instruments", el: <MobileInstrumentsTab /> },
    { id: "connections", label: "Connections", el: <MobileConnectionsTab /> },
    { id: "sounds", label: "Sounds", el: <MobileSoundsTab /> },
  ];
  const active = tabs.find(t => t.id === tab) ?? tabs[0];
  return (
    <div className="mc-sett">
      <div className="mc-sett-tabs">
        {tabs.map(t => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="mc-sett-body">{active.el}</div>
    </div>
  );
}
