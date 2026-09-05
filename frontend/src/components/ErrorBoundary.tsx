import React from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Shown in the crash report so the user knows WHAT crashed. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time crashes in a subtree so one broken component can never
 * blank the whole dashboard (and drop the WebSocket). Shows the actual error
 * message + stack so failures are diagnosable without DevTools.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.label ?? 'section'}]`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    const err = this.state.error as any;
    return (
      <div className="terminal-panel p-4 my-2 max-w-2xl mx-auto">
        <div className="flex items-center gap-2 text-red-400 text-sm font-bold">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {this.props.label ?? 'This section'} crashed
        </div>
        <p className="mt-2 text-[12px] text-terminal-muted leading-relaxed">
          The rest of the app is still running. Please report this error:
        </p>
        <pre className="mt-2 p-2.5 rounded bg-terminal-bg border border-terminal-border text-[10px] font-mono text-terminal-text whitespace-pre-wrap break-words max-h-40 overflow-y-auto terminal-scroll">
          {String(err?.message ?? err)}
          {'
'}
          {String(err?.stack ?? '').split('
').slice(0, 5).join('
')}
        </pre>
        <div className="mt-3 flex gap-2">
          <button
            onClick={this.reset}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-mono border border-terminal-border text-terminal-muted hover:text-terminal-text hover:bg-white/5 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-mono bg-terminal-pe/20 text-terminal-pe border border-terminal-pe/30 hover:bg-terminal-pe/30 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Reload app
          </button>
        </div>
      </div>
    );
  }
}
