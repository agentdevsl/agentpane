/**
 * Browser-side API client for fetching data from server endpoints.
 * Used by route loaders and components to access data via REST API.
 */

import type { PlanSession } from '@/lib/plan-mode/types';
import type { GitHubOrg, GitHubRepo, TokenInfo } from '@/services/github-token.service';
import type {
  DreamSession as MemoryDreamSession,
  HealthStatus as MemoryHealthStatus,
  Insight as MemoryInsight,
  SearchResult as MemorySearchResult,
  SkillExecution as MemorySkillExecution,
  SkillMetrics as MemorySkillMetrics,
  SkillSuggestion as MemorySkillSuggestion,
} from '@/services/memory/types';
import type {
  CreateEventSourceInput,
  CreateSubscriptionInput,
  EventLogEntry,
  EventSource,
  EventSubscription,
  UpdateEventSourceInput,
  UpdateSubscriptionInput,
} from '../events/types';
import type { ApiResponse } from './response';
import { API_ERROR_CODES } from './types';

// API server base URL — use relative URLs in the browser so requests go through
// the Vite dev proxy (port 3000 → 3001), sharing the HTTP/2 connection pool.
// Direct connections to port 3001 exhaust the HTTP/1.1 6-connection browser limit.
const API_BASE = typeof window !== 'undefined' ? '' : 'http://localhost:3001';

type FetchOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * Create an API fetch function with optional base URL prefix
 *
 * @param baseUrl - Optional base URL to prefix all requests (e.g., 'http://localhost:3001')
 * @returns A fetch function that returns typed ApiResponse
 */
function createApiFetch(baseUrl?: string) {
  return async function apiFetch<T>(
    path: string,
    options: FetchOptions = {}
  ): Promise<ApiResponse<T>> {
    const url = baseUrl ? `${baseUrl}${path}` : path;
    let response: Response;

    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      });
    } catch (error) {
      // Network-level errors (connection refused, DNS failure, etc.)
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          ok: false,
          error: { code: API_ERROR_CODES.REQUEST_ABORTED, message: 'Request was aborted' },
        };
      }
      // TypeError is thrown by fetch for network failures (CORS, connection refused, DNS)
      if (error instanceof TypeError) {
        return {
          ok: false,
          error: {
            code: API_ERROR_CODES.NETWORK_ERROR,
            message: error.message || 'Network request failed',
          },
        };
      }
      return {
        ok: false,
        error: {
          code: API_ERROR_CODES.FETCH_ERROR,
          message: error instanceof Error ? error.message : 'Network request failed',
        },
      };
    }

    try {
      const json = await response.json();
      return json as ApiResponse<T>;
    } catch (parseError) {
      // JSON parsing failed - include original error for debugging
      return {
        ok: false,
        error: {
          code: API_ERROR_CODES.PARSE_ERROR,
          message: `Invalid JSON response (HTTP ${response.status}): ${parseError instanceof Error ? parseError.message : 'unknown parse error'}`,
        },
      };
    }
  };
}

// Fetch from relative path (same origin)
const apiFetch = createApiFetch();

// Fetch from API server (port 3001)
const apiServerFetch = createApiFetch(API_BASE);

// Re-export shared types for convenience
export type { TaskCreationStatus, TaskSuggestion } from './types';
export { API_ERROR_CODES } from './types';
// Export factory for custom base URLs
export { createApiFetch };

// Codespace types
export type CodespaceListItem = {
  id: string;
  name: string;
  path: string;
  description?: string | null;
  projectFolderId?: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

/** @deprecated Use CodespaceListItem instead */
export type ProjectListItem = CodespaceListItem;

export type CodespaceListResponse = {
  items: CodespaceListItem[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
};

/** @deprecated Use CodespaceListResponse instead */
export type ProjectListResponse = CodespaceListResponse;

export type ProjectSummaryItem = {
  codespace: CodespaceListItem;
  taskCounts: {
    backlog: number;
    queued: number;
    inProgress: number;
    waitingApproval: number;
    verified: number;
    total: number;
  };
  runningAgents: Array<{
    id: string;
    name: string;
    currentTaskId: string | null;
    currentTaskTitle?: string;
  }>;
  status: 'running' | 'idle' | 'needs-approval';
  lastActivityAt: string | null;
};

export type ProjectSummaryResponse = {
  items: ProjectSummaryItem[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
};

// Project folder types
export type ProjectFolderItem = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  icon: string;
  color: string;
  createdAt: string;
  updatedAt: string;
};

export type FolderSummary = {
  folder: ProjectFolderItem;
  totalCodespaces: number;
  runningAgents: number;
  totalTasks: number;
};

// Template types
export type CreateTemplateInput = {
  name: string;
  description?: string;
  scope: 'org' | 'codespace';
  githubUrl: string;
  branch?: string;
  configPath?: string;
  /** Codespace IDs to associate with this template (for codespace-scoped templates) */
  codespaceIds?: string[];
};

export type UpdateTemplateInput = {
  name?: string;
  description?: string;
  branch?: string;
  configPath?: string;
  /** Update the codespace associations (replaces existing) */
  codespaceIds?: string[];
};

// Sandbox Config types — derived from the canonical SandboxProvider type
import type { SandboxProvider } from '../sandbox/types.js';
export type SandboxType = SandboxProvider;

export type SandboxConfigItem = {
  id: string;
  name: string;
  description?: string | null;
  type: SandboxType;
  isDefault: boolean;
  baseImage: string;
  memoryMb: number;
  cpuCores: number;
  maxProcesses: number;
  timeoutMinutes: number;
  /** Volume mount path from local host for docker sandboxes */
  volumeMountPath?: string | null;
  // Kubernetes-specific configuration
  /** Path to kubeconfig file */
  kubeConfigPath?: string | null;
  /** Kubernetes context name */
  kubeContext?: string | null;
  /** Kubernetes namespace for sandbox pods */
  kubeNamespace?: string | null;
  /** Enable network policies for K8s sandboxes */
  networkPolicyEnabled?: boolean | null;
  /** Allowed egress hosts for network policies */
  allowedEgressHosts?: string[] | null;
  // Nomad-specific configuration
  nomadAddress?: string | null;
  nomadNamespace?: string | null;
  nomadRegion?: string | null;
  nomadDatacenter?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateSandboxConfigInput = {
  name: string;
  description?: string;
  type?: SandboxType;
  isDefault?: boolean;
  baseImage?: string;
  memoryMb?: number;
  cpuCores?: number;
  maxProcesses?: number;
  timeoutMinutes?: number;
  /** Volume mount path from local host for docker sandboxes */
  volumeMountPath?: string;
  // Kubernetes-specific configuration
  /** Path to kubeconfig file */
  kubeConfigPath?: string;
  /** Kubernetes context name */
  kubeContext?: string;
  /** Kubernetes namespace for sandbox pods */
  kubeNamespace?: string;
  /** Enable network policies for K8s sandboxes */
  networkPolicyEnabled?: boolean;
  /** Allowed egress hosts for network policies */
  allowedEgressHosts?: string[];
  // Nomad-specific configuration
  nomadAddress?: string;
  nomadToken?: string;
  nomadNamespace?: string;
  nomadRegion?: string;
  nomadDatacenter?: string;
};

export type UpdateSandboxConfigInput = {
  name?: string;
  description?: string;
  type?: SandboxType;
  isDefault?: boolean;
  baseImage?: string;
  memoryMb?: number;
  cpuCores?: number;
  maxProcesses?: number;
  timeoutMinutes?: number;
  /** Volume mount path from local host for docker sandboxes */
  volumeMountPath?: string;
  // Kubernetes-specific configuration
  /** Path to kubeconfig file */
  kubeConfigPath?: string;
  /** Kubernetes context name */
  kubeContext?: string;
  /** Kubernetes namespace for sandbox pods */
  kubeNamespace?: string;
  /** Enable network policies for K8s sandboxes */
  networkPolicyEnabled?: boolean;
  /** Allowed egress hosts for network policies */
  allowedEgressHosts?: string[];
  // Nomad-specific configuration
  nomadAddress?: string;
  nomadToken?: string;
  nomadNamespace?: string;
  nomadRegion?: string;
  nomadDatacenter?: string;
};

// API client methods
// Settings types
export type SettingsResponse = {
  settings: Record<string, unknown>;
};

export type SettingsUpdateResponse = {
  ok: true;
};

export const apiClient = {
  settings: {
    /**
     * Get settings by keys (or all settings if no keys provided)
     * @param keys - Optional array of setting keys to retrieve
     */
    get: (keys?: string[]) => {
      const params = new URLSearchParams();
      if (keys && keys.length > 0) {
        params.set('keys', keys.join(','));
      }
      const query = params.toString();
      return apiServerFetch<SettingsResponse>(`/api/settings${query ? `?${query}` : ''}`);
    },

    /**
     * Update settings
     * @param settings - Map of setting keys to values
     */
    update: (settings: Record<string, unknown>) =>
      apiServerFetch<SettingsUpdateResponse>('/api/settings', {
        method: 'PUT',
        body: { settings },
      }),
  },

  projects: {
    list: (params?: { limit?: number }) =>
      apiServerFetch<CodespaceListResponse>(
        `/api/codespaces${params?.limit ? `?limit=${params.limit}` : ''}`
      ),

    listWithSummaries: (params?: { limit?: number }) =>
      apiServerFetch<ProjectSummaryResponse>(
        `/api/codespaces/summaries${params?.limit ? `?limit=${params.limit}` : ''}`
      ),

    get: (id: string) => apiServerFetch<CodespaceListItem>(`/api/codespaces/${id}`),

    create: (data: {
      name: string;
      path: string;
      description?: string;
      sandboxConfigId?: string;
      projectFolderId?: string;
    }) => apiServerFetch<CodespaceListItem>('/api/codespaces', { method: 'POST', body: data }),

    update: (
      id: string,
      data: {
        name?: string;
        description?: string;
        maxConcurrentAgents?: number;
        config?: Record<string, unknown>;
        projectFolderId?: string;
      }
    ) =>
      apiServerFetch<CodespaceListItem>(`/api/codespaces/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: data,
      }),

    delete: (id: string, options?: { deleteFiles?: boolean }) =>
      apiServerFetch<{ deleted: boolean }>(
        `/api/codespaces/${encodeURIComponent(id)}${options?.deleteFiles ? '?deleteFiles=true' : ''}`,
        {
          method: 'DELETE',
        }
      ),

    getSkills: (id: string) =>
      apiServerFetch<
        Array<{
          id: string;
          name: string;
          description?: string;
          tags?: string[];
          sourceType: string;
          sourceName: string;
        }>
      >(`/api/codespaces/${encodeURIComponent(id)}/skills`),
  },

  // Alias: codespaces points to the same methods as projects
  get codespaces() {
    return this.projects;
  },

  projectFolders: {
    list: () => apiServerFetch<{ items: ProjectFolderItem[] }>('/api/project-folders'),

    get: (id: string) =>
      apiServerFetch<ProjectFolderItem>(`/api/project-folders/${encodeURIComponent(id)}`),

    create: (data: {
      name: string;
      slug: string;
      icon?: string;
      color?: string;
      description?: string;
    }) => apiServerFetch<ProjectFolderItem>('/api/project-folders', { method: 'POST', body: data }),

    update: (
      id: string,
      data: Partial<{
        name: string;
        slug: string;
        icon: string;
        color: string;
        description: string;
      }>
    ) =>
      apiServerFetch<ProjectFolderItem>(`/api/project-folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: data,
      }),

    delete: (id: string) =>
      apiServerFetch<null>(`/api/project-folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    listCodespaces: (folderId: string) =>
      apiServerFetch<{ items: CodespaceListItem[] }>(
        `/api/project-folders/${encodeURIComponent(folderId)}/codespaces`
      ),

    getSummary: (folderId: string) =>
      apiServerFetch<FolderSummary>(`/api/project-folders/${encodeURIComponent(folderId)}/summary`),
  },

  agents: {
    list: (params?: { codespaceId?: string; status?: string }) => {
      const searchParams = new URLSearchParams();
      if (params?.codespaceId) searchParams.set('codespaceId', params.codespaceId);
      if (params?.status) searchParams.set('status', params.status);
      const query = searchParams.toString();
      return apiFetch<{ items: unknown[]; totalCount: number }>(
        `/api/agents${query ? `?${query}` : ''}`
      );
    },

    getRunningCount: () =>
      apiFetch<{ items: unknown[]; totalCount: number }>('/api/agents?status=running'),
  },

  tasks: {
    list: (codespaceId: string, params?: { status?: string; limit?: number }) => {
      const searchParams = new URLSearchParams();
      searchParams.set('codespaceId', codespaceId);
      if (params?.status) searchParams.set('status', params.status);
      if (params?.limit) searchParams.set('limit', String(params.limit));
      return apiServerFetch<{ items: unknown[]; totalCount: number }>(
        `/api/tasks?${searchParams.toString()}`
      );
    },

    get: (id: string) => apiServerFetch<unknown>(`/api/tasks/${id}`),

    /**
     * Create a new task directly (manual mode)
     */
    create: (data: {
      codespaceId: string;
      title: string;
      description?: string;
      labels?: string[];
      priority?: 'high' | 'medium' | 'low';
      skillId?: string | null;
      skillName?: string | null;
    }) =>
      apiServerFetch<{
        taskId: string;
        title: string;
        codespaceId: string;
      }>('/api/tasks', { method: 'POST', body: data }),

    /**
     * Update a task (title, description, labels, priority, skill, etc.)
     */
    update: (
      id: string,
      data: {
        title?: string;
        description?: string;
        labels?: string[];
        priority?: 'high' | 'medium' | 'low';
        skillId?: string | null;
        skillName?: string | null;
      }
    ) =>
      apiServerFetch<unknown>(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: data,
      }),

    /**
     * Delete a task
     */
    delete: (id: string) =>
      apiServerFetch<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),

    /**
     * Move a task to a different column
     */
    move: (
      id: string,
      column: 'backlog' | 'queued' | 'in_progress' | 'waiting_approval' | 'verified',
      position?: number
    ) =>
      apiServerFetch<unknown>(`/api/tasks/${id}/move`, {
        method: 'PATCH',
        body: { column, position },
      }),

    /**
     * Approve a pending plan for a task and start execution
     */
    approvePlan: (id: string) =>
      apiServerFetch<{ approved: boolean }>(`/api/tasks/${id}/approve-plan`, {
        method: 'POST',
      }),

    /**
     * Reject a pending plan for a task
     */
    rejectPlan: (id: string, reason?: string) =>
      apiServerFetch<{ rejected: boolean }>(`/api/tasks/${id}/reject-plan`, {
        method: 'POST',
        body: reason ? { reason } : undefined,
      }),

    /**
     * Get diff for a task (file changes made by the agent)
     */
    getDiff: (id: string) =>
      apiServerFetch<{
        summary: { filesChanged: number; additions: number; deletions: number };
        files: Array<{
          path: string;
          status: 'added' | 'modified' | 'deleted' | 'renamed';
          additions: number;
          deletions: number;
          hunks?: Array<{
            header: string;
            lines: Array<{
              type: 'context' | 'add' | 'delete';
              content: string;
              lineNumber?: number;
            }>;
          }>;
        }>;
      }>(`/api/tasks/${id}/diff`),
  },

  sessions: {
    list: (params?: {
      codespaceId?: string;
      limit?: number;
      offset?: number;
      status?: string[];
      agentId?: string;
      taskId?: string;
      dateFrom?: string;
      dateTo?: string;
      search?: string;
    }) => {
      const searchParams = new URLSearchParams();
      if (params?.codespaceId) searchParams.set('codespaceId', params.codespaceId);
      if (params?.limit) searchParams.set('limit', String(params.limit));
      if (params?.offset) searchParams.set('offset', String(params.offset));
      if (params?.status?.length) searchParams.set('status', params.status.join(','));
      if (params?.agentId) searchParams.set('agentId', params.agentId);
      if (params?.taskId) searchParams.set('taskId', params.taskId);
      if (params?.dateFrom) searchParams.set('dateFrom', params.dateFrom);
      if (params?.dateTo) searchParams.set('dateTo', params.dateTo);
      if (params?.search) searchParams.set('search', params.search);
      const query = searchParams.toString();
      // Use apiServerFetch to hit the Bun API server directly
      return apiServerFetch<{ data: unknown[]; pagination: unknown }>(
        `/api/sessions${query ? `?${query}` : ''}`
      );
    },

    get: (id: string) => apiServerFetch<unknown>(`/api/sessions/${id}`),

    getEvents: (
      id: string,
      params?: { limit?: number; offset?: number; afterEventId?: string }
    ) => {
      const searchParams = new URLSearchParams();
      if (params?.limit) searchParams.set('limit', String(params.limit));
      if (params?.offset) searchParams.set('offset', String(params.offset));
      if (params?.afterEventId) searchParams.set('afterEventId', params.afterEventId);
      const query = searchParams.toString();
      // Use apiServerFetch to hit the Bun API server directly
      return apiServerFetch<Array<{ id: string; type: string; timestamp: number; data: unknown }>>(
        `/api/sessions/${encodeURIComponent(id)}/events${query ? `?${query}` : ''}`
      );
    },

    getSummary: (id: string) =>
      // Use apiServerFetch to hit the Bun API server directly
      apiServerFetch<{
        sessionId: string;
        durationMs: number | null;
        turnsCount: number;
        tokensUsed: number;
        filesModified: number;
        linesAdded: number;
        linesRemoved: number;
        finalStatus: 'success' | 'failed' | 'cancelled' | null;
        session: { id: string; status: string; title: string | null };
      }>(`/api/sessions/${encodeURIComponent(id)}/summary`),

    export: (id: string, format: 'json' | 'markdown' | 'csv') =>
      apiServerFetch<{
        content: string;
        contentType: string;
        filename: string;
      }>(`/api/sessions/${encodeURIComponent(id)}/export`, {
        method: 'POST',
        body: { format },
      }),

    delete: (id: string) =>
      apiServerFetch<{ deleted: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
  },

  worktrees: {
    list: (params?: { codespaceId?: string }) => {
      const searchParams = new URLSearchParams();
      if (params?.codespaceId) searchParams.set('codespaceId', params.codespaceId);
      const query = searchParams.toString();
      return apiServerFetch<{
        items: Array<{
          id: string;
          branch: string;
          path: string;
          baseBranch: string;
          status: string;
          taskId: string | null;
          taskTitle?: string;
          agentId?: string;
          agentName?: string;
          createdAt: string;
          updatedAt: string | null;
          hasUncommittedChanges?: boolean;
          aheadBehind?: { ahead: number; behind: number };
        }>;
        totalCount: number;
      }>(`/api/worktrees${query ? `?${query}` : ''}`);
    },

    get: (id: string) =>
      apiServerFetch<{
        id: string;
        branch: string;
        path: string;
        baseBranch: string;
        status: string;
        taskId: string | null;
        createdAt: string;
        updatedAt: string | null;
        hasUncommittedChanges: boolean;
        aheadBehind?: { ahead: number; behind: number };
      }>(`/api/worktrees/${encodeURIComponent(id)}`),

    create: (data: { codespaceId: string; taskId: string; baseBranch?: string }) =>
      apiServerFetch<{
        id: string;
        branch: string;
        path: string;
        status: string;
      }>('/api/worktrees', { method: 'POST', body: data }),

    remove: (id: string, force?: boolean) =>
      apiServerFetch<{ success: boolean }>(
        `/api/worktrees/${encodeURIComponent(id)}${force ? '?force=true' : ''}`,
        { method: 'DELETE' }
      ),

    commit: (id: string, message: string) =>
      apiServerFetch<{ sha: string }>(`/api/worktrees/${encodeURIComponent(id)}/commit`, {
        method: 'POST',
        body: { message },
      }),

    merge: (
      id: string,
      options: {
        targetBranch?: string;
        deleteAfterMerge?: boolean;
        squash?: boolean;
        commitMessage?: string;
      }
    ) =>
      apiServerFetch<{
        merged: boolean;
        conflicts?: string[];
        cleanupFailed?: boolean;
        cleanupError?: string;
      }>(`/api/worktrees/${encodeURIComponent(id)}/merge`, { method: 'POST', body: options }),

    getDiff: (id: string) =>
      apiServerFetch<{
        files: Array<{
          path: string;
          status: 'added' | 'modified' | 'deleted' | 'renamed';
          additions: number;
          deletions: number;
        }>;
        stats: { filesChanged: number; additions: number; deletions: number };
      }>(`/api/worktrees/${encodeURIComponent(id)}/diff`),

    prune: (codespaceId: string) =>
      apiServerFetch<{
        pruned: number;
        failed: Array<{ worktreeId: string; branch: string; error: string }>;
      }>(`/api/worktrees/prune`, { method: 'POST', body: { codespaceId } }),
  },

  git: {
    status: (codespaceId: string) =>
      apiServerFetch<{
        repoName: string;
        currentBranch: string;
        status: 'clean' | 'dirty';
        staged: number;
        unstaged: number;
        untracked: number;
        ahead: number;
        behind: number;
      }>(`/api/git/status?codespaceId=${encodeURIComponent(codespaceId)}`),

    branches: (codespaceId: string) =>
      apiServerFetch<{
        items: Array<{
          name: string;
          commitHash: string;
          shortHash: string;
          commitCount: number;
          isHead: boolean;
          status: 'ahead' | 'behind' | 'diverged' | 'up-to-date' | 'no-upstream';
        }>;
      }>(`/api/git/branches?codespaceId=${encodeURIComponent(codespaceId)}`),

    commits: (codespaceId: string, branch?: string, limit?: number) => {
      const params = new URLSearchParams({ codespaceId });
      if (branch) params.set('branch', branch);
      if (limit) params.set('limit', String(limit));
      return apiServerFetch<{
        items: Array<{
          hash: string;
          shortHash: string;
          message: string;
          author: string;
          date: string;
          additions?: number;
          deletions?: number;
          filesChanged?: number;
        }>;
      }>(`/api/git/commits?${params.toString()}`);
    },

    remoteBranches: (codespaceId: string) =>
      apiServerFetch<{
        items: Array<{
          name: string;
          fullName: string;
          commitHash: string;
          shortHash: string;
          commitCount: number;
        }>;
      }>(`/api/git/remote-branches?codespaceId=${encodeURIComponent(codespaceId)}`),
  },

  filesystem: {
    discoverRepos: () =>
      apiServerFetch<{ repos: { name: string; path: string; lastModified: string }[] }>(
        '/api/filesystem/discover-repos'
      ),
  },

  github: {
    listOrgs: () => apiServerFetch<{ orgs: GitHubOrg[] }>('/api/github/orgs'),

    listReposForOwner: (owner: string) =>
      apiServerFetch<{ repos: GitHubRepo[] }>(`/api/github/repos/${encodeURIComponent(owner)}`),

    listRepos: () => apiServerFetch<{ repos: GitHubRepo[] }>('/api/github/repos'),

    clone: (url: string, destination: string) =>
      apiServerFetch<{ path: string }>('/api/github/clone', {
        method: 'POST',
        body: { url, destination },
      }),

    getTokenInfo: () => apiServerFetch<{ tokenInfo: TokenInfo | null }>('/api/github/token'),

    saveToken: (token: string) =>
      apiServerFetch<{ tokenInfo: TokenInfo }>('/api/github/token', {
        method: 'POST',
        body: { token },
      }),

    deleteToken: () => apiServerFetch<null>('/api/github/token', { method: 'DELETE' }),

    revalidateToken: () =>
      apiServerFetch<{ isValid: boolean }>('/api/github/revalidate', { method: 'POST' }),

    createFromTemplate: (params: {
      templateOwner: string;
      templateRepo: string;
      name: string;
      owner?: string;
      description?: string;
      isPrivate?: boolean;
      clonePath: string;
    }) =>
      apiServerFetch<{ path: string; repoFullName: string; cloneUrl: string }>(
        '/api/github/create-from-template',
        { method: 'POST', body: params }
      ),

    app: {
      status: () =>
        apiServerFetch<{
          configured: boolean;
          installUrl: string | null;
          appSlug: string | null;
          appId: string | null;
        }>('/api/github/app/status'),

      getManifest: (externalUrl: string, appName?: string) =>
        apiServerFetch<{ manifest: string; state: string; githubUrl: string }>(
          '/api/github/app/manifest',
          { method: 'POST', body: { externalUrl, ...(appName ? { appName } : {}) } }
        ),

      setupCallback: (code: string) =>
        apiServerFetch<{ appId: string; appSlug: string; installUrl: string }>(
          '/api/github/app/setup-callback',
          { method: 'POST', body: { code } }
        ),

      deleteCredentials: () =>
        apiServerFetch<{ deleted: boolean }>('/api/github/app/credentials', { method: 'DELETE' }),

      listInstallations: (teamId?: string) =>
        apiServerFetch<{
          items: Array<{
            id: string;
            installationId: string;
            accountLogin: string;
            accountType: string;
            teamId: string | null;
            status: string;
            createdAt: string;
          }>;
        }>(`/api/github/app/installations${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`),

      registerInstallation: (installationId: number, teamId: string) =>
        apiServerFetch<{
          id: string;
          installationId: string;
          accountLogin: string;
          accountType: string;
          status: string;
        }>('/api/github/app/installations', {
          method: 'POST',
          body: { installationId, teamId },
        }),

      removeInstallation: (id: string) =>
        apiServerFetch<{ deleted: boolean }>(
          `/api/github/app/installations/${encodeURIComponent(id)}`,
          {
            method: 'DELETE',
          }
        ),

      configureCodespace: (installationId: string, codespaceId: string) =>
        apiServerFetch<{
          eventSourceId: string | null;
          subscriptionId: string | null;
          installationId: string | null;
        }>(
          `/api/github/app/installations/${encodeURIComponent(installationId)}/configure-codespace`,
          {
            method: 'POST',
            body: { codespaceId },
          }
        ),
    },
  },

  system: {
    health: () =>
      apiServerFetch<{
        status: 'healthy' | 'degraded';
        timestamp: string;
        uptime: number;
        checks: {
          database: {
            status: 'ok' | 'error';
            latencyMs?: number;
            mode?: string;
            version?: string;
            error?: string;
          };
          github: { status: 'ok' | 'error' | 'not_configured'; login?: string | null };
        };
        responseTimeMs: number;
      }>('/api/health'),
  },

  apiKeys: {
    get: (service: string) =>
      apiServerFetch<{
        keyInfo: {
          id: string;
          service: string;
          maskedKey: string;
          isValid: boolean;
          lastValidatedAt: string | null;
          createdAt: string;
        } | null;
      }>(`/api/keys/${encodeURIComponent(service)}`),

    save: (service: string, key: string) =>
      apiServerFetch<{
        keyInfo: {
          id: string;
          service: string;
          maskedKey: string;
          isValid: boolean;
          lastValidatedAt: string | null;
          createdAt: string;
        };
      }>(`/api/keys/${encodeURIComponent(service)}`, { method: 'POST', body: { key } }),

    delete: (service: string) =>
      apiServerFetch<null>(`/api/keys/${encodeURIComponent(service)}`, { method: 'DELETE' }),
  },

  templates: {
    list: (options?: { scope?: 'org' | 'codespace'; codespaceId?: string; limit?: number }) => {
      const searchParams = new URLSearchParams();
      if (options?.scope) searchParams.set('scope', options.scope);
      if (options?.codespaceId) searchParams.set('codespaceId', options.codespaceId);
      if (options?.limit) searchParams.set('limit', String(options.limit));
      const query = searchParams.toString();
      return apiServerFetch<{ items: unknown[]; totalCount: number }>(
        `/api/templates${query ? `?${query}` : ''}`
      );
    },

    create: (input: CreateTemplateInput) =>
      apiServerFetch<unknown>('/api/templates', { method: 'POST', body: input }),

    getById: (id: string) => apiServerFetch<unknown>(`/api/templates/${encodeURIComponent(id)}`),

    update: (id: string, input: UpdateTemplateInput) =>
      apiServerFetch<unknown>(`/api/templates/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: input,
      }),

    delete: (id: string) =>
      apiServerFetch<null>(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    sync: (id: string) =>
      apiServerFetch<unknown>(`/api/templates/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  },

  sandboxConfigs: {
    list: (options?: { limit?: number; offset?: number }) => {
      const searchParams = new URLSearchParams();
      if (options?.limit) searchParams.set('limit', String(options.limit));
      if (options?.offset) searchParams.set('offset', String(options.offset));
      const query = searchParams.toString();
      return apiServerFetch<{ items: SandboxConfigItem[]; totalCount: number }>(
        `/api/sandbox-configs${query ? `?${query}` : ''}`
      );
    },

    create: (input: CreateSandboxConfigInput) =>
      apiServerFetch<SandboxConfigItem>('/api/sandbox-configs', { method: 'POST', body: input }),

    getById: (id: string) =>
      apiServerFetch<SandboxConfigItem>(`/api/sandbox-configs/${encodeURIComponent(id)}`),

    update: (id: string, input: UpdateSandboxConfigInput) =>
      apiServerFetch<SandboxConfigItem>(`/api/sandbox-configs/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: input,
      }),

    delete: (id: string) =>
      apiServerFetch<null>(`/api/sandbox-configs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  plans: {
    /**
     * Get plan session for a task
     */
    get: (taskId: string) =>
      apiFetch<{ session: PlanSession | null }>(`/api/plans/${encodeURIComponent(taskId)}`),

    /**
     * Start a new plan session for a task
     */
    start: (taskId: string, data: { codespaceId: string; initialPrompt: string }) =>
      apiFetch<{ session: PlanSession }>(`/api/plans/${encodeURIComponent(taskId)}/start`, {
        method: 'POST',
        body: data,
      }),

    /**
     * Answer an interaction question in a plan session
     */
    answerInteraction: (
      taskId: string,
      data: { interactionId: string; answers: Record<string, string> }
    ) =>
      apiFetch<{ session: PlanSession }>(`/api/plans/${encodeURIComponent(taskId)}/answer`, {
        method: 'POST',
        body: data,
      }),

    /**
     * Cancel a plan session
     */
    cancel: (taskId: string) =>
      apiFetch<{ session: PlanSession }>(`/api/plans/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
      }),

    // NOTE: SSE stream URL removed — clients subscribe to Caddy durable streams
    // at /v1/stream/plans/:taskId directly.
  },

  taskCreation: {
    /**
     * Start a new AI task creation conversation
     * @param codespaceId - Project to create task for
     * @param allowedTools - Optional tools configured in settings
     */
    start: (codespaceId: string, allowedTools?: string[]) =>
      apiServerFetch<{
        sessionId: string;
        codespaceId: string;
        status: string;
        createdAt: string;
      }>('/api/tasks/create-with-ai/start', {
        method: 'POST',
        body: { codespaceId, allowedTools },
      }),

    /**
     * Send a message in the conversation
     */
    sendMessage: (sessionId: string, message: string) =>
      apiServerFetch<{
        sessionId: string;
        status: string;
        messageCount: number;
        hasSuggestion: boolean;
        suggestion: {
          title: string;
          description: string;
          labels: string[];
          priority: 'high' | 'medium' | 'low';
        } | null;
      }>('/api/tasks/create-with-ai/message', {
        method: 'POST',
        body: { sessionId, message },
      }),

    /**
     * Accept the suggestion and create a task
     */
    accept: (
      sessionId: string,
      overrides?: Partial<{
        title: string;
        description: string;
        labels: string[];
        priority: 'high' | 'medium' | 'low';
      }>
    ) =>
      apiServerFetch<{
        taskId: string;
        sessionId: string;
        status: string;
      }>('/api/tasks/create-with-ai/accept', {
        method: 'POST',
        body: { sessionId, overrides },
      }),

    /**
     * Cancel a task creation session
     */
    cancel: (sessionId: string) =>
      apiServerFetch<{
        sessionId: string;
        status: string;
      }>('/api/tasks/create-with-ai/cancel', {
        method: 'POST',
        body: { sessionId },
      }),

    /**
     * Answer clarifying questions
     */
    answerQuestions: (
      sessionId: string,
      questionsId: string,
      answers: Record<string, string | string[]>
    ) =>
      apiServerFetch<{
        sessionId: string;
        status: string;
      }>('/api/tasks/create-with-ai/answer', {
        method: 'POST',
        body: { sessionId, questionsId, answers },
      }),

    /**
     * Skip clarifying questions
     */
    skipQuestions: (sessionId: string) =>
      apiServerFetch<{
        sessionId: string;
        status: string;
      }>('/api/tasks/create-with-ai/skip', {
        method: 'POST',
        body: { sessionId },
      }),

    /**
     * Get the SSE stream URL for a task creation session
     */
    getStreamUrl: (sessionId: string) =>
      `${API_BASE}/api/tasks/create-with-ai/stream?sessionId=${encodeURIComponent(sessionId)}`,
  },

  marketplaces: {
    /**
     * List all connected marketplaces
     */
    list: (options?: { limit?: number; includeDisabled?: boolean }) => {
      const params = new URLSearchParams();
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.includeDisabled) params.set('includeDisabled', 'true');
      const query = params.toString();
      return apiServerFetch<{
        items: Array<{
          id: string;
          name: string;
          githubOwner: string;
          githubRepo: string;
          branch: string;
          pluginsPath: string;
          isDefault: boolean;
          isEnabled: boolean;
          status: 'active' | 'syncing' | 'error';
          lastSyncedAt: string | null;
          syncError: string | null;
          pluginCount: number;
          createdAt: string;
          updatedAt: string;
        }>;
        totalCount: number;
      }>(`/api/marketplaces${query ? `?${query}` : ''}`);
    },

    /**
     * Get a marketplace by ID
     */
    get: (id: string) =>
      apiServerFetch<{
        id: string;
        name: string;
        githubOwner: string;
        githubRepo: string;
        branch: string;
        pluginsPath: string;
        isDefault: boolean;
        isEnabled: boolean;
        status: 'active' | 'syncing' | 'error';
        lastSyncedAt: string | null;
        syncError: string | null;
        plugins: Array<{
          id: string;
          name: string;
          description?: string;
          author?: string;
          version?: string;
          category?: string;
          readme?: string;
        }>;
        createdAt: string;
        updatedAt: string;
      }>(`/api/marketplaces/${encodeURIComponent(id)}`),

    /**
     * Create a new marketplace
     */
    create: (data: {
      name: string;
      githubUrl?: string;
      githubOwner?: string;
      githubRepo?: string;
      branch?: string;
      pluginsPath?: string;
    }) =>
      apiServerFetch<{
        id: string;
        name: string;
        githubOwner: string;
        githubRepo: string;
      }>('/api/marketplaces', { method: 'POST', body: data }),

    /**
     * Delete a marketplace
     */
    delete: (id: string) =>
      apiServerFetch<{ deleted: boolean }>(`/api/marketplaces/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    /**
     * Sync a marketplace from GitHub
     */
    sync: (id: string) =>
      apiServerFetch<{
        marketplaceId: string;
        pluginCount: number;
        sha: string;
        syncedAt: string;
      }>(`/api/marketplaces/${encodeURIComponent(id)}/sync`, { method: 'POST' }),

    /**
     * Seed the default marketplace
     */
    seed: () => apiServerFetch<{ seeded: boolean }>('/api/marketplaces/seed', { method: 'POST' }),

    /**
     * List all plugins from all marketplaces
     */
    listPlugins: (options?: { search?: string; category?: string; marketplaceId?: string }) => {
      const params = new URLSearchParams();
      if (options?.search) params.set('search', options.search);
      if (options?.category) params.set('category', options.category);
      if (options?.marketplaceId) params.set('marketplaceId', options.marketplaceId);
      const query = params.toString();
      return apiServerFetch<{
        items: Array<{
          id: string;
          name: string;
          description?: string;
          author?: string;
          version?: string;
          category?: string;
          marketplaceId: string;
          marketplaceName: string;
          isEnabled: boolean;
        }>;
        totalCount: number;
      }>(`/api/marketplaces/plugins${query ? `?${query}` : ''}`);
    },

    /**
     * Get all plugin categories
     */
    getCategories: () => apiServerFetch<{ categories: string[] }>('/api/marketplaces/categories'),
  },

  terraform: {
    listRegistries: () =>
      apiServerFetch<{
        items: Array<{
          id: string;
          name: string;
          orgName: string;
          hasToken: boolean;
          status: 'active' | 'syncing' | 'error';
          lastSyncedAt: string | null;
          syncError: string | null;
          moduleCount: number;
          syncIntervalMinutes: number | null;
          nextSyncAt: string | null;
          createdAt: string;
          updatedAt: string;
        }>;
        totalCount: number;
      }>('/api/terraform/registries'),

    createRegistry: (data: {
      name: string;
      orgName: string;
      apiToken: string;
      syncIntervalMinutes?: number;
    }) =>
      apiServerFetch<{
        id: string;
        name: string;
        orgName: string;
        hasToken: boolean;
        status: string;
        moduleCount: number;
        createdAt: string;
        updatedAt: string;
      }>('/api/terraform/registries', { method: 'POST', body: data }),

    getRegistry: (id: string) =>
      apiServerFetch<{
        id: string;
        name: string;
        orgName: string;
        hasToken: boolean;
        status: string;
        lastSyncedAt: string | null;
        syncError: string | null;
        moduleCount: number;
        syncIntervalMinutes: number | null;
        nextSyncAt: string | null;
        createdAt: string;
        updatedAt: string;
      }>(`/api/terraform/registries/${encodeURIComponent(id)}`),

    deleteRegistry: (id: string) =>
      apiServerFetch<{ deleted: boolean }>(`/api/terraform/registries/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    updateRegistry: (
      id: string,
      data: {
        name?: string;
        orgName?: string;
        apiToken?: string;
        syncIntervalMinutes?: number | null;
      }
    ) =>
      apiServerFetch<{
        id: string;
        name: string;
        orgName: string;
        hasToken: boolean;
        status: string;
        syncIntervalMinutes: number | null;
        updatedAt: string;
      }>(`/api/terraform/registries/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: data,
      }),

    syncRegistry: (id: string) =>
      apiServerFetch<{
        registryId: string;
        moduleCount: number;
        syncedAt: string;
      }>(`/api/terraform/registries/${encodeURIComponent(id)}/sync`, { method: 'POST' }),

    listModules: (params?: {
      search?: string;
      provider?: string;
      registryId?: string;
      limit?: number;
    }) => {
      const sp = new URLSearchParams();
      if (params?.search) sp.set('search', params.search);
      if (params?.provider) sp.set('provider', params.provider);
      if (params?.registryId) sp.set('registryId', params.registryId);
      if (params?.limit) sp.set('limit', String(params.limit));
      const qs = sp.toString();
      return apiServerFetch<{
        items: Array<{
          id: string;
          registryId: string;
          name: string;
          namespace: string;
          provider: string;
          version: string;
          source: string;
          description: string | null;
          inputs: unknown[] | null;
          outputs: unknown[] | null;
          dependencies: string[] | null;
          publishedAt: string | null;
          createdAt: string;
          updatedAt: string;
        }>;
        totalCount: number;
      }>(`/api/terraform/modules${qs ? `?${qs}` : ''}`);
    },

    getModule: (id: string) =>
      apiServerFetch<{
        id: string;
        registryId: string;
        name: string;
        namespace: string;
        provider: string;
        version: string;
        source: string;
        description: string | null;
        readme: string | null;
        inputs: unknown[] | null;
        outputs: unknown[] | null;
        dependencies: string[] | null;
        publishedAt: string | null;
        createdAt: string;
        updatedAt: string;
      }>(`/api/terraform/modules/${encodeURIComponent(id)}`),

    validateCode: (data: { code: string; tfvars?: string }) =>
      apiServerFetch<{
        valid: boolean;
        diagnostics: Array<{
          severity: 'error' | 'warning';
          summary: string;
          detail?: string;
        }>;
      }>('/api/terraform/validate', { method: 'POST', body: data }),

    getComposeUrl: () => `${API_BASE}/api/terraform/compose`,
  },

  teams: {
    list: () =>
      apiServerFetch<{
        items: Array<{ id: string; name: string; slug: string }>;
      }>('/api/teams'),
  },

  events: {
    sources: {
      list: (params?: { teamId?: string }) => {
        const sp = new URLSearchParams();
        if (params?.teamId) sp.set('teamId', params.teamId);
        const qs = sp.toString();
        return apiServerFetch<{ items: EventSource[] }>(`/api/events/sources${qs ? `?${qs}` : ''}`);
      },
      get: (id: string) =>
        apiServerFetch<EventSource>(`/api/events/sources/${encodeURIComponent(id)}`),
      create: (data: CreateEventSourceInput) =>
        apiServerFetch<EventSource & { webhookSecret: string; webhookUrl: string }>(
          '/api/events/sources',
          { method: 'POST', body: data }
        ),
      update: (id: string, data: UpdateEventSourceInput) =>
        apiServerFetch<EventSource>(`/api/events/sources/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: data,
        }),
      delete: (id: string) =>
        apiServerFetch<{ deleted: boolean }>(`/api/events/sources/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }),
      rotateSecret: (id: string) =>
        apiServerFetch<{ secret: string }>(
          `/api/events/sources/${encodeURIComponent(id)}/rotate-secret`,
          { method: 'POST' }
        ),
    },
    subscriptions: {
      list: (params?: { eventSourceId?: string; targetCodespaceId?: string }) => {
        const sp = new URLSearchParams();
        if (params?.eventSourceId) sp.set('eventSourceId', params.eventSourceId);
        if (params?.targetCodespaceId) sp.set('targetCodespaceId', params.targetCodespaceId);
        const qs = sp.toString();
        return apiServerFetch<{ items: EventSubscription[] }>(
          `/api/events/subscriptions${qs ? `?${qs}` : ''}`
        );
      },
      get: (id: string) =>
        apiServerFetch<EventSubscription>(`/api/events/subscriptions/${encodeURIComponent(id)}`),
      create: (data: CreateSubscriptionInput) =>
        apiServerFetch<EventSubscription>('/api/events/subscriptions', {
          method: 'POST',
          body: data,
        }),
      update: (id: string, data: UpdateSubscriptionInput) =>
        apiServerFetch<EventSubscription>(`/api/events/subscriptions/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: data,
        }),
      delete: (id: string) =>
        apiServerFetch<{ deleted: boolean }>(
          `/api/events/subscriptions/${encodeURIComponent(id)}`,
          { method: 'DELETE' }
        ),
    },
    log: {
      list: (params?: {
        eventSourceId?: string;
        status?: string;
        eventType?: string;
        cursor?: string;
        limit?: number;
      }) => {
        const sp = new URLSearchParams();
        if (params?.eventSourceId) sp.set('eventSourceId', params.eventSourceId);
        if (params?.status) sp.set('status', params.status);
        if (params?.eventType) sp.set('eventType', params.eventType);
        if (params?.cursor) sp.set('cursor', params.cursor);
        if (params?.limit) sp.set('limit', String(params.limit));
        const qs = sp.toString();
        return apiServerFetch<{
          items: EventLogEntry[];
          nextCursor: string | null;
          hasMore: boolean;
        }>(`/api/events/log${qs ? `?${qs}` : ''}`);
      },
      get: (id: string) =>
        apiServerFetch<EventLogEntry>(`/api/events/log/${encodeURIComponent(id)}`),
    },
    getStreamUrl: () => `${API_BASE}/api/events/stream`,
  },

  cliMonitor: {
    status: () =>
      apiServerFetch<{
        connected: boolean;
        daemon: {
          daemonId: string;
          pid: number;
          version: string;
          watchPath: string;
          capabilities: string[];
          registeredAt: number;
          lastHeartbeatAt: number;
        } | null;
        sessionCount: number;
      }>('/api/cli-monitor/status'),
    listSessions: () =>
      apiServerFetch<{
        sessions: Array<{
          sessionId: string;
          cwd: string;
          projectName: string;
          status: 'working' | 'waiting_for_approval' | 'waiting_for_input' | 'idle';
          messageCount: number;
          turnCount: number;
          goal?: string;
          model?: string;
          startedAt: number;
          lastActivityAt: number;
          isSubagent: boolean;
        }>;
        connected: boolean;
      }>('/api/cli-monitor/sessions'),
    getStreamUrl: () => `${API_BASE}/api/cli-monitor/stream`,
  },

  memory: {
    health: () => apiServerFetch<MemoryHealthStatus>('/api/memory/health'),

    getInsights: (codespaceId?: string | null, params?: { page?: number; size?: number }) => {
      const sp = new URLSearchParams();
      if (params?.page !== undefined) sp.set('page', String(params.page));
      if (params?.size !== undefined) sp.set('size', String(params.size));
      const qs = sp.toString();
      const base = codespaceId
        ? `/api/memory/codespaces/${codespaceId}/insights`
        : '/api/memory/insights';
      return apiServerFetch<Array<MemoryInsight>>(`${base}${qs ? `?${qs}` : ''}`);
    },

    createInsight: (
      codespaceId: string,
      data: {
        content: string;
        source?: MemoryInsight['source'];
        tags?: string[];
        metadata?: Record<string, unknown>;
        skillId?: string;
      }
    ) =>
      apiServerFetch<MemoryInsight>(`/api/memory/codespaces/${codespaceId}/insights`, {
        method: 'POST',
        body: data,
      }),

    deleteInsight: (insightId: string) =>
      apiServerFetch<null>(`/api/memory/insights/${insightId}`, { method: 'DELETE' }),

    search: (codespaceId: string | null | undefined, query: string, limit?: number) => {
      const base = codespaceId
        ? `/api/memory/codespaces/${codespaceId}/search`
        : '/api/memory/search';
      return apiServerFetch<Array<MemorySearchResult>>(base, {
        method: 'POST',
        body: { query, limit },
      });
    },

    getSkillMetrics: (codespaceId?: string | null) => {
      const base = codespaceId
        ? `/api/memory/codespaces/${codespaceId}/skill-metrics`
        : '/api/memory/skill-metrics';
      return apiServerFetch<Array<MemorySkillMetrics>>(base);
    },

    getSkillExecutions: (
      codespaceId: string | null | undefined,
      skillId: string,
      params?: { page?: number; size?: number }
    ) => {
      const sp = new URLSearchParams();
      if (params?.page !== undefined) sp.set('page', String(params.page));
      if (params?.size !== undefined) sp.set('size', String(params.size));
      const qs = sp.toString();
      const base = codespaceId
        ? `/api/memory/codespaces/${codespaceId}/skill-metrics/${skillId}/executions`
        : `/api/memory/skill-metrics/${skillId}/executions`;
      return apiServerFetch<Array<MemorySkillExecution>>(`${base}${qs ? `?${qs}` : ''}`);
    },

    getDreamSessions: (codespaceId?: string | null, params?: { page?: number; size?: number }) => {
      const sp = new URLSearchParams();
      if (params?.page !== undefined) sp.set('page', String(params.page));
      if (params?.size !== undefined) sp.set('size', String(params.size));
      const qs = sp.toString();
      const base = codespaceId
        ? `/api/memory/codespaces/${codespaceId}/dream-sessions`
        : '/api/memory/dream-sessions';
      return apiServerFetch<Array<MemoryDreamSession>>(`${base}${qs ? `?${qs}` : ''}`);
    },

    triggerDream: (codespaceId: string) =>
      apiServerFetch<MemoryDreamSession>(`/api/memory/codespaces/${codespaceId}/dream`, {
        method: 'POST',
      }),

    getSuggestions: (
      codespaceId?: string | null,
      params?: { status?: string; skillId?: string; page?: number; size?: number }
    ) => {
      const sp = new URLSearchParams();
      if (params?.status) sp.set('status', params.status);
      if (params?.skillId) sp.set('skillId', params.skillId);
      if (params?.page !== undefined) sp.set('page', String(params.page));
      if (params?.size !== undefined) sp.set('size', String(params.size));
      const qs = sp.toString();
      const base = codespaceId
        ? `/api/memory/codespaces/${codespaceId}/suggestions`
        : '/api/memory/suggestions';
      return apiServerFetch<Array<MemorySkillSuggestion>>(`${base}${qs ? `?${qs}` : ''}`);
    },

    acceptSuggestion: (id: string, userNotes?: string) =>
      apiServerFetch<MemorySkillSuggestion>(`/api/memory/suggestions/${id}/accept`, {
        method: 'PATCH',
        body: userNotes ? { userNotes } : {},
      }),

    rejectSuggestion: (id: string, userNotes?: string) =>
      apiServerFetch<MemorySkillSuggestion>(`/api/memory/suggestions/${id}/reject`, {
        method: 'PATCH',
        body: userNotes ? { userNotes } : {},
      }),

    modifySuggestion: (id: string, modifiedContent: string, userNotes?: string) =>
      apiServerFetch<MemorySkillSuggestion>(`/api/memory/suggestions/${id}/modify`, {
        method: 'PATCH',
        body: { modifiedContent, userNotes },
      }),

    getDreamSkillOverrides: () =>
      apiServerFetch<Record<string, { enabled?: boolean; model?: string; minRuns?: number }>>(
        '/api/memory/dream-config/skills'
      ),

    setDreamSkillOverride: (
      skillId: string,
      override: { enabled?: boolean; model?: string; minRuns?: number } | null
    ) =>
      apiServerFetch<void>(`/api/memory/dream-config/skills/${encodeURIComponent(skillId)}`, {
        method: 'PUT',
        body: override ?? {},
      }),
  },
};
