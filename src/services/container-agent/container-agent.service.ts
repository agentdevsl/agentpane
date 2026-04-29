/**
 * ContainerAgentService (Facade)
 *
 * Delegates to focused sub-services while maintaining the exact same public API.
 * All existing imports continue to work via the backward-compatible re-export
 * in src/services/container-agent.service.ts.
 *
 * Sub-services:
 * - SandboxStateManager:    owns 2 Maps + 1 Set for state tracking
 * - WorktreeInitService:    worktree creation, path translation
 * - ContainerExecService:   container lifecycle management (Docker/K8s/Nomad)
 * - PlanApprovalService:    plan ready/approve/reject handlers
 */

import { eq } from 'drizzle-orm';

import { tasks } from '../../db/schema';
import type { SandboxError } from '../../lib/errors/sandbox-errors.js';
import { SandboxErrors } from '../../lib/errors/sandbox-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { SandboxProvider } from '../../lib/sandbox/providers/sandbox-provider.js';
import type { Result } from '../../lib/utils/result.js';
import { err } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import type { ApiKeyService } from '../api-key.service.js';
import type { DurableStreamsService } from '../durable-streams.service.js';
import type { GitHubTokenService } from '../github-token.service.js';
import type { SkillTrackingService } from '../memory/skill-tracking.service.js';
import type { WorktreeService } from '../worktree.service.js';

import { AgentReviewService } from './agent-review.service.js';
import { ContainerExecService } from './container-exec.service.js';
import { PlanApprovalService } from './plan-approval.service.js';
import { SandboxStateManager } from './sandbox-state.js';
import type { ContainerAgentDeps, PlanData, StartAgentInput } from './types.js';
import { WorktreeInitService } from './worktree-init.service.js';

const log = createLogger('ContainerAgentService');

export class ContainerAgentService {
  private state: SandboxStateManager;
  private worktreeInit: WorktreeInitService;
  private containerExec: ContainerExecService;
  private planApproval: PlanApprovalService;
  private deps: ContainerAgentDeps;

  /** Optional callback invoked when an agent completes a task, for queue auto-dequeue */
  private onAgentCompleteCallback?: (codespaceId: string, taskId: string) => Promise<void>;

  /** Expose provider name so callers (e.g. TaskService) can tag sessions at creation */
  get providerName(): string {
    return this.deps.provider.name;
  }

  constructor(
    db: Database,
    provider: SandboxProvider,
    streams: DurableStreamsService,
    apiKeyService: ApiKeyService,
    worktreeService?: WorktreeService,
    githubTokenService?: GitHubTokenService,
    skillTrackingService?: SkillTrackingService | null
  ) {
    if (!worktreeService) {
      log.info('WorktreeService not injected -- agents will share workspace');
    }

    this.deps = {
      db,
      provider,
      streams,
      apiKeyService,
      worktreeService,
      githubTokenService,
      skillTrackingService,
    };

    // Initialize sub-services
    this.state = new SandboxStateManager();
    this.worktreeInit = new WorktreeInitService(this.deps);

    // handlePlanReady callback shared by exec path
    const handlePlanReady = (
      taskId: string,
      sessionId: string,
      codespaceId: string,
      planData: {
        plan: string;
        turnCount: number;
        sdkSessionId: string;
        allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
      }
    ) => this.planApproval.handlePlanReady(taskId, sessionId, codespaceId, planData);

    const getOnAgentCompleteCallback = () => this.onAgentCompleteCallback;

    this.containerExec = new ContainerExecService(
      this.deps,
      this.state,
      this.worktreeInit,
      handlePlanReady,
      getOnAgentCompleteCallback
    );

    const agentReview = new AgentReviewService(this.deps);

    this.planApproval = new PlanApprovalService(
      this.deps,
      this.state,
      this.worktreeInit,
      (input) => this.startAgent(input),
      agentReview
    );

    // Wire circular reference: review service needs planApproval to call approvePlan()
    agentReview.setPlanApproval(this.planApproval);
  }

  /**
   * Set a callback to be invoked when an agent completes a task.
   */
  setOnAgentComplete(callback: (codespaceId: string, taskId: string) => Promise<void>): void {
    this.onAgentCompleteCallback = callback;
  }

  /**
   * SL-017: Reconcile orphaned in_progress tasks on startup.
   *
   * After a server restart no agents are running in memory, so any task
   * still marked `in_progress` is orphaned. Move them back to `backlog`
   * so they can be re-queued.
   */
  async reconcile(): Promise<void> {
    const orphaned = await this.deps.db.query.tasks.findMany({
      where: eq(tasks.column, 'in_progress'),
    });

    if (orphaned.length === 0) return;

    log.info(`Reconciling ${orphaned.length} orphaned in_progress task(s)`);

    for (const task of orphaned) {
      // Only move tasks that have no live agent in memory
      if (this.state.hasAnyRunningAgent(task.id)) continue;

      await this.deps.db
        .update(tasks)
        .set({ column: 'backlog', lastAgentStatus: null })
        .where(eq(tasks.id, task.id));

      log.info('Moved orphaned task to backlog', { data: { taskId: task.id } });
    }
  }

  /**
   * Stop the plan cleanup interval.
   */
  dispose(): void {
    this.state.dispose();
  }

  /** Start an agent for a task. */
  async startAgent(input: StartAgentInput): Promise<Result<void, SandboxError>> {
    const { taskId, phase = 'plan' } = input;
    log.info('Starting agent', { data: { taskId, phase } });

    if (this.state.hasAnyRunningAgent(taskId) || this.state.isStarting(taskId)) {
      log.info('Agent already running or starting for task', { data: { taskId } });
      return err(SandboxErrors.AGENT_ALREADY_RUNNING(taskId));
    }
    this.state.markStarting(taskId);

    try {
      return this.containerExec.startAgent(input);
    } finally {
      this.state.clearStarting(taskId);
    }
  }

  /**
   * Stop a running agent.
   */
  async stopAgent(taskId: string): Promise<Result<void, SandboxError>> {
    log.info('Stopping agent', { data: { taskId } });

    // Clear any pending plan
    this.state.deletePendingPlan(taskId);
    // Clear starting guard
    this.state.clearStarting(taskId);

    return this.containerExec.stopAgent(taskId);
  }

  /**
   * Check if an agent is running for a task.
   */
  isAgentRunning(taskId: string): boolean {
    return this.state.hasAnyRunningAgent(taskId);
  }

  /**
   * Get running agent info for a task.
   */
  getRunningAgent(
    taskId: string
  ): { codespaceId: string; sessionId: string; startedAt: Date } | null {
    return this.state.getAnyRunningAgent(taskId);
  }

  /**
   * Get all running agents.
   */
  getRunningAgents(): Array<{
    taskId: string;
    codespaceId: string;
    sessionId: string;
    startedAt: Date;
  }> {
    return this.state.getAllRunningAgents().map((agent) => ({
      taskId: agent.taskId,
      codespaceId: agent.codespaceId,
      sessionId: agent.sessionId,
      startedAt: agent.startedAt,
    }));
  }

  /**
   * Get pending plan data for a task.
   */
  async getPendingPlan(taskId: string): Promise<PlanData | undefined> {
    return this.planApproval.getPendingPlan(taskId);
  }

  /**
   * Approve a plan and start execution phase.
   */
  async approvePlan(taskId: string): Promise<Result<void, SandboxError>> {
    return this.planApproval.approvePlan(taskId);
  }

  /**
   * Reject a plan and clean up.
   */
  async rejectPlan(taskId: string, reason?: string): Promise<Result<void, SandboxError>> {
    return this.planApproval.rejectPlan(taskId, reason);
  }
}

/**
 * Create a ContainerAgentService instance.
 */
export function createContainerAgentService(
  db: Database,
  provider: SandboxProvider,
  streams: DurableStreamsService,
  apiKeyService: ApiKeyService,
  worktreeService?: WorktreeService,
  githubTokenService?: GitHubTokenService,
  skillTrackingService?: SkillTrackingService | null
): ContainerAgentService {
  return new ContainerAgentService(
    db,
    provider,
    streams,
    apiKeyService,
    worktreeService,
    githubTokenService,
    skillTrackingService
  );
}
