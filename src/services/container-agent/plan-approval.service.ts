/**
 * PlanApprovalService - Handles plan ready, approve, and reject workflows.
 *
 * Responsibilities:
 * - Store plan data when planning phase completes (handlePlanReady)
 * - Approve a plan and start execution phase (approvePlan)
 * - Reject a plan and clean up (rejectPlan)
 * - Recover plans from database after server restart (getPendingPlan)
 */

import { and, eq } from 'drizzle-orm';

import { tasks } from '../../db/schema';
import type { SandboxError } from '../../lib/errors/sandbox-errors.js';
import { SandboxErrors } from '../../lib/errors/sandbox-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import { softInvariant } from '../../lib/utils/invariant.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { AgentReviewService } from './agent-review.service.js';
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
    private isAgentCoreProvider: () => boolean,
    private agentReview?: AgentReviewService
  ) {}

  /**
   * Handle plan ready event from planning phase.
   * Stores the plan data for later execution when approved.
   */
  async handlePlanReady(
    taskId: string,
    sessionId: string,
    codespaceId: string,
    planData: {
      plan: string;
      turnCount: number;
      sdkSessionId: string;
      allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
    }
  ): Promise<void> {
    // Idempotency guard: if a plan is already pending, a duplicate plan_ready
    // event arrived — skip to avoid overwriting the first plan.
    // Synchronous in-memory check catches rapid-fire duplicates from live streams.
    if (this.state.hasPendingPlan(taskId)) {
      log.warn('Duplicate plan_ready event — plan already pending, ignoring', {
        data: { taskId },
      });
      // Still clean up running agent maps (planning phase is done)
      this.state.deleteRunningAgent(taskId);
      this.state.deleteRunningAgentCoreAgent(taskId);
      return;
    }

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
      codespaceId,
      plan: planData.plan,
      turnCount: planData.turnCount,
      sdkSessionId: planData.sdkSessionId,
      allowedPrompts: planData.allowedPrompts,
      sandboxId: planningSandboxId,
      createdAt: new Date(),
    });

    // Persist plan to the task record so it survives server restarts.
    // The column guard prevents overwriting if a duplicate event arrives after
    // the plan was already persisted (DB-level idempotency).
    try {
      const [persisted] = await db
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
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.column, 'in_progress')))
        .returning();

      if (!persisted) {
        log.warn(
          'Plan not persisted — task no longer in_progress (possible duplicate or user move)',
          {
            data: { taskId },
          }
        );
        this.state.deletePendingPlan(taskId);
        this.state.deleteRunningAgent(taskId);
        this.state.deleteRunningAgentCoreAgent(taskId);
        return;
      }
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.error('Failed to persist plan to database', {
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
          log.error('Failed to publish plan DB error event', {
            data: {
              taskId,
              error: publishErr instanceof Error ? publishErr.message : String(publishErr),
            },
          });
        });

      // Clean up worktree since the plan failed to persist (Gap 4)
      const orphanedAgent = this.state.getRunningAgent(taskId);
      if (orphanedAgent?.worktreeId) {
        this.worktreeInit.cleanupWorktree(taskId, orphanedAgent.worktreeId).catch((err) => {
          log.warn('Failed to clean up worktree', {
            error: err instanceof Error ? err.message : String(err),
            data: { taskId },
          });
        });
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

    // Check if agent review is configured for this task. The approval mode
    // resolves through task → codespace → global settings → 'human'. Emit an
    // explicit, prominent message either way so the session log makes the
    // current approval state obvious instead of leaving it implicit in the
    // task column transition (which the session view doesn't surface).
    const approvalMode = this.agentReview
      ? await this.agentReview.resolveApprovalMode(taskId)
      : 'human';

    if (approvalMode === 'agent') {
      // Surface the imminent auto-review so users see the chain
      // `plan_ready → agent reviewing → approve/flag` end-to-end.
      streams
        .publish(sessionId, 'container-agent:message', {
          taskId,
          sessionId,
          role: 'approval',
          content:
            'Plan ready. Approval mode: agent — automated review will run next; ' +
            'no human action needed unless the agent flags concerns.',
        })
        .catch((err) =>
          log.warn('Failed to publish plan_ready/agent message', {
            error: err instanceof Error ? err.message : String(err),
          })
        );

      log.info('Agent approval mode enabled — starting automated review', { data: { taskId } });
      const pendingPlan = this.state.getPendingPlan(taskId);
      if (pendingPlan) {
        this.agentReview?.reviewPlan(taskId, pendingPlan).catch((reviewErr) => {
          log.error('Agent review failed, falling back to human approval', {
            data: {
              taskId,
              error: reviewErr instanceof Error ? reviewErr.message : String(reviewErr),
            },
          });
          // Safety net: ensure task is not stuck in 'agent_reviewing' status
          this.agentReview?.resetToPlanning(taskId).catch((resetErr) => {
            log.error('Failed to reset task status after review failure', {
              data: {
                taskId,
                error: resetErr instanceof Error ? resetErr.message : String(resetErr),
              },
            });
          });
        });
      }
    } else {
      // Human approval is the default. Make the wait state explicit so the
      // session log doesn't go silent — historically users would see plan
      // text generated, then nothing, with no indication that the agent
      // was now blocked on their click.
      streams
        .publish(sessionId, 'container-agent:message', {
          taskId,
          sessionId,
          role: 'approval',
          content:
            'Plan ready. Approval mode: human — waiting for you to Approve or Reject the plan.',
        })
        .catch((err) =>
          log.warn('Failed to publish plan_ready/human message', {
            error: err instanceof Error ? err.message : String(err),
          })
        );
    }
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
        codespaceId: task.codespaceId,
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
  async approvePlan(
    taskId: string,
    approvedBy: 'user' | 'agent-review' = 'user'
  ): Promise<Result<void, SandboxError>> {
    const planData = await this.getPendingPlan(taskId);
    if (!planData) {
      log.info('No pending plan found', { data: { taskId } });
      return err(SandboxErrors.PLAN_NOT_FOUND(taskId));
    }

    const { db, provider, streams } = this.deps;

    // Skill chaining: if task has an execution skill, build a full skill-aware prompt
    // that instructs the agent to read the execution skill file and follow its workflow.
    // This mirrors the skill instructions from TaskService.buildTaskPrompt but targets
    // the chained execution skill instead of the original planning skill.
    let executionPrompt = planData.plan;
    let executionSkillId: string | null = null;
    let executionSkillName: string | null = null;
    let originalSkillId: string | null = null;
    let originalSkillName: string | null = null;

    try {
      const taskRecord = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
      if (taskRecord?.executionSkillId) {
        executionSkillId = taskRecord.executionSkillId;
        executionSkillName = taskRecord.executionSkillName;
        originalSkillId = taskRecord.skillId;
        originalSkillName = taskRecord.skillName;
        log.info('Skill chaining: switching to execution skill', {
          data: {
            taskId,
            planSkill: taskRecord.skillId,
            executionSkill: taskRecord.executionSkillId,
          },
        });

        // Build full skill-aware prompt with reading instructions, subagent directives,
        // and the approved plan as context — matching TaskService.buildTaskPrompt format
        const skillParts: string[] = [
          `IMPORTANT: Before starting any work, use the Read tool to read the file at .claude/skills/${executionSkillId}/SKILL.md`,
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
          '',
          `The following plan has been approved. Execute it using the skill workflow above:`,
          '',
          planData.plan,
        ];
        executionPrompt = skillParts.join('\n');
      }
    } catch (skillChainErr) {
      const msg = skillChainErr instanceof Error ? skillChainErr.message : String(skillChainErr);
      log.error('Skill chaining DB read failed', { data: { taskId, error: msg } });
      return err(SandboxErrors.AGENT_START_FAILED(`Skill chaining failed: ${msg}`));
    }

    // Build the atomic state transition — includes skill swap if chaining
    const transitionSet: Record<string, unknown> = {
      column: 'in_progress' as const,
      lastAgentStatus: null,
      ...(executionSkillId ? { skillId: executionSkillId, skillName: executionSkillName } : {}),
    };

    // Build the rollback — restores original skill if chaining was applied
    const rollbackSet: Record<string, unknown> = {
      column: 'waiting_approval' as const,
      lastAgentStatus: 'planning',
      ...(executionSkillId ? { skillId: originalSkillId, skillName: originalSkillName } : {}),
    };

    // AgentCore branch
    if (this.isAgentCoreProvider()) {
      log.info('Approving plan via AgentCore path', {
        data: { taskId, sdkSessionId: planData.sdkSessionId },
      });

      try {
        // Atomic: move to in_progress + swap skill in one CAS update
        const [updated] = await db
          .update(tasks)
          .set(transitionSet)
          .where(and(eq(tasks.id, taskId), eq(tasks.column, 'waiting_approval')))
          .returning();

        if (!updated) {
          this.state.deletePendingPlan(taskId);
          log.warn('Plan approval failed — task already moved from waiting_approval', {
            data: { taskId },
          });
          return err(SandboxErrors.PLAN_NOT_FOUND(taskId));
        }
      } catch (dbErr) {
        const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
        log.error('Failed to move task to in_progress for execution (AgentCore)', {
          data: { taskId, error: errorMessage },
        });
        return err(SandboxErrors.AGENT_START_FAILED(`DB update failed: ${errorMessage}`));
      }

      const startResult = await this.startAgentFn({
        codespaceId: planData.codespaceId,
        taskId: planData.taskId,
        sessionId: planData.sessionId,
        prompt: executionPrompt,
        phase: 'execute',
        sdkSessionId: planData.sdkSessionId || undefined,
      });

      if (!startResult.ok) {
        // Restore task state + original skill so user can retry approval
        try {
          const [restored] = await db
            .update(tasks)
            .set(rollbackSet)
            .where(and(eq(tasks.id, taskId), eq(tasks.column, 'in_progress')))
            .returning({ id: tasks.id });
          softInvariant(!!restored, 'task restore expected column in_progress', { taskId });
        } catch (restoreErr) {
          log.error('Failed to restore task state after agent start failure', {
            data: {
              taskId,
              error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
            },
          });
        }
        return startResult;
      }

      // Only delete plan from memory AFTER successful start
      this.state.deletePendingPlan(taskId);
      return ok(undefined);
    }

    // Container exec branch: detect sandbox changes, start execution
    let effectiveSdkSessionId: string | undefined = planData.sdkSessionId || undefined;
    if (planData.sandboxId) {
      try {
        const currentSandbox = await provider.get(planData.codespaceId);
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
            .catch((publishErr) =>
              log.warn('Failed to publish sandbox change message', {
                error: publishErr instanceof Error ? publishErr.message : String(publishErr),
              })
            );
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
      // Atomic: move to in_progress + swap skill in one CAS update
      const [updated] = await db
        .update(tasks)
        .set(transitionSet)
        .where(and(eq(tasks.id, taskId), eq(tasks.column, 'waiting_approval')))
        .returning();

      if (!updated) {
        this.state.deletePendingPlan(taskId);
        log.warn('Plan approval failed — task already moved from waiting_approval', {
          data: { taskId },
        });
        return err(SandboxErrors.PLAN_NOT_FOUND(taskId));
      }
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.error('Failed to move task to in_progress for execution', {
        data: { taskId, error: errorMessage },
      });
      return err(SandboxErrors.AGENT_START_FAILED(`DB update failed: ${errorMessage}`));
    }

    // Surface the approval transition explicitly in the session log so
    // the jump from `waiting_approval` to a running execution agent isn't
    // silent. The attribution comes from the caller — the agent-review
    // path passes 'agent-review', everywhere else (HTTP route handler,
    // CLI) gets the default 'user'. We deliberately don't read
    // `tasks.approvedBy` here because the agent-review service writes
    // that column AFTER approvePlan returns, so the row would still be
    // null at this point and the message would always claim 'user'.
    streams
      .publish(planData.sessionId, 'container-agent:message', {
        taskId,
        sessionId: planData.sessionId,
        role: 'approval',
        content: `Plan approved by ${approvedBy}. Starting execution phase.`,
      })
      .catch((err) =>
        log.warn('Failed to publish approval message', {
          error: err instanceof Error ? err.message : String(err),
        })
      );

    const startResult = await this.startAgentFn({
      codespaceId: planData.codespaceId,
      taskId: planData.taskId,
      sessionId: planData.sessionId,
      prompt: executionPrompt,
      phase: 'execute',
      sdkSessionId: effectiveSdkSessionId,
    });

    if (!startResult.ok) {
      // Restore task state + original skill so user can retry approval
      try {
        const [restored] = await db
          .update(tasks)
          .set(rollbackSet)
          .where(and(eq(tasks.id, taskId), eq(tasks.column, 'in_progress')))
          .returning({ id: tasks.id });
        softInvariant(!!restored, 'task restore expected column in_progress', { taskId });
      } catch (restoreErr) {
        log.error('Failed to restore task state after agent start failure', {
          data: {
            taskId,
            error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          },
        });
      }
      return startResult;
    }

    // Only delete plan from memory AFTER successful start
    this.state.deletePendingPlan(taskId);
    return ok(undefined);
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
    // Atomic: only reject if task still has lastAgentStatus='planning' (not yet approved)
    try {
      const [updated] = await db
        .update(tasks)
        .set({
          column: 'backlog',
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
        this.state.deletePendingPlan(taskId);
        log.info('Plan rejection failed — task no longer in planning state', {
          data: { taskId },
        });
        return err(SandboxErrors.PLAN_NOT_FOUND(taskId));
      }

      log.info('Task moved to backlog and plan cleared', { data: { taskId, reason } });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.error('Failed to update task on plan rejection', {
        data: { taskId, error: errorMessage },
      });
      return err(SandboxErrors.PLAN_REJECTION_FAILED(taskId, errorMessage));
    }

    // DB succeeded -- safe to clear in-memory cache
    this.state.deletePendingPlan(taskId);

    // Clean up the worktree (async, best-effort)
    if (worktreeIdToClean) {
      this.worktreeInit.cleanupWorktree(taskId, worktreeIdToClean).catch((err) => {
        log.warn('Failed to clean up worktree', {
          error: err instanceof Error ? err.message : String(err),
          data: { taskId },
        });
      });
    }

    log.info('Plan rejected successfully', { data: { taskId } });
    return ok(undefined);
  }
}
