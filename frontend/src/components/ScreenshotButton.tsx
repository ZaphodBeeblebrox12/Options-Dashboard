import React, { useState, useCallback } from 'react';
import { Camera, Check, AlertTriangle } from 'lucide-react';
import { toBlob } from 'html-to-image';

interface ScreenshotButtonProps {
  targetRef: React.RefObject<HTMLElement>;
  filename: string;
  className?: string;
}

// Telegram attaches clipboard images as inline PHOTOS only when they look like
// normal photos; otherwise they arrive as "filename.png" documents (no preview,
// can't be grouped). Three things trigger the demotion:
//   1. any side over ~10,000px      -> handled by MAX_OUTPUT_SIDE + dynamic ratio
//   2. extreme strips (the FUT OI buildup row is ~30:1 wide) -> padded to MAX_ASPECT
//   3. oversized files              -> the caps keep files small
const MAX_OUTPUT_SIDE = 4000;
const MAX_ASPECT = 3; // width:height no wider than 3:1
const BG = '#0a0a0f';

async function renderCapture(el: HTMLElement): Promise<Blob> {
  const rect = el.getBoundingClientRect();
  const ratio = Math.min(2, MAX_OUTPUT_SIDE / Math.max(rect.width, rect.height, 1));
  const blob = await toBlob(el, { cacheBust: true, backgroundColor: BG, pixelRatio: ratio });
  if (!blob) throw new Error('toBlob returned null');

  // Pad extreme strips vertically so the result is a normal-aspect photo.
  const bmp = await createImageBitmap(blob);
  if (bmp.width <= MAX_ASPECT * bmp.height) return blob;
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = Math.round(bmp.width / MAX_ASPECT);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, (canvas.height - bmp.height) / 2);
  return new Promise<Blob>((res, rej) =>
    canvas.toBlob(b => (b ? res(b) : rej(new Error('pad canvas failed'))), 'image/png'));
}

export const ScreenshotButton: React.FC<ScreenshotButtonProps> = ({ targetRef, filename, className = '' }) => {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  const handleCapture = useCallback(async () => {
    if (!targetRef.current) return;
    try {
      const blob = await renderCapture(targetRef.current);
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } else {
        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = rej;
          r.readAsDataURL(blob);
        });
        const link = document.createElement('a');
        link.download = `${filename}.png`;
        link.href = dataUrl;
        link.click();
      }
    } catch (err) {
      console.error('Screenshot to clipboard failed:', err);
      setError(true);
      setTimeout(() => setError(false), 1500);
    }
  }, [targetRef, filename]);

  return (
    <button onClick={handleCapture} className={`p-1 rounded hover:bg-white/10 transition-colors ${className}`} title="Copy screenshot to clipboard">
      {copied ? <Check className="w-3.5 h-3.5 text-terminal-pe" /> : error ? <AlertTriangle className="w-3.5 h-3.5 text-terminal-ce" /> : <Camera className="w-3.5 h-3.5 text-terminal-muted hover:text-terminal-text" />}
    </button>
  );
};
