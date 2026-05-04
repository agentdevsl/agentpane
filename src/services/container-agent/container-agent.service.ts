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
 * - AgentCoreBridgeService: AgentCore start/stop, SSE bridge (lazy-loaded
 *                           only when `AGENTCORE_ENABLED=true`)
 * - PlanApprovalService:    plan ready/approve/reject handlers
 */

import { eq } from 'drizzle-orm';

import { codespaces, sessionEvents, sessions, tasks } from '../../db/schema';
import type { SandboxError } from '../../lib/errors/sandbox-errors.js';
import { SandboxErrors } from '../../lib/errors/sandbox-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
// theme-04 W2-D-FIX (F04-04, F04-05): AgentCore-related imports are TYPE-ONLY.
// The concrete modules (which transitively pull in `agentcore-bridge.ts`,
// `agentcore-sandbox-provider.ts`, `agentcore-sandbox-instance.ts`, the
// hand-rolled SigV4 signer, and the AWS SDK) are loaded via dynamic `import()`
// inside `setAgentCoreProvider` ONLY when `AGENTCORE_ENABLED=true`. Type
// imports are erased at compile time and contribute zero bytes to the runtime
// module graph, so when the gate is off none of the AgentCore code ships in
// the loaded graph.
import type {
  AgentCoreProviderConfig,
  AgentCoreSandboxProvider,
} from '../../lib/sandbox/providers/agentcore-sandbox-provider.js';
import type { SandboxProvider } from '../../lib/sandbox/providers/sandbox-provider.js';
import type { Result } from '../../lib/utils/result.js';
import { err } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';
import type { ApiKeyService } from '../api-key.service.js';
import type { DurableStreamsService } from '../durable-streams.service.js';
import type { GitHubTokenService } from '../github-token.service.js';
import type { SkillTrackingService } from '../memory/skill-tracking.service.js';
import type { SandboxService } from '../sandbox.service.js';
import type { WorktreeService } from '../worktree.service.js';

import { AgentReviewService } from './agent-review.service.js';
// theme-04 W2-D-FIX: AgentCoreBridgeService is intentionally TYPE-ONLY here.
// The runtime module is loaded via dynamic import inside `loadAgentCoreBridge()`,
// gated on `AGENTCORE_ENABLED=true`. The runtime import would otherwise pull
// `lib/agents/agentcore-bridge.ts` (and its transitive `agentcore-sandbox-instance`
// type re-export wires) into the loaded graph regardless of the flag.
import type { AgentCoreBridgeService } from './agentcore-bridge.service.js';
import { ContainerExecService } from './container-exec.service.js';
import { PlanApprovalService } from './plan-approval.service.js';
import { SandboxStateManager } from './sandbox-state.js';
import type { ContainerAgentDeps, PlanData, StartAgentInput } from './types.js';
import { WorktreeInitService } from './worktree-init.service.js';

const log = createLogger('ContainerAgentService');

/**
 * theme-04 P1-02 / W2-D-FIX: Feature flag for AgentCore.
 *
 * When this returns false (the default), NO AgentCore module is in the loaded
 * module graph: `agentcore-bridge.service.ts`, `agentcore-bridge.ts`,
 * `agentcore-sandbox-provider.ts`, `agentcore-sandbox-instance.ts` (which
 * contains the hand-rolled SigV4 signer ~110 LOC), and the AWS SDK are all
 * gated behind dynamic `import()` calls keyed off this flag. Set
 * `AGENTCORE_ENABLED=true` to opt in.
 */
function isAgentCoreEnabled(): boolean {
  return process.env.AGENTCORE_ENABLED === 'true';
}

export class ContainerAgentService {
  private state: SandboxStateManager;
  private worktreeInit: WorktreeInitService;
  private containerExec: ContainerExecService;
  /**
   * theme-04 W2-D-FIX (F04-04): AgentCoreBridgeService is lazily loaded.
   * Undefined until `setAgentCoreProvider()` is called with the flag enabled.
   * The constructor MUST NOT instantiate this — doing so pulls the entire
   * AgentCore module graph (including the hand-rolled SigV4 signer in
   * `agentcore-sandbox-instance.ts`) into the loaded module set regardless
   * of `AGENTCORE_ENABLED`.
   */
  private agentCoreBridge?: AgentCoreBridgeService;
  private planApproval: PlanApprovalService;
  private deps: ContainerAgentDeps;

  /**
   * Shared handlePlanReady callback used by both ContainerExecService (eager)
   * and AgentCoreBridgeService (lazy). Stored as a field so the lazy AgentCore
   * bridge can wire it up after construction without forcing an early load.
   */
  private readonly handlePlanReady: (
    taskId: string,
    sessionId: string,
    codespaceId: string,
    planData: {
      plan: string;
      turnCount: number;
      sdkSessionId: string;
      allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
    }
  ) => Promise<void>;

  /**
   * Provides access to the on-agent-complete callback. Stored as a closure so
   * the lazy AgentCore bridge can read the latest registered callback.
   */
  private readonly getOnAgentCompleteCallback: () =>
    | ((codespaceId: string, taskId: string) => Promise<void>)
    | undefined;

  /** AgentCore sandbox provider (lazily initialized when AgentCore config is set) */
  private agentCoreProvider?: AgentCoreSandboxProvider;

  /** Optional callback invoked when an agent completes a task, for queue auto-dequeue */
  private onAgentCompleteCallback?: (codespaceId: string, taskId: string) => Promise<void>;

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
    githubTokenService?: GitHubTokenService,
    skillTrackingService?: SkillTrackingService | null,
    sandboxService?: Pick<SandboxService, 'getOrCreateForCodespace'>
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
      sandboxService,
    };

    // Initialize sub-services
    this.state = new SandboxStateManager();
    this.worktreeInit = new WorktreeInitService(this.deps);

    // handlePlanReady callback shared by both exec paths
    this.handlePlanReady = (taskId, sessionId, codespaceId, planData) =>
      this.planApproval.handlePlanReady(taskId, sessionId, codespaceId, planData);

    this.getOnAgentCompleteCallback = () => this.onAgentCompleteCallback;

    this.containerExec = new ContainerExecService(
      this.deps,
      this.state,
      this.worktreeInit,
      this.handlePlanReady,
      this.getOnAgentCompleteCallback
    );

    // theme-04 W2-D-FIX: AgentCoreBridgeService is NOT instantiated here.
    // It is lazily loaded by `loadAgentCoreBridge()` from `setAgentCoreProvider()`
    // when (and only when) `AGENTCORE_ENABLED=true`. With the flag off the
    // module graph contains zero AgentCore code — no bridge service, no
    // SigV4 signer, no AWS SDK.

    const agentReview = new AgentReviewService(this.deps);

    this.planApproval = new PlanApprovalService(
      this.deps,
      this.state,
      this.worktreeInit,
      (input) => this.startAgent(input),
      () => this.isAgentCoreProvider(),
      agentReview
    );

    // Wire circular reference: review service needs planApproval to call approvePlan()
    agentReview.setPlanApproval(this.planApproval);
  }

  /**
   * theme-04 W2-D-FIX (F04-04, F04-05): Lazily load and construct the
   * AgentCoreBridgeService. The dynamic `import()` is the gate that keeps
   * `agentcore-bridge.service.ts`, `agentcore-bridge.ts`, and the SigV4
   * signer in `agentcore-sandbox-instance.ts` out of the runtime module
   * graph when `AGENTCORE_ENABLED=false`.
   *
   * Idempotent: once loaded, returns the cached instance. Returns undefined
   * (and logs) if the gate is off, so callers can short-circuit gracefully.
   */
  private async loadAgentCoreBridge(): Promise<AgentCoreBridgeService | undefined> {
    if (!isAgentCoreEnabled()) {
      log.warn('loadAgentCoreBridge called but AGENTCORE_ENABLED is not set — skipping');
      return undefined;
    }
    if (this.agentCoreBridge) {
      return this.agentCoreBridge;
    }
    const { AgentCoreBridgeService: BridgeCtor } = await import('./agentcore-bridge.service.js');
    this.agentCoreBridge = new BridgeCtor(
      this.deps,
      this.state,
      this.containerExec,
      () => this.agentCoreProvider,
      this.handlePlanReady,
      this.getOnAgentCompleteCallback
    );
    log.info('AgentCoreBridgeService lazily loaded (AGENTCORE_ENABLED=true)');
    return this.agentCoreBridge;
  }

  /**
   * Set a callback to be invoked when an agent completes a task.
   */
  setOnAgentComplete(callback: (codespaceId: string, taskId: string) => Promise<void>): void {
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
   *
   * theme-04 P1-02 / W2-D-FIX (F04-04, F04-05): This is a no-op unless
   * `AGENTCORE_ENABLED=true` is set. Both the AgentCore provider module and
   * the bridge service are loaded via dynamic import — with the flag off,
   * neither module (nor the SigV4 signer in `agentcore-sandbox-instance.ts`,
   * nor the AWS SDK) ever reaches the runtime module graph.
   */
  async setAgentCoreProvider(config: AgentCoreProviderConfig): Promise<void> {
    if (!isAgentCoreEnabled()) {
      log.warn(
        'setAgentCoreProvider called but AGENTCORE_ENABLED is not set — AgentCore is disabled',
        { data: { region: config.region } }
      );
      return;
    }
    const { createAgentCoreProvider } = await import(
      '../../lib/sandbox/providers/agentcore-sandbox-provider.js'
    );
    this.agentCoreProvider = createAgentCoreProvider(config);
    // theme-04 W2-D-FIX: load the bridge service alongside the provider so
    // both modules enter the graph together (or, with the flag off, neither
    // does). Loading is idempotent — subsequent setAgentCoreProvider calls
    // reuse the cached bridge.
    await this.loadAgentCoreBridge();
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
   * SL-017: Reconcile orphaned in_progress tasks on startup.
   *
   * After a server restart no agents are running in memory, so any task
   * still marked `in_progress` is orphaned. Move them back to `backlog`
   * so they can be re-queued, and emit synthetic `tool:result` events
   * for any in-flight `tool:start`s on the orphan's sessions — without
   * the synthetic results, the topology view keeps the tools stuck on
   * "running" forever and "Tool tracking is broken" reports follow.
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

      // Flush orphan tool starts for every session attached to this task.
      // Best-effort — failures are logged and the reconcile loop continues
      // so one stuck session doesn't block the whole startup.
      try {
        await this.flushOrphanToolStartsForTask(task.id);
      } catch (err) {
        log.warn('Failed to flush orphan tool starts for reconciled task', {
          data: { taskId: task.id },
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * For every session belonging to `taskId`, emit a synthetic
   * `tool:result` for any `tool:start` event that has no matching
   * `tool:result` (paired by `toolId`). Used by `reconcile()` to clean
   * up the visual tail-end of an abruptly-terminated agent run.
   *
   * Persists each synthetic result via the durable streams pipeline so
   * the row lands in `session_events` and survives a future page
   * refresh — the UI looks up tool start/result pairs from the same
   * table and this is the only way to flip a `RUNNING` chip to
   * `terminated` after the process is gone.
   */
  private async flushOrphanToolStartsForTask(taskId: string): Promise<void> {
    const taskSessions = await this.deps.db.query.sessions.findMany({
      where: eq(sessions.taskId, taskId),
      columns: { id: true },
    });
    for (const { id: sessionId } of taskSessions) {
      const allToolEvents = await this.deps.db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
        columns: { type: true, data: true, timestamp: true },
      });

      const seenResultIds = new Set<string>();
      const orphanStarts: Array<{
        toolId: string;
        toolName: string;
        startTimestamp: number;
      }> = [];
      for (const event of allToolEvents) {
        if (event.type === 'container-agent:tool:result') {
          const data = event.data as { toolId?: string; id?: string };
          const id = data.toolId ?? data.id;
          if (id) seenResultIds.add(id);
        }
      }
      for (const event of allToolEvents) {
        if (event.type !== 'container-agent:tool:start') continue;
        const data = event.data as {
          toolId?: string;
          id?: string;
          toolName?: string;
          tool?: string;
        };
        const toolId = data.toolId ?? data.id;
        if (!toolId || seenResultIds.has(toolId)) continue;
        orphanStarts.push({
          toolId,
          toolName: data.toolName ?? data.tool ?? 'Unknown',
          startTimestamp: typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
        });
      }

      if (orphanStarts.length === 0) continue;
      log.info('Flushing orphan tool starts for reconciled session', {
        data: { taskId, sessionId, count: orphanStarts.length },
      });

      for (const orphan of orphanStarts) {
        const durationMs = Math.max(0, Date.now() - orphan.startTimestamp);
        await this.deps.streams
          .publish(sessionId, 'container-agent:tool:result', {
            taskId,
            sessionId,
            toolId: orphan.toolId,
            toolName: orphan.toolName,
            result: 'Agent runner terminated before this tool returned',
            isError: true,
            durationMs,
          })
          .catch((publishErr) => {
            log.warn('Failed to publish synthetic tool:result', {
              data: { taskId, sessionId, toolId: orphan.toolId },
              error: publishErr instanceof Error ? publishErr.message : String(publishErr),
            });
          });
      }
    }
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
        const codespace = await this.deps.db.query.codespaces.findFirst({
          where: eq(codespaces.id, input.codespaceId),
        });
        if (!codespace) return err(SandboxErrors.PROJECT_NOT_FOUND);
        // theme-04 W2-D-FIX: bridge should already be loaded by
        // setAgentCoreProvider(); load defensively in case a caller
        // manually populated the provider via test injection.
        const bridge = await this.loadAgentCoreBridge();
        if (!bridge) {
          // AGENTCORE_ENABLED is off but a provider was somehow set — surface
          // this as an error rather than silently falling through to the
          // container exec path, which would not produce the expected
          // AgentCore semantics.
          return err(
            SandboxErrors.AGENT_START_FAILED(
              'AgentCore provider is configured but AGENTCORE_ENABLED is not set; bridge unavailable'
            )
          );
        }
        return bridge.startAgentCoreAgent(input, codespace);
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

    // AgentCore branch — `acAgent` is only ever populated by the AgentCore
    // bridge after a successful startAgentCoreAgent, so by the time we're
    // here the bridge has already been lazy-loaded. We still call
    // loadAgentCoreBridge() defensively to surface a clear error if the
    // gate is somehow off.
    const acAgent = this.state.getRunningAgentCoreAgent(taskId);
    if (acAgent) {
      const bridge = await this.loadAgentCoreBridge();
      if (!bridge) {
        return err(
          SandboxErrors.AGENT_STOP_FAILED(
            'AgentCore agent is running but AGENTCORE_ENABLED is not set; bridge unavailable'
          )
        );
      }
      return bridge.stopAgentCoreAgent(acAgent);
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
    const containerAgents = this.state.getAllRunningAgents().map((agent) => ({
      taskId: agent.taskId,
      codespaceId: agent.codespaceId,
      sessionId: agent.sessionId,
      startedAt: agent.startedAt,
    }));
    const agentCoreAgents = this.state.getAllRunningAgentCoreAgents().map((agent) => ({
      taskId: agent.taskId,
      codespaceId: agent.codespaceId,
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
  githubTokenService?: GitHubTokenService,
  skillTrackingService?: SkillTrackingService | null,
  sandboxService?: Pick<SandboxService, 'getOrCreateForCodespace'>
): ContainerAgentService {
  return new ContainerAgentService(
    db,
    provider,
    streams,
    apiKeyService,
    worktreeService,
    githubTokenService,
    skillTrackingService,
    sandboxService
  );
}
