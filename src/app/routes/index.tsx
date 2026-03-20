import { MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';

// Lazy-load heavy dialog component (FC-012)
const NewProjectDialog = React.lazy(() =>
  import('@/app/components/features/new-project-dialog').then((m) => ({
    default: m.NewProjectDialog,
  }))
);

import type { ProjectStatus, TaskCounts } from '@/app/components/features/project-card';
import { AddProjectCard, ProjectCard } from '@/app/components/features/project-card';
import { AgentPaneLogo } from '@/app/components/ui/agentpane-logo';
import { Button } from '@/app/components/ui/button';
import {
  apiClient,
  type ProjectListItem,
  type ProjectSummaryItem,
  type SandboxConfigItem,
  type SandboxType,
} from '@/lib/api/client';
import type { Result } from '@/lib/utils/result';
import type { GitHubOrg, GitHubRepo } from '@/services/github-token.service';

// Simplified project summary for client-side rendering
type ClientProjectSummary = {
  project: ProjectListItem;
  status: ProjectStatus;
  taskCounts: TaskCounts;
  runningAgents: { id: string; name: string; currentTaskId?: string; currentTaskTitle?: string }[];
  lastActivityAt?: Date | null;
};

// Loader return type (Route.useLoaderData() returns void in this route tree)
type DashboardLoaderData = { projects: ProjectSummaryItem[] };

export const Route = createFileRoute('/')({
  loader: async () => {
    // Prefetch project summaries (FC-022)
    const result = await apiClient.projects.listWithSummaries({ limit: 24 });
    return { projects: result.ok ? result.data.items : [] };
  },
  component: Dashboard,
});

function Dashboard(): React.JSX.Element {
  const navigate = useNavigate();
  const loaderData = Route.useLoaderData() as DashboardLoaderData;
  const loaderProjects = loaderData.projects;
  const [projectSummaries, setProjectSummaries] = useState<ClientProjectSummary[]>(
    () =>
      loaderProjects.map((item: ProjectSummaryItem) => ({
        project: item.project,
        status: item.status,
        taskCounts: item.taskCounts,
        runningAgents: item.runningAgents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          currentTaskId: agent.currentTaskId ?? undefined,
          currentTaskTitle: agent.currentTaskTitle ?? undefined,
        })),
        lastActivityAt: item.lastActivityAt ? new Date(item.lastActivityAt) : null,
      })) as ClientProjectSummary[]
  );
  const [isLoading, setIsLoading] = useState(loaderProjects.length === 0);
  const [showNewProject, setShowNewProject] = useState(false);
  const [isSettingsConfigured, setIsSettingsConfigured] = useState(false);
  const [isGitHubConfigured, setIsGitHubConfigured] = useState(false);
  const [localRepos, setLocalRepos] = useState<{ name: string; path: string }[]>([]);
  const [defaultSandboxType, setDefaultSandboxType] = useState<SandboxType>('docker');
  const [sandboxConfigs, setSandboxConfigs] = useState<SandboxConfigItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  // Filter projects by search query
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) {
      return projectSummaries;
    }
    const query = searchQuery.toLowerCase();
    return projectSummaries.filter(
      (s) =>
        s.project.name.toLowerCase().includes(query) || s.project.path.toLowerCase().includes(query)
    );
  }, [projectSummaries, searchQuery]);

  // Check if global settings are configured (API key is required, GitHub PAT is optional)
  // Batch all mount API calls with Promise.all to avoid 4 separate re-renders
  useEffect(() => {
    const loadInitialData = async () => {
      const [keyResult, githubResult, reposResult, configsResult] = await Promise.all([
        apiClient.apiKeys.get('anthropic').catch((error) => {
          console.error('Failed to check Anthropic API key:', error);
          return null;
        }),
        apiClient.github.getTokenInfo().catch((error) => {
          console.error('Failed to check GitHub token:', error);
          return null;
        }),
        apiClient.filesystem.discoverRepos().catch((error) => {
          console.error('Failed to discover local repos:', error);
          return null;
        }),
        apiClient.sandboxConfigs.list().catch((error) => {
          console.error('Failed to fetch sandbox configs:', error);
          return null;
        }),
      ]);

      setIsSettingsConfigured(keyResult?.ok === true && keyResult.data.keyInfo !== null);
      setIsGitHubConfigured(
        githubResult?.ok === true && githubResult.data.tokenInfo?.isValid === true
      );

      if (reposResult?.ok) {
        setLocalRepos(reposResult.data.repos.map((r) => ({ name: r.name, path: r.path })));
      } else if (reposResult && !reposResult.ok) {
        console.warn('Failed to discover local repos:', reposResult.error);
      }

      if (configsResult?.ok) {
        setSandboxConfigs(configsResult.data.items);
        const defaultConfig = configsResult.data.items.find((c) => c.isDefault);
        if (defaultConfig) {
          setDefaultSandboxType(defaultConfig.type);
        }
      }
    };
    loadInitialData();
  }, []);

  // Polling interval ref for project updates
  const pollingIntervalRef = useRef<number | null>(null);
  const currentIntervalMsRef = useRef<number | null>(null);
  const isFetchingRef = useRef(false);

  // FC-021: Polling-vs-SSE decision for the dashboard
  // -------------------------------------------------
  // The dashboard uses polling (5s active / 30s idle) rather than SSE because:
  // 1. The dashboard aggregates data across ALL projects -- there is no single
  //    session ID to subscribe to via durable streams.
  // 2. The listWithSummaries endpoint returns pre-aggregated counts that would
  //    require fan-out across multiple SSE channels to replicate.
  // 3. The adaptive polling interval (5s when agents run, 30s when idle)
  //    provides acceptable freshness without a persistent connection.
  // If a global event bus (e.g., project:updated) is added, SSE could replace
  // polling here by subscribing to a single organization-level stream.
  useEffect(() => {
    const fetchProjects = async () => {
      if (isFetchingRef.current) {
        console.debug('[Home] fetchProjects skipped — already in-flight');
        return;
      }
      isFetchingRef.current = true;
      console.debug('[Home] fetchProjects starting');
      try {
        const result = await apiClient.projects.listWithSummaries({ limit: 24 });
        if (result.ok) {
          // Convert API response to client project summaries
          const summaries: ClientProjectSummary[] = result.data.items.map(
            (item: ProjectSummaryItem) => ({
              project: item.project,
              status: item.status,
              taskCounts: item.taskCounts,
              runningAgents: item.runningAgents.map((agent) => ({
                id: agent.id,
                name: agent.name,
                currentTaskId: agent.currentTaskId ?? undefined,
                currentTaskTitle: agent.currentTaskTitle ?? undefined,
              })),
              lastActivityAt: item.lastActivityAt ? new Date(item.lastActivityAt) : null,
            })
          );
          setProjectSummaries(summaries);

          // Poll at 5s when agents are running for near-real-time updates,
          // 30s when idle to detect newly started agents without stopping entirely
          const hasRunningAgents = summaries.some((s) => s.runningAgents.length > 0);
          const desiredInterval = hasRunningAgents ? 5000 : 30000;

          if (currentIntervalMsRef.current !== desiredInterval) {
            if (pollingIntervalRef.current !== null) {
              window.clearInterval(pollingIntervalRef.current);
            }
            pollingIntervalRef.current = window.setInterval(fetchProjects, desiredInterval);
            currentIntervalMsRef.current = desiredInterval;
          }
        } else {
          console.error('Failed to fetch projects:', result.error);
        }
      } catch (error) {
        console.error('Failed to fetch projects:', error);
      } finally {
        isFetchingRef.current = false;
        setIsLoading(false);
      }
    };
    if (loaderProjects.length > 0) {
      // Loader already has data - skip immediate fetch, but start polling
      const hasRunningAgents = loaderProjects.some(
        (s: ProjectSummaryItem) => s.runningAgents.length > 0
      );
      const desiredInterval = hasRunningAgents ? 5000 : 30000;
      pollingIntervalRef.current = window.setInterval(fetchProjects, desiredInterval);
      currentIntervalMsRef.current = desiredInterval;
      setIsLoading(false);
    } else {
      fetchProjects();
    }

    return () => {
      if (pollingIntervalRef.current) {
        window.clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
        currentIntervalMsRef.current = null;
      }
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: loaderProjects is stable from route loader, intentionally run once on mount
  }, []);

  const handleCreateProject = useCallback(
    async (data: {
      name: string;
      path: string;
      description?: string;
      sandboxType?: SandboxType;
    }): Promise<Result<void, { code: string; message: string }>> => {
      try {
        // Find or create sandbox config for the selected type
        const selectedType = data.sandboxType ?? defaultSandboxType;
        let sandboxConfigId: string | undefined;

        // Look for an existing config with the selected type
        const existingConfig = sandboxConfigs.find((c) => c.type === selectedType);
        if (existingConfig) {
          sandboxConfigId = existingConfig.id;
        } else {
          // Create a new sandbox config with the selected type
          const configResult = await apiClient.sandboxConfigs.create({
            name: `${selectedType === 'docker' ? 'Docker' : 'DevContainer'} Default`,
            type: selectedType,
            isDefault: sandboxConfigs.length === 0, // Make default if first config
          });
          if (configResult.ok) {
            sandboxConfigId = configResult.data.id;
            // Update local state
            setSandboxConfigs((prev) => [...prev, configResult.data]);
          }
        }

        const result = await apiClient.projects.create({
          name: data.name,
          path: data.path,
          description: data.description,
          sandboxConfigId,
        });

        if (!result.ok) {
          console.error('Failed to create project:', result.error);
          return {
            ok: false,
            error: {
              code: result.error.code,
              message: result.error.message,
            },
          };
        }

        const listResult = await apiClient.projects.listWithSummaries({ limit: 24 });
        if (listResult.ok) {
          const summaries: ClientProjectSummary[] = listResult.data.items.map(
            (item: ProjectSummaryItem) => ({
              project: item.project,
              status: item.status,
              taskCounts: item.taskCounts,
              runningAgents: item.runningAgents.map((agent) => ({
                id: agent.id,
                name: agent.name,
                currentTaskId: agent.currentTaskId ?? undefined,
                currentTaskTitle: agent.currentTaskTitle ?? undefined,
              })),
              lastActivityAt: item.lastActivityAt ? new Date(item.lastActivityAt) : null,
            })
          );
          setProjectSummaries(summaries);
        }

        return { ok: true, value: undefined };
      } catch (error) {
        console.error('Unexpected error creating project:', error);
        return {
          ok: false,
          error: {
            code: 'UNEXPECTED_ERROR',
            message: error instanceof Error ? error.message : 'An unexpected error occurred',
          },
        };
      }
    },
    [defaultSandboxType, sandboxConfigs]
  );

  const handleValidatePath = useCallback(
    async (
      pathToValidate: string
    ): Promise<
      Result<
        {
          name: string;
          path: string;
          defaultBranch: string;
          hasClaudeConfig: boolean;
          remoteUrl?: string;
        },
        unknown
      >
    > => {
      // TODO: [CQ-018] Add API endpoint for path validation
      // For now, return a basic validation result
      const pathParts = pathToValidate.split('/');
      const name = pathParts[pathParts.length - 1] || 'unknown';
      return {
        ok: true,
        value: { name, path: pathToValidate, defaultBranch: 'main', hasClaudeConfig: false },
      };
    },
    []
  );

  const handleClone = useCallback(
    async (url: string, destination: string): Promise<Result<{ path: string }, unknown>> => {
      try {
        const result = await apiClient.github.clone(url, destination);
        if (result.ok) {
          return { ok: true, value: { path: result.data.path } };
        }
        console.error('Failed to clone repository:', result.error);
        return {
          ok: false,
          error: result.error,
        };
      } catch (error) {
        console.error('Unexpected error cloning repository:', error);
        return {
          ok: false,
          error: { code: 'UNEXPECTED_ERROR', message: String(error) },
        };
      }
    },
    []
  );

  const handleCreateFromTemplate = useCallback(
    async (params: {
      templateOwner: string;
      templateRepo: string;
      name: string;
      owner?: string;
      description?: string;
      isPrivate?: boolean;
      clonePath: string;
    }): Promise<Result<{ path: string }, unknown>> => {
      try {
        const result = await apiClient.github.createFromTemplate(params);
        if (result.ok) {
          return { ok: true, value: { path: result.data.path } };
        }
        console.error('Failed to create from template:', result.error);
        return {
          ok: false,
          error: result.error,
        };
      } catch (error) {
        console.error('Unexpected error creating from template:', error);
        return {
          ok: false,
          error: { code: 'UNEXPECTED_ERROR', message: String(error) },
        };
      }
    },
    []
  );

  const handleFetchOrgs = useCallback(async (): Promise<GitHubOrg[]> => {
    try {
      const result = await apiClient.github.listOrgs();
      if (result.ok) {
        return result.data.orgs;
      }
      console.error('Failed to fetch GitHub orgs:', result.error);
      return [];
    } catch (error) {
      console.error('Unexpected error fetching GitHub orgs:', error);
      return [];
    }
  }, []);

  const handleFetchReposForOwner = useCallback(async (owner: string): Promise<GitHubRepo[]> => {
    try {
      const result = await apiClient.github.listReposForOwner(owner);
      if (result.ok) {
        return result.data.repos;
      }
      console.error(`Failed to fetch repos for ${owner}:`, result.error);
      return [];
    } catch (error) {
      console.error(`Unexpected error fetching repos for ${owner}:`, error);
      return [];
    }
  }, []);

  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Projects' }]}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading projects...</div>
        </div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell
      breadcrumbs={[{ label: 'Projects' }]}
      actions={
        <div className="flex items-center gap-3">
          <div className="relative">
            <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search projects..."
              className="w-48 rounded-md border border-border bg-surface py-1.5 pl-9 pr-3 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              data-testid="project-search"
            />
          </div>
          <Button onClick={() => setShowNewProject(true)} data-testid="new-project-button">
            <Plus className="h-4 w-4" />
            New Project
          </Button>
        </div>
      }
    >
      <div className="p-6">
        {projectSummaries.length === 0 ? (
          <div className="flex items-center justify-center min-h-[60vh]">
            <EmptyState
              preset="first-run"
              size="lg"
              customIcon={<AgentPaneLogo />}
              title="Welcome to AgentPane!"
              subtitle="Let's get you started with your first project"
              steps={[
                { label: 'Install AgentPane', completed: true },
                { label: 'Configure Global Settings', completed: isSettingsConfigured },
                { label: 'Create your first project', completed: false },
                { label: 'Run your first agent', completed: false },
              ]}
              primaryAction={
                isSettingsConfigured
                  ? {
                      label: 'Create Project',
                      onClick: () => setShowNewProject(true),
                    }
                  : {
                      label: 'Configure Settings',
                      onClick: () => {
                        navigate({ to: '/settings' });
                      },
                    }
              }
              secondaryAction={
                isSettingsConfigured
                  ? undefined
                  : {
                      label: 'Skip for now',
                      onClick: () => setShowNewProject(true),
                    }
              }
            />
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[40vh] text-center">
            <MagnifyingGlass className="h-12 w-12 text-fg-subtle mb-4" />
            <p className="text-fg-muted">No projects match "{searchQuery}"</p>
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="mt-2 text-sm text-accent hover:text-accent/80"
            >
              Clear search
            </button>
          </div>
        ) : (
          <div
            className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            data-testid="project-list"
          >
            {filteredProjects.map((summary) => (
              <ProjectCard
                key={summary.project.id}
                project={summary.project}
                status={summary.status}
                taskCounts={summary.taskCounts}
                activeAgents={summary.runningAgents.map((agent) => ({
                  id: agent.id,
                  name: agent.name,
                  taskId: agent.currentTaskId ?? '',
                  taskTitle: agent.currentTaskTitle ?? '',
                  type: 'runner' as const,
                }))}
                lastRunAt={summary.lastActivityAt}
              />
            ))}
            <AddProjectCard onClick={() => setShowNewProject(true)} />
          </div>
        )}
      </div>

      <Suspense fallback={null}>
        <NewProjectDialog
          open={showNewProject}
          onOpenChange={setShowNewProject}
          onSubmit={handleCreateProject}
          onValidatePath={handleValidatePath}
          onClone={handleClone}
          onCreateFromTemplate={handleCreateFromTemplate}
          onFetchOrgs={handleFetchOrgs}
          onFetchReposForOwner={handleFetchReposForOwner}
          isGitHubConfigured={isGitHubConfigured}
          recentRepos={localRepos}
          defaultSandboxType={defaultSandboxType}
        />
      </Suspense>
    </LayoutShell>
  );
}
