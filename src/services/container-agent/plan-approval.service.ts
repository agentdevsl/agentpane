/**
 * PlanApprovalService - Handles plan ready, approve, and reject workflows.
 *
 * Responsibilities:
 * - Store plan data when planning phase completes (handlePlanReady)
 * - Approve a plan and start execution phase (approvePlan)
 * - Reject a plan and clean up (rejectPlan)
 * - Recover plans from database after server restart (getPendingPlan)
 */

import { eq } from 'drizzle-orm';

import { tasks } from '../../db/schema';
import type { SandboxError } from '../../lib/errors/sandbox-errors.js';
import { SandboxErrors } from '../../lib/errors/sandbox-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { SandboxStateManager } from './sandbox-state.js';
import type { ContainerAgentDeps, PlanData, StartAgentInput, TaskPlanRow } from './types.js';
import type { WorktreeInitService } from './worktree-init.service.js';

const log = createLogger('PlanApprovalService');

export class PlanApprovalService {
  constructor(
    private deps: ContainerAgentDeps,
    private state: SandboxStateManager,
    private worktreeInit: WorktreeInitService,
    private startAgentFn: (input: StartAgentInput) => Promise<Result<void, SandboxError>>,
    private isAgentCoreProvider: () => boolean
  ) {}

  /**
   * Handle plan ready event from planning phase.
   * Stores the plan data for later execution when approved.
   */
  async handlePlanReady(
    taskId: string,
    sessionId: string,
    projectId: string,
    planData: {
      plan: string;
      turnCount: number;
      sdkSessionId: string;
      allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
      launchSwarm?: boolean;
      teammateCount?: number;
    },
  ): Promise<void> {
    log.info('Storing plan data for approval', {
      data: {
        taskId,
        sessionId,
        planLength: planData.plan.length,
        sdkSessionId: planData.sdkSessionId,
      },
    });

    const { db, streams } = this.deps;

    // Capture the sandbox ID from the running agent before cleanup removes it
    const runningAgent = this.state.getRunningAgent(taskId);
    if (!runningAgent) {
      log.warn(
        'Running agent not found in memory -- sandbox change detection will be disabled for this plan',
        { data: { taskId, runningAgentsSize: this.state.runningAgentCount } }
      );
    }
    const planningSandboxId = runningAgent?.sandboxId;

    // Store plan data for later execution (in-memory for fast access)
    this.state.setPendingPlan(taskId, {
      taskId,
      sessionId,
      projectId,
      plan: planData.plan,
      turnCount: planData.turnCount,
      sdkSessionId: planData.sdkSessionId,
      allowedPrompts: planData.allowedPrompts,
      launchSwarm: planData.launchSwarm,
      teammateCount: planData.teammateCount,
      sandboxId: planningSandboxId,
      createdAt: new Date(),
    });

    // Persist plan to the task record so it survives server restarts
    try {
      await db
        .update(tasks)
        .set({
          plan: planData.plan,
          planOptions: {
            sdkSessionId: planData.sdkSessionId,
            allowedPrompts: planData.allowedPrompts,
            planningSandboxId,
          },
          lastAgentStatus: 'planning',
          column: 'waiting_approval',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(tasks.id, taskId));
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.info('CRITICAL: Failed to persist plan to database', {
        data: { taskId, error: errorMessage },
      });
      this.state.deletePendingPlan(taskId);
      streams
        .publish(sessionId, 'container-agent:error', {
          taskId,
          sessionId,
          error: `Failed to persist plan: ${errorMessage}`,
          turnCount: planData.turnCount,
        })
        .catch((publishErr) => {
          log.info('Failed to publish plan DB error event', {
            data: {
              taskId,
              error: publishErr instanceof Error ? publishErr.message : String(publishErr),
            },
          });
        });

      // Clean up worktree since the plan failed to persist (Gap 4)
      const orphanedAgent = this.state.getRunningAgent(taskId);
      if (orphanedAgent?.worktreeId) {
        void this.worktreeInit.cleanupWorktree(taskId, orphanedAgent.worktreeId);
      }

      // Clean up running agent (both maps)
      this.state.deleteRunningAgent(taskId);
      this.state.deleteRunningAgentCoreAgent(taskId);
      return;
    }

    // Clean up running agent (planning phase completed -- both maps)
    this.state.deleteRunningAgent(taskId);
    this.state.deleteRunningAgentCoreAgent(taskId);

    log.info('Plan persisted and stored, waiting for approval', {
      data: {
        taskId,
        pendingPlans: this.state.pendingPlanCount,
        remainingAgents: this.state.totalRunningAgentCount,
      },
    });
  }

  /**
   * Get pending plan data for a task.
   * Checks in-memory cache first, then falls back to the database.
   */
  async getPendingPlan(taskId: string): Promise<PlanData | undefined> {
    const cached = this.state.getPendingPlan(taskId);
    if (cached) return cached;

    const { db } = this.deps;

    // Recover from database if not in memory (e.g., after server restart)
    const task = (await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    })) as unknown as TaskPlanRow | undefined;

    if (task?.plan && task.lastAgentStatus === 'planning') {
      const planOptions = task.planOptions ?? {};

      const recovered: PlanData = {
        taskId,
        sessionId: task.sessionId ?? '',
        projectId: task.projectId,
        plan: task.plan,
        turnCount: 0,
        sdkSessionId: planOptions.sdkSessionId ?? '',
        allowedPrompts: planOptions.allowedPrompts,
        sandboxId: planOptions.planningSandboxId,
        createdAt: new Date(),
      };

      // Re-cache for subsequent calls
      this.state.setPendingPlan(taskId, recovered);
      log.info('Recovered plan from database', { data: { taskId } });
      return recovered;
    }

    return undefined;
  }

  /**
   * Approve a plan and start execution phase.
   */
  async approvePlan(taskId: string): Promise<Result<void, SandboxError>> {
    const planData = await this.getPendingPlan(taskId);
    if (!planData) {
      log.info('No pending plan found', { data: { taskId } });
      return err(SandboxErrors.PLAN_NOT_FOUND(taskId));
    }

    const { db, provider, streams } = this.deps;

    // AgentCore branch
    if (this.isAgentCoreProvider()) {
      log.info('Approving plan via AgentCore path', {
        data: { taskId, sdkSessionId: planData.sdkSessionId },
      });

      try {
        await db
          .update(tasks)
          .set({ column: 'in_progress', updatedAt: new Date().toISOString() })
          .where(eq(tasks.id, taskId));
      } catch (dbErr) {
        const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
        log.info('Failed to move task to in_progress for execution (AgentCore)', {
          data: { taskId, error: errorMessage },
        });
        return err(SandboxErrors.AGENT_START_FAILED(`DB update failed: ${errorMessage}`));
      }

      this.state.deletePendingPlan(taskId);

      return this.startAgentFn({
        projectId: planData.projectId,
        taskId: planData.taskId,
        sessionId: planData.sessionId,
        prompt: planData.plan,
        phase: 'execute',
        sdkSessionId: planData.sdkSessionId || undefined,
      });
    }

    // Container exec branch: detect sandbox changes, start execution
    let effectiveSdkSessionId: string | undefined = planData.sdkSessionId || undefined;
    if (planData.sandboxId) {
      try {
        const currentSandbox = await provider.get(planData.projectId);
        if (!currentSandbox || currentSandbox.id !== planData.sandboxId) {
          log.warn('Sandbox changed since planning phase -- using fresh session', {
            data: {
              taskId,
              planningSandboxId: planData.sandboxId,
              currentSandboxId: currentSandbox?.id ?? 'none',
            },
          });
          effectiveSdkSessionId = undefined;

          await streams
            .publish(planData.sessionId, 'container-agent:message', {
              taskId,
              sessionId: planData.sessionId,
              role: 'system',
              content:
                'Sandbox container changed since planning. Agent will start a fresh session with the full plan text.',
            })
            .catch(() => {});
        }
      } catch (lookupErr) {
        log.warn('Sandbox lookup failed -- cannot verify sandbox continuity, using fresh session', {
          data: { taskId },
          error: lookupErr,
        });
        effectiveSdkSessionId = undefined;
      }
    }

    log.info('Approving plan and starting execution', {
      data: { taskId, sdkSessionId: effectiveSdkSessionId ?? '(fresh session)' },
    });

    try {
      await db
        .update(tasks)
        .set({ column: 'in_progress', updatedAt: new Date().toISOString() })
        .where(eq(tasks.id, taskId));
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.info('Failed to move task to in_progress for execution', {
        data: { taskId, error: errorMessage },
      });
      return err(SandboxErrors.AGENT_START_FAILED(`DB update failed: ${errorMessage}`));
    }

    this.state.deletePendingPlan(taskId);

    return this.startAgentFn({
      projectId: planData.projectId,
      taskId: planData.taskId,
      sessionId: planData.sessionId,
      prompt: planData.plan,
      phase: 'execute',
      sdkSessionId: effectiveSdkSessionId,
    });
  }

  /**
   * Reject a plan and clean up.
   * Moves the task back to backlog and clears plan-related fields.
   */
  async rejectPlan(taskId: string, reason?: string): Promise<Result<void, SandboxError>> {
    const existed = this.state.hasPendingPlan(taskId);
    const { db } = this.deps;

    if (!existed) {
      const task = (await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
      })) as unknown as TaskPlanRow | undefined;

      if (!task?.plan || task.lastAgentStatus !== 'planning') {
        log.info('No plan to reject', { data: { taskId } });
        return err(SandboxErrors.PLAN_NOT_FOUND(taskId));
      }
    }

    // Look up worktreeId from task before clearing fields
    const taskRecord = (await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    })) as unknown as { worktreeId?: string | null } | undefined;
    const worktreeIdToClean = taskRecord?.worktreeId;

    // DB write FIRST -- only clear in-memory on success
    try {
      await db
        .update(tasks)
        .set({
          column: 'backlog',
          plan: null,
          planOptions: null,
          lastAgentStatus: null,
          rejectionReason: reason ?? null,
          worktreeId: null,
          branch: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(tasks.id, taskId));
      log.info('Task moved to backlog and plan cleared', { data: { taskId, reason } });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.info('Failed to update task on plan rejection', {
        data: { taskId, error: errorMessage },
      });
      return err(SandboxErrors.PLAN_REJECTION_FAILED(taskId, errorMessage));
    }

    // DB succeeded -- safe to clear in-memory cache
    this.state.deletePendingPlan(taskId);

    // Clean up the worktree (async, best-effort)
    if (worktreeIdToClean) {
      void this.worktreeInit.cleanupWorktree(taskId, worktreeIdToClean);
    }

    log.info('Plan rejected successfully', { data: { taskId } });
    return ok(undefined);
  }
}
