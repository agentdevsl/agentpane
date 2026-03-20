import { Gear } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AgentConfigDialog } from '@/app/components/features/agent-config-dialog';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { Button } from '@/app/components/ui/button';

// Agent type for client-side display
type ClientAgent = {
  id: string;
  name: string;
  type: string;
  status: string;
  currentTaskId?: string | null;
  config?: Record<string, unknown>;
};

export const Route = createFileRoute('/agents/$agentId')({
  component: AgentDetailPage,
});

function AgentDetailPage(): React.JSX.Element {
  const { agentId } = Route.useParams();
  const [agent, setAgent] = useState<ClientAgent | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);

  // Fetch agent from API on mount
  useEffect(() => {
    const fetchAgent = async () => {
      try {
        const response = await fetch(`/api/agents/${agentId}`);
        const data = await response.json();
        if (data.ok) {
          setAgent(data.data);
        }
      } catch {
        // API may not be ready
      }
      setIsLoading(false);
    };
    fetchAgent();
  }, [agentId]);

  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Agents', to: '/agents' }, { label: 'Loading...' }]}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading agent...</div>
        </div>
      </LayoutShell>
    );
  }

  if (!agent) {
    return <div className="p-6 text-sm text-fg-muted">Agent not found.</div>;
  }

  return (
    <LayoutShell breadcrumbs={[{ label: 'Agents', to: '/agents' }, { label: agent.name }]}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-fg-muted">Agent</p>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{agent.name}</h1>
            <p className="text-sm text-fg-muted capitalize">{agent.type}</p>
          </div>
          <Button variant="outline" onClick={() => setShowConfig(true)}>
            <Gear className="h-4 w-4" />
            Configure
          </Button>
        </header>

        <section className="rounded-lg border border-border bg-surface p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-fg">Status</p>
              <p className="text-xs text-fg-muted capitalize">{agent.status}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-medium text-fg">Current task</p>
              <p className="text-xs text-fg-muted">{agent.currentTaskId ?? 'None'}</p>
            </div>
          </div>
        </section>

        {showConfig && (
          <AgentConfigDialog
            agent={agent as Parameters<typeof AgentConfigDialog>[0]['agent']}
            open={showConfig}
            onOpenChange={setShowConfig}
            onSave={async (config) => {
              // TODO: [CQ-018] Add API endpoint for updating agent config
              setAgent((prev) =>
                prev ? { ...prev, config: { ...prev.config, ...config } } : null
              );
            }}
          />
        )}
      </div>
    </LayoutShell>
  );
}
