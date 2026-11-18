import React, { createContext, useContext, useEffect, useState } from "react";

type SetPreviewTimestamp = React.Dispatch<React.SetStateAction<string | null>>;

const PreviewTimestampContext = createContext<string | null>(null);
const SetPreviewTimestampContext = createContext<SetPreviewTimestamp>(() => {});

/**
 * Keeps seek-preview updates local to the replay controls and market timer.
 * The timestamp and setter use separate contexts so changing the timestamp
 * only notifies the timer; the controls keep their own slider state.
 */
export function ReplayPreviewProvider({
  resetKey,
  children,
}: {
  resetKey: string;
  children: React.ReactNode;
}) {
  const [previewTimestamp, setPreviewTimestamp] = useState<string | null>(null);

  useEffect(() => {
    setPreviewTimestamp(null);
  }, [resetKey]);

  return (
    <PreviewTimestampContext.Provider value={previewTimestamp}>
      <SetPreviewTimestampContext.Provider value={setPreviewTimestamp}>
        {children}
      </SetPreviewTimestampContext.Provider>
    </PreviewTimestampContext.Provider>
  );
}

export function useReplayPreviewTimestamp() {
  return useContext(PreviewTimestampContext);
}

export function useSetReplayPreviewTimestamp() {
  return useContext(SetPreviewTimestampContext);
}
