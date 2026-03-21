import { Funnel, Play, Robot } from '@phosphor-icons/react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { Button } from '@/app/components/ui/button';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient, type ProjectListItem } from '@/lib/api/client';

// Agent type for client-side display
type ClientAgent = {
  id: string;
  name: string;
  type: string;
  status: string;
};

// Loader return type (Route.useLoaderData() returns void in this route tree)
type AgentsLoaderData = {
  agents: ClientAgent[];
  projects: ProjectListItem[];
};

export const Route = createFileRoute('/agents/')({
  loader: async () => {
    // Prefetch agents and projects in parallel (FC-022)
    const [agentsResult, projectsResult] = await Promise.all([
      apiClient.agents.list(),
      apiClient.projects.list({ limit: 10 }),
    ]);
    return {
      agents: agentsResult.ok ? agentsResult.data.items : [],
      projects: projectsResult.ok ? projectsResult.data.items : [],
    };
  },
  component: AgentsPage,
});

function AgentsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const loaderData = Route.useLoaderData() as AgentsLoaderData;
  const loaderAgents = loaderData.agents as ClientAgent[];
  const loaderProjects = loaderData.projects as ProjectListItem[];
  const [agents, setAgents] = useState<ClientAgent[]>(loaderAgents);
  const [projects, setProjects] = useState<ProjectListItem[]>(loaderProjects);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch agents and projects from API on mount (fallback if loader data is empty)
  useWatchEffect(() => {
    if (loaderAgents.length > 0 || loaderProjects.length > 0) return;

    const fetchData = async () => {
      setIsLoading(true);
      const [agentsResult, projectsResult] = await Promise.all([
        apiClient.agents.list(),
        apiClient.projects.list({ limit: 10 }),
      ]);

      if (agentsResult.ok) {
        setAgents(agentsResult.data.items as ClientAgent[]);
      }
      if (projectsResult.ok) {
        setProjects(projectsResult.data.items);
      }
      setIsLoading(false);
    };
    fetchData();
  }, [loaderAgents.length, loaderProjects.length]);

  const handleNewAgent = () => {
    const firstProject = projects[0];
    if (firstProject) {
      navigate({ to: '/projects/$projectId', params: { projectId: firstProject.id } });
    } else {
      navigate({ to: '/' });
    }
  };

  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Agents' }]}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading agents...</div>
        </div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell breadcrumbs={[{ label: 'Agents' }]}>
      <div
        data-testid="agents-page"
        className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10"
      >
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-fg-muted">Workspace</p>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">Agents</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline">
              <Funnel className="h-4 w-4" />
              Filters
            </Button>
            <Button onClick={handleNewAgent}>
              <Play className="h-4 w-4" />
              New Agent
            </Button>
          </div>
        </header>

        <div data-testid="agents-list" className="grid gap-4 md:grid-cols-2">
          {agents.length === 0 ? (
            <div className="col-span-full">
              <EmptyState preset="no-agents" />
            </div>
          ) : (
            agents.map((agent) => (
              <Link
                key={agent.id}
                to="/agents/$agentId"
                params={{ agentId: agent.id }}
                data-testid="agent-card"
                className="rounded-lg border border-border bg-surface p-4 transition hover:border-fg-subtle"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-surface-subtle">
                    <Robot className="h-5 w-5 text-fg-muted" />
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-fg">{agent.name}</p>
                    <p className="text-xs text-fg-muted capitalize">{agent.type}</p>
                  </div>
                  <span data-testid="agent-status" className="text-xs text-fg-muted capitalize">
                    {agent.status}
                  </span>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </LayoutShell>
  );
}
