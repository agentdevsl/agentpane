import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { agentRuns, agents, projects, sessions, tasks, worktrees } from '../../db/schema';
import { createAgentHooks } from '../../lib/agents/hooks/index.js';
import { handleAgentError } from '../../lib/agents/recovery.js';
import { runAgentExecution, runAgentPlanning } from '../../lib/agents/stream-handler.js';
import type { AgentError } from '../../lib/errors/agent-errors.js';
import { AgentErrors } from '../../lib/errors/agent-errors.js';
import type { ConcurrencyError } from '../../lib/errors/concurrency-errors.js';
import { ConcurrencyErrors } from '../../lib/errors/concurrency-errors.js';
import { resolveModel } from '../../lib/utils/resolve-model.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import { getGlobalDefaultModel } from '../settings.service.js';
import type { AgentQueueService } from './agent-queue.service.js';
import type {
  AgentRunResult,
  AgentStartResult,
  PostToolUseHook,
  PreToolUseHook,
  SessionServiceInterface,
  TaskService,
  WorktreeService,
} from './types.js';

/**
 * Shared map of running agents with their AbortControllers.
 * This is module-level to allow proper cleanup across service instances.
 */
const runningAgents = new Map<string, AbortController>();

/**
 * AgentExecutionService handles agent lifecycle and execution.
 *
 * Responsibilities:
 * - Start agent execution with task assignment
 * - Stop running agents
 * - Pause and resume agents
 * - Manage AbortController lifecycle
 * - Handle execution results and errors
 * - Check project availability for new agents
 */
export class AgentExecutionService {
  private preToolHooks = new Map<string, PreToolUseHook[]>();
  private postToolHooks = new Map<string, PostToolUseHook[]>();
  private queueService: AgentQueueService | null = null;

  constructor(
    private db: Database,
    private worktreeService: WorktreeService,
    _taskService: TaskService,
    private sessionService: SessionServiceInterface
  ) {}

  /**
   * Set the queue service for auto-dequeue on agent completion.
   * This avoids circular dependency between execution and queue services.
   */
  setQueueService(queueService: AgentQueueService): void {
    this.queueService = queueService;
  }

  /**
   * Start an agent with an optional specific task.
   * If no task is specified, picks the next available task from the backlog.
   */
  async start(
    agentId: string,
    taskId?: string
  ): Promise<Result<AgentStartResult, AgentError | ConcurrencyError>> {
    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });

    if (!agent) {
      return err(AgentErrors.NOT_FOUND);
    }

    if (agent.status !== 'idle') {
      return err(AgentErrors.ALREADY_RUNNING(agent.currentTaskId ?? undefined));
    }

    let task = taskId
      ? await this.db.query.tasks.findFirst({
          where: eq(tasks.id, taskId),
        })
      : null;

    if (!task) {
      // Look for queued tasks first (FIFO), then backlog
      task = await this.db.query.tasks.findFirst({
        where: and(
          eq(tasks.projectId, agent.projectId),
          inArray(tasks.column, ['queued', 'backlog'])
        ),
        orderBy: asc(tasks.updatedAt),
      });
    }

    if (!task) {
      return err(AgentErrors.NO_AVAILABLE_TASK);
    }

    if (task.column !== 'backlog' && task.column !== 'queued') {
      return err(AgentErrors.NO_AVAILABLE_TASK);
    }

    // Check concurrency BEFORE modifying task state to avoid race condition
    const availability = await this.checkAvailability(agent.projectId);
    if (!availability.ok || !availability.value) {
      const runningResult = await this.getRunningCount(agent.projectId);
      const runningCount = runningResult.ok ? runningResult.value : 0;
      const project = await this.db.query.projects.findFirst({
        where: eq(projects.id, agent.projectId),
      });
      return err(ConcurrencyErrors.LIMIT_EXCEEDED(runningCount, project?.maxConcurrentAgents ?? 1));
    }

    // Create worktree and session BEFORE the transaction
    // These are external service calls that must succeed before we modify DB state
    const worktree = await this.worktreeService.create({
      projectId: agent.projectId,
      agentId: agent.id,
      taskId: task.id,
      taskTitle: task.title,
    });
    if (!worktree.ok) {
      return worktree;
    }

    const session = await this.sessionService.create({
      projectId: agent.projectId,
      taskId: task.id,
      agentId: agent.id,
      title: task.title,
    });

    if (!session.ok) {
      return err(AgentErrors.EXECUTION_ERROR('Failed to create session'));
    }

    // Wrap all DB state mutations in a transaction for atomicity
    // Task column change happens AFTER worktree + session creation succeeds
    let agentRun: typeof import('../../db/schema').agentRuns.$inferSelect | undefined;
    try {
      agentRun = await this.db.transaction(async (tx) => {
        await tx
          .update(tasks)
          .set({
            column: 'in_progress',
            agentId,
            sessionId: session.value.id,
            worktreeId: worktree.value.id,
            branch: worktree.value.branch,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, task.id));

        await tx
          .update(agents)
          .set({
            status: 'starting',
            currentTaskId: task.id,
            currentSessionId: session.value.id,
            currentTurn: 0,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));

        const [run] = await tx
          .insert(agentRuns)
          .values({
            agentId,
            taskId: task.id,
            projectId: agent.projectId,
            sessionId: session.value.id,
            status: 'running',
          })
          .returning();

        // Set planning status within the same transaction
        await tx.update(agents).set({ status: 'planning' }).where(eq(agents.id, agentId));

        return run;
      });
    } catch {
      // Clean up externally created resources on transaction failure
      await this.db
        .delete(worktrees)
        .where(eq(worktrees.id, worktree.value.id))
        .catch(() => {});
      return err(AgentErrors.EXECUTION_ERROR('Failed to start agent: transaction error'));
    }

    await this.sessionService.publish(session.value.id, {
      id: createId(),
      type: 'state:update',
      timestamp: Date.now(),
      data: { status: 'starting', agentId, taskId: task.id },
    });

    const controller = new AbortController();
    runningAgents.set(agentId, controller);

    // Get project for model configuration
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, agent.projectId),
    });

    // Resolve model using cascade priority:
    // Task.modelOverride → Agent.config.model → Project.config.model → Global setting → Default
    const taskModelOverride = (task as typeof task & { modelOverride?: string | null })
      .modelOverride;
    const projectConfig = project?.config as { model?: string } | null;

    const globalDefault = await getGlobalDefaultModel(this.db);

    const resolvedModel = resolveModel({
      taskModelOverride: taskModelOverride,
      agentModel: agent.config?.model,
      projectModel: projectConfig?.model,
      globalDefault,
    });

    // Build task prompt
    const taskPrompt = `Work on the following task:\n\nTitle: ${task.title}\n\nDescription: ${task.description ?? 'No description provided'}\n\nThe task is in the worktree at: ${worktree.value.path}`;

    // Create agent hooks for streaming and audit
    const hooks = createAgentHooks({
      agentId,
      sessionId: session.value.id,
      agentRunId: agentRun?.id ?? createId(),
      taskId: task.id,
      projectId: agent.projectId,
      allowedTools: agent.config?.allowedTools ?? [],
      db: this.db,
      sessionService: this.sessionService,
    });

    // Start agent execution asynchronously (fire-and-forget with error handling)
    // The agent runs in the background and updates state through events
    this.executeAgentAsync(
      agentId,
      session.value.id,
      taskPrompt,
      {
        allowedTools: agent.config?.allowedTools ?? [],
        maxTurns: agent.config?.maxTurns ?? 50,
        model: resolvedModel,
        cwd: worktree.value.path,
        hooks,
        signal: controller.signal,
      },
      agentRun?.id ?? createId(),
      task.id
    );

    const updatedAgent = await this.db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });

    const updatedTask = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    const updatedSession = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, session.value.id),
    });

    const updatedWorktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.value.id),
    });

    if (!updatedAgent || !updatedTask || !updatedSession || !updatedWorktree) {
      return err(AgentErrors.EXECUTION_ERROR('Missing updated resources after start'));
    }

    return ok({
      agent: updatedAgent,
      task: updatedTask,
      session: updatedSession,
      worktree: updatedWorktree,
    });
  }

  /**
   * Execute agent asynchronously with streaming.
   * Updates agent status based on execution result.
   */
  private async executeAgentAsync(
    agentId: string,
    sessionId: string,
    prompt: string,
    options: {
      allowedTools: string[];
      maxTurns: number;
      model: string;
      cwd: string;
      hooks: ReturnType<typeof createAgentHooks>;
      signal?: AbortSignal;
    },
    runId: string,
    taskId: string
  ): Promise<void> {
    // Abort signal handling is managed by stream-handler.ts which publishes agent:stopped

    try {
      const result = await runAgentPlanning({
        agentId,
        sessionId,
        prompt,
        allowedTools: options.allowedTools,
        maxTurns: options.maxTurns,
        model: options.model,
        cwd: options.cwd,
        hooks: options.hooks,
        signal: options.signal,
        sessionService: this.sessionService,
      });

      // Update agent run with result
      // Map SDK statuses to database enum values:
      // - 'turn_limit' (SDK) -> 'paused' (DB) - agent hit iteration limit
      // - 'planning' (SDK) -> 'running' (DB) - agent is in planning phase awaiting approval
      // Note: DB schema uses 'running' for planning since 'planning' isn't a DB enum value
      let dbStatus: 'completed' | 'error' | 'paused' | 'running';
      switch (result.status) {
        case 'turn_limit':
          dbStatus = 'paused';
          break;
        case 'planning':
          dbStatus = 'running';
          break;
        case 'completed':
        case 'error':
        case 'paused':
          dbStatus = result.status;
          break;
        default: {
          // Exhaustive check - TypeScript will error if a new status is added
          const _exhaustiveCheck: never = result.status;
          void _exhaustiveCheck;
          console.error(
            `[AgentExecutionService] Unknown agent status: ${result.status}, defaulting to error`
          );
          dbStatus = 'error';
        }
      }
      await this.db
        .update(agentRuns)
        .set({
          status: dbStatus,
          completedAt: result.status === 'planning' ? null : new Date().toISOString(),
          turnsUsed: result.turnCount,
          errorMessage: result.error,
        })
        .where(eq(agentRuns.id, runId));

      // Update agent status based on result
      if (result.status === 'planning') {
        // Planning phase completed - agent stays in 'planning' status
        // Task stays in 'in_progress' - user needs to approve the plan
        await this.db
          .update(agents)
          .set({
            status: 'planning',
            currentTurn: result.turnCount,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));

        // Store the plan and options on the task
        await this.db
          .update(tasks)
          .set({
            plan: result.plan,
            planOptions: result.planOptions,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));

        console.log(
          `[AgentExecutionService] Agent ${agentId} planning complete, awaiting approval`
        );
      } else if (result.status === 'completed') {
        await this.db
          .update(agents)
          .set({
            status: 'idle',
            currentTaskId: null,
            currentSessionId: null,
            currentTurn: result.turnCount,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));

        // Move task to waiting_approval
        await this.db
          .update(tasks)
          .set({
            column: 'waiting_approval',
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));
      } else if (result.status === 'turn_limit' || result.status === 'paused') {
        await this.db
          .update(agents)
          .set({
            status: 'paused',
            currentTurn: result.turnCount,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));

        // Move task to waiting_approval for review
        await this.db
          .update(tasks)
          .set({
            column: 'waiting_approval',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));
      } else if (result.status === 'error') {
        await this.db
          .update(agents)
          .set({
            status: 'error',
            currentTurn: result.turnCount,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));
      }

      // Remove from running agents
      runningAgents.delete(agentId);

      // Auto-dequeue: when an agent completes, check if there's a queued task to pick up
      if (result.status === 'completed' && this.queueService) {
        this.tryDequeueAndStart(agentId).catch((dequeueErr) => {
          console.error(
            `[AgentExecutionService] Failed to dequeue next task for agent ${agentId}:`,
            dequeueErr
          );
        });
      }
    } catch (error) {
      console.error(`[AgentExecutionService] Agent ${agentId} execution failed:`, error);

      const errorMessage = error instanceof Error ? error.message : String(error);
      const recovery = handleAgentError(error instanceof Error ? error : new Error(errorMessage), {
        agentId,
        taskId,
        maxTurns: options.maxTurns,
        currentTurn: 0,
      });

      // Update run with error
      await this.db
        .update(agentRuns)
        .set({
          status: 'error',
          completedAt: new Date().toISOString(),
          errorMessage: errorMessage,
        })
        .where(eq(agentRuns.id, runId));

      // Update agent status
      await this.db
        .update(agents)
        .set({
          status: recovery.action === 'pause' ? 'paused' : 'error',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agents.id, agentId));

      // Publish error event
      await this.sessionService.publish(sessionId, {
        id: createId(),
        type: 'agent:error',
        timestamp: Date.now(),
        data: { agentId, error: errorMessage, recovery: recovery.action },
      });

      runningAgents.delete(agentId);
    }
  }

  /**
   * Stop a running agent by aborting its execution.
   */
  async stop(agentId: string): Promise<Result<void, AgentError>> {
    const controller = runningAgents.get(agentId);
    if (!controller) {
      return err(AgentErrors.NOT_RUNNING);
    }

    controller.abort();
    runningAgents.delete(agentId);

    await this.db
      .update(agents)
      .set({
        status: 'idle',
        currentTaskId: null,
        currentSessionId: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(agents.id, agentId));

    return ok(undefined);
  }

  /**
   * Pause a running agent.
   */
  async pause(agentId: string): Promise<Result<void, AgentError>> {
    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });

    if (!agent) {
      return err(AgentErrors.NOT_FOUND);
    }

    await this.db
      .update(agents)
      .set({ status: 'paused', updatedAt: new Date().toISOString() })
      .where(eq(agents.id, agentId));

    return ok(undefined);
  }

  /**
   * Resume a paused agent with optional feedback.
   * Handles two cases:
   * - Agent in 'planning' state (plan approved): starts execution phase
   * - Agent in 'paused' state (turn limit): resumes with existing behavior
   */
  async resume(agentId: string, feedback?: string): Promise<Result<AgentRunResult, AgentError>> {
    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });

    if (!agent) {
      return err(AgentErrors.NOT_FOUND);
    }

    // Case 1: Plan approved - start execution phase
    if (agent.status === 'planning' && agent.currentTaskId && agent.currentSessionId) {
      await this.db
        .update(agents)
        .set({ status: 'running', updatedAt: new Date().toISOString() })
        .where(eq(agents.id, agentId));

      // Fetch task to get the plan for execution prompt
      const task = await this.db.query.tasks.findFirst({
        where: eq(tasks.id, agent.currentTaskId),
      });

      if (!task) {
        return err(AgentErrors.EXECUTION_ERROR('Task not found for plan execution'));
      }

      // Create new AbortController for execution phase
      const controller = new AbortController();
      runningAgents.set(agentId, controller);

      // Build execution prompt from the approved plan
      const executionPrompt = task.plan
        ? `Execute the following approved plan:\n\n${task.plan}\n\nOriginal task: ${task.title}\n\nDescription: ${task.description ?? 'No description provided'}`
        : `Work on the following task:\n\nTitle: ${task.title}\n\nDescription: ${task.description ?? 'No description provided'}`;

      // Start execution asynchronously
      this.executeAgentExecution(
        agentId,
        agent.currentSessionId,
        executionPrompt,
        task,
        controller.signal
      ).catch((execErr) => {
        console.error(
          `[AgentExecutionService] Unhandled error in execution for agent ${agentId}:`,
          execErr
        );
        this.db
          .update(agents)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(agents.id, agentId));
        runningAgents.delete(agentId);
      });

      return ok({
        runId: createId(),
        status: 'planning',
        turnCount: agent.currentTurn ?? 0,
      });
    }

    // Case 2: Paused agent (turn limit) - resume with existing behavior
    if (agent.status !== 'paused') {
      return err(AgentErrors.NOT_RUNNING);
    }

    await this.db
      .update(agents)
      .set({ status: 'running', updatedAt: new Date().toISOString() })
      .where(eq(agents.id, agentId));

    if (agent.currentSessionId) {
      await this.sessionService.publish(agent.currentSessionId, {
        id: createId(),
        type: 'approval:rejected',
        timestamp: Date.now(),
        data: { feedback },
      });
    }

    return ok({
      runId: createId(),
      status: 'paused',
      turnCount: agent.currentTurn ?? 0,
    });
  }

  /**
   * Execute the agent in execution mode after plan approval.
   * Similar to executeAgentAsync() but calls runAgentExecution() instead of runAgentPlanning().
   */
  private async executeAgentExecution(
    agentId: string,
    sessionId: string,
    prompt: string,
    task: { id: string; worktreeId: string | null },
    signal: AbortSignal
  ): Promise<void> {
    // Abort signal handling is managed by stream-handler.ts which publishes agent:stopped

    let runId = createId();

    try {
      // Get agent config for model/tools/maxTurns
      const agent = await this.db.query.agents.findFirst({
        where: eq(agents.id, agentId),
      });

      if (!agent) {
        console.error(`[AgentExecutionService] Agent ${agentId} not found for execution`);
        await this.db
          .update(agents)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(agents.id, agentId));
        await this.sessionService.publish(sessionId, {
          id: createId(),
          type: 'agent:error',
          timestamp: Date.now(),
          data: { agentId, error: 'Agent not found during execution phase' },
        });
        runningAgents.delete(agentId);
        return;
      }

      // Get worktree path for cwd
      let cwd = '.';
      if (task.worktreeId) {
        const worktree = await this.db.query.worktrees.findFirst({
          where: eq(worktrees.id, task.worktreeId),
        });
        if (worktree) {
          cwd = worktree.path;
        }
      }

      // Get project for model configuration
      const project = await this.db.query.projects.findFirst({
        where: eq(projects.id, agent.projectId),
      });

      const taskModelOverride = (task as typeof task & { modelOverride?: string | null })
        .modelOverride;
      const projectConfig = project?.config as { model?: string } | null;
      const globalDefault = await getGlobalDefaultModel(this.db);

      const resolvedModel = resolveModel({
        taskModelOverride: taskModelOverride,
        agentModel: agent.config?.model,
        projectModel: projectConfig?.model,
        globalDefault,
      });

      // Create agent run for execution phase
      const [agentRun] = await this.db
        .insert(agentRuns)
        .values({
          agentId,
          taskId: task.id,
          projectId: agent.projectId,
          sessionId,
          status: 'running',
        })
        .returning();

      runId = agentRun?.id ?? runId;

      // Create agent hooks
      const hooks = createAgentHooks({
        agentId,
        sessionId,
        agentRunId: runId,
        taskId: task.id,
        projectId: agent.projectId,
        allowedTools: agent.config?.allowedTools ?? [],
        db: this.db,
        sessionService: this.sessionService,
      });

      const result = await runAgentExecution({
        agentId,
        sessionId,
        prompt,
        allowedTools: agent.config?.allowedTools ?? [],
        maxTurns: agent.config?.maxTurns ?? 50,
        model: resolvedModel,
        cwd,
        hooks,
        signal,
        sessionService: this.sessionService,
      });

      // Update agent run with result
      let dbStatus: 'completed' | 'error' | 'paused' | 'running';
      switch (result.status) {
        case 'turn_limit':
          dbStatus = 'paused';
          break;
        case 'planning':
          dbStatus = 'running';
          break;
        case 'completed':
        case 'error':
        case 'paused':
          dbStatus = result.status;
          break;
        default: {
          const _exhaustiveCheck: never = result.status;
          void _exhaustiveCheck;
          dbStatus = 'error';
        }
      }

      await this.db
        .update(agentRuns)
        .set({
          status: dbStatus,
          completedAt: new Date().toISOString(),
          turnsUsed: result.turnCount,
          errorMessage: result.error,
        })
        .where(eq(agentRuns.id, runId));

      // Update agent status based on result
      if (result.status === 'completed') {
        await this.db
          .update(agents)
          .set({
            status: 'idle',
            currentTaskId: null,
            currentSessionId: null,
            currentTurn: result.turnCount,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));

        // Move task to waiting_approval
        await this.db
          .update(tasks)
          .set({
            column: 'waiting_approval',
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, task.id));
      } else if (result.status === 'turn_limit' || result.status === 'paused') {
        await this.db
          .update(agents)
          .set({
            status: 'paused',
            currentTurn: result.turnCount,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));

        await this.db
          .update(tasks)
          .set({
            column: 'waiting_approval',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, task.id));
      } else if (result.status === 'error') {
        await this.db
          .update(agents)
          .set({
            status: 'error',
            currentTurn: result.turnCount,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));
      }

      runningAgents.delete(agentId);

      // Auto-dequeue: when agent completes execution, check for queued tasks
      if (result.status === 'completed' && this.queueService) {
        this.tryDequeueAndStart(agentId).catch((dequeueErr) => {
          console.error(
            `[AgentExecutionService] Failed to dequeue next task for agent ${agentId}:`,
            dequeueErr
          );
        });
      }
    } catch (error) {
      console.error(`[AgentExecutionService] Agent ${agentId} execution failed:`, error);

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Update agent run with error
      await this.db
        .update(agentRuns)
        .set({
          status: 'error',
          completedAt: new Date().toISOString(),
          errorMessage,
        })
        .where(eq(agentRuns.id, runId));

      const recovery = handleAgentError(error instanceof Error ? error : new Error(errorMessage), {
        agentId,
        taskId: task.id,
        maxTurns: 50,
        currentTurn: 0,
      });

      await this.db
        .update(agents)
        .set({
          status: recovery.action === 'pause' ? 'paused' : 'error',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agents.id, agentId));

      await this.sessionService.publish(sessionId, {
        id: createId(),
        type: 'agent:error',
        timestamp: Date.now(),
        data: { agentId, error: errorMessage, recovery: recovery.action },
      });

      runningAgents.delete(agentId);
    }
  }

  /**
   * Check if a project has availability for a new running agent.
   */
  async checkAvailability(projectId: string): Promise<Result<boolean, never>> {
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project) {
      return ok(false);
    }

    const runningResult = await this.getRunningCount(projectId);
    const runningCount = runningResult.ok ? runningResult.value : 0;
    return ok(runningCount < (project.maxConcurrentAgents ?? 3));
  }

  /**
   * Get the count of running agents for a specific project.
   */
  async getRunningCount(projectId: string): Promise<Result<number, never>> {
    const running = await this.db.query.agents.findMany({
      where: and(
        eq(agents.projectId, projectId),
        inArray(agents.status, ['starting', 'planning', 'running'])
      ),
    });

    return ok(running.length);
  }

  /**
   * Register a pre-tool use hook for an agent.
   */
  registerPreToolUseHook(agentId: string, hook: PreToolUseHook): void {
    const hooks = this.preToolHooks.get(agentId) ?? [];
    hooks.push(hook);
    this.preToolHooks.set(agentId, hooks);
  }

  /**
   * Register a post-tool use hook for an agent.
   */
  registerPostToolUseHook(agentId: string, hook: PostToolUseHook): void {
    const hooks = this.postToolHooks.get(agentId) ?? [];
    hooks.push(hook);
    this.postToolHooks.set(agentId, hooks);
  }

  /**
   * Check if an agent is currently running.
   */
  isRunning(agentId: string): boolean {
    return runningAgents.has(agentId);
  }

  /**
   * Try to dequeue the next queued task and auto-start the agent on it.
   * Called after an agent completes a task. Failures are logged but not propagated.
   */
  private async tryDequeueAndStart(agentId: string): Promise<void> {
    if (!this.queueService) return;

    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });

    if (!agent || agent.status !== 'idle') return;

    const dequeueResult = await this.queueService.dequeueNext(agent.projectId);
    if (!dequeueResult.ok || !dequeueResult.value) return;

    const nextTask = dequeueResult.value;
    console.log(
      `[AgentExecutionService] Auto-starting agent ${agentId} on queued task ${nextTask.id}`
    );

    // Start the agent on the dequeued task (this will move it to in_progress)
    const startResult = await this.start(agentId, nextTask.id);
    if (!startResult.ok) {
      console.warn(
        `[AgentExecutionService] Failed to auto-start agent ${agentId} on task ${nextTask.id}:`,
        startResult.error
      );
    }
  }
}
