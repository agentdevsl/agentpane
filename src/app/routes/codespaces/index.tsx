import { MagnifyingGlass, Plus, SortAscending } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import React, { Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { EmptyState } from '@/app/components/features/empty-state';
import { LayoutShell } from '@/app/components/features/layout-shell';
import { useMountEffect } from '@/app/hooks/use-mount-effect';

// Lazy-load heavy dialog component (FC-012)
const NewProjectDialog = React.lazy(() =>
  import('@/app/components/features/new-project-dialog').then((m) => ({
    default: m.NewProjectDialog,
  }))
);

import { AddProjectCard, ProjectCard } from '@/app/components/features/project-card';
import { AgentPaneLogo } from '@/app/components/ui/agentpane-logo';
import { Button } from '@/app/components/ui/button';
import {
  apiClient,
  type ProjectSummaryItem,
  type SandboxConfigItem,
  type SandboxType,
} from '@/lib/api/client';
import type { Result } from '@/lib/utils/result';
import type { GitHubOrg, GitHubRepo } from '@/services/github-token.service';

// Use the API response type for codespace summaries
type ClientCodespaceSummary = ProjectSummaryItem;

export const Route = createFileRoute('/codespaces/')({
  loader: async () => {
    // Prefetch codespace summaries (FC-022)
    const result = await apiClient.codespaces.listWithSummaries({ limit: 24 });
    return { codespaces: result.ok ? result.data.items : [] };
  },
  component: CodespacesPage,
});

type SortOption = 'recent' | 'name' | 'created';

function CodespacesPage(): React.JSX.Element {
  const loaderData = Route.useLoaderData() as { codespaces: ProjectSummaryItem[] } | undefined;
  const loaderCodespaces = (loaderData?.codespaces ?? []) as ClientCodespaceSummary[];
  const [codespaceSummaries, setCodespaceSummaries] =
    useState<ClientCodespaceSummary[]>(loaderCodespaces);
  const [isLoading, setIsLoading] = useState(loaderCodespaces.length === 0);
  const [showNewCodespace, setShowNewCodespace] = useState(false);
  const [isSettingsConfigured, setIsSettingsConfigured] = useState(false);
  const [isGitHubConfigured, setIsGitHubConfigured] = useState(false);
  const [localRepos, setLocalRepos] = useState<{ name: string; path: string }[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('recent');
  const [defaultSandboxType, setDefaultSandboxType] = useState<SandboxType>('docker');
  const [sandboxConfigs, setSandboxConfigs] = useState<SandboxConfigItem[]>([]);

  // Filter and sort codespaces
  const filteredCodespaces = useMemo(() => {
    let result = [...codespaceSummaries];

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (s) =>
          s.project.name.toLowerCase().includes(query) ||
          s.project.path.toLowerCase().includes(query) ||
          s.project.description?.toLowerCase().includes(query)
      );
    }

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.project.name.localeCompare(b.project.name);
        case 'created':
          return (
            new Date(b.project.createdAt ?? 0).getTime() -
            new Date(a.project.createdAt ?? 0).getTime()
          );
        default:
          return (
            new Date(b.project.updatedAt ?? 0).getTime() -
            new Date(a.project.updatedAt ?? 0).getTime()
          );
      }
    });

    return result;
  }, [codespaceSummaries, searchQuery, sortBy]);

  // Check if global settings are configured (API key is required, GitHub PAT is optional)
  // Batch all mount API calls with Promise.all to avoid 4 separate re-renders
  useMountEffect(() => {
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
  });

  // Polling interval ref for codespace updates
  const pollingIntervalRef = useRef<number | null>(null);
  const currentIntervalMsRef = useRef<number | null>(null);
  const isFetchingRef = useRef(false);

  // Fetch codespaces with summaries from API on mount and poll when agents are running
  useMountEffect(() => {
    const fetchCodespaces = async () => {
      if (isFetchingRef.current) {
        console.debug('[Codespaces] fetchCodespaces skipped — already in-flight');
        return;
      }
      isFetchingRef.current = true;
      console.debug('[Codespaces] fetchCodespaces starting');
      try {
        const result = await apiClient.codespaces.listWithSummaries({ limit: 24 });
        if (result.ok) {
          setCodespaceSummaries(result.data.items);

          // Poll at 10s when agents are running for near-real-time updates,
          // 30s when idle to detect newly started agents without stopping entirely
          const hasRunningAgents = result.data.items.some((s) => s.runningAgents.length > 0);
          const desiredInterval = hasRunningAgents ? 10000 : 30000;

          if (currentIntervalMsRef.current !== desiredInterval) {
            if (pollingIntervalRef.current !== null) {
              window.clearInterval(pollingIntervalRef.current);
            }
            pollingIntervalRef.current = window.setInterval(fetchCodespaces, desiredInterval);
            currentIntervalMsRef.current = desiredInterval;
          }
        }
      } finally {
        isFetchingRef.current = false;
        setIsLoading(false);
      }
    };
    if (loaderCodespaces.length > 0) {
      // Loader already has data — skip immediate fetch, but start polling
      const hasRunningAgents = loaderCodespaces.some(
        (s: ClientCodespaceSummary) => s.runningAgents.length > 0
      );
      const desiredInterval = hasRunningAgents ? 10000 : 30000;
      pollingIntervalRef.current = window.setInterval(fetchCodespaces, desiredInterval);
      currentIntervalMsRef.current = desiredInterval;
      setIsLoading(false);
    } else {
      fetchCodespaces();
    }

    return () => {
      if (pollingIntervalRef.current) {
        window.clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
        currentIntervalMsRef.current = null;
      }
    };
  });

  const handleCreateCodespace = useCallback(
    async (data: {
      name: string;
      path: string;
      description?: string;
      sandboxType?: SandboxType;
    }): Promise<Result<void, { code: string; message: string }>> => {
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

      const result = await apiClient.codespaces.create({
        name: data.name,
        path: data.path,
        description: data.description,
        sandboxConfigId,
      });

      if (!result.ok) {
        return {
          ok: false,
          error: {
            code: result.error.code,
            message: result.error.message,
          },
        };
      }

      // Refresh codespace list with summaries
      const listResult = await apiClient.codespaces.listWithSummaries({ limit: 24 });
      if (listResult.ok) {
        setCodespaceSummaries(listResult.data.items);
      }

      return { ok: true, value: undefined };
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
      // TODO: Add API endpoint for path validation
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
      const result = await apiClient.github.clone(url, destination);
      if (result.ok) {
        return { ok: true, value: { path: result.data.path } };
      }
      return {
        ok: false,
        error: result.error,
      };
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
      const result = await apiClient.github.createFromTemplate(params);
      if (result.ok) {
        return { ok: true, value: { path: result.data.path } };
      }
      return {
        ok: false,
        error: result.error,
      };
    },
    []
  );

  const handleFetchOrgs = useCallback(async (): Promise<GitHubOrg[]> => {
    // Fetch orgs via API (uses token from SQLite)
    const result = await apiClient.github.listOrgs();
    if (result.ok) {
      return result.data.orgs;
    }
    console.error('Failed to fetch GitHub orgs:', result.error);
    return [];
  }, []);

  const handleFetchReposForOwner = useCallback(async (owner: string): Promise<GitHubRepo[]> => {
    // Fetch repos for a specific owner via API
    const result = await apiClient.github.listReposForOwner(owner);
    if (result.ok) {
      return result.data.repos;
    }
    console.error('Failed to fetch repos for owner:', result.error);
    return [];
  }, []);

  if (isLoading) {
    return (
      <LayoutShell breadcrumbs={[{ label: 'Codespaces' }]}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-muted-foreground">Loading codespaces...</div>
        </div>
      </LayoutShell>
    );
  }

  return (
    <LayoutShell
      breadcrumbs={[{ label: 'Codespaces' }]}
      actions={
        <div className="flex items-center gap-3">
          {/* Search input */}
          <div className="relative">
            <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search codespaces..."
              className="w-48 rounded-md border border-border bg-surface py-1.5 pl-9 pr-3 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              data-testid="codespace-search"
            />
          </div>

          {/* Sort dropdown */}
          <div className="relative">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="appearance-none rounded-md border border-border bg-surface py-1.5 pl-3 pr-8 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              data-testid="codespace-sort"
            >
              <option value="recent">Recently Updated</option>
              <option value="name">Name (A-Z)</option>
              <option value="created">Date Created</option>
            </select>
            <SortAscending className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          </div>

          <Button data-testid="create-codespace-button" onClick={() => setShowNewCodespace(true)}>
            <Plus className="h-4 w-4" />
            New Codespace
          </Button>
        </div>
      }
    >
      <div data-testid="codespaces-page" className="p-6">
        {codespaceSummaries.length === 0 ? (
          <div className="flex items-center justify-center min-h-[60vh]">
            <EmptyState
              preset="first-run"
              size="lg"
              customIcon={<AgentPaneLogo />}
              title="Welcome to AgentPane!"
              subtitle="Let's get you started with your first codespace"
              steps={[
                { label: 'Install AgentPane', completed: true },
                { label: 'Configure Global Settings', completed: isSettingsConfigured },
                { label: 'Create your first codespace', completed: false },
                { label: 'Run your first agent', completed: false },
              ]}
              primaryAction={
                isSettingsConfigured
                  ? {
                      label: 'Create Codespace',
                      onClick: () => setShowNewCodespace(true),
                    }
                  : {
                      label: 'Configure Settings',
                      onClick: () => {
                        window.location.href = '/settings';
                      },
                    }
              }
              secondaryAction={
                isSettingsConfigured
                  ? undefined
                  : {
                      label: 'Skip for now',
                      onClick: () => setShowNewCodespace(true),
                    }
              }
            />
          </div>
        ) : filteredCodespaces.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[40vh] text-center">
            <MagnifyingGlass className="h-12 w-12 text-fg-subtle mb-4" />
            <p className="text-fg-muted">No codespaces match "{searchQuery}"</p>
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
            data-testid="codespace-list"
          >
            {filteredCodespaces.map((summary) => (
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
            <AddProjectCard onClick={() => setShowNewCodespace(true)} />
          </div>
        )}
      </div>

      <Suspense fallback={null}>
        <NewProjectDialog
          open={showNewCodespace}
          onOpenChange={setShowNewCodespace}
          onSubmit={handleCreateCodespace}
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
