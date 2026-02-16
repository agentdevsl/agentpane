import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq } from 'drizzle-orm';
import type { Task, TaskColumn } from '../db/schema';
import { projects, sessions, settings, tasks } from '../db/schema';
import { getFullModelId } from '../lib/constants/models.js';
import { ProjectErrors } from '../lib/errors/project-errors.js';
import type { TaskError } from '../lib/errors/task-errors.js';
import { TaskErrors } from '../lib/errors/task-errors.js';
import { ValidationErrors } from '../lib/errors/validation-errors.js';
import type { ProjectSandboxConfig } from '../lib/sandbox/types.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
import type { StartAgentInput } from './container-agent.service.js';
import { getGlobalDefaultModel } from './settings.service.js';
import { canTransition } from './task-transitions.js';
import type { GitDiff } from './worktree.service.js';

export type CreateTaskInput = {
  projectId: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: 'high' | 'medium' | 'low';
};

export type UpdateTaskInput = {
  title?: string;
  description?: string;
  labels?: string[];
  priority?: 'high' | 'medium' | 'low';
  /** Model override for this task (short ID like 'claude-opus-4') */
  modelOverride?: string | null;
};

export type ListTasksOptions = {
  column?: TaskColumn;
  agentId?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'position' | 'createdAt' | 'updatedAt';
  orderDirection?: 'asc' | 'desc';
};

export type ApproveInput = {
  approvedBy?: string;
  createMergeCommit?: boolean;
};

export type RejectInput = {
  reason: string;
};

export type DiffResult = {
  taskId: string;
  branch: string;
  baseBranch: string;
  files: GitDiff['files'];
  summary: GitDiff['stats'];
};

/**
 * Result of moving a task to a new column.
 * Includes the updated task and any agent startup error (if applicable).
 */
export type MoveTaskResult = {
  task: Task;
  /** Error message if agent failed to start (task move still succeeded) */
  agentError?: string;
};

/**
 * Optional container agent service for triggering agent execution on task move.
 */
export interface ContainerAgentTrigger {
  /** Sandbox provider name (e.g., 'docker', 'kubernetes') */
  readonly providerName: string;
  startAgent: (input: StartAgentInput) => Promise<Result<void, unknown>>;
  stopAgent: (taskId: string) => Promise<Result<void, unknown>>;
  isAgentRunning: (taskId: string) => boolean;
  approvePlan: (taskId: string) => Promise<Result<void, unknown>>;
  rejectPlan: (taskId: string, reason?: string) => Promise<Result<void, unknown>>;
}

export class TaskService {
  private containerAgentService?: ContainerAgentTrigger;

  constructor(
    private db: Database,
    private worktreeService: {
      getDiff: (worktreeId: string) => Promise<Result<GitDiff, TaskError>>;
      merge: (worktreeId: string, targetBranch?: string) => Promise<Result<void, TaskError>>;
      remove: (worktreeId: string) => Promise<Result<void, TaskError>>;
    }
  ) {}

  /**
   * Set the container agent service for automatic agent triggering.
   * This is optional - if not set, tasks won't auto-trigger container agents.
   */
  setContainerAgentService(service: ContainerAgentTrigger): void {
    this.containerAgentService = service;
  }

  /**
   * Stop a running container agent for a task.
   * If the agent isn't in memory (e.g., container died), cleans up task state anyway.
   */
  async stopAgent(taskId: string): Promise<Result<void, TaskError>> {
    // Check if agent is actually running in memory
    const isRunning = this.containerAgentService?.isAgentRunning(taskId);

    if (isRunning && this.containerAgentService) {
      // Agent is running - stop it properly
      const result = await this.containerAgentService.stopAgent(taskId);
      if (!result.ok) {
        return err(TaskErrors.AGENT_STOP_FAILED);
      }
    } else {
      // Agent not in memory - clean up task state anyway
      // This handles cases where container died or server restarted
      const task = await this.db.query.tasks.findFirst({
        where: (tasks, { eq }) => eq(tasks.id, taskId),
      });

      if (task?.agentId) {
        // Update task to remove agent reference and mark as cancelled
        await this.db
          .update(tasks)
          .set({
            agentId: null,
            sessionId: null,
            lastAgentStatus: 'cancelled',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));
      }
    }

    return ok(undefined);
  }

  /**
   * Approve a pending plan for a task and start execution.
   */
  async approvePlan(taskId: string): Promise<Result<void, TaskError>> {
    if (!this.containerAgentService) {
      return err({
        code: 'CONTAINER_AGENT_SERVICE_UNAVAILABLE',
        message: 'Container agent service is not configured',
        status: 503,
      });
    }

    const result = await this.containerAgentService.approvePlan(taskId);
    if (!result.ok) {
      // Propagate the actual error from containerAgentService
      const errorObj = result.error as
        | { code?: string; message?: string; status?: number }
        | undefined;
      return err({
        code: errorObj?.code ?? 'PLAN_APPROVAL_FAILED',
        message: errorObj?.message ?? `Failed to approve plan for task ${taskId}`,
        status: errorObj?.status ?? 500,
      });
    }

    return ok(undefined);
  }

  /**
   * Reject a pending plan for a task and move it back to backlog.
   */
  async rejectPlan(taskId: string, reason?: string): Promise<Result<void, TaskError>> {
    if (!this.containerAgentService) {
      return err({
        code: 'CONTAINER_AGENT_SERVICE_UNAVAILABLE',
        message: 'Container agent service is not configured',
        status: 503,
      });
    }

    const result = await this.containerAgentService.rejectPlan(taskId, reason);
    if (!result.ok) {
      // Propagate the actual error — distinguish PLAN_NOT_FOUND from PLAN_REJECTION_FAILED
      const errorObj = result.error as
        | { code?: string; message?: string; status?: number }
        | undefined;
      return err({
        code: errorObj?.code ?? 'PLAN_REJECTION_FAILED',
        message: errorObj?.message ?? `Failed to reject plan for task ${taskId}`,
        status: errorObj?.status ?? 500,
      });
    }

    return ok(undefined);
  }

  /**
   * Update the worktree service after construction.
   * Useful when TaskService is created before WorktreeService is fully initialized.
   */
  setWorktreeService(service: {
    getDiff: (worktreeId: string) => Promise<Result<GitDiff, TaskError>>;
    merge: (worktreeId: string, targetBranch?: string) => Promise<Result<void, TaskError>>;
    remove: (worktreeId: string) => Promise<Result<void, TaskError>>;
  }): void {
    this.worktreeService = service;
  }

  async create(input: CreateTaskInput): Promise<Result<Task, TaskError>> {
    const { projectId, title, description, labels = [], priority = 'medium' } = input;

    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project) {
      return err(ProjectErrors.NOT_FOUND);
    }

    const lastTask = await this.db.query.tasks.findFirst({
      where: and(eq(tasks.projectId, projectId), eq(tasks.column, 'backlog')),
      orderBy: desc(tasks.position),
    });

    const position = (lastTask?.position ?? -1) + 1;

    const [task] = await this.db
      .insert(tasks)
      .values({
        projectId,
        title,
        description,
        labels,
        priority,
        column: 'backlog',
        position,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();

    if (!task) {
      return err(TaskErrors.NOT_FOUND);
    }

    return ok(task);
  }

  async getById(id: string): Promise<Result<Task, TaskError>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, id),
    });

    if (!task) {
      return err(TaskErrors.NOT_FOUND);
    }

    return ok(task);
  }

  async list(projectId: string, options?: ListTasksOptions): Promise<Result<Task[], TaskError>> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const orderBy = options?.orderBy ?? 'position';
    const direction = options?.orderDirection ?? 'asc';

    const orderColumn =
      orderBy === 'createdAt'
        ? tasks.createdAt
        : orderBy === 'updatedAt'
          ? tasks.updatedAt
          : tasks.position;

    const filters = [eq(tasks.projectId, projectId)];
    if (options?.column) {
      filters.push(eq(tasks.column, options.column));
    }
    if (options?.agentId) {
      filters.push(eq(tasks.agentId, options.agentId));
    }

    const items = await this.db.query.tasks.findMany({
      where: filters.length > 1 ? and(...filters) : filters[0],
      orderBy: (direction === 'asc' ? [orderColumn] : [desc(orderColumn)]) as never,
      limit,
      offset,
    });

    return ok(items);
  }

  async update(id: string, input: UpdateTaskInput): Promise<Result<Task, TaskError>> {
    const [updated] = await this.db
      .update(tasks)
      .set({ ...input, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, id))
      .returning();

    if (!updated) {
      return err(TaskErrors.NOT_FOUND);
    }

    return ok(updated);
  }

  async delete(id: string): Promise<Result<void, TaskError>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, id),
    });

    if (!task) {
      return err(TaskErrors.NOT_FOUND);
    }

    await this.db.delete(tasks).where(eq(tasks.id, id));
    return ok(undefined);
  }

  async moveColumn(
    id: string,
    column: TaskColumn,
    position?: number
  ): Promise<Result<MoveTaskResult, TaskError>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, id),
    });

    if (!task) {
      return err(TaskErrors.NOT_FOUND);
    }

    // No-op if task is already in the target column
    if (task.column === column) {
      return ok({ task });
    }

    if (!canTransition(task.column, column)) {
      return err(TaskErrors.INVALID_TRANSITION(task.column, column));
    }

    let newPosition = position;
    if (newPosition === undefined) {
      const lastInColumn = await this.db.query.tasks.findFirst({
        where: and(eq(tasks.projectId, task.projectId), eq(tasks.column, column)),
        orderBy: desc(tasks.position),
      });
      newPosition = (lastInColumn?.position ?? -1) + 1;
    }

    // PRODUCTION-ROBUST: Generate sessionId upfront for in_progress moves
    // This ensures the sessionId is included in the returned task so the
    // frontend can immediately subscribe to the stream
    let sessionId: string | null = null;
    if (column === 'in_progress' && this.containerAgentService) {
      sessionId = task.sessionId ?? createId();

      // IMPORTANT: Create session record BEFORE updating task with sessionId
      // SQLite foreign keys are enforced, so the session must exist first
      if (sessionId && sessionId !== task.sessionId) {
        try {
          await this.db.insert(sessions).values({
            id: sessionId,
            projectId: task.projectId,
            taskId: task.id,
            agentId: null,
            title: task.title ?? `Task ${task.id}`,
            url: `/projects/${task.projectId}/sessions/${sessionId}`,
            status: 'active',
            sandboxProvider: this.containerAgentService?.providerName ?? null,
            createdAt: new Date().toISOString(),
          });
        } catch (insertErr) {
          // Ignore if session already exists (race condition or retry)
          const errorMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
          if (!errorMsg.includes('UNIQUE constraint')) {
            console.warn('[TaskService] Failed to create session record:', errorMsg);
          }
        }
      }
    }

    const [updated] = await this.db
      .update(tasks)
      .set({
        column,
        position: newPosition,
        updatedAt: new Date().toISOString(),
        ...(column === 'in_progress' ? { startedAt: new Date().toISOString() } : {}),
        ...(column === 'verified' ? { completedAt: new Date().toISOString() } : {}),
        // Include sessionId in the update so it's returned to frontend
        ...(sessionId ? { sessionId } : {}),
      })
      .where(eq(tasks.id, id))
      .returning();

    if (!updated) {
      return err(TaskErrors.NOT_FOUND);
    }

    // Trigger container agent when moving to in_progress (if sandbox is enabled)
    // We await the agent startup to capture any errors
    let agentError: string | undefined;
    if (column === 'in_progress' && this.containerAgentService && sessionId) {
      agentError = await this.triggerContainerAgent(updated, sessionId);
    }

    return ok({ task: updated, agentError });
  }

  /**
   * Load global sandbox defaults from settings.
   */
  private async getGlobalSandboxDefaults(): Promise<ProjectSandboxConfig | null> {
    try {
      const setting = await this.db.query.settings.findFirst({
        where: eq(settings.key, 'sandbox.defaults'),
      });
      if (setting?.value) {
        return JSON.parse(setting.value) as ProjectSandboxConfig;
      }
    } catch (error) {
      console.warn('[TaskService] Failed to load global sandbox defaults:', error);
    }
    return null;
  }

  /**
   * Trigger container agent execution for a task if sandbox is enabled.
   *
   * @param task - The task to execute
   * @param sessionId - Pre-generated sessionId (required for frontend to subscribe immediately)
   * @returns Error message string if the agent fails to start, or undefined on success
   */
  private async triggerContainerAgent(task: Task, sessionId: string): Promise<string | undefined> {
    if (!this.containerAgentService) {
      return undefined;
    }

    // Check if agent is already running for this task
    if (this.containerAgentService.isAgentRunning(task.id)) {
      console.log(`[TaskService] Agent already running for task ${task.id}, skipping trigger`);
      return undefined;
    }

    // Get project to check sandbox config
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, task.projectId),
    });

    if (!project) {
      const errorMsg = `Project not found for task ${task.id}`;
      console.warn(`[TaskService] ${errorMsg}, cannot trigger agent`);
      return errorMsg;
    }

    // Get sandbox config - project can override global defaults
    // If project sandbox is explicitly null, use global defaults
    // If project sandbox exists but is disabled, still check global defaults
    let sandboxConfig = project.config?.sandbox as ProjectSandboxConfig | null | undefined;

    // Use global defaults if:
    // - Project has no sandbox config (undefined)
    // - Project sandbox is explicitly null (use global)
    // - Project sandbox exists but is not enabled
    if (!sandboxConfig?.enabled) {
      const globalDefaults = await this.getGlobalSandboxDefaults();
      if (globalDefaults?.enabled) {
        console.log(`[TaskService] Using global sandbox defaults for project ${project.id}`);
        sandboxConfig = globalDefaults;
      }
    }

    // Only trigger if sandbox is enabled (either project or global)
    if (!sandboxConfig?.enabled) {
      console.log(
        `[TaskService] Sandbox not enabled for project ${project.id}, skipping container agent`
      );
      return undefined;
    }

    // Build task prompt
    const prompt = this.buildTaskPrompt(task);

    // Resolve model: project config → global default_model setting → hardcoded default
    // getGlobalDefaultModel already returns a full API model ID; apply getFullModelId
    // to the project config value too since it may store a short ID
    const projectModel = project.config?.model as string | undefined;
    const resolvedModel =
      (projectModel ? getFullModelId(projectModel) : undefined) ??
      (await getGlobalDefaultModel(this.db));

    // Trigger agent execution and capture startup errors
    // The sessionId was already set on the task in moveColumn() before this call
    console.log(
      `[TaskService] Triggering container agent for task ${task.id}, sessionId: ${sessionId}, model: ${resolvedModel ?? 'default'}`
    );
    try {
      const result = await this.containerAgentService.startAgent({
        projectId: task.projectId,
        taskId: task.id,
        sessionId,
        prompt,
        model: resolvedModel,
        maxTurns: project.config?.maxTurns,
      });

      if (!result.ok) {
        const errorObj = result.error;
        let errorMsg: string;
        if (typeof errorObj === 'object' && errorObj !== null && 'message' in errorObj) {
          errorMsg = (errorObj as { message: string }).message;
        } else if (typeof errorObj === 'string') {
          errorMsg = errorObj;
        } else {
          errorMsg = 'Failed to start agent';
        }
        console.error(`[TaskService] Container agent failed for task ${task.id}:`, errorMsg);
        return errorMsg;
      }

      console.log(`[TaskService] Container agent started for task ${task.id}`);
      return undefined;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to start agent';
      console.error(`[TaskService] Error starting container agent for task ${task.id}:`, error);
      return errorMsg;
    }
  }

  /**
   * Build the prompt for container agent execution.
   */
  private buildTaskPrompt(task: Task): string {
    const parts = [
      'Work on the following task:',
      '',
      `Title: ${task.title}`,
      '',
      `Description: ${task.description ?? 'No description provided.'}`,
    ];

    if (task.labels && task.labels.length > 0) {
      parts.push('', `Labels: ${task.labels.join(', ')}`);
    }

    if (task.priority) {
      parts.push('', `Priority: ${task.priority}`);
    }

    parts.push(
      '',
      'The project is mounted at /workspace. Make the necessary changes to complete this task.',
      'When you are done, the task will be moved to review.'
    );

    return parts.join('\n');
  }

  async reorder(id: string, position: number): Promise<Result<Task, TaskError>> {
    const [updated] = await this.db
      .update(tasks)
      .set({ position, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, id))
      .returning();

    if (!updated) {
      return err(TaskErrors.NOT_FOUND);
    }

    return ok(updated);
  }

  async getByColumn(projectId: string, column: TaskColumn): Promise<Result<Task[], TaskError>> {
    const items = await this.db.query.tasks.findMany({
      where: and(eq(tasks.projectId, projectId), eq(tasks.column, column)),
      orderBy: desc(tasks.position),
    });

    return ok(items);
  }

  async approve(id: string, input: ApproveInput): Promise<Result<Task, TaskError>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, id),
    });

    if (!task) {
      return err(TaskErrors.NOT_FOUND);
    }

    if (task.column !== 'waiting_approval') {
      return err(TaskErrors.NOT_WAITING_APPROVAL(task.column));
    }

    if (task.approvedAt) {
      return err(TaskErrors.ALREADY_APPROVED);
    }

    if (!task.worktreeId) {
      return err(TaskErrors.NO_DIFF);
    }

    const diff = await this.worktreeService.getDiff(task.worktreeId);
    if (!diff.ok) {
      return diff;
    }

    if (diff.value.stats.filesChanged === 0) {
      return err(TaskErrors.NO_DIFF);
    }

    if (input.createMergeCommit !== false) {
      const mergeResult = await this.worktreeService.merge(task.worktreeId);
      if (!mergeResult.ok) {
        return mergeResult;
      }
    }

    const [updated] = await this.db
      .update(tasks)
      .set({
        column: 'verified',
        approvedAt: new Date().toISOString(),
        approvedBy: input.approvedBy,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        diffSummary: diff.value.stats,
      })
      .where(eq(tasks.id, id))
      .returning();

    if (task.worktreeId) {
      await this.worktreeService.remove(task.worktreeId);
    }

    if (!updated) {
      return err(TaskErrors.NOT_FOUND);
    }

    return ok(updated);
  }

  async reject(id: string, input: RejectInput): Promise<Result<Task, TaskError>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, id),
    });

    if (!task) {
      return err(TaskErrors.NOT_FOUND);
    }

    if (task.column !== 'waiting_approval') {
      return err(TaskErrors.NOT_WAITING_APPROVAL(task.column));
    }

    if (!input.reason || input.reason.length < 1 || input.reason.length > 1000) {
      return err(ValidationErrors.INVALID_ENUM_VALUE('reason', input.reason, ['1-1000 chars']));
    }

    const [updated] = await this.db
      .update(tasks)
      .set({
        column: 'in_progress',
        rejectionCount: (task.rejectionCount ?? 0) + 1,
        rejectionReason: input.reason,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, id))
      .returning();

    if (!updated) {
      return err(TaskErrors.NOT_FOUND);
    }

    return ok(updated);
  }

  async getDiff(id: string): Promise<Result<DiffResult, TaskError>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, id),
    });

    if (!task) {
      return err(TaskErrors.NOT_FOUND);
    }

    if (!task.worktreeId || !task.branch) {
      return err(TaskErrors.NO_DIFF);
    }

    const diff = await this.worktreeService.getDiff(task.worktreeId);
    if (!diff.ok) {
      return diff;
    }

    return ok({
      taskId: task.id,
      branch: task.branch,
      baseBranch: 'main',
      files: diff.value.files,
      summary: diff.value.stats,
    });
  }
}
