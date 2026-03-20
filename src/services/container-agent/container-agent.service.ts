/**
 * ContainerAgentService (Facade)
 *
 * Delegates to focused sub-services while maintaining the exact same public API.
 * All existing imports continue to work via the backward-compatible re-export
 * in src/services/container-agent.service.ts.
 *
 * Sub-services:
 * - SandboxStateManager:    owns 3 Maps + 1 Set for state tracking
 * - WorktreeInitService:    worktree creation, path translation
 * - ContainerExecService:   container lifecycle management (Docker/K8s/Nomad)
 * - AgentCoreBridgeService: AgentCore start/stop, SSE bridge
 * - PlanApprovalService:    plan ready/approve/reject handlers
 */

import { eq } from 'drizzle-orm';

import { projects } from '../../db/schema';
import type { SandboxError } from '../../lib/errors/sandbox-errors.js';
import { SandboxErrors } from '../../lib/errors/sandbox-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type {
  AgentCoreProviderConfig,
  AgentCoreSandboxProvider,
} from '../../lib/sandbox/providers/agentcore-sandbox-provider.js';
import { createAgentCoreProvider } from '../../lib/sandbox/providers/agentcore-sandbox-provider.js';
import type { SandboxProvider } from '../../lib/sandbox/providers/sandbox-provider.js';
import type { Result } from '../../lib/utils/result.js';
import { err } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import type { ApiKeyService } from '../api-key.service.js';
import type { DurableStreamsService } from '../durable-streams.service.js';
import type { GitHubTokenService } from '../github-token.service.js';
import type { WorktreeService } from '../worktree.service.js';

import { AgentCoreBridgeService } from './agentcore-bridge.service.js';
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
  private agentCoreBridge: AgentCoreBridgeService;
  private planApproval: PlanApprovalService;
  private deps: ContainerAgentDeps;

  /** AgentCore sandbox provider (lazily initialized when AgentCore config is set) */
  private agentCoreProvider?: AgentCoreSandboxProvider;

  /** Optional callback invoked when an agent completes a task, for queue auto-dequeue */
  private onAgentCompleteCallback?: (projectId: string, taskId: string) => Promise<void>;

  /** Expose provider name so callers (e.g. TaskService) can tag sessions at creation */
  get providerName(): string {
    if (this.agentCoreProvider) return 'agentcore';
    return this.deps.provider.name;
  }

  constructor(
    db: Database,
    provider: SandboxProvider,
    streams: DurableStreamsService,
    apiKeyService: ApiKeyService,
    worktreeService?: WorktreeService,
    githubTokenService?: GitHubTokenService
  ) {
    if (!worktreeService) {
      log.info('WorktreeService not injected -- agents will share workspace');
    }

    this.deps = { db, provider, streams, apiKeyService, worktreeService, githubTokenService };

    // Initialize sub-services
    this.state = new SandboxStateManager();
    this.worktreeInit = new WorktreeInitService(this.deps);

    // handlePlanReady callback shared by both exec paths
    const handlePlanReady = (
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
    ) => this.planApproval.handlePlanReady(taskId, sessionId, projectId, planData);

    const getOnAgentCompleteCallback = () => this.onAgentCompleteCallback;

    this.containerExec = new ContainerExecService(
      this.deps,
      this.state,
      this.worktreeInit,
      handlePlanReady,
      getOnAgentCompleteCallback
    );

    this.agentCoreBridge = new AgentCoreBridgeService(
      this.deps,
      this.state,
      this.containerExec,
      () => this.agentCoreProvider,
      handlePlanReady,
      getOnAgentCompleteCallback
    );

    this.planApproval = new PlanApprovalService(
      this.deps,
      this.state,
      this.worktreeInit,
      (input) => this.startAgent(input),
      () => this.isAgentCoreProvider()
    );
  }

  /**
   * Set a callback to be invoked when an agent completes a task.
   */
  setOnAgentComplete(callback: (projectId: string, taskId: string) => Promise<void>): void {
    this.onAgentCompleteCallback = callback;
  }

  /**
   * Check whether the active sandbox provider is AgentCore.
   */
  private isAgentCoreProvider(): boolean {
    return this.agentCoreProvider !== undefined;
  }

  /**
   * Configure the AgentCore sandbox provider.
   */
  setAgentCoreProvider(config: AgentCoreProviderConfig): void {
    this.agentCoreProvider = createAgentCoreProvider(config);
    log.info('AgentCore provider configured', {
      data: { region: config.region, runtimeArn: config.runtimeArn },
    });
  }

  /**
   * Remove the AgentCore provider (switch back to container-based execution).
   */
  clearAgentCoreProvider(): void {
    this.agentCoreProvider = undefined;
    log.info('AgentCore provider cleared, using container exec path');
  }

  /**
   * Stop the plan cleanup interval and clean up AgentCore resources.
   */
  dispose(): void {
    this.state.dispose();
    if (this.agentCoreProvider) {
      this.agentCoreProvider.cleanup().catch((cleanupErr) => {
        log.warn('AgentCore cleanup failed', { error: cleanupErr });
      });
    }
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
      if (this.isAgentCoreProvider()) {
        const project = await this.deps.db.query.projects.findFirst({
          where: eq(projects.id, input.projectId),
        });
        if (!project) return err(SandboxErrors.PROJECT_NOT_FOUND);
        return this.agentCoreBridge.startAgentCoreAgent(input, project);
      }
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

    // AgentCore branch
    const acAgent = this.state.getRunningAgentCoreAgent(taskId);
    if (acAgent) {
      return this.agentCoreBridge.stopAgentCoreAgent(acAgent);
    }

    // Container exec branch
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
  ): { projectId: string; sessionId: string; startedAt: Date } | null {
    return this.state.getAnyRunningAgent(taskId);
  }

  /**
   * Get all running agents.
   */
  getRunningAgents(): Array<{
    taskId: string;
    projectId: string;
    sessionId: string;
    startedAt: Date;
  }> {
    const containerAgents = this.state.getAllRunningAgents().map((agent) => ({
      taskId: agent.taskId,
      projectId: agent.projectId,
      sessionId: agent.sessionId,
      startedAt: agent.startedAt,
    }));
    const agentCoreAgents = this.state.getAllRunningAgentCoreAgents().map((agent) => ({
      taskId: agent.taskId,
      projectId: agent.projectId,
      sessionId: agent.sessionId,
      startedAt: agent.startedAt,
    }));
    return [...containerAgents, ...agentCoreAgents];
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
  githubTokenService?: GitHubTokenService
): ContainerAgentService {
  return new ContainerAgentService(
    db,
    provider,
    streams,
    apiKeyService,
    worktreeService,
    githubTokenService
  );
}
