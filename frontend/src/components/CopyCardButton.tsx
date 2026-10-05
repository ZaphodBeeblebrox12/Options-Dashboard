import React, { useRef, useState } from 'react';
import { Camera } from 'lucide-react';

/**
 * CopyCardButton — renders the enclosing card to a PNG and writes it to the
 * clipboard, so any panel can be shared without a manual screenshot.
 *
 * Card-root resolution (first match wins):
 *   1. `selector` prop (explicit CSS selector) via closest()
 *   2. the closest ancestor with the .terminal-panel class (our panel style)
 *   3. the button's grandparent div (how it sits inside MetricCard's root)
 *
 * Requires: npm install html-to-image
 * Clipboard image write needs a secure context (localhost / https) — fine
 * for this app. Falls back to triggering a PNG download if the clipboard
 * write is rejected.
 */
interface Props {
  selector?: string;
}

export const CopyCardButton: React.FC<Props> = ({ selector }) => {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'error'>('idle');

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const btn = btnRef.current;
    if (!btn || state === 'busy') return;
    setState('busy');
    try {
      const { toPng } = await import('html-to-image');
      let target: HTMLElement | null = selector
        ? btn.closest(selector)
        : (btn.closest('.terminal-panel') as HTMLElement | null);
      if (!target) {
        // as mounted inside MetricCard: wrapper div -> card root div
        target = (btn.parentElement?.parentElement ?? null) as HTMLElement | null;
      }
      if (!target) throw new Error('card root not found');

      const bg = getComputedStyle(target).backgroundColor;
      const dataUrl = await toPng(target, {
        pixelRatio: 2,           // crisp on retina / when pasted into chat
        backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#0b0f17',
      });
      const blob = await (await fetch(dataUrl)).blob();

      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setState('copied');
      } catch {
        // clipboard rejected (permissions/policy): fall back to download
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `card-${Date.now()}.png`;
        a.click();
        setState('copied');
      }
    } catch (err) {
      console.error('[CopyCardButton] failed:', err);
      setState('error');
    } finally {
      setTimeout(() => setState('idle'), 1500);
    }
  };

  return (
    <button
      ref={btnRef}
      onClick={copy}
      title="Copy card as image"
      className="flex items-center gap-1 p-1 rounded hover:bg-white/10 text-terminal-muted"
    >
      <Camera className="w-3 h-3" />
      {state === 'copied' && <span className="text-[9px] font-mono text-terminal-pe">copied</span>}
      {state === 'error' && <span className="text-[9px] font-mono text-terminal-ce">failed</span>}
    </button>
  );
};
