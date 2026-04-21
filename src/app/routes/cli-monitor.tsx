import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import {
  CliMonitorProvider,
  useCliMonitor,
} from '@/app/components/features/cli-monitor/cli-monitor-context';
import { DaemonToggle } from '@/app/components/features/cli-monitor/daemon-toggle';
import { StatusIndicator } from '@/app/components/features/cli-monitor/status-indicator';
import { ViewSwitcher } from '@/app/components/features/cli-monitor/view-switcher';
import { LayoutShell } from '@/app/components/features/layout-shell';

export const Route = createFileRoute('/cli-monitor')({
  component: CliMonitorLayout,
});

function CliMonitorLayout(): React.JSX.Element {
  return (
    <CliMonitorProvider>
      <CliMonitorLayoutInner />
    </CliMonitorProvider>
  );
}

function CliMonitorLayoutInner(): React.JSX.Element {
  const { pageState, aggregateStatus, daemonConnected, connectionError, isOffline } =
    useCliMonitor();

  return (
    <LayoutShell
      breadcrumbs={[{ label: 'CLI Monitor', to: '/cli-monitor' }]}
      centerAction={<ViewSwitcher />}
      actions={
        <div className="flex items-center gap-3">
          {pageState === 'active' && <StatusIndicator status={aggregateStatus} />}
          <DaemonToggle connected={daemonConnected} />
        </div>
      }
    >
      <CliMonitorErrorBoundary>
        <div className="flex flex-1 flex-col overflow-hidden">
          {isOffline && (
            <div
              className="flex items-center gap-2 bg-attention/10 px-4 py-2 text-sm text-attention"
              role="alert"
            >
              You are offline &mdash; updates will resume when connected
            </div>
          )}
          {connectionError && (
            <div
              className="flex items-center gap-2 bg-danger/10 px-4 py-2 text-sm text-danger"
              role="alert"
            >
              Connection lost &mdash; retrying...
            </div>
          )}
          <Outlet />
        </div>
      </CliMonitorErrorBoundary>
    </LayoutShell>
  );
}

// Error boundary

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class CliMonitorErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[CliMonitor] Error boundary caught:', error, info.componentStack);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="text-3xl text-danger">Something went wrong</div>
          <p className="max-w-[400px] text-sm text-fg-muted">
            {this.state.error?.message || 'An unexpected error occurred in the CLI Monitor.'}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
