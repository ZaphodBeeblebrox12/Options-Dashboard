import React, { useState, useCallback } from 'react';
import { Camera, Check, AlertTriangle } from 'lucide-react';
import { toBlob, toPng } from 'html-to-image';

interface ScreenshotButtonProps {
  targetRef: React.RefObject<HTMLElement>;
  filename: string;
  className?: string;
}

export const ScreenshotButton: React.FC<ScreenshotButtonProps> = ({
  targetRef,
  filename,
  className = '',
}) => {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  const handleCapture = useCallback(async () => {
    if (!targetRef.current) return;
    try {
      const blob = await toBlob(targetRef.current, {
        cacheBust: true,
        backgroundColor: '#0a0a0f',
        pixelRatio: 2,
      });

      if (!blob) throw new Error('toBlob returned null');

      // Write PNG to system clipboard
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob }),
        ]);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } else {
        // Browser lacks clipboard-write — fallback to download
        const dataUrl = await toPng(targetRef.current, {
          cacheBust: true,
          backgroundColor: '#0a0a0f',
          pixelRatio: 2,
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
    <button
      onClick={handleCapture}
      className={`p-1 rounded hover:bg-white/10 transition-colors ${className}`}
      title="Copy screenshot to clipboard"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-terminal-pe" />
      ) : error ? (
        <AlertTriangle className="w-3.5 h-3.5 text-terminal-ce" />
      ) : (
        <Camera className="w-3.5 h-3.5 text-terminal-muted hover:text-terminal-text" />
      )}
    </button>
  );
};
