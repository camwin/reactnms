import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="px-4 py-10 text-down">
          <h2 className="text-xl font-semibold">Something went wrong</h2>
          <pre className="mt-3 whitespace-pre-wrap font-mono text-xs text-muted">{this.state.error?.message}</pre>
          <button
            type="button"
            className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm text-fg"
            onClick={() => this.setState({ hasError: false })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
