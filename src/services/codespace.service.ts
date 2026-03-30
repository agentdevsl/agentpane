// Browser-compatible path utilities
const pathUtils = {
  resolve: (...parts: string[]): string => {
    // Simple path resolution for browser
    const combined = parts.join('/').replace(/\/+/g, '/');
    return combined.startsWith('/') ? combined : `/${combined}`;
  },
  join: (...parts: string[]): string => {
    return parts.join('/').replace(/\/+/g, '/');
  },
  basename: (filePath: string): string => {
    // Get the last part of a path
    const parts = filePath.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || '';
  },
};

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Codespace, CodespaceConfig } from '../db/schema';
import {
  agents,
  codespaces,
  githubInstallations,
  planSessions,
  sandboxInstances,
  sessionEvents,
  sessions,
  tasks,
} from '../db/schema';
import { codespaceConfigSchema } from '../lib/config/schemas.js';
import { DEFAULT_CODESPACE_CONFIG } from '../lib/config/types.js';
import { containsSecrets } from '../lib/config/validate-secrets.js';
import type { CodespaceError } from '../lib/errors/codespace-errors.js';
import { CodespaceErrors } from '../lib/errors/codespace-errors.js';
import { getInstallationOctokit } from '../lib/github/client.js';
import { syncConfigFromGitHub } from '../lib/github/config-sync.js';
import { deepMerge } from '../lib/utils/deep-merge.js';
import { errorMessage } from '../lib/utils/error-message.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

export type CreateCodespaceInput = {
  projectFolderId: string;
  path: string;
  name?: string;
  description?: string;
  config?: Partial<CodespaceConfig>;
  maxConcurrentAgents?: number;
  sandboxConfigId?: string;
};

export type UpdateCodespaceInput = {
  name?: string;
  description?: string;
  maxConcurrentAgents?: number;
  configPath?: string;
  githubOwner?: string;
  githubRepo?: string;
  config?: Record<string, unknown>;
  projectFolderId?: string;
};

export type ListCodespacesOptions = {
  limit?: number;
  offset?: number;
  orderBy?: 'name' | 'createdAt' | 'updatedAt';
  orderDirection?: 'asc' | 'desc';
  projectFolderId?: string;
};

export type PathValidation = {
  name: string;
  path: string;
  hasClaudeConfig: boolean;
  hasClaudeConfigError?: string;
  defaultBranch: string;
  remoteUrl?: string;
};

export type CodespaceSummary = {
  codespace: Codespace;
  taskCounts: {
    backlog: number;
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

export type CommandRunner = {
  exec: (command: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
};

export class CodespaceService {
  constructor(
    private db: Database,
    private worktreeService: {
      prune: (
        codespaceId: string
      ) => Promise<
        Result<
          { pruned: number; failed: Array<{ worktreeId: string; branch: string; error: string }> },
          CodespaceError
        >
      >;
    },
    private runner: CommandRunner
  ) {}

  private updateTimestamp(): string {
    return new Date().toISOString();
  }

  async create(input: CreateCodespaceInput): Promise<Result<Codespace, CodespaceError>> {
    const resolved = pathUtils.resolve(input.path);
    const validation = await this.validatePath(resolved);
    if (!validation.ok) {
      return validation;
    }

    const existing = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.path, resolved),
    });
    if (existing) {
      return err(CodespaceErrors.PATH_EXISTS);
    }

    const name = validation.value.name;
    const merged = deepMerge(DEFAULT_CODESPACE_CONFIG, input.config ?? {});
    const validated = this.validateConfig(merged);
    if (!validated.ok) {
      return validated;
    }

    const [codespace] = await this.db
      .insert(codespaces)
      .values({
        projectFolderId: input.projectFolderId,
        name,
        path: resolved,
        config: validated.value,
        maxConcurrentAgents: input.maxConcurrentAgents ?? 3,
        sandboxConfigId: input.sandboxConfigId,
        createdAt: this.updateTimestamp(),
        updatedAt: this.updateTimestamp(),
      })
      .returning();

    if (!codespace) {
      return err(CodespaceErrors.NOT_FOUND);
    }

    return ok(codespace);
  }

  async getById(id: string): Promise<Result<Codespace, CodespaceError>> {
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, id),
    });

    if (!codespace) {
      return err(CodespaceErrors.NOT_FOUND);
    }

    return ok(codespace);
  }

  async list(options?: ListCodespacesOptions): Promise<Result<Codespace[], CodespaceError>> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const orderBy = options?.orderBy ?? 'updatedAt';
    const direction = options?.orderDirection ?? 'desc';

    const orderColumn =
      orderBy === 'name'
        ? codespaces.name
        : orderBy === 'createdAt'
          ? codespaces.createdAt
          : codespaces.updatedAt;

    const whereClause = options?.projectFolderId
      ? eq(codespaces.projectFolderId, options.projectFolderId)
      : undefined;

    const items = await this.db.query.codespaces.findMany({
      where: whereClause,
      orderBy: (direction === 'asc' ? [orderColumn] : [desc(orderColumn)]) as never,
      limit,
      offset,
    });

    return ok(items);
  }

  async listWithSummaries(
    options?: ListCodespacesOptions
  ): Promise<Result<CodespaceSummary[], CodespaceError>> {
    const codespaceResult = await this.list(options);
    if (!codespaceResult.ok) {
      return codespaceResult;
    }

    const codespaceList = codespaceResult.value;
    const codespaceIds = codespaceList.map((c) => c.id);

    // Short-circuit: no codespaces means no summaries
    if (codespaceIds.length === 0) {
      return ok([]);
    }

    // Query 2: Get ALL tasks for ALL codespaces in one batch query (fixes N+1)
    const allTasks = await this.db.query.tasks.findMany({
      where: inArray(tasks.codespaceId, codespaceIds),
    });

    // Group tasks by codespaceId
    const tasksByCodespace = new Map<string, typeof allTasks>();
    for (const task of allTasks) {
      const existing = tasksByCodespace.get(task.codespaceId);
      if (existing) {
        existing.push(task);
      } else {
        tasksByCodespace.set(task.codespaceId, [task]);
      }
    }

    // Build a lookup map of task id -> title for agent task titles
    const taskTitleMap = new Map<string, string>();
    for (const task of allTasks) {
      taskTitleMap.set(task.id, task.title);
    }

    // Query 3: Get ALL active agents for ALL codespaces in one batch query (fixes N+1)
    const activeStatuses = ['starting', 'planning', 'running'] as const;
    const allActiveAgents = await this.db.query.agents.findMany({
      where: and(
        inArray(agents.codespaceId, codespaceIds),
        inArray(agents.status, [...activeStatuses])
      ),
    });

    // Group agents by codespaceId
    const agentsByCodespace = new Map<string, typeof allActiveAgents>();
    for (const agent of allActiveAgents) {
      const existing = agentsByCodespace.get(agent.codespaceId);
      if (existing) {
        existing.push(agent);
      } else {
        agentsByCodespace.set(agent.codespaceId, [agent]);
      }
    }

    const summaries: CodespaceSummary[] = codespaceList.map((codespace) => {
      const csTasks = tasksByCodespace.get(codespace.id) ?? [];

      // SL-010: Single-loop counting instead of 4x .filter().length
      const taskCounts = {
        backlog: 0,
        inProgress: 0,
        waitingApproval: 0,
        verified: 0,
        total: csTasks.length,
      };
      for (const t of csTasks) {
        switch (t.column) {
          case 'backlog':
            taskCounts.backlog++;
            break;
          case 'in_progress':
            taskCounts.inProgress++;
            break;
          case 'waiting_approval':
            taskCounts.waitingApproval++;
            break;
          case 'verified':
            taskCounts.verified++;
            break;
        }
      }

      const runningAgentsList = agentsByCodespace.get(codespace.id) ?? [];

      // Resolve task titles from the in-memory lookup map (no extra queries)
      const runningAgents = runningAgentsList.map((agent) => ({
        id: agent.id,
        name: agent.name ?? 'Agent',
        currentTaskId: agent.currentTaskId,
        currentTaskTitle: agent.currentTaskId ? taskTitleMap.get(agent.currentTaskId) : undefined,
      }));

      // Determine codespace status
      let status: CodespaceSummary['status'] = 'idle';
      if (runningAgents.length > 0) {
        status = 'running';
      } else if (taskCounts.waitingApproval > 0) {
        status = 'needs-approval';
      }

      // Get last activity date (updatedAt is an ISO string from SQLite)
      const lastTask = csTasks.sort((a, b) => {
        const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bTime - aTime;
      })[0];

      return {
        codespace,
        taskCounts,
        runningAgents,
        status,
        lastActivityAt: lastTask?.updatedAt ?? null,
      };
    });

    return ok(summaries);
  }

  async update(
    id: string,
    input: UpdateCodespaceInput
  ): Promise<Result<Codespace, CodespaceError>> {
    // For config merges, we need the existing codespace
    let existingConfig: Record<string, unknown> | null = null;
    if (input.config !== undefined) {
      const existing = await this.db.query.codespaces.findFirst({
        where: eq(codespaces.id, id),
      });
      if (!existing) {
        return err(CodespaceErrors.NOT_FOUND);
      }
      existingConfig = (existing.config as Record<string, unknown>) ?? {};
    }

    const updates: Partial<Codespace> = {};
    if (input.name !== undefined) {
      updates.name = input.name;
    }
    if (input.description !== undefined) {
      updates.description = input.description;
    }
    if (input.maxConcurrentAgents !== undefined) {
      updates.maxConcurrentAgents = input.maxConcurrentAgents;
    }
    if (input.configPath !== undefined) {
      updates.configPath = input.configPath;
    }
    if (input.githubOwner !== undefined) {
      updates.githubOwner = input.githubOwner;
    }
    if (input.githubRepo !== undefined) {
      updates.githubRepo = input.githubRepo;
    }
    if (input.config !== undefined && existingConfig !== null) {
      updates.config = { ...existingConfig, ...input.config } as Codespace['config'];
    }
    if (input.projectFolderId !== undefined) {
      updates.projectFolderId = input.projectFolderId;
    }

    const setPayload = { ...updates, updatedAt: this.updateTimestamp() };

    const [updated] = await this.db
      .update(codespaces)
      .set(setPayload)
      .where(eq(codespaces.id, id))
      .returning();

    if (!updated) {
      return err(CodespaceErrors.NOT_FOUND);
    }

    return ok(updated);
  }

  async delete(id: string): Promise<Result<void, CodespaceError>> {
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, id),
    });

    if (!codespace) {
      return err(CodespaceErrors.NOT_FOUND);
    }

    const running = await this.db.query.agents.findMany({
      where: and(eq(agents.codespaceId, id), eq(agents.status, 'running')),
    });
    const runningAgents = running;

    if (runningAgents.length > 0) {
      return err(CodespaceErrors.HAS_RUNNING_AGENTS(runningAgents.length));
    }

    await this.worktreeService.prune(id);

    // Explicitly delete session_events for this codespace's sessions, plans, and sandboxes
    // (no FK cascade — session_events stores events for multiple stream types)
    const codespaceSessionIds = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.codespaceId, id));

    // Plan and sandbox tables may not exist in all environments (pre-migration DBs)
    let codspacePlanIds: { id: string }[] = [];
    let codspaceSandboxIds: { id: string }[] = [];
    try {
      codspacePlanIds = await this.db
        .select({ id: planSessions.id })
        .from(planSessions)
        .where(eq(planSessions.codespaceId, id));
    } catch {
      // plan_sessions table may not exist yet
    }
    try {
      codspaceSandboxIds = await this.db
        .select({ id: sandboxInstances.id })
        .from(sandboxInstances)
        .where(eq(sandboxInstances.codespaceId, id));
    } catch {
      // sandbox_instances table may not exist yet
    }

    const eventSessionIds = [
      ...codespaceSessionIds.map((s) => s.id),
      ...codspacePlanIds.map((p) => `plan:${p.id}`),
      ...codspaceSandboxIds.map((s) => `sandbox:${s.id}`),
    ];
    if (eventSessionIds.length > 0) {
      await this.db.delete(sessionEvents).where(inArray(sessionEvents.sessionId, eventSessionIds));
    }

    // Memory data (insights, messages, skill metrics, etc.) cascade-deletes via FK on codespaceId
    await this.db.delete(codespaces).where(eq(codespaces.id, id));

    return ok(undefined);
  }

  async updateConfig(
    id: string,
    config: Partial<CodespaceConfig>
  ): Promise<Result<Codespace, CodespaceError>> {
    const validation = this.validateConfig(config);
    if (!validation.ok) {
      return validation;
    }

    const [updated] = await this.db
      .update(codespaces)
      .set({ config: validation.value, updatedAt: this.updateTimestamp() })
      .where(eq(codespaces.id, id))
      .returning();

    if (!updated) {
      return err(CodespaceErrors.NOT_FOUND);
    }

    return ok(updated);
  }

  async syncFromGitHub(id: string): Promise<Result<Codespace, CodespaceError>> {
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, id),
    });

    if (!codespace) {
      return err(CodespaceErrors.NOT_FOUND);
    }

    if (!codespace.githubOwner || !codespace.githubRepo) {
      return err(CodespaceErrors.CONFIG_INVALID(['Missing GitHub repository metadata']));
    }

    if (!codespace.githubInstallationId) {
      return err(CodespaceErrors.CONFIG_INVALID(['Missing GitHub App installation ID']));
    }

    try {
      // Get installation-scoped Octokit client
      const installation = await this.db.query.githubInstallations.findFirst({
        where: eq(githubInstallations.id, codespace.githubInstallationId),
      });

      if (!installation) {
        return err(CodespaceErrors.CONFIG_INVALID(['GitHub App installation not found']));
      }

      const octokit = await getInstallationOctokit(Number(installation.installationId));

      // Fetch config from GitHub
      const configResult = await syncConfigFromGitHub({
        octokit,
        owner: codespace.githubOwner,
        repo: codespace.githubRepo,
        configPath: codespace.configPath ?? '.claude',
      });

      if (!configResult.ok) {
        return err(CodespaceErrors.CONFIG_INVALID([configResult.error.message]));
      }

      // Validate the synced config
      const validation = this.validateConfig(configResult.value.config);
      if (!validation.ok) {
        return validation;
      }

      // Merge synced config with existing config
      const mergedConfig = deepMerge(codespace.config ?? {}, validation.value) as CodespaceConfig;

      // Update codespace with synced config
      const [updated] = await this.db
        .update(codespaces)
        .set({ config: mergedConfig, updatedAt: this.updateTimestamp() })
        .where(eq(codespaces.id, id))
        .returning();

      if (!updated) {
        return err(CodespaceErrors.NOT_FOUND);
      }

      return ok(updated);
    } catch (error) {
      return err(CodespaceErrors.CONFIG_INVALID([`GitHub sync failed: ${errorMessage(error)}`]));
    }
  }

  /**
   * Clone a repository from a URL to a local path
   * Note: In browser environment, this returns the expected path but doesn't actually clone
   */
  async cloneRepository(
    url: string,
    destinationDir: string
  ): Promise<Result<{ path: string; name: string }, CodespaceError>> {
    // Extract repo name from URL
    const repoName = url.split('/').pop()?.replace('.git', '') ?? 'repo';

    // Handle ~ expansion for browser (use /Users/user as fallback)
    const expandedDir = destinationDir.replace(/^~/, '/Users/user');
    const resolved = pathUtils.resolve(expandedDir);
    const targetPath = pathUtils.join(resolved, repoName);

    // Check if we're in a browser environment (no shell access)
    if (typeof window !== 'undefined' && !this.runner) {
      // In browser-only mode, we can't actually clone
      // Return the path info so the user can clone manually
      return ok({
        path: targetPath,
        name: repoName,
      });
    }

    try {
      // SC-C3: Validate inputs to prevent shell injection
      // Reject URLs/paths containing characters that could break out of double quotes
      if (/["\\\n\r\0$`!]/.test(url)) {
        return err(CodespaceErrors.CONFIG_INVALID(['Invalid characters in repository URL']));
      }
      if (/["\\\n\r\0$`!]/.test(resolved) || /["\\\n\r\0$`!]/.test(targetPath)) {
        return err(CodespaceErrors.CONFIG_INVALID(['Invalid characters in destination path']));
      }
      // SC-C2: Validate path traversal - resolved path must not escape via '..'
      if (resolved.includes('..') || targetPath.includes('..')) {
        return err(CodespaceErrors.CONFIG_INVALID(['Path traversal sequences not allowed']));
      }

      // Check if destination directory exists, create if not
      await this.runner.exec(`mkdir -p "${resolved}"`, '/tmp');

      // Check if target path already exists
      try {
        await this.runner.exec(`test -d "${targetPath}"`, '/tmp');
        return err(CodespaceErrors.PATH_EXISTS);
      } catch {
        // Directory doesn't exist, which is good
      }

      // Clone the repository
      await this.runner.exec(`git clone "${url}" "${targetPath}"`, resolved);

      return ok({
        path: targetPath,
        name: repoName,
      });
    } catch (error) {
      return err(
        CodespaceErrors.CONFIG_INVALID([`Failed to clone repository: ${errorMessage(error)}`])
      );
    }
  }

  async validatePath(codspacePath: string): Promise<Result<PathValidation, CodespaceError>> {
    const normalized = pathUtils.resolve(codspacePath);
    const name = pathUtils.basename(normalized);

    try {
      await this.runner.exec('git rev-parse --git-dir', normalized);
    } catch {
      return err(CodespaceErrors.NOT_A_GIT_REPO(normalized));
    }

    let remoteUrl: string | undefined;
    try {
      const remote = await this.runner.exec('git remote get-url origin', normalized);
      remoteUrl = remote.stdout.trim() || undefined;
    } catch (_error) {
      remoteUrl = undefined;
    }

    let defaultBranch = 'main';
    try {
      const branch = await this.runner.exec('git symbolic-ref --short HEAD', normalized);
      defaultBranch = branch.stdout.trim() || 'main';
    } catch (_error) {
      defaultBranch = 'main';
    }

    const claudeConfigResult = await this.runner
      .exec('test -d .claude && echo yes || echo no', normalized)
      .then((res) => ({
        detected: res.stdout.trim() === 'yes',
        error: undefined as string | undefined,
      }))
      .catch((error) => {
        return { detected: false, error: String(error) };
      });

    return ok({
      name,
      path: normalized,
      hasClaudeConfig: claudeConfigResult.detected,
      hasClaudeConfigError: claudeConfigResult.error,
      defaultBranch,
      remoteUrl,
    });
  }

  validateConfig(config: Partial<CodespaceConfig>): Result<CodespaceConfig, CodespaceError> {
    try {
      const validated = codespaceConfigSchema.parse(config);
      const secrets = containsSecrets(config as Record<string, unknown>);
      if (secrets.length > 0) {
        return err(CodespaceErrors.CONFIG_INVALID([`Secrets detected: ${secrets.join(', ')}`]));
      }
      return ok(validated);
    } catch (error) {
      return err(CodespaceErrors.CONFIG_INVALID([String(error)]));
    }
  }
}
