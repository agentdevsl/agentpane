import { Component, type ErrorInfo, lazy, type ReactNode, Suspense } from 'react';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import type { TopologyGraph } from '@/lib/topology/types';
import { TopologyProvider } from './topology-context';

const AgentTopologyInner = lazy(() => {
  console.debug('[AgentTopology] lazy import START');
  const start = performance.now();
  return import('./agent-topology').then((mod) => {
    console.debug('[AgentTopology] lazy import DONE', {
      ms: Math.round(performance.now() - start),
    });
    return { default: mod.AgentTopology };
  });
});

interface AgentTopologyProps {
  /** Session ID to subscribe to for live topology events */
  sessionId?: string;
  /** Static topology data (used when no sessionId is provided) */
  initialData?: TopologyGraph;
}

/** Error boundary to catch React Flow / ELK crashes */
class TopologyErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[AgentTopology] Render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          <p className="text-sm font-medium text-danger">Topology view failed to load</p>
          <p className="max-w-sm text-xs text-fg-subtle">{this.state.error.message}</p>
          <button
            type="button"
            className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-surface-subtle"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function TopologyLoading(): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-sm text-fg-muted">Loading topology...</p>
    </div>
  );
}

function DebugMount({ label }: { label: string }): null {
  useMountEffect(() => {
    console.debug(`[AgentTopology] ${label} mounted`);
    return () => console.debug(`[AgentTopology] ${label} unmounted`);
  });
  return null;
}

export function AgentTopology({ sessionId, initialData }: AgentTopologyProps): React.JSX.Element {
  console.debug('[AgentTopology] render', { sessionId, hasInitialData: !!initialData });
  return (
    <TopologyErrorBoundary>
      <DebugMount label="ErrorBoundary" />
      <TopologyProvider sessionId={sessionId} initialData={initialData}>
        <DebugMount label="Provider" />
        <Suspense fallback={<TopologyLoading />}>
          <AgentTopologyInner />
        </Suspense>
      </TopologyProvider>
    </TopologyErrorBoundary>
  );
}
