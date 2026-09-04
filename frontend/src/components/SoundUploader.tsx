import React, { useState, useRef } from 'react';
import { Upload, Trash2, FileAudio } from 'lucide-react';
import { useSounds } from '../hooks/useAlerts';

export const SoundUploader: React.FC = () => {
  const { sounds, uploadSound, deleteSound } = useSounds();
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const customSounds = sounds.filter((s) => s.type === 'custom');

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('audio/')) {
      alert('Please upload an audio file (MP3, WAV, OGG)');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('File too large (max 5MB)');
      return;
    }
    setUploading(true);
    const name = file.name.replace(/\.[^/.]+$/, '');
    await uploadSound(file, name);
    setUploading(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-lg px-4 py-3 flex flex-col items-center justify-center cursor-pointer transition-colors ${
          dragOver
            ? 'border-terminal-pe bg-terminal-pe/10'
            : 'border-terminal-border hover:border-terminal-muted hover:bg-white/5'
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        {uploading ? (
          <div className="flex items-center gap-2 text-terminal-muted text-[10px] font-mono">
            <div className="w-3 h-3 border-2 border-terminal-muted border-t-transparent rounded-full animate-spin" />
            Uploading...
          </div>
        ) : (
          <>
            <Upload className="w-4 h-4 text-terminal-muted mb-1" />
            <span className="text-[10px] font-mono text-terminal-muted">
              Drop audio file or click to upload
            </span>
            <span className="text-[9px] font-mono text-terminal-muted/60">
              MP3, WAV, OGG — max 5MB
            </span>
          </>
        )}
      </div>

      {customSounds.length > 0 && (
        <div className="space-y-1">
          {customSounds.map((sound) => (
            <div
              key={sound.id}
              className="flex items-center justify-between px-2 py-1.5 rounded bg-terminal-bg border border-terminal-border/50"
            >
              <div className="flex items-center gap-2 min-w-0">
                <FileAudio className="w-3 h-3 text-terminal-muted shrink-0" />
                <span className="text-[10px] font-mono text-terminal-text truncate">
                  {sound.name}
                </span>
                <span className="text-[9px] font-mono text-terminal-muted/60 shrink-0">
                  ({(sound.size_bytes / 1024).toFixed(1)} KB)
                </span>
              </div>
              <button
                onClick={() => deleteSound(sound.id)}
                className="p-1 rounded hover:bg-red-500/20 text-terminal-muted hover:text-red-400 transition-colors shrink-0"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
