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
import type { Project, ProjectConfig } from '../db/schema';
import { agents, githubInstallations, projects, tasks } from '../db/schema';
import { projectConfigSchema } from '../lib/config/schemas.js';
import { DEFAULT_PROJECT_CONFIG } from '../lib/config/types.js';
import { containsSecrets } from '../lib/config/validate-secrets.js';
import type { ProjectError } from '../lib/errors/project-errors.js';
import { ProjectErrors } from '../lib/errors/project-errors.js';
import { getInstallationOctokit } from '../lib/github/client.js';
import { syncConfigFromGitHub } from '../lib/github/config-sync.js';
import { deepMerge } from '../lib/utils/deep-merge.js';
import { errorMessage } from '../lib/utils/error-message.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

export type CreateProjectInput = {
  path: string;
  name?: string;
  description?: string;
  config?: Partial<ProjectConfig>;
  maxConcurrentAgents?: number;
  sandboxConfigId?: string;
};

export type UpdateProjectInput = {
  name?: string;
  description?: string;
  maxConcurrentAgents?: number;
  configPath?: string;
  githubOwner?: string;
  githubRepo?: string;
  config?: Record<string, unknown>;
};

export type ListProjectsOptions = {
  limit?: number;
  offset?: number;
  orderBy?: 'name' | 'createdAt' | 'updatedAt';
  orderDirection?: 'asc' | 'desc';
};

export type PathValidation = {
  name: string;
  path: string;
  hasClaudeConfig: boolean;
  hasClaudeConfigError?: string;
  defaultBranch: string;
  remoteUrl?: string;
};

export type ProjectSummary = {
  project: Project;
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

export class ProjectService {
  constructor(
    private db: Database,
    private worktreeService: {
      prune: (
        projectId: string
      ) => Promise<
        Result<
          { pruned: number; failed: Array<{ worktreeId: string; branch: string; error: string }> },
          ProjectError
        >
      >;
    },
    private runner: CommandRunner
  ) {}

  private updateTimestamp(): string {
    return new Date().toISOString();
  }

  async create(input: CreateProjectInput): Promise<Result<Project, ProjectError>> {
    const resolved = pathUtils.resolve(input.path);
    const validation = await this.validatePath(resolved);
    if (!validation.ok) {
      return validation;
    }

    const existing = await this.db.query.projects.findFirst({
      where: eq(projects.path, resolved),
    });
    if (existing) {
      return err(ProjectErrors.PATH_EXISTS);
    }

    const name = validation.value.name;
    const merged = deepMerge(DEFAULT_PROJECT_CONFIG, input.config ?? {});
    const validated = this.validateConfig(merged);
    if (!validated.ok) {
      return validated;
    }

    const [project] = await this.db
      .insert(projects)
      .values({
        name,
        path: resolved,
        config: validated.value,
        maxConcurrentAgents: input.maxConcurrentAgents ?? 3,
        sandboxConfigId: input.sandboxConfigId,
        createdAt: this.updateTimestamp(),
        updatedAt: this.updateTimestamp(),
      })
      .returning();

    if (!project) {
      return err(ProjectErrors.NOT_FOUND);
    }

    return ok(project);
  }

  async getById(id: string): Promise<Result<Project, ProjectError>> {
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, id),
    });

    if (!project) {
      return err(ProjectErrors.NOT_FOUND);
    }

    return ok(project);
  }

  async list(options?: ListProjectsOptions): Promise<Result<Project[], ProjectError>> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const orderBy = options?.orderBy ?? 'updatedAt';
    const direction = options?.orderDirection ?? 'desc';

    const orderColumn =
      orderBy === 'name'
        ? projects.name
        : orderBy === 'createdAt'
          ? projects.createdAt
          : projects.updatedAt;

    const items = await this.db.query.projects.findMany({
      orderBy: (direction === 'asc' ? [orderColumn] : [desc(orderColumn)]) as never,
      limit,
      offset,
    });

    return ok(items);
  }

  async listWithSummaries(
    options?: ListProjectsOptions
  ): Promise<Result<ProjectSummary[], ProjectError>> {
    const projectsResult = await this.list(options);
    if (!projectsResult.ok) {
      return projectsResult;
    }

    const projectList = projectsResult.value;
    const projectIds = projectList.map((p) => p.id);

    // Short-circuit: no projects means no summaries
    if (projectIds.length === 0) {
      return ok([]);
    }

    // Query 2: Get ALL tasks for ALL projects in one batch query (fixes N+1)
    const allTasks = await this.db.query.tasks.findMany({
      where: inArray(tasks.projectId, projectIds),
    });

    // Group tasks by projectId
    const tasksByProject = new Map<string, typeof allTasks>();
    for (const task of allTasks) {
      const existing = tasksByProject.get(task.projectId);
      if (existing) {
        existing.push(task);
      } else {
        tasksByProject.set(task.projectId, [task]);
      }
    }

    // Build a lookup map of task id -> title for agent task titles
    const taskTitleMap = new Map<string, string>();
    for (const task of allTasks) {
      taskTitleMap.set(task.id, task.title);
    }

    // Query 3: Get ALL active agents for ALL projects in one batch query (fixes N+1)
    const activeStatuses = ['starting', 'planning', 'running'] as const;
    const allActiveAgents = await this.db.query.agents.findMany({
      where: and(
        inArray(agents.projectId, projectIds),
        inArray(agents.status, [...activeStatuses])
      ),
    });

    // Group agents by projectId
    const agentsByProject = new Map<string, typeof allActiveAgents>();
    for (const agent of allActiveAgents) {
      const existing = agentsByProject.get(agent.projectId);
      if (existing) {
        existing.push(agent);
      } else {
        agentsByProject.set(agent.projectId, [agent]);
      }
    }

    const summaries: ProjectSummary[] = projectList.map((project) => {
      const projectTasks = tasksByProject.get(project.id) ?? [];

      // SL-010: Single-loop counting instead of 4x .filter().length
      const taskCounts = {
        backlog: 0,
        inProgress: 0,
        waitingApproval: 0,
        verified: 0,
        total: projectTasks.length,
      };
      for (const t of projectTasks) {
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

      const runningAgentsList = agentsByProject.get(project.id) ?? [];

      // Resolve task titles from the in-memory lookup map (no extra queries)
      const runningAgents = runningAgentsList.map((agent) => ({
        id: agent.id,
        name: agent.name ?? 'Agent',
        currentTaskId: agent.currentTaskId,
        currentTaskTitle: agent.currentTaskId ? taskTitleMap.get(agent.currentTaskId) : undefined,
      }));

      // Determine project status
      let status: ProjectSummary['status'] = 'idle';
      if (runningAgents.length > 0) {
        status = 'running';
      } else if (taskCounts.waitingApproval > 0) {
        status = 'needs-approval';
      }

      // Get last activity date (updatedAt is an ISO string from SQLite)
      const lastTask = projectTasks.sort((a, b) => {
        const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bTime - aTime;
      })[0];

      return {
        project,
        taskCounts,
        runningAgents,
        status,
        lastActivityAt: lastTask?.updatedAt ?? null,
      };
    });

    return ok(summaries);
  }

  async update(id: string, input: UpdateProjectInput): Promise<Result<Project, ProjectError>> {
    // For config merges, we need the existing project
    let existingConfig: Record<string, unknown> | null = null;
    if (input.config !== undefined) {
      const existing = await this.db.query.projects.findFirst({
        where: eq(projects.id, id),
      });
      if (!existing) {
        return err(ProjectErrors.NOT_FOUND);
      }
      existingConfig = (existing.config as Record<string, unknown>) ?? {};
    }

    const updates: Partial<Project> = {};
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
      updates.config = { ...existingConfig, ...input.config } as Project['config'];
    }

    const [updated] = await this.db
      .update(projects)
      .set({ ...updates, updatedAt: this.updateTimestamp() })
      .where(eq(projects.id, id))
      .returning();

    if (!updated) {
      return err(ProjectErrors.NOT_FOUND);
    }

    return ok(updated);
  }

  async delete(id: string): Promise<Result<void, ProjectError>> {
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, id),
    });

    if (!project) {
      return err(ProjectErrors.NOT_FOUND);
    }

    const running = await this.db.query.agents.findMany({
      where: and(eq(agents.projectId, id), eq(agents.status, 'running')),
    });
    const runningAgents = running;

    if (runningAgents.length > 0) {
      return err(ProjectErrors.HAS_RUNNING_AGENTS(runningAgents.length));
    }

    await this.worktreeService.prune(id);
    await this.db.delete(projects).where(eq(projects.id, id));

    return ok(undefined);
  }

  async updateConfig(
    id: string,
    config: Partial<ProjectConfig>
  ): Promise<Result<Project, ProjectError>> {
    const validation = this.validateConfig(config);
    if (!validation.ok) {
      return validation;
    }

    const [updated] = await this.db
      .update(projects)
      .set({ config: validation.value, updatedAt: this.updateTimestamp() })
      .where(eq(projects.id, id))
      .returning();

    if (!updated) {
      return err(ProjectErrors.NOT_FOUND);
    }

    return ok(updated);
  }

  async syncFromGitHub(id: string): Promise<Result<Project, ProjectError>> {
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, id),
    });

    if (!project) {
      return err(ProjectErrors.NOT_FOUND);
    }

    if (!project.githubOwner || !project.githubRepo) {
      return err(ProjectErrors.CONFIG_INVALID(['Missing GitHub repository metadata']));
    }

    if (!project.githubInstallationId) {
      return err(ProjectErrors.CONFIG_INVALID(['Missing GitHub App installation ID']));
    }

    try {
      // Get installation-scoped Octokit client
      const installation = await this.db.query.githubInstallations.findFirst({
        where: eq(githubInstallations.id, project.githubInstallationId),
      });

      if (!installation) {
        return err(ProjectErrors.CONFIG_INVALID(['GitHub App installation not found']));
      }

      const octokit = await getInstallationOctokit(Number(installation.installationId));

      // Fetch config from GitHub
      const configResult = await syncConfigFromGitHub({
        octokit,
        owner: project.githubOwner,
        repo: project.githubRepo,
        configPath: project.configPath ?? '.claude',
      });

      if (!configResult.ok) {
        return err(ProjectErrors.CONFIG_INVALID([configResult.error.message]));
      }

      // Validate the synced config
      const validation = this.validateConfig(configResult.value.config);
      if (!validation.ok) {
        return validation;
      }

      // Merge synced config with existing config
      const mergedConfig = deepMerge(project.config ?? {}, validation.value) as ProjectConfig;

      // Update project with synced config
      const [updated] = await this.db
        .update(projects)
        .set({ config: mergedConfig, updatedAt: this.updateTimestamp() })
        .where(eq(projects.id, id))
        .returning();

      if (!updated) {
        return err(ProjectErrors.NOT_FOUND);
      }

      console.log(
        `[ProjectService] Synced config from GitHub for project ${id}: ${configResult.value.path} (sha: ${configResult.value.sha})`
      );

      return ok(updated);
    } catch (error) {
      console.error(`[ProjectService] GitHub sync failed for project ${id}:`, error);
      return err(ProjectErrors.CONFIG_INVALID([`GitHub sync failed: ${errorMessage(error)}`]));
    }
  }

  /**
   * Clone a repository from a URL to a local path
   * Note: In browser environment, this returns the expected path but doesn't actually clone
   */
  async cloneRepository(
    url: string,
    destinationDir: string
  ): Promise<Result<{ path: string; name: string }, ProjectError>> {
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
      // Check if destination directory exists, create if not
      await this.runner.exec(`mkdir -p "${resolved}"`, '/tmp');

      // Check if target path already exists
      try {
        await this.runner.exec(`test -d "${targetPath}"`, '/tmp');
        return err(ProjectErrors.PATH_EXISTS);
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
        ProjectErrors.CONFIG_INVALID([`Failed to clone repository: ${errorMessage(error)}`])
      );
    }
  }

  async validatePath(projectPath: string): Promise<Result<PathValidation, ProjectError>> {
    const normalized = pathUtils.resolve(projectPath);
    const name = pathUtils.basename(normalized);

    try {
      await this.runner.exec('git rev-parse --git-dir', normalized);
    } catch {
      return err(ProjectErrors.NOT_A_GIT_REPO(normalized));
    }

    let remoteUrl: string | undefined;
    try {
      const remote = await this.runner.exec('git remote get-url origin', normalized);
      remoteUrl = remote.stdout.trim() || undefined;
    } catch (error) {
      console.warn(`[ProjectService] Could not detect remote URL for ${normalized}:`, error);
      remoteUrl = undefined;
    }

    let defaultBranch = 'main';
    try {
      const branch = await this.runner.exec('git symbolic-ref --short HEAD', normalized);
      defaultBranch = branch.stdout.trim() || 'main';
    } catch (error) {
      console.warn(`[ProjectService] Could not detect default branch for ${normalized}:`, error);
      defaultBranch = 'main';
    }

    const claudeConfigResult = await this.runner
      .exec('test -d .claude && echo yes || echo no', normalized)
      .then((res) => ({
        detected: res.stdout.trim() === 'yes',
        error: undefined as string | undefined,
      }))
      .catch((error) => {
        console.warn(
          `[ProjectService] Could not detect .claude directory for ${normalized}:`,
          error
        );
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

  validateConfig(config: Partial<ProjectConfig>): Result<ProjectConfig, ProjectError> {
    try {
      const validated = projectConfigSchema.parse(config);
      const secrets = containsSecrets(config as Record<string, unknown>);
      if (secrets.length > 0) {
        return err(ProjectErrors.CONFIG_INVALID([`Secrets detected: ${secrets.join(', ')}`]));
      }
      return ok(validated);
    } catch (error) {
      return err(ProjectErrors.CONFIG_INVALID([String(error)]));
    }
  }
}
