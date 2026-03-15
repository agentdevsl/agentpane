import type { TopologyGraph } from '@/lib/topology/types';
import { AgentTopology as AgentTopologyInner } from './agent-topology';
import { TopologyProvider } from './topology-context';

interface AgentTopologyProps {
  /** Session ID to subscribe to for live topology events */
  sessionId?: string;
  /** Static topology data (used when no sessionId is provided) */
  initialData?: TopologyGraph;
}

export function AgentTopology({ sessionId, initialData }: AgentTopologyProps): React.JSX.Element {
  return (
    <TopologyProvider sessionId={sessionId} initialData={initialData}>
      <AgentTopologyInner />
    </TopologyProvider>
  );
}
