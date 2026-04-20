/**
 * Reusable React error boundary with a configurable fallback and a "Retry"
 * button that resets the caught-error state so children can re-render.
 *
 * This mirrors the ad-hoc boundaries in `agent-topology/index.tsx` and
 * `memory-view/memory-view.tsx`, but is exported so components can reuse it
 * instead of duplicating the class-component boilerplate.
 *
 * See F09-02 in `specs/arch_review_april/09-testing.md`.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional label used in the default fallback and console.error tag. */
  label?: string;
  /**
   * Render-prop fallback. Receives the caught error and a reset callback that
   * clears the error state so the boundary re-renders its children.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Optional hook invoked whenever the boundary catches (e.g. telemetry). */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const tag = this.props.label ? `[${this.props.label}]` : '[ErrorBoundary]';
    console.error(`${tag} Render error:`, error, info.componentStack);
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback(error, this.reset);
      }
      return (
        <div
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center"
        >
          <p className="text-sm font-medium text-danger">
            {this.props.label ?? 'Component'} failed to load
          </p>
          <p className="max-w-sm text-xs text-fg-subtle">{error.message}</p>
          <button
            type="button"
            className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-surface-subtle"
            onClick={this.reset}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
