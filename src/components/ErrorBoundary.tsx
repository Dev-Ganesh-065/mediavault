import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * A component-level failure must not blank the whole app. This boundary
 * shows what happened, offers a way back (reload the app), and keeps the
 * error from taking down the shell around it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: unknown): State {
    return {
      hasError: true,
      message: err instanceof Error ? err.message : 'Something unexpected happened.',
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Keep the raw detail out of the UI but available for debugging.
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="boundary" role="alert">
          <h1>Something went wrong</h1>
          <p>{this.state.message}</p>
          <button
            className="btn btn--primary"
            onClick={() => {
              this.setState({ hasError: false, message: '' });
            }}
          >
            Try to continue
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload the app
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}