import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Task, TaskColumn } from '../db/schema';
import { codespaces, sessions, settings, tasks } from '../db/schema';
import { getFullModelId } from '../lib/constants/models.js';
import { CodespaceErrors } from '../lib/errors/codespace-errors.js';
import type { SandboxError } from '../lib/errors/sandbox-errors.js';
import type { TaskError } from '../lib/errors/task-errors.js';
import { TaskErrors } from '../lib/errors/task-errors.js';
import { ValidationErrors } from '../lib/errors/validation-errors.js';
import { createLogger } from '../lib/logging/logger.js';
import { deriveGitHubFromPath } from '../lib/sandbox/git-token-resolver.js';
import type { CodespaceSandboxConfig } from '../lib/sandbox/types.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
import type { StartAgentInput } from './container-agent.service.js';
import { getGlobalDefaultModel } from './settings.service.js';
import { canTransition } from './task-transitions.js';
import type { GitDiff } from './worktree.service.js';

const log = createLogger('TaskService');

export type CreateTaskInput = {
  codespaceId: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: 'high' | 'medium' | 'low';
  skillId?: string;
  skillName?: string;
  executionSkillId?: string;
  executionSkillName?: string;
  /** Approval mode: 'human' (manual) or 'agent' (auto-review). Null inherits from codespace/global. */
  approvalMode?: 'human' | 'agent';
  /** When true, immediately move the task to in_progress and start the agent */
  autoStart?: boolean;
};

export type UpdateTaskInput = {
  title?: string;
  description?: string;
  labels?: string[];
  priority?: 'high' | 'medium' | 'low';
  /** Model override for this task (short ID like 'claude-opus-4') */
  modelOverride?: string | null;
  skillId?: string | null;
  skillName?: string | null;
  executionSkillId?: string | null;
  executionSkillName?: string | null;
  /** Approval mode: 'human' (manual) or 'agent' (auto-review). Null clears to inherit. */
  approvalMode?: 'human' | 'agent' | null;
};

export type ListTasksOptions = {
  column?: TaskColumn;
  agentId?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'position' | 'createdAt' | 'updatedAt';
  orderDirection?: 'asc' | 'desc';
  /**
   * F07-01: cursor-based pagination. When supplied, the service queries
   * `limit + 1` rows strictly after the cursor position using a compound
   * `(sortValue, id)` comparison. `offset` is ignored when `cursor` is
   * present.
   */
  cursor?: {
    sortValue: string | number | null;
    id: string;
  };
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
  startAgent: (input: StartAgentInput) => Promise<Result<void, SandboxError>>;
  stopAgent: (taskId: string) => Promise<Result<void, SandboxError>>;
  isAgentRunning: (taskId: string) => boolean;
  approvePlan: (taskId: string) => Promise<Result<void, SandboxError>>;
  rejectPlan: (taskId: string, reason?: string) => Promise<Result<void, SandboxError>>;
}

/**
 * Optional host-mode agent execution service for plan approval fallback.
 */
export interface AgentExecutionTrigger {
  resume: (agentId: string, feedback?: string) => Promise<Result<unknown, unknown>>;
  /**
   * theme-03 F6: host-mode plan rejection. Stops any host-mode agent running
   * for the task, moves the task back to backlog, clears plan state, and
   * removes the worktree.
   */
  rejectPlanForTask?: (
    taskId: string,
    reason?: string
  ) => Promise<Result<void, { code: string; message: string; status: number }>>;
}

export class TaskService {
  private containerAgentService?: ContainerAgentTrigger;
  private agentExecutionService?: AgentExecutionTrigger;

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
   * Set the agent execution service for host-mode plan approval fallback.
   * When containerAgentService is not available, plan approvals use this service instead.
   */
  setAgentExecutionService(service: AgentExecutionTrigger): void {
    this.agentExecutionService = service;
  }

  /**
   * Cancel an in-progress or waiting-approval task: stop the running agent
   * (if any) and move the task back to backlog. Agent stop errors are ignored
   * so cleanup always proceeds.
   */
  async cancelTask(taskId: string): Promise<Result<Task, TaskError>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });

    if (!task) {
      return err(TaskErrors.NOT_FOUND);
    }

    // Stop the agent if one is running — log failures but proceed with cleanup
    if (task.agentId || task.sessionId) {
      const stopResult = await this.stopAgent(taskId);
      if (!stopResult.ok) {
        log.warn('Agent stop failed during cancel, proceeding with cleanup', {
          data: { taskId, error: stopResult.error },
        });
      }
    }

    // Only cancel tasks that are in_progress or waiting_approval
    if (task.column !== 'in_progress' && task.column !== 'waiting_approval') {
      return err(TaskErrors.INVALID_TRANSITION(task.column, 'backlog'));
    }

    // Move to backlog, clear stale plan/agent state
    const [updated] = await this.db
      .update(tasks)
      .set({
        column: 'backlog' as TaskColumn,
        agentId: null,
        lastAgentStatus: 'cancelled',
        plan: null,
        planOptions: null,
        agentReviewResult: null,
        agentReviewedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.column, task.column)))
      .returning();

    if (!updated) {
      return err(TaskErrors.NOT_FOUND);
    }

    return ok(updated);
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

      // Clean up task state regardless of stop result
      // Agent process may be dead even if stop API returned error
      const task = await this.db.query.tasks.findFirst({
        where: (tasks, { eq }) => eq(tasks.id, taskId),
      });
      if (task?.agentId) {
        // Preserve sessionId so the UI can show session events after stopping
        await this.db
          .update(tasks)
          .set({
            agentId: null,
            lastAgentStatus: result.ok ? 'cancelled' : 'error',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));
      }

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
        // Preserve sessionId so the UI can show session events
        await this.db
          .update(tasks)
          .set({
            agentId: null,
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
   * Supports both container mode (via containerAgentService) and
   * host mode (via agentExecutionService.resume fallback).
   */
  async approvePlan(taskId: string): Promise<Result<void, TaskError>> {
    // Container mode: delegate to container agent service
    if (this.containerAgentService) {
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

    // Host-mode fallback: resume the agent directly
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });

    if (task?.agentId && this.agentExecutionService) {
      const result = await this.agentExecutionService.resume(task.agentId);
      if (!result.ok) {
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

    return err({
      code: 'NO_EXECUTION_SERVICE',
      message: 'No execution service available for plan approval',
      status: 503,
    });
  }

  /**
   * Reject a pending plan for a task and move it back to backlog.
   *
   * theme-03 F6: falls back to host-mode rejection (agentExecutionService)
   * when the container agent service is not configured, so deployments
   * running host-mode agents can still reach the `plan → backlog` edge of
   * the state machine.
   */
  async rejectPlan(taskId: string, reason?: string): Promise<Result<void, TaskError>> {
    // Container mode: delegate to the container agent service.
    if (this.containerAgentService) {
      const result = await this.containerAgentService.rejectPlan(taskId, reason);
      if (!result.ok) {
        // Propagate the actual error — distinguish PLAN_NOT_FOUND from PLAN_REJECTION_FAILED
        const errorObj = result.error;
        return err({
          code: errorObj?.code ?? 'PLAN_REJECTION_FAILED',
          message: errorObj?.message ?? `Failed to reject plan for task ${taskId}`,
          status: errorObj?.status ?? 500,
        });
      }
      return ok(undefined);
    }

    // theme-03 F6: host-mode fallback.
    if (this.agentExecutionService?.rejectPlanForTask) {
      const result = await this.agentExecutionService.rejectPlanForTask(taskId, reason);
      if (!result.ok) {
        return err({
          code: result.error.code,
          message: result.error.message,
          status: result.error.status,
        });
      }
      return ok(undefined);
    }

    return err({
      code: 'NO_EXECUTION_SERVICE',
      message: 'No execution service available for plan rejection',
      status: 503,
    });
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
    const {
      codespaceId,
      title,
      description,
      labels = [],
      priority = 'medium',
      skillId,
      skillName = skillId ?? undefined,
      executionSkillId,
      executionSkillName = executionSkillId ?? undefined,
      approvalMode,
    } = input;

    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespaceId),
    });

    if (!codespace) {
      return err(CodespaceErrors.NOT_FOUND);
    }

    // Wrap position calculation + insert in a transaction to prevent
    // concurrent creates from computing the same position value.
    // SQLite serializes transactions, so this eliminates the race condition.
    const [task] = await this.db.transaction(async (tx) => {
      const lastTask = await tx.query.tasks.findFirst({
        where: and(eq(tasks.codespaceId, codespaceId), eq(tasks.column, 'backlog')),
        orderBy: desc(tasks.position),
      });

      const position = (lastTask?.position ?? -1) + 1;

      return tx
        .insert(tasks)
        .values({
          codespaceId,
          title,
          description,
          labels,
          priority,
          column: 'backlog',
          position,
          skillId,
          skillName,
          executionSkillId,
          executionSkillName,
          approvalMode,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();
    });

    if (!task) {
      return err(TaskErrors.NOT_FOUND);
    }

    // Auto-start: immediately move to in_progress to trigger the agent
    if (input.autoStart) {
      const moveResult = await this.moveColumn(task.id, 'in_progress');
      if (moveResult.ok) {
        return ok(moveResult.value.task);
      }
      // Move failed — return the task in backlog (non-fatal, agent can be started later)
      log.warn('Auto-start failed, task remains in backlog', {
        data: { taskId: task.id, error: moveResult.error },
      });
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

  async list(codespaceId: string, options?: ListTasksOptions): Promise<Result<Task[], TaskError>> {
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

    const filters = [eq(tasks.codespaceId, codespaceId)];
    if (options?.column) {
      filters.push(eq(tasks.column, options.column));
    }
    if (options?.agentId) {
      filters.push(eq(tasks.agentId, options.agentId));
    }

    // F07-01: cursor-based pagination. When supplied, append a compound
    // `(sortValue, id)` tuple comparison filter and fetch `limit + 1` rows.
    const cursor = options?.cursor;
    let fetchLimit = limit;
    let fetchOffset = offset;
    if (cursor) {
      const sortVal = cursor.sortValue;
      const primary =
        direction === 'desc' ? sql`${orderColumn} < ${sortVal}` : sql`${orderColumn} > ${sortVal}`;
      const tiebreak =
        direction === 'desc'
          ? sql`(${orderColumn} = ${sortVal} AND ${tasks.id} < ${cursor.id})`
          : sql`(${orderColumn} = ${sortVal} AND ${tasks.id} > ${cursor.id})`;
      filters.push(sql`(${primary} OR ${tiebreak})`);
      fetchLimit = limit + 1;
      fetchOffset = 0;
    }

    const items = await this.db.query.tasks.findMany({
      where: filters.length > 1 ? and(...filters) : filters[0],
      orderBy: (direction === 'asc'
        ? [orderColumn, tasks.id]
        : [desc(orderColumn), desc(tasks.id)]) as never,
      limit: fetchLimit,
      offset: fetchOffset,
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

    // Stop any running agent before deleting to prevent orphaned processes
    if (task.column === 'in_progress' && (task.agentId || task.sessionId)) {
      await this.stopAgent(id);
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

    // Guard: cannot move to verified when plan is pending (would skip execution phase).
    // Includes 'agent_reviewing' — the automated review is a pre-approval state, not a
    // completed plan.
    if (
      column === 'verified' &&
      (task.lastAgentStatus === 'planning' || task.lastAgentStatus === 'agent_reviewing')
    ) {
      return err(TaskErrors.PLAN_NOT_EXECUTED);
    }

    let newPosition = position;
    if (newPosition === undefined) {
      const lastInColumn = await this.db.query.tasks.findFirst({
        where: and(eq(tasks.codespaceId, task.codespaceId), eq(tasks.column, column)),
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
    }

    // Wrap session-create + task-update in a transaction for atomicity.
    // If either fails, both are rolled back — prevents orphaned sessions
    // or tasks pointing to non-existent sessions.
    const updated = await this.db.transaction(async (tx) => {
      // IMPORTANT: Create session record BEFORE updating task with sessionId
      // SQLite foreign keys are enforced, so the session must exist first
      if (sessionId && sessionId !== task.sessionId && this.containerAgentService) {
        try {
          await tx.insert(sessions).values({
            id: sessionId,
            codespaceId: task.codespaceId,
            taskId: task.id,
            agentId: null,
            title: task.title ?? `Task ${task.id}`,
            url: `/codespaces/${task.codespaceId}/sessions/${sessionId}`,
            status: 'active',
            sandboxProvider: this.containerAgentService?.providerName ?? null,
            createdAt: new Date().toISOString(),
          });
        } catch (insertErr) {
          const errorMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
          if (!errorMsg.includes('UNIQUE constraint')) {
            // Non-duplicate error — abort transaction
            throw insertErr;
          }
          // UNIQUE constraint = session already exists, safe to continue
        }
      }

      const [result] = await tx
        .update(tasks)
        .set({
          column,
          position: newPosition,
          updatedAt: new Date().toISOString(),
          // On move to in_progress, clear any stale lastAgentStatus from a prior run.
          // Without this, UI badge logic (getCardBadgeKind, isAgentRunning) mis-identifies
          // the task as terminal and hides the running indicator on re-run.
          ...(column === 'in_progress'
            ? { startedAt: new Date().toISOString(), lastAgentStatus: null }
            : {}),
          ...(column === 'verified' ? { completedAt: new Date().toISOString() } : {}),
          // Include sessionId in the update so it's returned to frontend
          ...(sessionId ? { sessionId } : {}),
        })
        .where(eq(tasks.id, id))
        .returning();

      return result;
    });

    if (!updated) {
      return err(TaskErrors.NOT_FOUND);
    }

    // Trigger container agent when moving to in_progress (if sandbox is enabled)
    // We await the agent startup to capture any errors
    let agentError: string | undefined;
    if (column === 'in_progress' && this.containerAgentService && sessionId) {
      agentError = await this.triggerContainerAgent(updated, sessionId);

      // If agent failed to start, move the task back to backlog so it doesn't
      // get stuck in in_progress with no running agent and no way to recover.
      if (agentError) {
        log.warn('Agent failed to start, reverting task to backlog', {
          data: { taskId: id, agentError },
        });
        const errorMsg = typeof agentError === 'string' ? agentError : String(agentError);
        const [reverted] = await this.db
          .update(tasks)
          .set({
            column: 'backlog' as TaskColumn,
            position: updated.position,
            sessionId: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, id))
          .returning();
        if (reverted) {
          return ok({ task: reverted, agentError: errorMsg });
        }
        // Revert failed — still return the error but append context
        log.error('Failed to revert task to backlog after agent error', {
          data: { taskId: id, agentError: errorMsg },
        });
        return ok({
          task: updated,
          agentError: `${errorMsg} (warning: task could not be reverted to backlog)`,
        });
      }
    }

    return ok({ task: updated, agentError });
  }

  /**
   * Load global sandbox defaults from settings.
   */
  private async getGlobalSandboxDefaults(): Promise<CodespaceSandboxConfig | null> {
    try {
      const setting = await this.db.query.settings.findFirst({
        where: eq(settings.key, 'sandbox.defaults'),
      });
      if (setting?.value) {
        return JSON.parse(setting.value) as CodespaceSandboxConfig;
      }
    } catch (error) {
      log.warn('Failed to load global sandbox defaults', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  /**
   * Trigger container agent execution for a task if sandbox is enabled.
   *
   * Note: The session record persists even if agent start fails. This is intentional:
   * the frontend uses the sessionId to subscribe to the SSE stream, and the agentError
   * field on the MoveTaskResult signals that the agent didn't start. Session cleanup
   * happens on codespace delete (CASCADE).
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
      log.info('Agent already running for task, skipping trigger', { data: { taskId: task.id } });
      return undefined;
    }

    // Get codespace to check sandbox config
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, task.codespaceId),
    });

    if (!codespace) {
      const errorMsg = `Codespace not found for task ${task.id}`;
      return errorMsg;
    }

    // Get sandbox config - codespace can override global defaults
    // If codespace sandbox is explicitly null, use global defaults
    // If codespace sandbox exists but is disabled, still check global defaults
    let sandboxConfig = codespace.config?.sandbox as CodespaceSandboxConfig | null | undefined;

    // Use global defaults if:
    // - Project has no sandbox config (undefined)
    // - Project sandbox is explicitly null (use global)
    // - Project sandbox exists but is not enabled
    if (!sandboxConfig?.enabled) {
      const globalDefaults = await this.getGlobalSandboxDefaults();
      if (globalDefaults?.enabled) {
        sandboxConfig = globalDefaults;
      }
    }

    // Only trigger if sandbox is enabled (either codespace or global)
    if (!sandboxConfig?.enabled) {
      return undefined;
    }

    // Validate: remote sandbox providers (kubernetes, nomad) require a GitHub repo
    // to clone into the pod. Without one, the agent would run with no git isolation.
    if (sandboxConfig.provider === 'kubernetes' || sandboxConfig.provider === 'nomad') {
      const hasExplicitRepo = codespace.githubOwner && codespace.githubRepo;
      const hasDerivedRepo = codespace.path ? deriveGitHubFromPath(codespace.path) !== null : false;
      if (!hasExplicitRepo && !hasDerivedRepo) {
        return TaskErrors.NO_GITHUB_REPO.message;
      }
    }

    // Build task prompt
    const prompt = this.buildTaskPrompt(task);

    // Resolve model: codespace config → global default_model setting → hardcoded default
    // getGlobalDefaultModel already returns a full API model ID; apply getFullModelId
    // to the codespace config value too since it may store a short ID
    const projectModel = codespace.config?.model as string | undefined;
    const resolvedModel =
      (projectModel ? getFullModelId(projectModel) : undefined) ??
      (await getGlobalDefaultModel(this.db));
    try {
      const result = await this.containerAgentService.startAgent({
        codespaceId: task.codespaceId,
        taskId: task.id,
        sessionId,
        prompt,
        model: resolvedModel,
        maxTurns: codespace.config?.maxTurns,
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
        return errorMsg;
      }
      return undefined;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to start agent';
      return errorMsg;
    }
  }

  /**
   * Build the prompt for container agent execution.
   */
  private buildTaskPrompt(task: Task): string {
    const parts: string[] = [];

    // Tell the agent to read the skill file at runtime rather than inlining its
    // content here.  The skill file is injected into the sandbox by skill-injector.ts
    // and may be large; keeping it out of the prompt avoids bloating the initial context.
    if (task.skillId) {
      parts.push(
        `IMPORTANT: Before starting any work, use the Read tool to read the file at .claude/skills/${task.skillId}/SKILL.md`,
        `This file contains the workflow you MUST follow step by step. Execute each phase in order.`,
        `Use the subagents and tools specified in the skill file. Do NOT skip or improvise around the defined workflow.`,
        '',
        `CRITICAL — SUBAGENT DELEGATION IS MANDATORY:`,
        `When the skill workflow says "Launch {agent-name} agent" or "Launch {agent-name} subagent", you MUST call the Agent tool. This is NOT optional.`,
        `The Agent tool is available to you. Agent definitions are at .claude/agents/{agent-name}.md.`,
        `Call it like: Agent(prompt="...", subagent_type="{agent-name}")`,
        `For concurrent subagents: make MULTIPLE Agent tool calls in the SAME message.`,
        `You MUST NOT do the subagent's work yourself. If the skill says "Launch tf-module-research", call the Agent tool — do NOT use WebFetch/Bash to do research directly.`,
        `This delegation is how the system tracks subagent topology, costs, and progress. Doing the work yourself breaks observability.`,
        ''
      );
    }

    parts.push(
      'Work on the following task:',
      '',
      `Title: ${task.title}`,
      '',
      `Description: ${task.description ?? 'No description provided.'}`
    );

    if (task.labels && task.labels.length > 0) {
      parts.push('', `Labels: ${task.labels.join(', ')}`);
    }

    if (task.priority) {
      parts.push('', `Priority: ${task.priority}`);
    }

    parts.push(
      '',
      'The codespace is mounted at /workspace. Make the necessary changes to complete this task.',
      'When you are done, the task will be moved to waiting_approval for human review.'
    );

    return parts.join('\n');
  }

  // Note: Position conflicts are possible under concurrent reorders.
  // The Kanban UI re-fetches after reorder, which resolves visual conflicts.
  // A unique constraint on (codespaceId, column, position) is not practical
  // because positions must shift when items are reordered.
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

  async getByColumn(codespaceId: string, column: TaskColumn): Promise<Result<Task[], TaskError>> {
    const items = await this.db.query.tasks.findMany({
      where: and(eq(tasks.codespaceId, codespaceId), eq(tasks.column, column)),
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

    // Guard: cannot approve changes when task is pending plan approval (would skip execution).
    // 'agent_reviewing' is also a pre-approval transient state — block approval there too.
    if (task.lastAgentStatus === 'planning' || task.lastAgentStatus === 'agent_reviewing') {
      return err(TaskErrors.PLAN_NOT_EXECUTED);
    }

    if (task.approvedAt) {
      return err(TaskErrors.ALREADY_APPROVED);
    }

    // Container agent tasks have a branch but no worktreeId.
    // They can be approved without diff/merge since the work lives on the branch.
    const isContainerAgent = !task.worktreeId && task.branch;

    let diffStats: GitDiff['stats'] | undefined;

    if (isContainerAgent) {
      // Container agent: skip worktree-based diff/merge.
      // The agent's changes are on the branch — approval just marks completion.
      log.info('Approving container agent task (no worktree)', {
        data: { taskId: id, branch: task.branch },
      });
    } else {
      if (!task.worktreeId) {
        return err(TaskErrors.NO_DIFF);
      }

      let diff: Result<GitDiff, TaskError>;
      try {
        diff = await this.worktreeService.getDiff(task.worktreeId);
      } catch (error) {
        log.error('getDiff threw unexpectedly', {
          data: {
            taskId: id,
            worktreeId: task.worktreeId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return err(TaskErrors.NO_DIFF);
      }
      if (!diff.ok) {
        return diff;
      }

      if (diff.value.stats.filesChanged === 0) {
        return err(TaskErrors.NO_DIFF);
      }

      diffStats = diff.value.stats;

      if (input.createMergeCommit !== false) {
        let mergeResult: Result<void, TaskError>;
        try {
          mergeResult = await this.worktreeService.merge(task.worktreeId);
        } catch (error) {
          log.error('merge threw unexpectedly', {
            data: {
              taskId: id,
              worktreeId: task.worktreeId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          return err({
            code: 'WORKTREE_MERGE_FAILED',
            message: error instanceof Error ? error.message : 'Merge failed',
            status: 500,
          });
        }
        if (!mergeResult.ok) {
          return mergeResult;
        }
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
        ...(diffStats ? { diffSummary: diffStats } : {}),
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
        column: 'backlog',
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

    let diff: Result<GitDiff, TaskError>;
    try {
      diff = await this.worktreeService.getDiff(task.worktreeId);
    } catch (error) {
      log.error('getDiff threw unexpectedly', {
        data: {
          taskId: id,
          worktreeId: task.worktreeId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return err(TaskErrors.NO_DIFF);
    }
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
