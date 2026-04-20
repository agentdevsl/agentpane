import { createId } from '@paralleldrive/cuid2';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { TaskColumn } from '../../db/schema';
import { agentRuns, agents, codespaces, sessions, tasks, worktrees } from '../../db/schema';
import { handleAgentError } from '../../lib/agents/recovery.js';
import { runAgentExecution, runAgentPlanning } from '../../lib/agents/stream-handler.js';
import { ALLOW_ALL_TOOLS } from '../../lib/constants/tools.js';

import type { AgentError } from '../../lib/errors/agent-errors.js';
import { AgentErrors } from '../../lib/errors/agent-errors.js';
import type { ConcurrencyError } from '../../lib/errors/concurrency-errors.js';
import { ConcurrencyErrors } from '../../lib/errors/concurrency-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import { createAgentLifecycleMachine } from '../../lib/state-machines/agent-lifecycle/machine.js';
import type { AgentLifecycleEvent } from '../../lib/state-machines/agent-lifecycle/types.js';
import { captureException } from '../../lib/telemetry/error-sink.js';
import { errorMessage } from '../../lib/utils/error-message.js';
import { resolveModel } from '../../lib/utils/resolve-model.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import type { MemoryService, MemorySessionRef, TaskOutcome } from '../memory/index.js';
import type { SkillTrackingService } from '../memory/skill-tracking.service.js';
import { createSessionEventWithMetadata } from '../session/event-metadata.js';
import {
  DEFAULT_AGENT_MAX_RUNTIME_MS,
  getAgentMaxRuntimeMs,
  getGlobalDefaultModel,
} from '../settings.service.js';
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

const log = createLogger('AgentExecutionService');

/**
 * Validate a state machine transition before performing a DB write.
 * Returns true if the transition is valid, false otherwise.
 */
function validateTransition(
  currentStatus: string,
  event: AgentLifecycleEvent,
  context?: { maxTurns?: number; currentTurn?: number; allowedTools?: string[] }
): boolean {
  // Normalize sub-states to state machine equivalents:
  // 'starting' and 'planning' are operational sub-phases of 'running'
  const normalizedStatus =
    currentStatus === 'starting' || currentStatus === 'planning' ? 'running' : currentStatus;
  const machine = createAgentLifecycleMachine({
    status: normalizedStatus as 'idle' | 'running' | 'paused' | 'completed' | 'error',
    maxTurns: context?.maxTurns ?? 50,
    currentTurn: context?.currentTurn ?? 0,
    allowedTools: context?.allowedTools ?? [],
  });
  const result = machine.send(event);
  return result.ok;
}

/**
 * AgentExecutionService handles agent lifecycle and execution.
 *
 * Responsibilities:
 * - Start agent execution with task assignment
 * - Stop running agents
 * - Pause and resume agents
 * - Manage AbortController lifecycle
 * - Handle execution results and errors
 * - Check codespace availability for new agents
 */
export class AgentExecutionService {
  /** Cached max agent runtime for orphan sweep (refreshed on each sweep). */
  private maxAgentRuntimeMs = DEFAULT_AGENT_MAX_RUNTIME_MS; // default 4 hours; refreshed on each orphan sweep
  /** Sweep interval for orphaned agents (10 minutes) */
  private static readonly ORPHAN_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

  private runningAgents = new Map<string, AbortController>();
  private agentStartTimes = new Map<string, number>();
  private preToolHooks = new Map<string, PreToolUseHook[]>();
  private postToolHooks = new Map<string, PostToolUseHook[]>();
  /** Insight IDs injected into agent prompts, keyed by agentId. Used for skill execution tracking. */
  private agentInsightIds = new Map<string, string[]>();
  private queueService: AgentQueueService | null = null;
  private memoryService: MemoryService | null = null;
  private skillTrackingService: SkillTrackingService | null = null;
  private orphanSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private worktreeService: WorktreeService,
    _taskService: TaskService,
    private sessionService: SessionServiceInterface,
    memoryService?: MemoryService | null,
    skillTrackingService?: SkillTrackingService | null
  ) {
    this.memoryService = memoryService ?? null;
    this.skillTrackingService = skillTrackingService ?? null;
  }

  /**
   * Build an onMessage callback for memory capture if both the service and session ref are available.
   */
  private buildOnMessageCallback(
    memoryRef: MemorySessionRef | null,
    memSvc: MemoryService | null
  ):
    | ((params: {
        role: 'user' | 'assistant';
        content: string;
        turn: number;
        metadata?: Record<string, unknown>;
      }) => Promise<void>)
    | undefined {
    if (!memoryRef || !memSvc) return undefined;
    return async (params) => {
      await memSvc.captureMessage(memoryRef, {
        role: params.role,
        content: params.content,
        turnNumber: params.turn,
        metadata: params.metadata,
      });
    };
  }

  /**
   * Map SDK agent result status to the database enum value.
   */
  private mapStatusToDb(
    status: 'completed' | 'error' | 'turn_limit' | 'paused' | 'planning'
  ): 'completed' | 'error' | 'paused' | 'running' {
    switch (status) {
      case 'turn_limit':
        return 'paused';
      case 'planning':
        return 'running';
      case 'completed':
      case 'error':
      case 'paused':
        return status;
      default: {
        const _exhaustiveCheck: never = status;
        void _exhaustiveCheck;
        log.error('Unknown agent status, defaulting to error', {
          data: { status },
        });
        return 'error';
      }
    }
  }

  /**
   * Finalize a memory session (fire-and-forget), logging warnings on failure.
   */
  private finalizeMemorySession(
    memoryRef: MemorySessionRef | null,
    agentId: string,
    phase: string,
    outcome?: TaskOutcome
  ): void {
    if (!memoryRef || !this.memoryService) return;
    this.memoryService.finalizeSession(memoryRef, outcome).catch((finalizeErr) => {
      log.warn(`Failed to finalize memory session after ${phase}`, {
        error: finalizeErr instanceof Error ? finalizeErr : new Error(String(finalizeErr)),
        data: { agentId },
      });
    });
  }

  /**
   * Record skill execution for a task if it has a skillId (fire-and-forget).
   */
  private async recordSkillExecutionForTask(params: {
    taskId: string;
    agentRunId: string;
    agentId?: string;
    insightIds?: string[] | null;
    sessionId: string;
    status: 'completed' | 'error' | 'turn_limit' | 'paused' | 'planning';
    turnCount: number;
    phase?: 'planning' | 'execution';
    metrics?: {
      totalCostUsd?: number;
      durationMs?: number;
      durationApiMs?: number;
      numTurns?: number;
      inputTokens?: number;
      outputTokens?: number;
    };
    fileChanges?: { filesModified: number; linesAdded: number | null; linesRemoved: number | null };
    errorMessage?: string;
  }): Promise<void> {
    if (!this.skillTrackingService) return;
    const taskForSkill = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, params.taskId),
      columns: {
        skillId: true,
        skillName: true,
        executionSkillId: true,
        executionSkillName: true,
        codespaceId: true,
        startedAt: true,
      },
    });
    // Allow recording when either skillId or executionSkillId (for execution phase) is present
    if (!taskForSkill?.skillId && !(params.phase === 'execution' && taskForSkill?.executionSkillId))
      return;

    // When phase is 'execution' and an executionSkillId exists that differs
    // from the planning skillId, record under the execution skill instead.
    let skillId = taskForSkill.skillId;
    let skillName = taskForSkill.skillName ?? null;
    if (
      params.phase === 'execution' &&
      taskForSkill.executionSkillId &&
      taskForSkill.executionSkillId !== taskForSkill.skillId
    ) {
      skillId = taskForSkill.executionSkillId;
      skillName = taskForSkill.executionSkillName ?? null;
    }

    const insightIdsUsed = params.insightIds ?? null;

    this.recordSkillExecution({
      codespaceId: taskForSkill.codespaceId,
      taskId: params.taskId,
      agentRunId: params.agentRunId,
      sessionId: params.sessionId,
      skillId,
      skillName,
      status: params.status,
      turnCount: params.turnCount,
      metrics: params.metrics,
      fileChanges: params.fileChanges,
      errorMessage: params.errorMessage,
      startedAt: taskForSkill.startedAt,
      insightIdsUsed,
    });
  }

  /**
   * Set the queue service for auto-dequeue on agent completion.
   * This avoids circular dependency between execution and queue services.
   */
  setQueueService(queueService: AgentQueueService): void {
    this.queueService = queueService;
  }

  /**
   * Record a skill execution after an agent run completes (fire-and-forget).
   * Only records if the task has a skillId and the skill tracking service is available.
   */
  private recordSkillExecution(params: {
    codespaceId: string;
    taskId: string;
    agentRunId: string;
    sessionId: string;
    skillId: string | null;
    skillName: string | null;
    status: 'completed' | 'error' | 'turn_limit' | 'paused' | 'planning';
    turnCount: number;
    metrics?: {
      totalCostUsd?: number;
      durationMs?: number;
      durationApiMs?: number;
      numTurns?: number;
      inputTokens?: number;
      outputTokens?: number;
    };
    fileChanges?: { filesModified: number; linesAdded: number | null; linesRemoved: number | null };
    errorMessage?: string;
    startedAt?: string | null;
    insightIdsUsed?: string[] | null;
  }): void {
    if (!this.skillTrackingService || !params.skillId) return;

    let trackingStatus: 'success' | 'turn_limit' | 'failed' | null;
    switch (params.status) {
      case 'completed':
        trackingStatus = 'success';
        break;
      case 'turn_limit':
        trackingStatus = 'turn_limit';
        break;
      case 'error':
        trackingStatus = 'failed';
        break;
      default:
        trackingStatus = null;
    }

    // Only record for terminal states (completed, error, turn_limit)
    if (!trackingStatus) return;

    const svc = this.skillTrackingService;
    const now = new Date().toISOString();

    svc
      .recordExecution({
        codespaceId: params.codespaceId,
        skillId: params.skillId,
        skillName: params.skillName,
        taskId: params.taskId,
        agentRunId: params.agentRunId,
        sessionId: params.sessionId,
        status: trackingStatus,
        turnsUsed: params.metrics?.numTurns ?? params.turnCount,
        tokensUsed:
          params.metrics?.inputTokens != null || params.metrics?.outputTokens != null
            ? (params.metrics.inputTokens ?? 0) + (params.metrics.outputTokens ?? 0)
            : null,
        durationMs: params.metrics?.durationMs ?? null,
        durationApiMs: params.metrics?.durationApiMs ?? null,
        costUsd: params.metrics?.totalCostUsd ?? null,
        errorMessage: params.errorMessage ?? null,
        filesModified: params.fileChanges?.filesModified ?? null,
        linesAdded: params.fileChanges?.linesAdded ?? null,
        linesRemoved: params.fileChanges?.linesRemoved ?? null,
        insightIdsUsed: params.insightIdsUsed ?? null,
        startedAt: params.startedAt ?? null,
        completedAt: now,
      })
      .then((result) => {
        if (result.ok) {
          // Also refresh aggregated metrics
          svc.refreshMetrics(params.codespaceId, params.skillId ?? '').catch((refreshErr) => {
            log.warn('Failed to refresh skill metrics after recording', {
              error: refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr)),
              data: { skillId: params.skillId, taskId: params.taskId },
            });
          });
        } else {
          log.warn('Failed to record skill execution', {
            data: { skillId: params.skillId, taskId: params.taskId, error: result.error },
          });
        }
      })
      .catch((recordErr) => {
        log.warn('Skill execution recording threw', {
          error: recordErr instanceof Error ? recordErr : new Error(String(recordErr)),
          data: { skillId: params.skillId, taskId: params.taskId },
        });
      });
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

    // AE-004: Validate agent is in a state that allows starting
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
          eq(tasks.codespaceId, agent.codespaceId),
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
    const availability = await this.checkAvailability(agent.codespaceId);
    if (!availability.ok || !availability.value) {
      const runningResult = await this.getRunningCount(agent.codespaceId);
      const runningCount = runningResult.ok ? runningResult.value : 0;
      const codespace = await this.db.query.codespaces.findFirst({
        where: eq(codespaces.id, agent.codespaceId),
      });
      return err(
        ConcurrencyErrors.LIMIT_EXCEEDED(runningCount, codespace?.maxConcurrentAgents ?? 1)
      );
    }

    // Create worktree and session BEFORE the transaction
    // These are external service calls that must succeed before we modify DB state
    const worktree = await this.worktreeService.create({
      codespaceId: agent.codespaceId,
      agentId: agent.id,
      taskId: task.id,
      taskTitle: task.title,
    });
    if (!worktree.ok) {
      return worktree;
    }

    const session = await this.sessionService.create({
      codespaceId: agent.codespaceId,
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
          })
          .where(eq(tasks.id, task.id));

        await tx
          .update(agents)
          .set({
            status: 'starting',
            currentTaskId: task.id,
            currentSessionId: session.value.id,
            currentTurn: 0,
          })
          .where(eq(agents.id, agentId));

        const [run] = await tx
          .insert(agentRuns)
          .values({
            agentId,
            taskId: task.id,
            codespaceId: agent.codespaceId,
            sessionId: session.value.id,
            status: 'running',
          })
          .returning();

        // Set planning status within the same transaction
        await tx.update(agents).set({ status: 'planning' }).where(eq(agents.id, agentId));

        return run;
      });
    } catch (txErr) {
      log.error('Transaction failed during agent start', {
        error: txErr instanceof Error ? txErr.message : String(txErr),
        data: { agentId, taskId: task.id },
      });

      // Clean up externally created resources on transaction failure
      // 1. Remove worktree (physical git directory + DB record)
      await this.worktreeService.remove(worktree.value.id, true).catch((cleanupErr: unknown) => {
        log.error('Failed to clean up worktree after transaction failure', {
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          data: { worktreeId: worktree.value.id, agentId },
        });
      });

      // 2. Remove orphaned session record
      await this.sessionService.delete(session.value.id).catch((cleanupErr: unknown) => {
        log.error('Failed to clean up orphaned session after transaction failure', {
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          data: { sessionId: session.value.id, agentId },
        });
      });

      return err(AgentErrors.EXECUTION_ERROR('Failed to start agent: transaction error'));
    }

    await this.sessionService.publish(
      session.value.id,
      createSessionEventWithMetadata({
        sessionId: session.value.id,
        type: 'state:update',
        partType: 'lifecycle',
        blockId: agentId,
        data: { status: 'starting', agentId, taskId: task.id },
      })
    );

    const controller = new AbortController();
    this.runningAgents.set(agentId, controller);
    this.agentStartTimes.set(agentId, Date.now());

    // Get codespace for model configuration
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, agent.codespaceId),
    });

    // Resolve model using cascade priority:
    // Task.modelOverride → Agent.config.model → Project.config.model → Global setting → Default
    const taskModelOverride = (task as typeof task & { modelOverride?: string | null })
      .modelOverride;
    const codespaceConfig = codespace?.config as { model?: string } | null;

    const globalDefault = await getGlobalDefaultModel(this.db);

    const resolvedModel = resolveModel({
      taskModelOverride: taskModelOverride,
      agentModel: agent.config?.model,
      projectModel: codespaceConfig?.model,
      globalDefault,
    });

    // Build task prompt
    let taskPrompt = `Work on the following task:\n\nTitle: ${task.title}\n\nDescription: ${task.description ?? 'No description provided'}\n\nThe task is in the worktree at: ${worktree.value.path}`;

    // Inject memory context if available
    if (this.memoryService) {
      try {
        const memoryResult = await this.memoryService.getContext(
          agent.codespaceId,
          task.title ?? '',
          undefined,
          task.skillId ?? null
        );
        if (memoryResult.ok && memoryResult.value.text) {
          taskPrompt = `${taskPrompt}\n\n---\n\n${memoryResult.value.text}`;
          log.info('Memory context injected into agent prompt', {
            data: {
              agentId,
              tokenCount: memoryResult.value.tokenCount,
              sources: memoryResult.value.sources,
            },
          });

          // Track which insights were injected for skill execution recording and notify UI
          if (memoryResult.value.sources.insightIds.length > 0) {
            this.agentInsightIds.set(agentId, memoryResult.value.sources.insightIds);
            await this.sessionService.publish(
              session.value.id,
              createSessionEventWithMetadata({
                sessionId: session.value.id,
                type: 'memory:insights_injected',
                partType: 'lifecycle',
                blockId: agentId,
                data: {
                  agentId,
                  taskId: task.id,
                  codespaceId: agent.codespaceId,
                  insightIds: memoryResult.value.sources.insightIds,
                  insightCount: memoryResult.value.sources.insights,
                  tokenCount: memoryResult.value.tokenCount,
                },
              })
            );
          }
        }
      } catch (error) {
        log.warn('Failed to inject memory context, continuing without it', {
          error: error instanceof Error ? error : new Error(String(error)),
          data: { agentId },
        });
      }
    }

    // Start agent execution asynchronously (fire-and-forget with error handling)
    // The agent runs in the background and updates state through events
    void this.executeAgentAsync(
      agentId,
      session.value.id,
      taskPrompt,
      {
        // F06-06: `[]` fails closed. Fall back to ALLOW_ALL_TOOLS when no config set.
        allowedTools: agent.config?.allowedTools ?? ALLOW_ALL_TOOLS,
        maxTurns: agent.config?.maxTurns ?? 50,
        model: resolvedModel,
        cwd: worktree.value.path,
        signal: controller.signal,
      },
      agentRun?.id ?? createId(),
      task.id,
      { skillId: task.skillId, skillName: task.skillName }
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
      signal?: AbortSignal;
    },
    runId: string,
    taskId: string,
    skillContext?: { skillId?: string | null; skillName?: string | null }
  ): Promise<void> {
    // Abort signal handling is managed by stream-handler.ts which publishes agent:stopped

    // Start memory session for tracking
    let memoryRef: MemorySessionRef | null = null;
    if (this.memoryService) {
      try {
        // Resolve codespaceId from the agent record
        const agentRecord = await this.db.query.agents.findFirst({
          where: eq(agents.id, agentId),
        });
        if (agentRecord) {
          const sessionResult = await this.memoryService.startSession({
            codespaceId: agentRecord.codespaceId,
            agentId,
            taskId,
          });
          if (sessionResult) {
            memoryRef = sessionResult;
          }
        }
      } catch (error) {
        log.warn('Failed to start memory session for planning, continuing without it', {
          error: error instanceof Error ? error : new Error(String(error)),
          data: { agentId },
        });
      }
    }

    const onMessage = this.buildOnMessageCallback(memoryRef, this.memoryService);

    const maxRuntimeMs = await getAgentMaxRuntimeMs(this.db);

    try {
      const result = await runAgentPlanning({
        agentId,
        sessionId,
        prompt,
        allowedTools: options.allowedTools,
        maxTurns: options.maxTurns,
        model: options.model,
        cwd: options.cwd,
        signal: options.signal,
        maxRuntimeMs,
        skillId: skillContext?.skillId,
        skillName: skillContext?.skillName,
        sessionService: this.sessionService,
        onMessage,
      });

      this.finalizeMemorySession(memoryRef, agentId, 'planning');

      const dbStatus = this.mapStatusToDb(result.status);
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
          })
          .where(eq(agents.id, agentId));

        // theme-03 F5: persist the captured SDK session id alongside the plan
        // options so host-mode execution (TaskService.approvePlan → resume)
        // can resume the same conversation rather than reseeding full context.
        const mergedPlanOptions = {
          ...(result.planOptions ?? {}),
          ...(result.sdkSessionId ? { sdkSessionId: result.sdkSessionId } : {}),
        };

        // Store the plan and options on the task, and flip to the
        // waiting_approval state. Without this the kanban UI would not
        // surface the plan and the theme-03 F6 rejectPlanForTask guard
        // (which requires lastAgentStatus === 'planning') would never
        // match, rendering host-mode reject non-functional. Mirrors
        // PlanApprovalService.handlePlanReady for container-mode.
        await this.db
          .update(tasks)
          .set({
            plan: result.plan,
            planOptions: mergedPlanOptions,
            lastAgentStatus: 'planning',
            column: 'waiting_approval',
          })
          .where(eq(tasks.id, taskId));

        log.info('Agent planning complete, awaiting approval', {
          data: { agentId, hasSdkSessionId: !!result.sdkSessionId },
        });
      } else if (result.status === 'completed') {
        await this.db
          .update(agents)
          .set({
            status: 'idle',
            currentTaskId: null,
            currentSessionId: null,
            currentTurn: result.turnCount,
          })
          .where(eq(agents.id, agentId));

        // Move task to waiting_approval
        await this.db
          .update(tasks)
          .set({
            column: 'waiting_approval',
            completedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));
      } else if (result.status === 'turn_limit' || result.status === 'paused') {
        await this.db
          .update(agents)
          .set({
            status: 'paused',
            currentTurn: result.turnCount,
          })
          .where(eq(agents.id, agentId));

        // Move task to waiting_approval for review
        await this.db
          .update(tasks)
          .set({
            column: 'waiting_approval',
          })
          .where(eq(tasks.id, taskId));
      } else if (result.status === 'error') {
        await this.db
          .update(agents)
          .set({
            status: 'error',
            currentTurn: result.turnCount,
          })
          .where(eq(agents.id, agentId));
      }

      // Read insight IDs before cleanup deletes them (fire-and-forget race fix)
      const planInsightIds = this.agentInsightIds.get(agentId) ?? null;

      this.recordSkillExecutionForTask({
        taskId,
        agentRunId: runId,
        agentId,
        insightIds: planInsightIds,
        sessionId,
        status: result.status,
        turnCount: result.turnCount,
        metrics: result.metrics,
        fileChanges: result.fileChanges,
        errorMessage: result.error,
      }).catch((err) => {
        log.error('Failed to record skill execution', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      this.runningAgents.delete(agentId);
      this.agentStartTimes.delete(agentId);
      this.agentInsightIds.delete(agentId);
      this.preToolHooks.delete(agentId);
      this.postToolHooks.delete(agentId);

      // Auto-dequeue: when an agent completes, check if there's a queued task to pick up
      if (result.status === 'completed' && this.queueService) {
        this.tryDequeueAndStart(agentId).catch((dequeueErr) => {
          log.error('Failed to dequeue next task for agent', {
            error: dequeueErr,
            data: { agentId },
          });
        });
      }
    } catch (error) {
      log.error('Agent execution failed', { error, data: { agentId } });
      // F10-04: forward to telemetry sink with task/session/agent tags so a
      // future Sentry adapter can group the failures correctly.
      captureException(error, {
        source: 'AgentExecutionService.runPlanning',
        agentId,
        taskId,
        sessionId,
      });
      this.finalizeMemorySession(memoryRef, agentId, 'planning error', { status: 'failed' });

      const errMsg = errorMessage(error);
      const recovery = handleAgentError(error instanceof Error ? error : new Error(errMsg), {
        agentId,
        taskId,
        maxTurns: options.maxTurns,
        currentTurn: 0,
      });

      await this.db
        .update(agentRuns)
        .set({
          status: 'error',
          completedAt: new Date().toISOString(),
          errorMessage: errMsg,
        })
        .where(eq(agentRuns.id, runId));

      await this.db
        .update(agents)
        .set({
          status: recovery.action === 'pause' ? 'paused' : 'error',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agents.id, agentId));

      this.recordSkillExecutionForTask({
        taskId,
        agentRunId: runId,
        agentId,
        sessionId,
        status: 'error',
        turnCount: 0,
        errorMessage: errMsg,
      }).catch((err) => {
        log.error('Failed to record skill execution', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      await this.sessionService.publish(
        sessionId,
        createSessionEventWithMetadata({
          sessionId,
          type: 'agent:error',
          partType: 'lifecycle',
          blockId: agentId,
          data: { agentId, error: errMsg, recovery: recovery.action },
        })
      );

      this.runningAgents.delete(agentId);
      this.agentStartTimes.delete(agentId);
      this.preToolHooks.delete(agentId);
      this.postToolHooks.delete(agentId);
    }
  }

  /**
   * Stop a running agent by aborting its execution.
   */
  async stop(agentId: string): Promise<Result<void, AgentError>> {
    const controller = this.runningAgents.get(agentId);
    if (!controller) {
      return err(AgentErrors.NOT_RUNNING);
    }

    // AE-004: Validate transition via state machine
    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });
    if (agent) {
      const isValid = validateTransition(agent.status, { type: 'ABORT' });
      if (!isValid) {
        log.warn('Invalid state transition for agent abort', {
          data: { agentId, currentStatus: agent.status },
        });
        return err(AgentErrors.EXECUTION_ERROR(`Cannot abort agent in '${agent.status}' state`));
      }
    }

    controller.abort();
    this.runningAgents.delete(agentId);
    this.agentStartTimes.delete(agentId);
    this.preToolHooks.delete(agentId);
    this.postToolHooks.delete(agentId);

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

    // AE-004: Validate transition via state machine
    if (!validateTransition(agent.status, { type: 'PAUSE', reason: 'user_request' })) {
      log.warn('Invalid pause transition', { data: { agentId, status: agent.status } });
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
      this.runningAgents.set(agentId, controller);
      this.agentStartTimes.set(agentId, Date.now());

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
      ).catch(async (execErr) => {
        log.error('Unhandled error in execution for agent', {
          error: execErr,
          data: { agentId },
        });
        await this.db
          .update(agents)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(agents.id, agentId));
        this.runningAgents.delete(agentId);
        this.agentStartTimes.delete(agentId);
        this.preToolHooks.delete(agentId);
        this.postToolHooks.delete(agentId);
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

    // AE-004: Validate transition via state machine
    if (!validateTransition(agent.status, { type: 'RESUME', feedback })) {
      log.warn('Invalid resume transition', { data: { agentId, status: agent.status } });
    }

    await this.db
      .update(agents)
      .set({ status: 'running', updatedAt: new Date().toISOString() })
      .where(eq(agents.id, agentId));

    // AE-012: Renamed from 'approval:rejected' to 'agent:resumed'
    if (agent.currentSessionId) {
      await this.sessionService.publish(
        agent.currentSessionId,
        createSessionEventWithMetadata({
          sessionId: agent.currentSessionId,
          type: 'agent:resumed',
          partType: 'lifecycle',
          blockId: agentId,
          data: { feedback },
        })
      );
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
    task: {
      id: string;
      worktreeId: string | null;
      skillId?: string | null;
      skillName?: string | null;
    },
    signal: AbortSignal
  ): Promise<void> {
    // Abort signal handling is managed by stream-handler.ts which publishes agent:stopped

    let runId = createId();

    // Start memory session for execution phase tracking
    let memoryRef: MemorySessionRef | null = null;

    try {
      // Get agent config for model/tools/maxTurns
      const agent = await this.db.query.agents.findFirst({
        where: eq(agents.id, agentId),
      });

      if (!agent) {
        log.error('Agent not found for execution', { data: { agentId } });
        await this.db
          .update(agents)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(agents.id, agentId));
        await this.sessionService.publish(
          sessionId,
          createSessionEventWithMetadata({
            sessionId,
            type: 'agent:error',
            partType: 'lifecycle',
            blockId: agentId,
            data: { agentId, error: 'Agent not found during execution phase' },
          })
        );
        this.runningAgents.delete(agentId);
        this.agentStartTimes.delete(agentId);
        this.preToolHooks.delete(agentId);
        this.postToolHooks.delete(agentId);
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

      // Get codespace for model configuration
      const codespace = await this.db.query.codespaces.findFirst({
        where: eq(codespaces.id, agent.codespaceId),
      });

      const taskModelOverride = (task as typeof task & { modelOverride?: string | null })
        .modelOverride;
      const codespaceConfig = codespace?.config as { model?: string } | null;
      const globalDefault = await getGlobalDefaultModel(this.db);

      const resolvedModel = resolveModel({
        taskModelOverride: taskModelOverride,
        agentModel: agent.config?.model,
        projectModel: codespaceConfig?.model,
        globalDefault,
      });

      // Create agent run for execution phase
      const [agentRun] = await this.db
        .insert(agentRuns)
        .values({
          agentId,
          taskId: task.id,
          codespaceId: agent.codespaceId,
          sessionId,
          status: 'running',
        })
        .returning();

      runId = agentRun?.id ?? runId;

      // Start memory session for execution phase
      if (this.memoryService) {
        try {
          const memSessionResult = await this.memoryService.startSession({
            codespaceId: agent.codespaceId,
            agentId,
            taskId: task.id,
          });
          if (memSessionResult) {
            memoryRef = memSessionResult;
          }
        } catch (error) {
          log.warn('Failed to start memory session for execution, continuing without it', {
            error: error instanceof Error ? error : new Error(String(error)),
            data: { agentId },
          });
        }
      }

      const maxRuntimeMs = await getAgentMaxRuntimeMs(this.db);

      // theme-03 F5: recover the SDK session id captured during planning so
      // the execution phase can resume the same conversation. Falls back to
      // a fresh session when absent (mirrors agent-runner behaviour).
      const taskRow = await this.db.query.tasks.findFirst({
        where: eq(tasks.id, task.id),
        columns: { planOptions: true },
      });
      const storedSdkSessionId =
        (taskRow?.planOptions as { sdkSessionId?: string } | null | undefined)?.sdkSessionId ??
        undefined;

      // theme-03 F2: forward any hooks registered for this agent into the
      // stream handler. `agent/types.PreToolUseHook` and its post-hook
      // sibling are structurally compatible with the stream-handler's
      // StreamPre/PostToolUseHook — both accept {tool_name, tool_input}.
      const preHooks = this.preToolHooks.get(agentId);
      const postHooks = this.postToolHooks.get(agentId);

      const result = await runAgentExecution({
        agentId,
        sessionId,
        prompt,
        // F06-06: `[]` fails closed. Fall back to ALLOW_ALL_TOOLS when no config set.
        allowedTools: agent.config?.allowedTools ?? ALLOW_ALL_TOOLS,
        maxTurns: agent.config?.maxTurns ?? 50,
        model: resolvedModel,
        cwd,
        signal,
        maxRuntimeMs,
        skillId: task.skillId,
        skillName: task.skillName,
        sdkSessionId: storedSdkSessionId,
        preToolUseHooks: preHooks && preHooks.length > 0 ? preHooks : undefined,
        // Service-level PostToolUseHook returns Promise<void>; the stream
        // handler only cares about fire-and-forget semantics, so adapt on
        // the fly to StreamPostToolUseHook's tool_response shape.
        postToolUseHooks:
          postHooks && postHooks.length > 0
            ? postHooks.map(
                (hook) =>
                  async (input: {
                    tool_name: string;
                    tool_input: Record<string, unknown>;
                    tool_response: { summary: string; is_error: boolean };
                  }) => {
                    await hook({
                      tool_name: input.tool_name,
                      tool_input: input.tool_input,
                      tool_response: input.tool_response,
                    });
                  }
              )
            : undefined,
        sessionService: this.sessionService,
        onMessage: this.buildOnMessageCallback(memoryRef, this.memoryService),
      });

      const executionOutcome: TaskOutcome = {
        status:
          result.status === 'completed'
            ? 'success'
            : result.status === 'turn_limit'
              ? 'turn_limit'
              : 'failed',
        turnsUsed: result.turnCount,
        insightIdsUsed: this.agentInsightIds.get(agentId) ?? null,
      };
      this.finalizeMemorySession(memoryRef, agentId, 'execution', executionOutcome);

      const dbStatus = this.mapStatusToDb(result.status);
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
          })
          .where(eq(agents.id, agentId));

        // Move task to waiting_approval
        await this.db
          .update(tasks)
          .set({
            column: 'waiting_approval',
            completedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, task.id));
      } else if (result.status === 'turn_limit' || result.status === 'paused') {
        await this.db
          .update(agents)
          .set({
            status: 'paused',
            currentTurn: result.turnCount,
          })
          .where(eq(agents.id, agentId));

        await this.db
          .update(tasks)
          .set({
            column: 'waiting_approval',
          })
          .where(eq(tasks.id, task.id));
      } else if (result.status === 'error') {
        await this.db
          .update(agents)
          .set({
            status: 'error',
            currentTurn: result.turnCount,
          })
          .where(eq(agents.id, agentId));
      }

      // Read insight IDs before cleanup deletes them (fire-and-forget race fix)
      const execInsightIds = this.agentInsightIds.get(agentId) ?? null;

      this.recordSkillExecutionForTask({
        taskId: task.id,
        agentRunId: runId,
        agentId,
        insightIds: execInsightIds,
        sessionId,
        phase: 'execution',
        status: result.status,
        turnCount: result.turnCount,
        metrics: result.metrics,
        fileChanges: result.fileChanges,
        errorMessage: result.error,
      }).catch((err) => {
        log.error('Failed to record skill execution', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      this.runningAgents.delete(agentId);
      this.agentStartTimes.delete(agentId);
      this.agentInsightIds.delete(agentId);
      this.preToolHooks.delete(agentId);
      this.postToolHooks.delete(agentId);

      // Auto-dequeue: when agent completes execution, check for queued tasks
      if (result.status === 'completed' && this.queueService) {
        this.tryDequeueAndStart(agentId).catch((dequeueErr) => {
          log.error('Failed to dequeue next task for agent', {
            error: dequeueErr,
            data: { agentId },
          });
        });
      }
    } catch (error) {
      log.error('Agent execution failed', { error, data: { agentId } });
      // F10-04: forward to telemetry sink with task/session/agent tags so a
      // future Sentry adapter can group the failures correctly.
      captureException(error, {
        source: 'AgentExecutionService.runExecution',
        agentId,
        taskId: task.id,
        sessionId,
      });
      this.finalizeMemorySession(memoryRef, agentId, 'execution error', {
        status: 'failed',
      });

      const errMsg = errorMessage(error);

      await this.db
        .update(agentRuns)
        .set({
          status: 'error',
          completedAt: new Date().toISOString(),
          errorMessage: errMsg,
        })
        .where(eq(agentRuns.id, runId));

      const recovery = handleAgentError(error instanceof Error ? error : new Error(errMsg), {
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

      this.recordSkillExecutionForTask({
        taskId: task.id,
        agentRunId: runId,
        agentId,
        sessionId,
        phase: 'execution',
        status: 'error',
        turnCount: 0,
        errorMessage: errMsg,
      }).catch((err) => {
        log.error('Failed to record skill execution', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      await this.sessionService.publish(
        sessionId,
        createSessionEventWithMetadata({
          sessionId,
          type: 'agent:error',
          partType: 'lifecycle',
          blockId: agentId,
          data: { agentId, error: errMsg, recovery: recovery.action },
        })
      );

      this.runningAgents.delete(agentId);
      this.agentStartTimes.delete(agentId);
      this.preToolHooks.delete(agentId);
      this.postToolHooks.delete(agentId);
    }
  }

  /**
   * Check if a codespace has availability for a new running agent.
   */
  async checkAvailability(codespaceId: string): Promise<Result<boolean, never>> {
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespaceId),
    });

    if (!codespace) {
      return ok(false);
    }

    const runningResult = await this.getRunningCount(codespaceId);
    const runningCount = runningResult.ok ? runningResult.value : 0;
    return ok(runningCount < (codespace.maxConcurrentAgents ?? 3));
  }

  /**
   * Get the count of running agents for a specific codespace.
   * AE-009: Uses COUNT(*) aggregate instead of findMany().length to avoid race conditions.
   */
  async getRunningCount(codespaceId: string): Promise<Result<number, never>> {
    const [result] = await this.db
      .select({ count: count() })
      .from(agents)
      .where(
        and(
          eq(agents.codespaceId, codespaceId),
          inArray(agents.status, ['starting', 'planning', 'running'])
        )
      );
    return ok(result?.count ?? 0);
  }

  /**
   * theme-03 F6: host-mode plan rejection.
   *
   * Atomically:
   *   1. Stop the running agent (abort controller + status → idle),
   *   2. CAS-move the task to backlog where `lastAgentStatus='planning'`,
   *      clearing plan/planOptions/worktreeId/branch,
   *   3. Remove the worktree (best-effort).
   *
   * Returns `PLAN_NOT_FOUND` when the task is not in a rejectable state so
   * the API layer can mirror the container-mode 404. Mirrors the CAS from
   * PlanApprovalService.rejectPlan — both paths refuse to reject a task
   * that has already moved on.
   */
  async rejectPlanForTask(
    taskId: string,
    reason?: string
  ): Promise<Result<void, { code: string; message: string; status: number }>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });

    if (!task || !task.plan || task.lastAgentStatus !== 'planning') {
      return err({
        code: 'PLAN_NOT_FOUND',
        message: `No pending plan for task ${taskId}`,
        status: 404,
      });
    }

    const worktreeIdToClean = task.worktreeId ?? null;
    const agentId = task.agentId ?? null;

    // Stop the host-mode agent first so its background executeAgentAsync does
    // not race with the DB update. stop() is best-effort — if the agent is
    // already gone (crashed / never started) we proceed with cleanup anyway.
    if (agentId && this.runningAgents.has(agentId)) {
      const controller = this.runningAgents.get(agentId);
      controller?.abort();
      this.runningAgents.delete(agentId);
      this.agentStartTimes.delete(agentId);
      this.preToolHooks.delete(agentId);
      this.postToolHooks.delete(agentId);
      try {
        await this.db
          .update(agents)
          .set({
            status: 'idle',
            currentTaskId: null,
            currentSessionId: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));
      } catch (agentErr) {
        log.warn('Failed to reset agent state on plan reject (continuing)', {
          error: agentErr instanceof Error ? agentErr.message : String(agentErr),
          data: { agentId, taskId },
        });
      }
    }

    // CAS-move: only reject if the task is still in the `planning` status.
    try {
      const [updated] = await this.db
        .update(tasks)
        .set({
          column: 'backlog' as TaskColumn,
          plan: null,
          planOptions: null,
          lastAgentStatus: null,
          rejectionReason: reason ?? null,
          worktreeId: null,
          branch: null,
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.lastAgentStatus, 'planning')))
        .returning();

      if (!updated) {
        return err({
          code: 'PLAN_NOT_FOUND',
          message: `Plan rejection failed — task ${taskId} no longer in planning state`,
          status: 404,
        });
      }
    } catch (dbErr) {
      const errorMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.error('Failed to reject plan (host-mode)', { data: { taskId, error: errorMsg } });
      return err({
        code: 'PLAN_REJECTION_FAILED',
        message: `Failed to reject plan for task ${taskId}: ${errorMsg}`,
        status: 500,
      });
    }

    // Remove the worktree (best-effort, fire-and-forget)
    if (worktreeIdToClean) {
      this.worktreeService.remove(worktreeIdToClean, true).catch((rmErr) => {
        log.warn('Failed to remove worktree on host-mode plan reject', {
          error: rmErr instanceof Error ? rmErr.message : String(rmErr),
          data: { taskId, worktreeId: worktreeIdToClean },
        });
      });
    }

    log.info('Plan rejected (host-mode)', {
      data: { taskId, reason: reason ?? null, worktreeRemoved: !!worktreeIdToClean },
    });
    return ok(undefined);
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
   * Start the periodic sweep for orphaned agents.
   * Safe to call multiple times — only one timer will be created.
   */
  startOrphanSweep(): void {
    if (this.orphanSweepTimer) return;
    this.orphanSweepTimer = setInterval(() => {
      this.sweepOrphanedAgents();
    }, AgentExecutionService.ORPHAN_SWEEP_INTERVAL_MS);
  }

  /**
   * Stop the orphaned agent sweep timer for clean shutdown.
   */
  stopOrphanSweep(): void {
    if (this.orphanSweepTimer) {
      clearInterval(this.orphanSweepTimer);
      this.orphanSweepTimer = null;
    }
  }

  /**
   * Sweep agents that have been running longer than the configured max runtime.
   * Safety net for agents that crash without calling the completion handler.
   * Refreshes the max runtime from settings on each sweep.
   */
  private sweepOrphanedAgents(): void {
    // Refresh cached max runtime from settings (fire-and-forget; uses last cached value on error)
    void getAgentMaxRuntimeMs(this.db)
      .then((ms) => {
        this.maxAgentRuntimeMs = ms;
      })
      .catch((e) => {
        log.warn('Failed to refresh agent max runtime for orphan sweep, using cached value.', {
          error: e,
        });
      });

    const now = Date.now();
    for (const [agentId, startTime] of this.agentStartTimes) {
      if (now - startTime > this.maxAgentRuntimeMs) {
        log.warn('Sweeping orphaned agent', {
          data: { agentId, runtimeMs: now - startTime },
        });
        const controller = this.runningAgents.get(agentId);
        if (controller) {
          controller.abort();
          this.runningAgents.delete(agentId);
        }
        this.agentStartTimes.delete(agentId);
        this.preToolHooks.delete(agentId);
        this.postToolHooks.delete(agentId);

        // Update DB status so the agent doesn't appear running in the UI
        this.db
          .update(agents)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(agents.id, agentId))
          .catch((dbErr) => {
            log.warn('Failed to update orphaned agent status in DB', {
              error: dbErr,
              data: { agentId },
            });
          });
      }
    }
  }

  /**
   * Check if an agent is currently running.
   */
  isRunning(agentId: string): boolean {
    return this.runningAgents.has(agentId);
  }

  /**
   * Stop all running agents. Used for graceful shutdown and test cleanup.
   */
  stopAll(): void {
    for (const [, controller] of this.runningAgents) {
      controller.abort();
    }
    this.runningAgents.clear();
    this.agentStartTimes.clear();
    this.preToolHooks.clear();
    this.postToolHooks.clear();
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

    const dequeueResult = await this.queueService.dequeueNext(agent.codespaceId);
    if (!dequeueResult.ok || !dequeueResult.value) return;

    const nextTask = dequeueResult.value;
    log.info('Auto-starting agent on queued task', {
      data: { agentId, taskId: nextTask.id },
    });

    // Start the agent on the dequeued task (this will move it to in_progress)
    const startResult = await this.start(agentId, nextTask.id);
    if (!startResult.ok) {
      log.warn('Failed to auto-start agent on task', {
        data: { agentId, taskId: nextTask.id, error: startResult.error },
      });
    }
  }
}
