/**
 * ContainerAgentService - Orchestrates Claude Agent SDK execution inside Docker containers.
 *
 * This service manages the lifecycle of agent processes running in sandbox containers:
 * - Starts agent-runner process via docker exec
 * - Bridges stdout events to DurableStreams
 * - Handles cancellation via sentinel files
 * - Tracks running agents per task
 */
import { eq } from 'drizzle-orm';

// Debug logging helper
const DEBUG = process.env.DEBUG_CONTAINER_AGENT === 'true' || process.env.DEBUG === 'true';

function debugLog(context: string, message: string, data?: Record<string, unknown>): void {
  if (DEBUG) {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    console.log(`[${timestamp}] [ContainerAgentService:${context}] ${message}${dataStr}`);
  }
}

function infoLog(context: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${timestamp}] [ContainerAgentService:${context}] ${message}${dataStr}`);
}

function warnLog(context: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.warn(`[${timestamp}] [ContainerAgentService:${context}] ${message}${dataStr}`);
}

import { agents, projects, sessions, tasks } from '../db/schema';
import { type ContainerBridge, createContainerBridge } from '../lib/agents/container-bridge.js';
import { DEFAULT_AGENT_MODEL, getFullModelId } from '../lib/constants/models.js';
import { CONTAINER_WORKSPACE_PATH } from '../lib/constants/sandbox.js';
import type { SandboxError } from '../lib/errors/sandbox-errors.js';
import { SandboxErrors } from '../lib/errors/sandbox-errors.js';
import type {
  ExecStreamResult,
  SandboxProvider,
} from '../lib/sandbox/providers/sandbox-provider.js';
import { SANDBOX_DEFAULTS } from '../lib/sandbox/types.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

/**
 * Shape of task row fields used by plan-related queries.
 * Avoids duplicating inline type casts across methods.
 */
interface TaskPlanRow {
  id: string;
  projectId: string;
  sessionId: string | null;
  plan: string | null;
  planOptions: {
    sdkSessionId?: string;
    allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  } | null;
  lastAgentStatus: string | null;
}

import type { ApiKeyService } from './api-key.service.js';
import type { DurableStreamsService } from './durable-streams.service.js';
import { getGlobalDefaultModel } from './settings.service.js';
import type { WorktreeService } from './worktree.service.js';

/**
 * Agent execution phase.
 */
export type AgentPhase = 'plan' | 'execute';

/**
 * Input for starting a container agent.
 */
export interface StartAgentInput {
  projectId: string;
  taskId: string;
  sessionId: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  /** Execution phase: 'plan' for planning, 'execute' for execution (default: 'plan') */
  phase?: AgentPhase;
  /** SDK session ID to resume (for execution after plan approval) */
  sdkSessionId?: string;
}

/**
 * Configuration for an agent run.
 */
export interface AgentConfig {
  model: string;
  maxTurns: number;
  allowedTools?: string[];
}

/**
 * Running agent instance.
 */
interface RunningAgent {
  taskId: string;
  sessionId: string;
  projectId: string;
  sandboxId: string;
  bridge: ContainerBridge;
  execResult: ExecStreamResult;
  stopFilePath: string;
  startedAt: Date;
  stopRequested: boolean;
  phase: AgentPhase;
  worktreeId?: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * Plan data stored after planning phase completes.
 */
export interface PlanData {
  taskId: string;
  sessionId: string;
  projectId: string;
  plan: string;
  turnCount: number;
  sdkSessionId: string;
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  createdAt: Date;
  // TODO: Pending GA — swarm features
  // launchSwarm?: boolean;
  // teammateCount?: number;
}

/** TTL for pending plans in milliseconds (1 hour) */
const PENDING_PLAN_TTL_MS = 60 * 60 * 1000;

/** Cleanup interval for expired plans (every 5 minutes) */
const PLAN_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * ContainerAgentService manages Claude Agent SDK execution inside Docker containers.
 */
export class ContainerAgentService {
  /** Map of taskId -> running agent */
  private runningAgents = new Map<string, RunningAgent>();

  /** Map of taskId -> pending plan data (awaiting approval) */
  private pendingPlans = new Map<string, PlanData>();

  /** Set of taskIds currently being started (prevents concurrent startAgent races) */
  private startingAgents = new Set<string>();

  /** Interval for cleaning up expired pending plans */
  private planCleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Expose provider name so callers (e.g. TaskService) can tag sessions at creation */
  get providerName(): string {
    return this.provider.name;
  }

  constructor(
    private db: Database,
    private provider: SandboxProvider,
    private streams: DurableStreamsService,
    private apiKeyService: ApiKeyService,
    private worktreeService?: WorktreeService
  ) {
    if (!worktreeService) {
      infoLog('constructor', 'WorktreeService not injected — agents will share workspace');
    }
    // Start periodic cleanup of expired pending plans
    this.planCleanupInterval = setInterval(() => {
      this.cleanupExpiredPlans();
    }, PLAN_CLEANUP_INTERVAL_MS);
  }

  /**
   * Clean up a worktree by removing it via WorktreeService.
   * Best-effort: logs errors but does not throw.
   */
  private async cleanupWorktree(taskId: string, worktreeId: string): Promise<void> {
    if (!this.worktreeService) {
      infoLog('cleanupWorktree', 'WorktreeService not available, skipping cleanup', {
        taskId,
        worktreeId,
      });
      return;
    }

    try {
      const result = await this.worktreeService.remove(worktreeId, true);
      if (result.ok) {
        infoLog('cleanupWorktree', 'Worktree removed', { taskId, worktreeId });
      } else {
        // Treat NOT_FOUND as success — worktree is already gone (Gap 7)
        const errorCode = (result.error as { code?: string })?.code;
        if (errorCode === 'WORKTREE_NOT_FOUND') {
          infoLog('cleanupWorktree', 'Worktree already removed (not found)', {
            taskId,
            worktreeId,
          });
        } else {
          infoLog('cleanupWorktree', 'Worktree removal returned error', {
            taskId,
            worktreeId,
            error: String(result.error),
          });
        }
      }
    } catch (removeErr) {
      infoLog('cleanupWorktree', 'Failed to remove worktree', {
        taskId,
        worktreeId,
        error: removeErr instanceof Error ? removeErr.message : String(removeErr),
      });
    }
  }

  /**
   * Translate a host filesystem path to the corresponding container path.
   * The container bind-mounts the project root at /workspace, so we replace
   * the host project path prefix with /workspace.
   */
  private translatePathForContainer(hostWorktreePath: string, hostProjectPath: string): string {
    if (hostWorktreePath.startsWith(hostProjectPath)) {
      return `${CONTAINER_WORKSPACE_PATH}${hostWorktreePath.slice(hostProjectPath.length)}`;
    }
    infoLog('translatePath', 'Path mismatch, defaulting to container workspace', {
      hostWorktreePath,
      hostProjectPath,
    });
    return CONTAINER_WORKSPACE_PATH;
  }

  /**
   * Resolve the worktree path for the agent, creating a new one
   * for planning or recovering an existing one for execution.
   */
  private async resolveWorktree(params: {
    phase: AgentPhase;
    taskId: string;
    sessionId: string;
    projectId: string;
    project: { path: string; name: string };
    task: { title: string; worktreeId: string | null };
    agentId: string;
    sandbox: { id: string };
  }): Promise<{ worktreeId?: string; worktreePath: string }> {
    const { phase, taskId, sessionId, projectId, project, task, agentId } = params;
    let worktreeId: string | undefined;
    let worktreePath = CONTAINER_WORKSPACE_PATH;

    if (this.worktreeService && phase === 'execute' && task.worktreeId) {
      try {
        const wts = await this.worktreeService.getStatus(task.worktreeId);
        if (wts.ok) {
          worktreeId = wts.value.id;
          worktreePath = this.translatePathForContainer(wts.value.path, project.path);
          infoLog('resolveWorktree', 'Recovered worktree for execution', {
            worktreeId,
            branch: wts.value.branch,
            hostPath: wts.value.path,
            containerPath: worktreePath,
          });
        } else {
          infoLog('resolveWorktree', 'Failed to recover worktree, using main workspace', {
            taskId,
            worktreeId: task.worktreeId,
            error: String(wts.error),
          });
        }
      } catch (wtErr) {
        const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
        infoLog('resolveWorktree', 'Error recovering worktree, using main workspace', {
          taskId,
          error: msg,
        });
      }
    }

    if (this.worktreeService && phase === 'plan') {
      await this.streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'creating_sandbox',
        message: 'Creating worktree...',
      });
      await this.streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content: `🌿 Creating isolated git worktree for task "${task.title}"...`,
      });

      const publishFallback = async (error: unknown): Promise<void> => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        warnLog('resolveWorktree', 'Worktree creation failed, continuing without isolation', {
          taskId,
          error: errorMsg,
        });
        await this.streams.publish(sessionId, 'container-agent:message', {
          taskId,
          sessionId,
          role: 'system',
          content: '⚠️ Could not create worktree' + ' — agent will work in main workspace',
        });
        await this.streams.publish(sessionId, 'container-agent:status', {
          taskId,
          sessionId,
          stage: 'creating_sandbox',
          message: 'Worktree creation failed' + ' — falling back to main workspace',
        });
      };

      try {
        const worktreeResult = await this.worktreeService.create(
          {
            projectId,
            agentId,
            taskId,
            taskTitle: task.title,
          },
          {
            skipEnvCopy: true,
            skipDepsInstall: true,
            skipInitScript: true,
          }
        );

        if (worktreeResult.ok) {
          worktreeId = worktreeResult.value.id;
          worktreePath = this.translatePathForContainer(worktreeResult.value.path, project.path);
          infoLog('resolveWorktree', 'Worktree created', {
            worktreeId,
            branch: worktreeResult.value.branch,
            hostPath: worktreeResult.value.path,
            containerPath: worktreePath,
          });

          try {
            await this.db
              .update(tasks)
              .set({
                worktreeId,
                branch: worktreeResult.value.branch,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(tasks.id, taskId));
          } catch (dbErr) {
            const eMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
            infoLog('resolveWorktree', 'Failed to link worktree to task (non-critical)', {
              taskId,
              worktreeId,
              error: eMsg,
            });
          }

          await this.streams.publish(sessionId, 'container-agent:worktree', {
            taskId,
            sessionId,
            worktreeId,
            branch: worktreeResult.value.branch,
            containerPath: worktreePath,
          });

          await this.streams.publish(sessionId, 'container-agent:message', {
            taskId,
            sessionId,
            role: 'system',
            content: `✅ Worktree created: branch "${worktreeResult.value.branch}"`,
          });
        } else {
          await publishFallback(worktreeResult.error);
        }
      } catch (wtErr) {
        await publishFallback(wtErr);
      }
    }

    return { worktreeId, worktreePath };
  }

  /**
   * Build environment variables and create the container bridge
   * for agent execution.
   */
  private prepareContainerExec(params: {
    taskId: string;
    sessionId: string;
    projectId: string;
    phase: AgentPhase;
    sdkSessionId?: string;
    prompt: string;
    agentConfig: AgentConfig;
    worktreePath: string;
    stopFilePath: string;
    oauthToken: string;
  }): { env: Record<string, string>; bridge: ContainerBridge } {
    const {
      taskId,
      sessionId,
      projectId,
      phase,
      sdkSessionId,
      prompt,
      agentConfig,
      worktreePath,
      stopFilePath,
    } = params;

    const env: Record<string, string> = {
      CLAUDE_OAUTH_TOKEN: '[REDACTED]',
      AGENT_TASK_ID: taskId,
      AGENT_SESSION_ID: sessionId,
      AGENT_PROMPT: prompt,
      AGENT_MAX_TURNS: String(agentConfig.maxTurns),
      AGENT_MODEL: agentConfig.model,
      AGENT_CWD: worktreePath,
      AGENT_STOP_FILE: stopFilePath,
      AGENT_PHASE: phase,
      ...(sdkSessionId ? { AGENT_SDK_SESSION_ID: sdkSessionId } : {}),
    };
    debugLog('prepareContainerExec', 'Env vars prepared', {
      ...env,
      AGENT_PROMPT: `[${prompt.length} chars]`,
      AGENT_PHASE: phase,
    });

    debugLog('prepareContainerExec', 'Creating container bridge', {
      taskId,
      sessionId,
      projectId,
      phase,
    });
    const bridge = createContainerBridge({
      taskId,
      sessionId,
      projectId,
      streams: this.streams,
      onComplete: (status, turnCount) => {
        infoLog('bridge:onComplete', 'Agent completed via bridge callback', {
          taskId,
          status,
          turnCount,
        });
        this.handleAgentComplete(taskId, status, turnCount);
      },
      onError: (error, turnCount) => {
        infoLog('bridge:onError', 'Agent error via bridge callback', { taskId, error, turnCount });
        this.handleAgentError(taskId, error, turnCount);
      },
      onPlanReady: (planData) => {
        infoLog('bridge:onPlanReady', 'Plan ready via bridge callback', {
          taskId,
          planLength: planData.plan.length,
          sdkSessionId: planData.sdkSessionId,
        });
        this.handlePlanReady(taskId, sessionId, projectId, planData);
      },
    });

    return { env, bridge };
  }

  /**
   * Clean up expired pending plans to prevent memory leaks.
   */
  private cleanupExpiredPlans(): void {
    const now = Date.now();
    const expiredTaskIds: string[] = [];

    for (const [taskId, plan] of this.pendingPlans) {
      const age = now - plan.createdAt.getTime();
      if (age > PENDING_PLAN_TTL_MS) {
        expiredTaskIds.push(taskId);
      }
    }

    for (const taskId of expiredTaskIds) {
      infoLog('cleanupExpiredPlans', 'Removing expired pending plan', {
        taskId,
        ageMinutes: Math.round(PENDING_PLAN_TTL_MS / 60000),
      });
      this.pendingPlans.delete(taskId);
    }
  }

  /**
   * Stop the plan cleanup interval (for testing or shutdown).
   */
  dispose(): void {
    if (this.planCleanupInterval) {
      clearInterval(this.planCleanupInterval);
      this.planCleanupInterval = null;
    }
  }

  /**
   * Start an agent for a task inside its project's sandbox container.
   * @param input.phase - 'plan' for planning mode (default), 'execute' for execution mode
   */
  async startAgent(input: StartAgentInput): Promise<Result<void, SandboxError>> {
    const {
      projectId,
      taskId,
      sessionId,
      prompt,
      model,
      maxTurns,
      phase = 'plan',
      sdkSessionId,
    } = input;

    infoLog('startAgent', 'Starting agent', {
      taskId,
      projectId,
      sessionId,
      model,
      maxTurns,
      phase,
      sdkSessionId: sdkSessionId ? '[set]' : undefined,
    });

    // Check if agent is already running for this task (fast, in-memory check)
    if (this.runningAgents.has(taskId)) {
      infoLog('startAgent', 'Agent already running for task', { taskId });
      return err(SandboxErrors.AGENT_ALREADY_RUNNING(taskId));
    }

    // Prevent concurrent startAgent calls for the same task (Gap 9)
    if (this.startingAgents.has(taskId)) {
      infoLog('startAgent', 'Agent start already in flight for task', { taskId });
      return err(SandboxErrors.AGENT_ALREADY_RUNNING(taskId));
    }
    this.startingAgents.add(taskId);

    try {
      // Parallel fetch: project and sandbox lookup at the same time
      const [project, initialSandbox] = await Promise.all([
        this.db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
        this.provider.get(projectId),
      ]);

      if (!project) {
        infoLog('startAgent', 'Project not found', { projectId });
        return err(SandboxErrors.PROJECT_NOT_FOUND);
      }

      // Use shared sandbox mode by default (fastest path - no per-project container creation)
      // Sandbox was already fetched in parallel above
      let sandbox = initialSandbox;

      // Auto-create sandbox if missing (K8s may not have a default yet)
      if (!sandbox) {
        infoLog('startAgent', 'No sandbox found, attempting auto-create', { projectId });
        try {
          sandbox = await this.provider.create({
            projectId,
            projectPath: project.path ?? '/workspace',
            image: SANDBOX_DEFAULTS.image,
            memoryMb: 2048,
            cpuCores: 2,
            idleTimeoutMinutes: 30,
            volumeMounts: [],
          });
          infoLog('startAgent', 'Auto-created sandbox', { projectId, sandboxId: sandbox.id });
        } catch (createErr) {
          infoLog('startAgent', 'Auto-create sandbox failed', {
            projectId,
            error: createErr instanceof Error ? createErr.message : String(createErr),
          });
          return err(SandboxErrors.CONTAINER_NOT_FOUND);
        }
      }

      infoLog('startAgent', 'Sandbox ready', { sandboxId: sandbox.id, status: sandbox.status });

      if (sandbox.status !== 'running') {
        infoLog('startAgent', 'Sandbox not running', {
          sandboxId: sandbox.id,
          status: sandbox.status,
        });
        return err(SandboxErrors.CONTAINER_NOT_RUNNING);
      }

      // Check if sandbox supports streaming exec
      if (!sandbox.execStream) {
        infoLog('startAgent', 'Sandbox does not support streaming exec', { sandboxId: sandbox.id });
        return err(SandboxErrors.STREAMING_EXEC_NOT_SUPPORTED);
      }

      // Fetch task to get title for session
      const task = await this.db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
      });

      // Validate task exists before proceeding
      if (!task) {
        infoLog('startAgent', 'Task not found', { taskId });
        return err(SandboxErrors.TASK_NOT_FOUND(taskId));
      }

      // Create or reuse agent record for this container agent run
      // This allows the UI to track active agents
      const agentId = `agent-${taskId}`;
      debugLog('startAgent', 'Creating agent record', { agentId, projectId, taskId });
      try {
        await this.db
          .insert(agents)
          .values({
            id: agentId,
            projectId,
            name: `Container Agent`,
            type: 'task',
            status: 'starting',
            currentTaskId: taskId,
            currentSessionId: sessionId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .onConflictDoUpdate({
            target: agents.id,
            set: {
              status: 'starting',
              currentTaskId: taskId,
              currentSessionId: sessionId,
              updatedAt: new Date().toISOString(),
            },
          });
        debugLog('startAgent', 'Agent record created/updated', { agentId });
      } catch (dbErr) {
        const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
        infoLog('startAgent', 'Failed to create agent record', {
          agentId,
          error: errorMessage,
        });
        return err(SandboxErrors.AGENT_RECORD_FAILED(errorMessage));
      }

      // Create database session record for this container agent run
      debugLog('startAgent', 'Creating session record', { sessionId, taskId });
      try {
        await this.db
          .insert(sessions)
          .values({
            id: sessionId,
            projectId,
            taskId,
            agentId,
            title: task.title ?? `Container Agent - ${taskId}`,
            url: `/projects/${projectId}/sessions/${sessionId}`,
            status: 'active',
            sandboxProvider: this.provider.name,
            createdAt: new Date().toISOString(),
          })
          .onConflictDoUpdate({
            target: sessions.id,
            set: {
              sandboxProvider: this.provider.name,
              agentId,
            },
          });
        debugLog('startAgent', 'Session record created/updated', {
          sessionId,
          sandboxProvider: this.provider.name,
        });
      } catch (dbErr) {
        const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
        infoLog('startAgent', 'Failed to create session record', {
          sessionId,
          taskId,
          error: errorMessage,
        });
        return err(SandboxErrors.SESSION_CREATE_FAILED(errorMessage));
      }

      // Link agent and session to task
      debugLog('startAgent', 'Linking agent and session to task', { taskId, agentId, sessionId });
      try {
        await this.db
          .update(tasks)
          .set({
            agentId,
            sessionId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));
        debugLog('startAgent', 'Task linked to agent and session', { taskId });
      } catch (dbErr) {
        const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
        infoLog('startAgent', 'Failed to link task to agent/session', {
          taskId,
          error: errorMessage,
        });
        // Continue anyway - linking is non-critical
      }

      // Create durable stream for real-time events
      debugLog('startAgent', 'Creating durable stream', { sessionId });
      try {
        await this.streams.createStream(sessionId, {
          type: 'container-agent',
          projectId,
          taskId,
        });
        debugLog('startAgent', 'Stream created successfully', { sessionId });
      } catch (streamErr) {
        const errorMessage = streamErr instanceof Error ? streamErr.message : String(streamErr);
        // Only ignore "already exists" errors
        if (!errorMessage.includes('already exists') && !errorMessage.includes('duplicate')) {
          infoLog('startAgent', 'Failed to create durable stream', {
            sessionId,
            error: errorMessage,
          });
          return err(SandboxErrors.STREAM_CREATE_FAILED(errorMessage));
        }
        debugLog('startAgent', 'Stream already exists, continuing', { sessionId });
      }

      // Publish initial status event (awaited to ensure stream is working)
      try {
        await this.streams.publish(sessionId, 'container-agent:status', {
          taskId,
          sessionId,
          stage: 'initializing',
          message: 'Starting...',
        });
        debugLog('startAgent', 'Initial status event published', { sessionId });
      } catch (publishErr) {
        const errorMessage = publishErr instanceof Error ? publishErr.message : String(publishErr);
        infoLog('startAgent', 'Failed to publish initial status event - aborting agent start', {
          sessionId,
          error: errorMessage,
        });
        return err(SandboxErrors.STREAM_PUBLISH_FAILED(errorMessage));
      }

      // Stage: Validating - verify project and sandbox configuration
      await this.streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'validating',
        message: 'Validating configuration...',
      });
      await this.streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content: `🔍 Validating project configuration for "${project.name}"...`,
      });
      infoLog('startAgent', 'Validating project configuration', { projectId, taskId });

      // Resolve agent configuration
      // Model cascade: explicit param → project config → global default_model setting → hardcoded default
      // All values are expanded to full API model IDs (e.g. 'claude-opus-4-5-20251101')
      const projectModel = project.config?.model as string | undefined;
      const resolvedModel =
        (model ? getFullModelId(model) : undefined) ??
        (projectModel ? getFullModelId(projectModel) : undefined) ??
        (await getGlobalDefaultModel(this.db));
      const agentConfig: AgentConfig = {
        model: resolvedModel ?? getFullModelId(DEFAULT_AGENT_MODEL),
        maxTurns: maxTurns ?? project.config?.maxTurns ?? 50,
      };
      infoLog('startAgent', 'Resolved agent config', {
        model: agentConfig.model,
        maxTurns: agentConfig.maxTurns,
      });

      await this.streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content: `✅ Configuration validated: model=${agentConfig.model}, maxTurns=${agentConfig.maxTurns}`,
      });
      infoLog('startAgent', 'Sandbox validated', {
        sandboxId: sandbox.id,
        status: sandbox.status,
        containerId: sandbox.containerId?.slice(0, 12),
      });

      // Create sentinel file path for cancellation
      const stopFilePath = `/tmp/.agent-stop-${taskId}`;

      // Clear any stale stop file from a previous run of the same task
      // Without this, re-running a task (e.g. after plan approval) can immediately
      // self-cancel if the previous run's stop file wasn't cleaned up in time
      try {
        await sandbox.exec('rm', ['-f', stopFilePath]);
      } catch (cleanupErr) {
        debugLog('startAgent', 'Failed to clean stale stop file (best effort)', {
          stopFilePath,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }

      // Stage: Credentials - get OAuth token
      await this.streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'credentials',
        message: 'Authenticating...',
      });
      await this.streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content: '🔑 Retrieving OAuth credentials...',
      });
      infoLog('startAgent', 'Retrieving OAuth credentials', { taskId });

      // Get OAuth token from database (via ApiKeyService)
      // The Claude Agent SDK requires OAuth tokens to be written to ~/.claude/.credentials.json
      // We pass it via CLAUDE_OAUTH_TOKEN env var, and agent-runner writes the credentials file
      let oauthToken: string | null = null;
      try {
        oauthToken = await this.apiKeyService.getDecryptedKey('anthropic');
        infoLog('startAgent', 'Retrieved OAuth token from database', {
          hasToken: !!oauthToken,
          isOAuth: oauthToken?.startsWith('sk-ant-oat') ?? false,
        });
      } catch (keyErr) {
        infoLog('startAgent', 'Failed to get OAuth token from database', {
          error: keyErr instanceof Error ? keyErr.message : String(keyErr),
        });
      }

      // Fall back to environment variable if not in database
      if (!oauthToken) {
        oauthToken = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? null;
        if (oauthToken) {
          infoLog('startAgent', 'Using OAuth token from environment variable');
        }
      }

      if (!oauthToken) {
        infoLog('startAgent', 'No OAuth token available');
        await this.streams.publish(sessionId, 'container-agent:message', {
          taskId,
          sessionId,
          role: 'system',
          content: '❌ No OAuth token configured. Please add your Anthropic API key in Settings.',
        });
        return err(SandboxErrors.API_KEY_NOT_CONFIGURED);
      }

      await this.streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content: '✅ OAuth credentials retrieved successfully',
      });

      // Stage: Creating Sandbox - ensure container is ready
      await this.streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'creating_sandbox',
        message: 'Preparing sandbox...',
      });
      const containerShort = sandbox.containerId?.slice(0, 12) ?? 'unknown';
      await this.streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content: `📦 Preparing sandbox container (${containerShort})...`,
      });
      infoLog('startAgent', 'Preparing sandbox environment', {
        sandboxId: sandbox.id,
        containerId: containerShort,
      });

      // Sandbox is confirmed running (early return at top of method guards non-running state)
      await this.streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content: '✅ Sandbox container ready',
      });

      // Stage: Worktree - create or recover isolated worktree
      // K8s pods don't have host filesystem mounts, so worktrees (created on the host)
      // are not accessible inside the pod. Skip worktree for kubernetes provider.
      const isK8sProvider = this.provider.name === 'kubernetes';
      const { worktreeId, worktreePath } = isK8sProvider
        ? { worktreeId: undefined, worktreePath: CONTAINER_WORKSPACE_PATH }
        : await this.resolveWorktree({
            phase,
            taskId,
            sessionId,
            projectId,
            project,
            task,
            agentId,
            sandbox,
          });

      // Build env vars and create container bridge
      const { env, bridge } = this.prepareContainerExec({
        taskId,
        sessionId,
        projectId,
        phase,
        sdkSessionId,
        prompt,
        agentConfig,
        worktreePath,
        stopFilePath,
        oauthToken,
      });

      // Await status event for persistence (critical for UI breadcrumbs)
      await this.streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'executing',
        message: phase === 'plan' ? 'Planning...' : 'Executing...',
      });
      await this.streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content:
          phase === 'plan'
            ? `🧠 Starting planning phase with ${agentConfig.model}...`
            : `⚡ Starting execution phase with ${agentConfig.model}...`,
      });

      try {
        // Start the agent-runner process inside the container
        infoLog('startAgent', 'Executing agent-runner in container', {
          sandboxId: sandbox.id,
          cmd: 'node /opt/agent-runner/dist/index.js',
        });

        const execResult = await sandbox.execStream({
          cmd: 'node',
          args: ['/opt/agent-runner/dist/index.js'],
          env: {
            ...env,
            CLAUDE_OAUTH_TOKEN: oauthToken, // Passed to agent-runner to write credentials file
            AGENT_PROMPT: prompt, // Use actual prompt
          },
          cwd: worktreePath,
        });
        debugLog('startAgent', 'Agent-runner process started', { sandboxId: sandbox.id });

        // Track the running agent
        const runningAgent: RunningAgent = {
          taskId,
          sessionId,
          projectId,
          sandboxId: sandbox.id,
          bridge,
          execResult,
          stopFilePath,
          startedAt: new Date(),
          stopRequested: false,
          phase,
          worktreeId,
        };

        this.runningAgents.set(taskId, runningAgent);

        // Set a maximum runtime timeout to prevent runaway agents
        const maxRuntimeMs = Number(process.env.AGENT_MAX_RUNTIME_MS) || 2 * 60 * 60 * 1000;
        runningAgent.timeoutHandle = setTimeout(() => {
          infoLog('startAgent', 'Agent exceeded max runtime, stopping', {
            taskId,
            maxRuntimeMs,
          });
          this.stopAgent(taskId);
        }, maxRuntimeMs);
        runningAgent.timeoutHandle.unref();

        infoLog('startAgent', 'Agent registered as running', {
          taskId,
          totalRunning: this.runningAgents.size,
        });

        // Update agent status to 'running' in database
        try {
          await this.db
            .update(agents)
            .set({
              status: phase === 'plan' ? 'planning' : 'running',
              updatedAt: new Date().toISOString(),
            })
            .where(eq(agents.id, agentId));
          debugLog('startAgent', 'Agent status updated to running', { agentId, phase });
        } catch (dbErr) {
          const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
          infoLog('startAgent', 'Failed to update agent status', { agentId, error: errorMessage });
          // Non-critical, continue
        }

        // Start processing the stdout stream (async, don't await)
        debugLog('startAgent', 'Starting stdout stream processing', { taskId });
        this.processAgentOutput(runningAgent);

        // Await critical status events for persistence
        await this.streams.publish(sessionId, 'container-agent:status', {
          taskId,
          sessionId,
          stage: 'running',
          message: 'Running',
        });
        await this.streams.publish(sessionId, 'container-agent:started', {
          taskId,
          sessionId,
          model: agentConfig.model,
          maxTurns: agentConfig.maxTurns,
          sandboxProvider: this.provider.name,
        });
        infoLog('startAgent', 'Agent started', { taskId, sessionId });

        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        infoLog('startAgent', 'Failed to start agent', { taskId, error: message });

        // Clean up worktree if it was created but agent failed to start (Gap 1)
        if (worktreeId) {
          await this.cleanupWorktree(taskId, worktreeId);
        }

        return err(SandboxErrors.AGENT_START_FAILED(message));
      }
    } finally {
      this.startingAgents.delete(taskId);
    }
  }

  /**
   * Stop a running agent by writing a sentinel file.
   */
  async stopAgent(taskId: string): Promise<Result<void, SandboxError>> {
    infoLog('stopAgent', 'Stopping agent', { taskId });

    const agent = this.runningAgents.get(taskId);
    if (!agent) {
      infoLog('stopAgent', 'Agent not found in running agents', {
        taskId,
        runningAgents: Array.from(this.runningAgents.keys()),
      });
      return err(SandboxErrors.AGENT_NOT_RUNNING(taskId));
    }

    debugLog('stopAgent', 'Found running agent', {
      taskId,
      sessionId: agent.sessionId,
      sandboxId: agent.sandboxId,
      runningFor: `${Date.now() - agent.startedAt.getTime()}ms`,
    });

    try {
      // Get the sandbox to write the sentinel file
      debugLog('stopAgent', 'Getting sandbox to write sentinel file', {
        sandboxId: agent.sandboxId,
      });
      const sandbox = await this.provider.getById(agent.sandboxId);
      if (sandbox && sandbox.status === 'running') {
        // Write sentinel file to signal agent to stop
        debugLog('stopAgent', 'Writing sentinel file', { stopFilePath: agent.stopFilePath });
        await sandbox.exec('touch', [agent.stopFilePath]);
      } else {
        debugLog('stopAgent', 'Sandbox not available for sentinel file', {
          sandboxExists: !!sandbox,
          status: sandbox?.status,
        });
      }

      // Kill the exec process and wait for cleanup
      debugLog('stopAgent', 'Killing exec process', { taskId });
      try {
        await agent.execResult.kill();
      } catch (killError) {
        // HTTP 101 errors can occur during Docker exec termination - this is expected
        // The process is still terminated, we just couldn't inspect it cleanly
        const killMessage = killError instanceof Error ? killError.message : String(killError);
        debugLog('stopAgent', 'Exec kill completed with warning', { taskId, warning: killMessage });
      }

      agent.stopRequested = true;

      // Safety-net worktree cleanup (Gap 3): if stream processing fails or
      // the container is force-killed, handleAgentComplete may never fire.
      // cleanupWorktree is idempotent — safe to call even if handleAgentComplete also cleans up.
      if (agent.worktreeId) {
        await this.cleanupWorktree(taskId, agent.worktreeId);
      }

      // Publish cancelled event
      await this.streams.publish(agent.sessionId, 'container-agent:cancelled', {
        taskId,
        sessionId: agent.sessionId,
        turnCount: 0, // Unknown at this point
      });

      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      infoLog('stopAgent', 'Failed to stop agent', { taskId, error: message });
      return err(SandboxErrors.AGENT_STOP_FAILED(message));
    }
  }

  /**
   * Check if an agent is running for a task.
   */
  isAgentRunning(taskId: string): boolean {
    return this.runningAgents.has(taskId);
  }

  /**
   * Get running agent info for a task.
   */
  getRunningAgent(
    taskId: string
  ): { projectId: string; sessionId: string; startedAt: Date } | null {
    const agent = this.runningAgents.get(taskId);
    if (!agent) {
      return null;
    }

    return {
      projectId: agent.projectId,
      sessionId: agent.sessionId,
      startedAt: agent.startedAt,
    };
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
    return Array.from(this.runningAgents.values()).map((agent) => ({
      taskId: agent.taskId,
      projectId: agent.projectId,
      sessionId: agent.sessionId,
      startedAt: agent.startedAt,
    }));
  }

  /**
   * Process stdout from the agent-runner process.
   */
  private async processAgentOutput(agent: RunningAgent): Promise<void> {
    debugLog('processAgentOutput', 'Starting to process agent output', {
      taskId: agent.taskId,
      sessionId: agent.sessionId,
      sandboxId: agent.sandboxId,
    });

    // Process stderr through the bridge to capture JSON error events
    // The agent-runner writes error events to stderr as a fallback when stdout fails (e.g., EPIPE)
    // This is critical for surfacing initialization errors to the UI
    agent.bridge.processStderr(agent.execResult.stderr);

    try {
      // Process the stdout stream through the bridge
      debugLog('processAgentOutput', 'Processing stdout stream through bridge', {
        taskId: agent.taskId,
      });
      await agent.bridge.processStream(agent.execResult.stdout);
      debugLog('processAgentOutput', 'Bridge finished processing stream', { taskId: agent.taskId });

      // Wait for process to exit
      debugLog('processAgentOutput', 'Waiting for process to exit', { taskId: agent.taskId });
      const { exitCode } = await agent.execResult.wait();
      infoLog('processAgentOutput', 'Process exited', { taskId: agent.taskId, exitCode });

      if (this.runningAgents.has(agent.taskId)) {
        if (agent.stopRequested) {
          infoLog('processAgentOutput', 'Agent stopped via cancellation request', {
            taskId: agent.taskId,
            exitCode,
          });
          await this.handleAgentComplete(agent.taskId, 'cancelled', 0);
          return;
        }

        const errorMessage =
          exitCode === 0
            ? 'Agent exited without emitting a completion event'
            : `Agent process exited with code ${exitCode}`;

        infoLog('processAgentOutput', 'Process exit without completion, publishing error', {
          taskId: agent.taskId,
          exitCode,
        });

        await this.streams.publish(agent.sessionId, 'container-agent:error', {
          taskId: agent.taskId,
          sessionId: agent.sessionId,
          error: errorMessage,
          turnCount: 0,
        });

        await this.handleAgentError(agent.taskId, errorMessage, 0);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      infoLog('processAgentOutput', 'Error processing agent output', {
        taskId: agent.taskId,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (this.runningAgents.has(agent.taskId)) {
        if (agent.stopRequested) {
          await this.handleAgentComplete(agent.taskId, 'cancelled', 0);
          return;
        }

        await this.streams.publish(agent.sessionId, 'container-agent:error', {
          taskId: agent.taskId,
          sessionId: agent.sessionId,
          error: message,
          turnCount: 0,
        });

        await this.handleAgentError(agent.taskId, message, 0);
      }
    } finally {
      // Note: Cleanup is handled by handleAgentComplete/handleAgentError callbacks.
      // We intentionally do NOT delete from runningAgents here to avoid race conditions
      // where the callbacks run after this finally block.
      debugLog('processAgentOutput', 'Stream processing finished', {
        taskId: agent.taskId,
        stillRunning: this.runningAgents.has(agent.taskId),
      });
    }
  }

  /**
   * Handle agent completion.
   */
  private async handleAgentComplete(
    taskId: string,
    status: 'completed' | 'turn_limit' | 'cancelled',
    turnCount: number
  ): Promise<void> {
    infoLog('handleAgentComplete', 'Agent completion callback triggered', {
      taskId,
      status,
      turnCount,
    });

    const agent = this.runningAgents.get(taskId);
    if (!agent) {
      debugLog('handleAgentComplete', 'Agent not found in running agents map', {
        taskId,
        runningAgents: Array.from(this.runningAgents.keys()),
      });
      return;
    }

    debugLog('handleAgentComplete', 'Found running agent', {
      taskId,
      sessionId: agent.sessionId,
      sandboxId: agent.sandboxId,
      runDuration: `${Date.now() - agent.startedAt.getTime()}ms`,
    });

    // Auto-commit worktree changes when the agent finishes work (completed or turn limit reached)
    if (
      agent.worktreeId &&
      this.worktreeService &&
      (status === 'completed' || status === 'turn_limit')
    ) {
      try {
        const reason = status === 'completed' ? 'completed' : 'reached turn limit';
        const commitResult = await this.worktreeService.commit(
          agent.worktreeId,
          `Agent ${reason}: ${agent.taskId}`
        );
        if (commitResult.ok) {
          const sha = commitResult.value;
          infoLog('handleAgentComplete', 'Worktree changes committed', {
            taskId,
            worktreeId: agent.worktreeId,
            sha: sha || '(no changes)',
          });
        } else {
          infoLog('handleAgentComplete', 'Worktree commit returned error', {
            taskId,
            error: String(commitResult.error),
          });
          await this.streams
            .publish(agent.sessionId, 'container-agent:message', {
              taskId,
              sessionId: agent.sessionId,
              role: 'system',
              content: `⚠️ Failed to commit worktree changes: ${String(commitResult.error)}. Agent work may not be persisted.`,
            })
            .catch(() => {});
        }
      } catch (commitErr) {
        const errorMessage = commitErr instanceof Error ? commitErr.message : String(commitErr);
        infoLog('handleAgentComplete', 'Failed to commit worktree changes', {
          taskId,
          worktreeId: agent.worktreeId,
          error: errorMessage,
        });
        await this.streams
          .publish(agent.sessionId, 'container-agent:message', {
            taskId,
            sessionId: agent.sessionId,
            role: 'system',
            content: `⚠️ Failed to commit worktree changes: ${errorMessage}. Agent work may not be persisted.`,
          })
          .catch(() => {});
      }
    }

    // Update task status based on completion - always clear agentId/sessionId and set lastAgentStatus
    try {
      if (status === 'completed') {
        // Move task to waiting_approval
        debugLog('handleAgentComplete', 'Updating task to waiting_approval (completed)', {
          taskId,
        });
        await this.db
          .update(tasks)
          .set({
            column: 'waiting_approval',
            agentId: null,
            sessionId: null,
            lastAgentStatus: 'completed',
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));
        infoLog('handleAgentComplete', 'Task moved to waiting_approval', { taskId, status });
      } else if (status === 'turn_limit') {
        // Move task to waiting_approval for review
        debugLog('handleAgentComplete', 'Updating task to waiting_approval (turn_limit)', {
          taskId,
        });
        await this.db
          .update(tasks)
          .set({
            column: 'waiting_approval',
            agentId: null,
            sessionId: null,
            lastAgentStatus: 'turn_limit',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));
        infoLog('handleAgentComplete', 'Task moved to waiting_approval (turn limit)', {
          taskId,
          status,
        });
      } else {
        // cancelled - clear agent refs but leave task in current column
        debugLog('handleAgentComplete', 'Task cancelled, clearing agent refs', { taskId });
        await this.db
          .update(tasks)
          .set({
            agentId: null,
            sessionId: null,
            lastAgentStatus: 'cancelled',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));

        // Clean up worktree on cancellation (not needed for review/merge)
        if (agent.worktreeId) {
          await this.cleanupWorktree(taskId, agent.worktreeId);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      infoLog('handleAgentComplete', 'Failed to update task status', {
        taskId,
        status,
        error: errorMessage,
      });
      // Publish error event so UI knows task update failed
      try {
        await this.streams.publish(agent.sessionId, 'container-agent:task-update-failed', {
          taskId,
          sessionId: agent.sessionId,
          error: errorMessage,
          attemptedStatus: status,
        });
      } catch (publishErr) {
        infoLog('handleAgentComplete', 'Failed to publish task update error event', {
          taskId,
          error: publishErr instanceof Error ? publishErr.message : String(publishErr),
        });
      }
    }

    // Update agent status to completed/idle
    const agentId = `agent-${taskId}`;
    try {
      await this.db
        .update(agents)
        .set({
          status: 'completed',
          currentTaskId: null,
          currentSessionId: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agents.id, agentId));
      debugLog('handleAgentComplete', 'Agent status updated to completed', { agentId });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      infoLog('handleAgentComplete', 'Failed to update agent status', {
        agentId,
        error: errorMessage,
      });
    }

    // Clean up sentinel file
    try {
      debugLog('handleAgentComplete', 'Cleaning up sentinel file', {
        taskId,
        stopFilePath: agent.stopFilePath,
      });
      const sandbox = await this.provider.getById(agent.sandboxId);
      if (sandbox && sandbox.status === 'running') {
        await sandbox.exec('rm', ['-f', agent.stopFilePath]);
        debugLog('handleAgentComplete', 'Sentinel file removed', { taskId });
      } else {
        debugLog('handleAgentComplete', 'Sandbox not available for cleanup', {
          taskId,
          sandboxExists: !!sandbox,
          status: sandbox?.status,
        });
      }
    } catch (cleanupError) {
      debugLog('handleAgentComplete', 'Failed to cleanup sentinel file (ignoring)', {
        taskId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }

    // Clear runtime timeout and remove from running agents
    clearTimeout(agent.timeoutHandle);
    this.runningAgents.delete(taskId);
    infoLog('handleAgentComplete', 'Agent completion handling finished', {
      taskId,
      remainingAgents: this.runningAgents.size,
    });
  }

  /**
   * Handle agent error.
   */
  private async handleAgentError(taskId: string, error: string, turnCount: number): Promise<void> {
    infoLog('handleAgentError', 'Agent error callback triggered', {
      taskId,
      error,
      turnCount,
    });

    const agent = this.runningAgents.get(taskId);
    if (!agent) {
      // Agent not in memory map — could be a post-plan error (session.close() abort)
      // or a genuine orphan from a server restart / race condition.
      // Check if the plan was already captured before overwriting status.
      infoLog('handleAgentError', 'Agent not found in running agents map', {
        taskId,
        runningAgents: Array.from(this.runningAgents.keys()),
      });

      // Query the task to check if a plan was already captured
      const existingTask = (await this.db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
      })) as unknown as TaskPlanRow | undefined;

      if (existingTask?.lastAgentStatus === 'planning' && existingTask.plan) {
        // Plan was already captured — only suppress expected post-plan errors
        // (e.g. stream closure after ExitPlanMode). Log unexpected errors as warnings.
        const POST_PLAN_ERROR_PATTERNS = [
          'Operation aborted',
          'session closed',
          'EPIPE',
          'stream ended',
        ];
        const isExpectedPostPlanError = POST_PLAN_ERROR_PATTERNS.some((pattern) =>
          error.includes(pattern)
        );

        if (isExpectedPostPlanError) {
          infoLog('handleAgentError', 'Suppressing expected post-plan error', {
            taskId,
            lastAgentStatus: existingTask.lastAgentStatus,
            error,
          });
          return;
        }

        // Unexpected error after plan capture — proceed to update DB
        infoLog('handleAgentError', 'Unexpected error after plan capture', {
          taskId,
          error,
          lastAgentStatus: existingTask.lastAgentStatus,
          planLength: existingTask.plan.length,
        });
      }

      // Genuine error for an orphaned agent — update DB so it doesn't stay stuck
      const agentId = `agent-${taskId}`;
      try {
        await this.db
          .update(agents)
          .set({
            status: 'error',
            currentTaskId: null,
            currentSessionId: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));
        await this.db
          .update(tasks)
          .set({
            agentId: null,
            sessionId: null,
            lastAgentStatus: 'error',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));
        infoLog('handleAgentError', 'DB updated for orphaned agent', { agentId, taskId });
      } catch (dbErr) {
        infoLog('handleAgentError', 'Failed to update orphaned agent status', {
          agentId,
          taskId,
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }
      return;
    }

    debugLog('handleAgentError', 'Found running agent', {
      taskId,
      sessionId: agent.sessionId,
      sandboxId: agent.sandboxId,
      runDuration: `${Date.now() - agent.startedAt.getTime()}ms`,
    });

    // Update task - clear agent refs on error and set lastAgentStatus
    try {
      debugLog('handleAgentError', 'Clearing agent refs and setting error status', { taskId });
      await this.db
        .update(tasks)
        .set({
          agentId: null,
          sessionId: null,
          lastAgentStatus: 'error',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(tasks.id, taskId));
      debugLog('handleAgentError', 'Task agent refs cleared, status set to error', { taskId });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      infoLog('handleAgentError', 'Failed to update task status', {
        taskId,
        status: 'error',
        error: errorMessage,
      });
      // Publish error event so UI knows task update failed
      try {
        await this.streams.publish(agent.sessionId, 'container-agent:task-update-failed', {
          taskId,
          sessionId: agent.sessionId,
          error: errorMessage,
          attemptedStatus: 'error',
        });
      } catch (publishErr) {
        infoLog('handleAgentError', 'Failed to publish task update error event', {
          taskId,
          error: publishErr instanceof Error ? publishErr.message : String(publishErr),
        });
      }
    }

    // Clean up worktree on error
    if (agent.worktreeId) {
      await this.cleanupWorktree(taskId, agent.worktreeId);
    }

    // Update agent status to error
    const agentId = `agent-${taskId}`;
    try {
      await this.db
        .update(agents)
        .set({
          status: 'error',
          currentTaskId: null,
          currentSessionId: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agents.id, agentId));
      debugLog('handleAgentError', 'Agent status updated to error', { agentId });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      infoLog('handleAgentError', 'Failed to update agent status', {
        agentId,
        error: errorMessage,
      });
    }

    // Clear runtime timeout and remove from running agents
    clearTimeout(agent.timeoutHandle);
    this.runningAgents.delete(taskId);
    infoLog('handleAgentError', 'Agent error handling finished', {
      taskId,
      remainingAgents: this.runningAgents.size,
    });
  }

  /**
   * Handle plan ready event from planning phase.
   * Stores the plan data for later execution when approved.
   */
  private async handlePlanReady(
    taskId: string,
    sessionId: string,
    projectId: string,
    planData: {
      plan: string;
      turnCount: number;
      sdkSessionId: string;
      allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
    }
  ): Promise<void> {
    infoLog('handlePlanReady', 'Storing plan data for approval', {
      taskId,
      sessionId,
      planLength: planData.plan.length,
      sdkSessionId: planData.sdkSessionId,
    });

    // Store plan data for later execution (in-memory for fast access)
    this.pendingPlans.set(taskId, {
      taskId,
      sessionId,
      projectId,
      plan: planData.plan,
      turnCount: planData.turnCount,
      sdkSessionId: planData.sdkSessionId,
      allowedPrompts: planData.allowedPrompts,
      createdAt: new Date(),
    });

    // Persist plan to the task record so it survives server restarts
    // Move card to waiting_approval so the user sees it on the Kanban board
    try {
      await this.db
        .update(tasks)
        .set({
          plan: planData.plan,
          planOptions: {
            sdkSessionId: planData.sdkSessionId,
            allowedPrompts: planData.allowedPrompts,
          },
          lastAgentStatus: 'planning',
          column: 'waiting_approval',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(tasks.id, taskId));
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      infoLog('handlePlanReady', 'CRITICAL: Failed to persist plan to database', {
        taskId,
        error: errorMessage,
      });
      // DB failed — card won't move to waiting_approval, so remove from pendingPlans
      // to avoid stale in-memory state that can't be approved properly
      this.pendingPlans.delete(taskId);
      // Publish error event so UI shows the failure
      this.streams
        .publish(sessionId, 'container-agent:error', {
          taskId,
          sessionId,
          error: `Failed to persist plan: ${errorMessage}`,
          turnCount: planData.turnCount,
        })
        .catch((publishErr) => {
          infoLog('handlePlanReady', 'Failed to publish plan DB error event', {
            taskId,
            error: publishErr instanceof Error ? publishErr.message : String(publishErr),
          });
        });

      // Clean up worktree since the plan failed to persist (Gap 4)
      const orphanedAgent = this.runningAgents.get(taskId);
      if (orphanedAgent?.worktreeId) {
        void this.cleanupWorktree(taskId, orphanedAgent.worktreeId);
      }

      // Clean up running agent and return early
      this.runningAgents.delete(taskId);
      return;
    }

    // Clean up running agent (planning phase completed)
    this.runningAgents.delete(taskId);

    infoLog('handlePlanReady', 'Plan persisted and stored, waiting for approval', {
      taskId,
      pendingPlans: this.pendingPlans.size,
      remainingAgents: this.runningAgents.size,
    });
  }

  /**
   * Get pending plan data for a task.
   * Checks in-memory cache first, then falls back to the database
   * (plan survives server restarts via the task record).
   */
  getPendingPlan(taskId: string): PlanData | undefined {
    const cached = this.pendingPlans.get(taskId);
    if (cached) return cached;

    // Recover from database if not in memory (e.g., after server restart)
    // better-sqlite3 driver executes synchronously despite the Promise return type
    const task = this.db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    }) as unknown as TaskPlanRow | undefined;

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
        createdAt: new Date(),
      };

      // Re-cache for subsequent calls
      this.pendingPlans.set(taskId, recovered);
      infoLog('getPendingPlan', 'Recovered plan from database', { taskId });
      return recovered;
    }

    return undefined;
  }

  /**
   * Approve a plan and start execution phase.
   */
  async approvePlan(taskId: string): Promise<Result<void, SandboxError>> {
    const planData = this.getPendingPlan(taskId);
    if (!planData) {
      infoLog('approvePlan', 'No pending plan found', { taskId });
      return err(SandboxErrors.PLAN_NOT_FOUND(taskId));
    }

    infoLog('approvePlan', 'Approving plan and starting execution', {
      taskId,
      sdkSessionId: planData.sdkSessionId,
    });

    // Move task back to in_progress for execution phase
    // lastAgentStatus stays as 'planning' until execution completes or errors (handleAgentComplete / handleAgentError sets it)
    try {
      await this.db
        .update(tasks)
        .set({
          column: 'in_progress',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(tasks.id, taskId));
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      infoLog('approvePlan', 'Failed to move task to in_progress for execution', {
        taskId,
        error: errorMessage,
      });
      return err(SandboxErrors.AGENT_START_FAILED(`DB update failed: ${errorMessage}`));
    }

    // Only remove from pending plans AFTER DB write succeeds
    this.pendingPlans.delete(taskId);

    // Start execution phase with the SDK session ID to resume
    const result = await this.startAgent({
      projectId: planData.projectId,
      taskId: planData.taskId,
      sessionId: planData.sessionId,
      prompt: planData.plan, // Use plan as context (though session will resume)
      phase: 'execute',
      sdkSessionId: planData.sdkSessionId,
    });

    return result;
  }

  /**
   * Reject a plan and clean up.
   * Moves the task back to backlog and clears plan-related fields.
   * DB write happens FIRST; pendingPlans is only cleared on success.
   */
  async rejectPlan(taskId: string, reason?: string): Promise<Result<void, SandboxError>> {
    const existed = this.pendingPlans.has(taskId);

    if (!existed) {
      // Also check DB (plan may have been recovered from restart)
      const task = this.db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
      }) as unknown as TaskPlanRow | undefined;

      if (!task?.plan || task.lastAgentStatus !== 'planning') {
        infoLog('rejectPlan', 'No plan to reject', { taskId });
        return err(SandboxErrors.PLAN_NOT_FOUND(taskId));
      }
    }

    // Look up worktreeId from task before clearing fields
    const taskRecord = this.db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    }) as unknown as { worktreeId?: string | null } | undefined;
    const worktreeIdToClean = taskRecord?.worktreeId;

    // DB write FIRST — only clear in-memory on success
    try {
      await this.db
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
      infoLog('rejectPlan', 'Task moved to backlog and plan cleared', { taskId, reason });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      infoLog('rejectPlan', 'Failed to update task on plan rejection', {
        taskId,
        error: errorMessage,
      });
      // Do NOT delete from pendingPlans — DB write failed, data must be preserved
      return err(SandboxErrors.PLAN_REJECTION_FAILED(taskId, errorMessage));
    }

    // DB succeeded — safe to clear in-memory cache
    this.pendingPlans.delete(taskId);

    // Clean up the worktree (async, best-effort — DB already updated)
    if (worktreeIdToClean) {
      void this.cleanupWorktree(taskId, worktreeIdToClean);
    }

    infoLog('rejectPlan', 'Plan rejected successfully', { taskId });
    return ok(undefined);
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
  worktreeService?: WorktreeService
): ContainerAgentService {
  return new ContainerAgentService(db, provider, streams, apiKeyService, worktreeService);
}
