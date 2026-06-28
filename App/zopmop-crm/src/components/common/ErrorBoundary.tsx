import { Component, type ErrorInfo, type ReactNode } from 'react';

// Top-level render-time error guard. A throw inside any route would
// otherwise unmount the whole SPA (white screen). This catches it, keeps
// the shell (Sidebar/Topbar) mounted, and offers a recover-without-reload
// path via resetKey-driven remount.
type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('CRM render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-10 max-w-2xl mx-auto">
          <h1 className="text-xl font-semibold text-danger">Something went wrong</h1>
          <p className="text-sm text-text-secondary mt-2">
            This page hit an error and couldn't render. The rest of the CRM is unaffected.
          </p>
          <pre className="mt-4 text-xs text-text-muted bg-surface-elevated rounded-md p-3 overflow-x-auto">
            {this.state.error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <button className="btn-primary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button className="btn-ghost" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
