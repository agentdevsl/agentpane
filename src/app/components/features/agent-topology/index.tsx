import type { TopologyGraph } from '@/lib/topology/types';
import { AgentTopology as AgentTopologyInner } from './agent-topology';
import { TopologyProvider } from './topology-context';

interface AgentTopologyProps {
  sessionId?: string;
  mockData?: TopologyGraph;
}

export function AgentTopology({ sessionId, mockData }: AgentTopologyProps): React.JSX.Element {
  return (
    <TopologyProvider sessionId={sessionId} initialData={mockData}>
      <AgentTopologyInner />
    </TopologyProvider>
  );
}
