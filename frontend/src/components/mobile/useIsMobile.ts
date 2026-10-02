import { useEffect, useState } from "react";

const QUERY = "(max-width: 820px)";

/**
 * One-way gate: small screens get the dedicated mobile shell rendered by
 * App.tsx; larger screens are untouched. Listens for rotations/resizes.
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia(QUERY).matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}
