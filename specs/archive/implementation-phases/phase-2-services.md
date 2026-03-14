# Phase 2: Services Layer

## Overview

**Duration:** Weeks 3-5
**Services:** 5
**Implementation Order:** WorktreeService → ProjectService → TaskService → SessionService → AgentService

---

## Service Dependency Graph

```
WorktreeService (no dependencies)
       ↓
ProjectService (depends on WorktreeService for config)
       ↓
TaskService (depends on WorktreeService)
       ↓
SessionService (depends on Durable Streams)
       ↓
AgentService (depends on ALL above + Claude SDK)
```

---

## 2.1 WorktreeService

**Location:** `services/worktree.service.ts`
**Dependencies:** Database, Bun shell
**Why First:** No service dependencies, foundation for all execution workflows

### Interface

```typescript
export interface IWorktreeService {
  // Lifecycle
  create(input: WorktreeCreateInput, options?: WorktreeSetupOptions): Promise<Result<Worktree, WorktreeError>>;
  remove(worktreeId: string, force?: boolean): Promise<Result<void, WorktreeError>>;
  prune(projectId: string): Promise<Result<number, WorktreeError>>;

  // Setup
  copyEnv(worktreeId: string): Promise<Result<void, WorktreeError>>;
  installDeps(worktreeId: string): Promise<Result<void, WorktreeError>>;
  runInitScript(worktreeId: string): Promise<Result<void, WorktreeError>>;

  // Git Operations
  commit(worktreeId: string, message: string): Promise<Result<string, WorktreeError>>;
  merge(worktreeId: string, targetBranch?: string): Promise<Result<void, WorktreeError>>;
  getDiff(worktreeId: string): Promise<Result<GitDiff, WorktreeError>>;

  // Status
  getStatus(worktreeId: string): Promise<Result<WorktreeStatusInfo, WorktreeError>>;
  list(projectId: string): Promise<Result<WorktreeStatusInfo[], never>>;
  getByBranch(projectId: string, branch: string): Promise<Result<Worktree | null, never>>;
}

export interface WorktreeCreateInput {
  projectId: string;
  taskId: string;
  baseBranch?: string; // Default: 'main'
}

export interface WorktreeSetupOptions {
  skipEnvCopy?: boolean;
  skipDepsInstall?: boolean;
  skipInitScript?: boolean;
}

export interface GitDiff {
  files: DiffFile[];
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}
```

### Implementation

```typescript
export class WorktreeService implements IWorktreeService {
  constructor(private db: Database) {}

  async create(input: WorktreeCreateInput, options?: WorktreeSetupOptions): Promise<Result<Worktree, WorktreeError>> {
    const { projectId, taskId, baseBranch = 'main' } = input;

    // 1. Get project
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project) return err(WorktreeErrors.PROJECT_NOT_FOUND(projectId));

    // 2. Generate branch name and path
    const branchId = createId();
    const branch = `agent/${branchId}/${taskId}`;
    const path = `${project.path}/${project.config?.worktreeRoot ?? '.worktrees'}/${sanitizePath(branch)}`;

    // 3. Check if branch already exists
    const existingBranch = await $`cd ${project.path} && git branch --list ${branch}`.text();
    if (existingBranch.trim()) {
      return err(WorktreeErrors.BRANCH_EXISTS(branch));
    }

    // 4. Create worktree
    try {
      await $`cd ${project.path} && git worktree add ${path} -b ${branch} ${baseBranch}`;
    } catch (error) {
      return err(WorktreeErrors.CREATION_FAILED(error));
    }

    // 5. Insert database record
    const [worktree] = await this.db.insert(worktrees).values({
      projectId,
      taskId,
      branch,
      path,
      baseBranch,
      status: 'creating',
    }).returning();

    // 6. Run setup steps
    if (!options?.skipEnvCopy) {
      const envResult = await this.copyEnv(worktree.id);
      if (!envResult.ok) console.warn('Env copy failed:', envResult.error);
    }

    if (!options?.skipDepsInstall) {
      const depsResult = await this.installDeps(worktree.id);
      if (!depsResult.ok) console.warn('Deps install failed:', depsResult.error);
    }

    if (!options?.skipInitScript && project.config?.initScript) {
      const initResult = await this.runInitScript(worktree.id);
      if (!initResult.ok) console.warn('Init script failed:', initResult.error);
    }

    // 7. Update status to active
    await this.db.update(worktrees)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(worktrees.id, worktree.id));

    // 8. Publish event
    await publishWorktreeEvent(worktree.id, { type: 'created', branch, path });

    return ok({ ...worktree, status: 'active' });
  }

  async remove(worktreeId: string, force = false): Promise<Result<void, WorktreeError>> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
      with: { project: true },
    });
    if (!worktree) return err(WorktreeErrors.NOT_FOUND(worktreeId));

    // Update status
    await this.db.update(worktrees)
      .set({ status: 'removing', updatedAt: new Date() })
      .where(eq(worktrees.id, worktreeId));

    try {
      // Remove worktree
      const forceFlag = force ? '--force' : '';
      await $`cd ${worktree.project.path} && git worktree remove ${worktree.path} ${forceFlag}`;

      // Delete branch
      await $`cd ${worktree.project.path} && git branch -D ${worktree.branch}`.nothrow();

      // Update database
      await this.db.update(worktrees)
        .set({ status: 'removed', removedAt: new Date(), updatedAt: new Date() })
        .where(eq(worktrees.id, worktreeId));

      return ok(undefined);
    } catch (error) {
      await this.db.update(worktrees)
        .set({ status: 'error', updatedAt: new Date() })
        .where(eq(worktrees.id, worktreeId));
      return err(WorktreeErrors.REMOVAL_FAILED(error));
    }
  }

  async merge(worktreeId: string, targetBranch?: string): Promise<Result<void, WorktreeError>> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
      with: { project: true },
    });
    if (!worktree) return err(WorktreeErrors.NOT_FOUND(worktreeId));

    const target = targetBranch ?? worktree.baseBranch;

    // Update status
    await this.db.update(worktrees)
      .set({ status: 'merging', updatedAt: new Date() })
      .where(eq(worktrees.id, worktreeId));

    try {
      // Switch to main worktree and merge
      await $`cd ${worktree.project.path} && git checkout ${target}`;
      await $`cd ${worktree.project.path} && git merge ${worktree.branch} --no-ff -m "Merge ${worktree.branch}"`;

      // Update database
      await this.db.update(worktrees)
        .set({ mergedAt: new Date(), updatedAt: new Date() })
        .where(eq(worktrees.id, worktreeId));

      return ok(undefined);
    } catch (error) {
      // Check for merge conflicts
      const status = await $`cd ${worktree.project.path} && git status --porcelain`.text();
      if (status.includes('UU ')) {
        await this.db.update(worktrees)
          .set({ status: 'conflict', updatedAt: new Date() })
          .where(eq(worktrees.id, worktreeId));
        return err(WorktreeErrors.MERGE_CONFLICT);
      }
      return err(WorktreeErrors.MERGE_FAILED(error));
    }
  }

  async getDiff(worktreeId: string): Promise<Result<GitDiff, WorktreeError>> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
    });
    if (!worktree) return err(WorktreeErrors.NOT_FOUND(worktreeId));

    try {
      const diffOutput = await $`cd ${worktree.path} && git diff ${worktree.baseBranch}...HEAD --stat`.text();
      const fullDiff = await $`cd ${worktree.path} && git diff ${worktree.baseBranch}...HEAD`.text();

      return ok(parseDiff(diffOutput, fullDiff));
    } catch (error) {
      return err(WorktreeErrors.DIFF_FAILED(error));
    }
  }

  async prune(projectId: string): Promise<Result<number, WorktreeError>> {
    const staleWorktrees = await this.db.query.worktrees.findMany({
      where: and(
        eq(worktrees.projectId, projectId),
        eq(worktrees.status, 'active'),
        lt(worktrees.updatedAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) // 7 days
      ),
    });

    let pruned = 0;
    for (const worktree of staleWorktrees) {
      const result = await this.remove(worktree.id, true);
      if (result.ok) pruned++;
    }

    return ok(pruned);
  }

  async copyEnv(worktreeId: string): Promise<Result<void, WorktreeError>> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
      with: { project: true },
    });
    if (!worktree) return err(WorktreeErrors.NOT_FOUND(worktreeId));

    const envFile = worktree.project.config?.envFile ?? '.env';
    const sourcePath = `${worktree.project.path}/${envFile}`;
    const targetPath = `${worktree.path}/${envFile}`;

    try {
      await $`cp ${sourcePath} ${targetPath}`;
      return ok(undefined);
    } catch {
      return err(WorktreeErrors.ENV_COPY_FAILED);
    }
  }

  async installDeps(worktreeId: string): Promise<Result<void, WorktreeError>> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
    });
    if (!worktree) return err(WorktreeErrors.NOT_FOUND(worktreeId));

    try {
      await $`cd ${worktree.path} && bun install`;
      return ok(undefined);
    } catch (error) {
      return err(WorktreeErrors.DEPS_INSTALL_FAILED(error));
    }
  }

  async runInitScript(worktreeId: string): Promise<Result<void, WorktreeError>> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
      with: { project: true },
    });
    if (!worktree) return err(WorktreeErrors.NOT_FOUND(worktreeId));

    const initScript = worktree.project.config?.initScript;
    if (!initScript) return ok(undefined);

    try {
      await $`cd ${worktree.path} && ${initScript}`;
      return ok(undefined);
    } catch (error) {
      return err(WorktreeErrors.INIT_SCRIPT_FAILED(error));
    }
  }
}
```

**Spec Reference:** `/specs/application/services/worktree-service.md`, `/specs/application/integrations/git-worktrees.md`

---

## 2.2 ProjectService

**Location:** `services/project.service.ts`
**Dependencies:** WorktreeService, GitHub (optional)

### Interface

```typescript
export interface IProjectService {
  create(input: CreateProjectInput): Promise<Result<Project, ProjectError>>;
  getById(id: string): Promise<Result<Project, ProjectError>>;
  list(options?: ListProjectsOptions): Promise<Result<PaginatedResult<Project>, ProjectError>>;
  update(id: string, input: UpdateProjectInput): Promise<Result<Project, ProjectError>>;
  delete(id: string): Promise<Result<void, ProjectError>>;
  updateConfig(id: string, config: Partial<ProjectConfig>): Promise<Result<Project, ProjectError>>;
  syncFromGitHub(id: string): Promise<Result<Project, ProjectError>>;
  validatePath(path: string): Promise<Result<PathValidation, ProjectError>>;
  validateConfig(config: Partial<ProjectConfig>): Result<ProjectConfig, ProjectError>;
}

export interface CreateProjectInput {
  path: string;
  name?: string; // Derived from directory name if not provided
  description?: string;
  config?: Partial<ProjectConfig>;
}

export interface ListProjectsOptions {
  cursor?: string;
  limit?: number;
  search?: string;
  sort?: 'updatedAt' | 'createdAt' | 'name';
  order?: 'asc' | 'desc';
}

export interface PathValidation {
  exists: boolean;
  isGitRepo: boolean;
  hasRemote: boolean;
  remoteUrl?: string;
  defaultBranch?: string;
}
```

### Implementation

```typescript
export class ProjectService implements IProjectService {
  constructor(
    private db: Database,
    private worktreeService: IWorktreeService
  ) {}

  async create(input: CreateProjectInput): Promise<Result<Project, ProjectError>> {
    const { path: projectPath, description, config } = input;

    // 1. Validate path
    const validation = await this.validatePath(projectPath);
    if (!validation.ok) return validation;
    if (!validation.value.isGitRepo) {
      return err(ProjectErrors.PATH_INVALID(projectPath));
    }

    // 2. Check for duplicate
    const existing = await this.db.query.projects.findFirst({
      where: eq(projects.path, projectPath),
    });
    if (existing) return err(ProjectErrors.PATH_EXISTS(projectPath));

    // 3. Derive name from directory
    const name = input.name ?? path.basename(projectPath);

    // 4. Merge config with defaults
    const mergedConfig = deepMerge(DEFAULT_PROJECT_CONFIG, config ?? {});
    const configValidation = this.validateConfig(mergedConfig);
    if (!configValidation.ok) return configValidation;

    // 5. Detect GitHub info from remote
    let githubOwner: string | undefined;
    let githubRepo: string | undefined;
    if (validation.value.remoteUrl) {
      const match = validation.value.remoteUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
      if (match) {
        githubOwner = match[1];
        githubRepo = match[2];
      }
    }

    // 6. Insert project
    const [project] = await this.db.insert(projects).values({
      name,
      path: projectPath,
      description,
      config: configValidation.value,
      githubOwner,
      githubRepo,
    }).returning();

    return ok(project);
  }

  async delete(id: string): Promise<Result<void, ProjectError>> {
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: { agents: true },
    });
    if (!project) return err(ProjectErrors.NOT_FOUND(id));

    // Check for running agents
    const runningAgents = project.agents.filter(a => a.status === 'running');
    if (runningAgents.length > 0) {
      return err(ProjectErrors.HAS_RUNNING_AGENTS(runningAgents.length));
    }

    // Prune all worktrees
    await this.worktreeService.prune(id);

    // Delete project (cascades to tasks, agents, sessions)
    await this.db.delete(projects).where(eq(projects.id, id));

    return ok(undefined);
  }

  async validatePath(projectPath: string): Promise<Result<PathValidation, ProjectError>> {
    const validation: PathValidation = {
      exists: false,
      isGitRepo: false,
      hasRemote: false,
    };

    // Check if path exists
    try {
      const stat = await Bun.file(projectPath).exists();
      validation.exists = stat;
    } catch {
      return ok(validation);
    }

    // Check if it's a git repo
    try {
      await $`cd ${projectPath} && git rev-parse --git-dir`;
      validation.isGitRepo = true;
    } catch {
      return ok(validation);
    }

    // Get remote URL
    try {
      const remote = await $`cd ${projectPath} && git remote get-url origin`.text();
      validation.hasRemote = true;
      validation.remoteUrl = remote.trim();
    } catch {
      // No remote is OK
    }

    // Get default branch
    try {
      const branch = await $`cd ${projectPath} && git symbolic-ref --short HEAD`.text();
      validation.defaultBranch = branch.trim();
    } catch {
      validation.defaultBranch = 'main';
    }

    return ok(validation);
  }

  validateConfig(config: Partial<ProjectConfig>): Result<ProjectConfig, ProjectError> {
    try {
      const validated = projectConfigSchema.parse(config);

      // Check for secrets
      const secrets = containsSecrets(config as Record<string, unknown>);
      if (secrets.length > 0) {
        return err(ProjectErrors.CONFIG_INVALID([`Secrets detected: ${secrets.join(', ')}`]));
      }

      return ok(validated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return err(ProjectErrors.CONFIG_INVALID(error.errors.map(e => e.message)));
      }
      throw error;
    }
  }

  async syncFromGitHub(id: string): Promise<Result<Project, ProjectError>> {
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, id),
    });
    if (!project) return err(ProjectErrors.NOT_FOUND(id));
    if (!project.githubOwner || !project.githubRepo) {
      return err(GitHubErrors.REPO_NOT_FOUND);
    }

    // Fetch config from GitHub
    const configResult = await fetchGitHubConfig(
      project.githubOwner,
      project.githubRepo,
      '.claude/settings.json'
    );
    if (!configResult.ok) return configResult;

    // Validate and merge config
    const validationResult = this.validateConfig(configResult.value);
    if (!validationResult.ok) return validationResult;

    // Update project
    const [updated] = await this.db.update(projects)
      .set({ config: validationResult.value, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    return ok(updated);
  }
}
```

**Spec Reference:** `/specs/application/services/project-service.md`

---

## 2.3 TaskService

**Location:** `services/task.service.ts`
**Dependencies:** WorktreeService

### Interface

```typescript
export interface ITaskService {
  create(input: CreateTaskInput): Promise<Result<Task, TaskError>>;
  getById(id: string): Promise<Result<Task, TaskError>>;
  list(projectId: string, options?: ListTasksOptions): Promise<Result<PaginatedResult<Task>, TaskError>>;
  update(id: string, input: UpdateTaskInput): Promise<Result<Task, TaskError>>;
  delete(id: string): Promise<Result<void, TaskError>>;
  moveColumn(id: string, column: TaskColumn, position?: number): Promise<Result<Task, TaskError>>;
  reorder(id: string, position: number): Promise<Result<Task, TaskError>>;
  getByColumn(projectId: string, column: TaskColumn): Promise<Result<Task[], TaskError>>;
  approve(id: string, input: ApproveInput): Promise<Result<Task, TaskError>>;
  reject(id: string, input: RejectInput): Promise<Result<Task, TaskError>>;
  getDiff(id: string): Promise<Result<DiffResult, TaskError>>;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  labels?: string[];
}

export interface ApproveInput {
  approvedBy?: string;
  createMergeCommit?: boolean;
}

export interface RejectInput {
  reason: string;
}

const VALID_TRANSITIONS: Record<TaskColumn, TaskColumn[]> = {
  backlog: ['in_progress'],
  in_progress: ['waiting_approval', 'backlog'],
  waiting_approval: ['verified', 'in_progress'],
  verified: [],
};
```

### Implementation

```typescript
export class TaskService implements ITaskService {
  constructor(
    private db: Database,
    private worktreeService: IWorktreeService
  ) {}

  async create(input: CreateTaskInput): Promise<Result<Task, TaskError>> {
    const { projectId, title, description, labels = [] } = input;

    // Validate project exists
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project) return err(ProjectErrors.NOT_FOUND(projectId));

    // Get next position in backlog
    const lastTask = await this.db.query.tasks.findFirst({
      where: and(eq(tasks.projectId, projectId), eq(tasks.column, 'backlog')),
      orderBy: desc(tasks.position),
    });
    const position = (lastTask?.position ?? -1) + 1;

    // Create task
    const [task] = await this.db.insert(tasks).values({
      projectId,
      title,
      description,
      labels,
      column: 'backlog',
      position,
    }).returning();

    return ok(task);
  }

  async moveColumn(id: string, column: TaskColumn, position?: number): Promise<Result<Task, TaskError>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, id),
    });
    if (!task) return err(TaskErrors.NOT_FOUND(id));

    // Validate transition
    const validTargets = VALID_TRANSITIONS[task.column];
    if (!validTargets.includes(column)) {
      return err(TaskErrors.INVALID_TRANSITION(task.column, column));
    }

    // Handle position
    let newPosition = position;
    if (newPosition === undefined) {
      const lastInColumn = await this.db.query.tasks.findFirst({
        where: and(eq(tasks.projectId, task.projectId), eq(tasks.column, column)),
        orderBy: desc(tasks.position),
      });
      newPosition = (lastInColumn?.position ?? -1) + 1;
    }

    // Update task
    const [updated] = await this.db.update(tasks)
      .set({
        column,
        position: newPosition,
        updatedAt: new Date(),
        ...(column === 'in_progress' ? { startedAt: new Date() } : {}),
        ...(column === 'verified' ? { completedAt: new Date() } : {}),
      })
      .where(eq(tasks.id, id))
      .returning();

    // Publish event
    await publishTaskEvent(id, { type: 'moved', from: task.column, to: column });

    return ok(updated);
  }

  async approve(id: string, input: ApproveInput): Promise<Result<Task, TaskError>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      with: { worktree: true },
    });
    if (!task) return err(TaskErrors.NOT_FOUND(id));
    if (task.column !== 'waiting_approval') {
      return err(TaskErrors.NOT_WAITING_APPROVAL(task.column));
    }
    if (task.approvedAt) {
      return err(TaskErrors.ALREADY_APPROVED);
    }

    // Check if there's a diff
    if (!task.worktree) {
      return err(TaskErrors.NO_DIFF);
    }
    const diff = await this.worktreeService.getDiff(task.worktree.id);
    if (!diff.ok) return diff;
    if (diff.value.stats.filesChanged === 0) {
      return err(TaskErrors.NO_DIFF);
    }

    // Merge if requested
    if (input.createMergeCommit !== false) {
      const mergeResult = await this.worktreeService.merge(task.worktree.id);
      if (!mergeResult.ok) return mergeResult;
    }

    // Update task
    const [updated] = await this.db.update(tasks)
      .set({
        column: 'verified',
        approvedAt: new Date(),
        approvedBy: input.approvedBy,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id))
      .returning();

    // Cleanup worktree
    await this.worktreeService.remove(task.worktree.id);

    // Publish event
    await publishTaskEvent(id, { type: 'approved' });

    return ok(updated);
  }

  async reject(id: string, input: RejectInput): Promise<Result<Task, TaskError>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, id),
    });
    if (!task) return err(TaskErrors.NOT_FOUND(id));
    if (task.column !== 'waiting_approval') {
      return err(TaskErrors.NOT_WAITING_APPROVAL(task.column));
    }

    // Validate reason
    if (!input.reason || input.reason.length < 1 || input.reason.length > 1000) {
      return err(ValidationErrors.INVALID_FIELD('reason', '1-1000 characters required'));
    }

    // Update task
    const [updated] = await this.db.update(tasks)
      .set({
        column: 'in_progress',
        rejectionCount: (task.rejectionCount ?? 0) + 1,
        rejectionReason: input.reason,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id))
      .returning();

    // Publish event to resume agent
    await publishTaskEvent(id, { type: 'rejected', reason: input.reason });

    return ok(updated);
  }
}
```

**Spec Reference:** `/specs/application/services/task-service.md`

---

## 2.4 SessionService

**Location:** `services/session.service.ts`
**Dependencies:** Durable Streams

### Interface

```typescript
export interface ISessionService {
  create(input: CreateSessionInput): Promise<Result<Session, SessionError>>;
  getById(id: string): Promise<Result<Session, SessionError>>;
  list(options: ListSessionsOptions): Promise<Result<PaginatedResult<Session>, SessionError>>;
  close(id: string): Promise<Result<Session, SessionError>>;
  join(sessionId: string, userId: string): Promise<Result<SessionWithPresence, SessionError>>;
  leave(sessionId: string, userId: string): Promise<Result<Session, SessionError>>;
  updatePresence(sessionId: string, userId: string, presence: PresenceUpdate): Promise<Result<void, SessionError>>;
  getActiveUsers(sessionId: string): Promise<Result<ActiveUser[], SessionError>>;
  publish(sessionId: string, event: SessionEvent): Promise<Result<void, SessionError>>;
  subscribe(sessionId: string, options?: SubscribeOptions): AsyncIterable<SessionEvent>;
  getHistory(sessionId: string, options?: HistoryOptions): Promise<Result<SessionEvent[], SessionError>>;
  generateUrl(sessionId: string): string;
  parseUrl(url: string): Result<string, ValidationError>;
}

export interface CreateSessionInput {
  projectId: string;
  taskId?: string;
  agentId?: string;
  title?: string;
}

export interface SessionEvent {
  id: string;
  type: SessionEventType;
  timestamp: number;
  data: unknown;
}

export type SessionEventType =
  | 'chunk'
  | 'tool:start'
  | 'tool:result'
  | 'presence:joined'
  | 'presence:left'
  | 'presence:cursor'
  | 'terminal:input'
  | 'terminal:output'
  | 'approval:requested'
  | 'approval:approved'
  | 'approval:rejected'
  | 'state:update';
```

### Durable Streams Schema

```typescript
import { createStateSchema, stateArray, stateMap, stateValue } from '@durable-streams/state';

export const sessionSchema = createStateSchema({
  chunks: stateArray<{
    id: string;
    agentId: string;
    text: string;
    timestamp: number;
  }>(),
  toolCalls: stateArray<{
    id: string;
    agentId: string;
    tool: string;
    input: unknown;
    output?: unknown;
    status: 'pending' | 'running' | 'complete' | 'error';
    timestamp: number;
  }>(),
  presence: stateMap<{
    userId: string;
    name: string;
    color: string;
    cursor?: { x: number; y: number };
    lastSeen: number;
  }>(),
  terminal: stateArray<{
    id: string;
    type: 'input' | 'output';
    source: 'user' | 'agent';
    data: string;
    timestamp: number;
  }>(),
  workflow: stateValue<{
    state: 'active' | 'paused' | 'completed';
    currentStep?: string;
    pendingApproval?: string;
  }>(),
  agentState: stateValue<{
    status: AgentStatus;
    turn: number;
    maxTurns: number;
    progress: number;
    currentTool?: string;
  }>(),
});
```

### Implementation

```typescript
export class SessionService implements ISessionService {
  private streams: DurableStreamsServer;
  private presenceStore: Map<string, Map<string, PresenceData>> = new Map();

  constructor(
    private db: Database,
    streams: DurableStreamsServer
  ) {
    this.streams = streams;
  }

  async create(input: CreateSessionInput): Promise<Result<Session, SessionError>> {
    const { projectId, taskId, agentId, title } = input;

    // Validate project
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project) return err(ProjectErrors.NOT_FOUND(projectId));

    // Generate URL-safe session ID
    const sessionId = createId();
    const url = this.generateUrl(sessionId);

    // Create session
    const [session] = await this.db.insert(sessions).values({
      id: sessionId,
      projectId,
      taskId,
      agentId,
      title,
      url,
      status: 'initializing',
    }).returning();

    // Initialize presence store
    this.presenceStore.set(sessionId, new Map());

    // Initialize Durable Stream
    await this.streams.createStream(sessionId, sessionSchema);

    // Update status
    await this.db.update(sessions)
      .set({ status: 'active' })
      .where(eq(sessions.id, sessionId));

    return ok({ ...session, status: 'active' });
  }

  async join(sessionId: string, userId: string): Promise<Result<SessionWithPresence, SessionError>> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });
    if (!session) return err(SessionErrors.NOT_FOUND(sessionId));
    if (session.status === 'closed') return err(SessionErrors.CLOSED);

    // Add to presence
    const presenceMap = this.presenceStore.get(sessionId) ?? new Map();
    presenceMap.set(userId, {
      userId,
      name: `User ${userId.slice(0, 4)}`,
      color: generateUserColor(userId),
      lastSeen: Date.now(),
    });
    this.presenceStore.set(sessionId, presenceMap);

    // Publish join event
    await this.publish(sessionId, {
      id: createId(),
      type: 'presence:joined',
      timestamp: Date.now(),
      data: { userId },
    });

    return ok({
      ...session,
      presence: Array.from(presenceMap.values()),
    });
  }

  async publish(sessionId: string, event: SessionEvent): Promise<Result<void, SessionError>> {
    try {
      await this.streams.publish(sessionId, event.type, event.data);
      return ok(undefined);
    } catch (error) {
      return err(SessionErrors.SYNC_FAILED(error));
    }
  }

  async *subscribe(sessionId: string, options?: SubscribeOptions): AsyncIterable<SessionEvent> {
    const startTime = options?.startTime ?? Date.now() - 60000; // Last minute by default

    // Get historical events first
    if (options?.includeHistory !== false) {
      const history = await this.getHistory(sessionId, { startTime });
      if (history.ok) {
        for (const event of history.value) {
          yield event;
        }
      }
    }

    // Subscribe to live events
    const subscription = this.streams.subscribe(sessionId);
    for await (const event of subscription) {
      yield {
        id: createId(),
        type: event.type as SessionEventType,
        timestamp: Date.now(),
        data: event.data,
      };
    }
  }

  generateUrl(sessionId: string): string {
    const baseUrl = process.env.APP_URL ?? 'http://localhost:5173';
    return `${baseUrl}/sessions/${sessionId}`;
  }

  parseUrl(url: string): Result<string, ValidationError> {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/sessions\/([a-z0-9]+)$/i);
      if (!match) {
        return err(ValidationErrors.INVALID_URL(url));
      }
      return ok(match[1]);
    } catch {
      return err(ValidationErrors.INVALID_URL(url));
    }
  }
}
```

**Spec Reference:** `/specs/application/services/session-service.md`, `/specs/application/integrations/durable-sessions.md`

---

## 2.5 AgentService

**Location:** `services/agent.service.ts`
**Dependencies:** WorktreeService, TaskService, SessionService, Claude Agent SDK

### Interface

```typescript
export interface IAgentService {
  create(input: NewAgent): Promise<Result<Agent, ValidationError>>;
  getById(id: string): Promise<Result<Agent, AgentError>>;
  list(projectId: string, filter?: { status?: AgentStatus }): Promise<Result<Agent[], never>>;
  update(id: string, input: Partial<AgentConfig>): Promise<Result<Agent, AgentError>>;
  delete(id: string): Promise<Result<void, AgentError>>;
  start(agentId: string, taskId: string): Promise<Result<AgentRunResult, AgentError>>;
  stop(agentId: string): Promise<Result<void, AgentError>>;
  pause(agentId: string): Promise<Result<void, AgentError>>;
  resume(agentId: string, feedback?: string): Promise<Result<AgentRunResult, AgentError>>;
  checkAvailability(projectId: string): Promise<Result<boolean, never>>;
  queueTask(projectId: string, taskId: string): Promise<Result<QueuePosition, ConcurrencyError>>;
  getRunningCount(projectId: string): Promise<Result<number, never>>;
  getQueuedTasks(projectId: string): Promise<Result<QueuePosition[], never>>;
  registerPreToolUseHook(agentId: string, hook: PreToolUseHook): void;
  registerPostToolUseHook(agentId: string, hook: PostToolUseHook): void;
}

export interface AgentRunResult {
  agentId: string;
  taskId: string;
  sessionId: string;
  status: 'completed' | 'paused' | 'error';
  turnsUsed: number;
  tokensUsed: number;
}

export type PreToolUseHook = (input: {
  tool_name: string;
  tool_input: unknown;
}) => Promise<{ deny?: boolean; reason?: string } | void>;

export type PostToolUseHook = (input: {
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
}) => Promise<void>;
```

### Implementation

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

export class AgentService implements IAgentService {
  private preToolHooks: Map<string, PreToolUseHook[]> = new Map();
  private postToolHooks: Map<string, PostToolUseHook[]> = new Map();
  private runningAgents: Map<string, AbortController> = new Map();

  constructor(
    private db: Database,
    private worktreeService: IWorktreeService,
    private taskService: ITaskService,
    private sessionService: ISessionService
  ) {}

  async start(agentId: string, taskId: string): Promise<Result<AgentRunResult, AgentError>> {
    // 1. Validate agent
    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, agentId),
      with: { project: true },
    });
    if (!agent) return err(AgentErrors.NOT_FOUND(agentId));
    if (agent.status !== 'idle') return err(AgentErrors.ALREADY_RUNNING);

    // 2. Validate task
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });
    if (!task) return err(TaskErrors.NOT_FOUND(taskId));
    if (task.column !== 'backlog') return err(TaskErrors.NOT_IN_COLUMN('backlog'));

    // 3. Check concurrency
    const available = await this.checkAvailability(agent.projectId);
    if (!available.value) {
      return err(ConcurrencyErrors.LIMIT_EXCEEDED);
    }

    // 4. Create worktree
    const worktreeResult = await this.worktreeService.create({
      projectId: agent.projectId,
      taskId,
    });
    if (!worktreeResult.ok) return worktreeResult;
    const worktree = worktreeResult.value;

    // 5. Create session
    const sessionResult = await this.sessionService.create({
      projectId: agent.projectId,
      taskId,
      agentId,
      title: task.title,
    });
    if (!sessionResult.ok) return sessionResult;
    const session = sessionResult.value;

    // 6. Update task
    await this.db.update(tasks).set({
      column: 'in_progress',
      agentId,
      sessionId: session.id,
      worktreeId: worktree.id,
      branch: worktree.branch,
      startedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(tasks.id, taskId));

    // 7. Update agent
    await this.db.update(agents).set({
      status: 'starting',
      currentTaskId: taskId,
      currentSessionId: session.id,
      currentTurn: 0,
      updatedAt: new Date(),
    }).where(eq(agents.id, agentId));

    // 8. Create agent run record
    const [agentRun] = await this.db.insert(agentRuns).values({
      agentId,
      taskId,
      projectId: agent.projectId,
      sessionId: session.id,
      status: 'running',
    }).returning();

    // 9. Execute agent
    const abortController = new AbortController();
    this.runningAgents.set(agentId, abortController);

    try {
      await this.db.update(agents).set({ status: 'running' }).where(eq(agents.id, agentId));

      const result = await this.executeAgent(agentId, task, worktree, session, abortController.signal);

      // Update final status
      await this.db.update(agentRuns).set({
        status: result.status === 'completed' ? 'completed' : result.status,
        completedAt: new Date(),
        turnsUsed: result.turnsUsed,
        tokensUsed: result.tokensUsed,
      }).where(eq(agentRuns.id, agentRun.id));

      return ok(result);
    } catch (error) {
      await this.db.update(agents).set({ status: 'error' }).where(eq(agents.id, agentId));
      await this.db.update(agentRuns).set({
        status: 'error',
        completedAt: new Date(),
        errorMessage: String(error),
      }).where(eq(agentRuns.id, agentRun.id));

      return err(AgentErrors.EXECUTION_ERROR(error));
    } finally {
      this.runningAgents.delete(agentId);
    }
  }

  private async executeAgent(
    agentId: string,
    task: Task,
    worktree: Worktree,
    session: Session,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });
    if (!agent) throw new Error('Agent not found');

    const config = agent.config ?? DEFAULT_AGENT_CONFIG;
    let turnsUsed = 0;
    let tokensUsed = 0;

    // Build hooks
    const hooks = this.buildHooks(agentId, session.id);

    // Execute with Claude SDK
    for await (const message of query({
      prompt: task.description ?? task.title,
      options: {
        allowedTools: config.allowedTools,
        model: config.model ?? 'claude-sonnet-4-6',
        maxTurns: config.maxTurns ?? 50,
        cwd: worktree.path,
        hooks,
        signal,
      },
    })) {
      // Handle different message types
      if (message.type === 'turn_complete') {
        turnsUsed++;
        await this.db.update(agents)
          .set({ currentTurn: turnsUsed })
          .where(eq(agents.id, agentId));

        // Publish state update
        await this.sessionService.publish(session.id, {
          id: createId(),
          type: 'state:update',
          timestamp: Date.now(),
          data: { turn: turnsUsed, maxTurns: config.maxTurns },
        });
      }

      if (message.type === 'stream_event' && message.event?.usage) {
        tokensUsed += message.event.usage.input_tokens + message.event.usage.output_tokens;
      }

      if (message.type === 'text') {
        await this.sessionService.publish(session.id, {
          id: createId(),
          type: 'chunk',
          timestamp: Date.now(),
          data: { agentId, text: message.text },
        });
      }
    }

    // Task completed - move to waiting_approval
    await this.db.update(tasks).set({
      column: 'waiting_approval',
      updatedAt: new Date(),
    }).where(eq(tasks.id, task.id));

    await this.db.update(agents).set({
      status: 'idle',
      currentTaskId: null,
      currentSessionId: null,
      currentTurn: 0,
      updatedAt: new Date(),
    }).where(eq(agents.id, agentId));

    return {
      agentId,
      taskId: task.id,
      sessionId: session.id,
      status: 'completed',
      turnsUsed,
      tokensUsed,
    };
  }

  private buildHooks(agentId: string, sessionId: string) {
    return {
      PreToolUse: [{
        hooks: [async (input: { tool_name: string; tool_input: unknown }) => {
          // Check tool whitelist (handled by SDK, but log it)
          await this.sessionService.publish(sessionId, {
            id: createId(),
            type: 'tool:start',
            timestamp: Date.now(),
            data: { tool: input.tool_name, input: input.tool_input },
          });

          // Run custom hooks
          const customHooks = this.preToolHooks.get(agentId) ?? [];
          for (const hook of customHooks) {
            const result = await hook(input);
            if (result?.deny) {
              return { deny: true, reason: result.reason };
            }
          }

          return {};
        }],
      }],
      PostToolUse: [{
        hooks: [async (input: { tool_name: string; tool_input: unknown; tool_response: unknown }) => {
          // Log to audit trail
          await this.db.insert(auditLogs).values({
            agentId,
            tool: input.tool_name,
            status: 'complete',
            input: input.tool_input,
            output: input.tool_response,
          });

          // Publish to session
          await this.sessionService.publish(sessionId, {
            id: createId(),
            type: 'tool:result',
            timestamp: Date.now(),
            data: {
              tool: input.tool_name,
              input: input.tool_input,
              output: input.tool_response,
            },
          });

          // Run custom hooks
          const customHooks = this.postToolHooks.get(agentId) ?? [];
          for (const hook of customHooks) {
            await hook(input);
          }
        }],
      }],
    };
  }

  async stop(agentId: string): Promise<Result<void, AgentError>> {
    const controller = this.runningAgents.get(agentId);
    if (!controller) return err(AgentErrors.NOT_RUNNING);

    controller.abort();
    await this.db.update(agents).set({
      status: 'idle',
      currentTaskId: null,
      currentSessionId: null,
      updatedAt: new Date(),
    }).where(eq(agents.id, agentId));

    return ok(undefined);
  }

  async checkAvailability(projectId: string): Promise<Result<boolean, never>> {
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project) return ok(false);

    const runningCount = await this.getRunningCount(projectId);
    const maxConcurrent = project.maxConcurrentAgents ?? 3;

    return ok(runningCount.value < maxConcurrent);
  }

  async getRunningCount(projectId: string): Promise<Result<number, never>> {
    const running = await this.db.query.agents.findMany({
      where: and(
        eq(agents.projectId, projectId),
        eq(agents.status, 'running')
      ),
    });
    return ok(running.length);
  }

  registerPreToolUseHook(agentId: string, hook: PreToolUseHook): void {
    const hooks = this.preToolHooks.get(agentId) ?? [];
    hooks.push(hook);
    this.preToolHooks.set(agentId, hooks);
  }

  registerPostToolUseHook(agentId: string, hook: PostToolUseHook): void {
    const hooks = this.postToolHooks.get(agentId) ?? [];
    hooks.push(hook);
    this.postToolHooks.set(agentId, hooks);
  }
}
```

**Spec Reference:** `/specs/application/services/agent-service.md`, `/specs/application/integrations/claude-agent-sdk.md`

---

## File Structure

```
services/
├── worktree.service.ts
├── project.service.ts
├── task.service.ts
├── session.service.ts
├── agent.service.ts
└── index.ts                 # Service factory and exports

lib/integrations/
├── claude-sdk/
│   ├── client.ts           # SDK initialization
│   ├── tools.ts            # Tool definitions
│   └── hooks.ts            # Hook implementations
├── github/
│   ├── app.ts              # GitHub App setup
│   ├── octokit.ts          # Octokit factory
│   └── webhooks.ts         # Webhook handlers
└── durable-streams/
    ├── schema.ts           # State schema
    ├── server.ts           # Server publishers
    └── client.ts           # Client subscriptions
```

## Testing Strategy

### Service Tests

| Service | Unit Tests | Integration Tests |
|---------|------------|-------------------|
| WorktreeService | 22 | 10 |
| ProjectService | 15 | 8 |
| TaskService | 18 | 12 |
| SessionService | 12 | 8 |
| AgentService | 20 | 15 |

### Mock Strategy

- **Database:** In-memory PGlite
- **Bun Shell:** Mock `$` command execution
- **Claude SDK:** Mock `query()` generator
- **Durable Streams:** Mock publish/subscribe
- **GitHub:** Mock Octokit client
