/**
 * ContainerExecService - Container lifecycle: start, stop, process output.
 *
 * Responsibilities:
 * - Start agent-runner inside Docker/K8s/Nomad containers
 * - Stop agents via sentinel files and process kills
 * - Process stdout/stderr from agent-runner
 * - Handle agent completion and error callbacks
 * - Auto-commit worktree changes on completion
 */

import { eq } from 'drizzle-orm';

import { agents, codespaces, sessions, tasks } from '../../db/schema';
import type { ContainerBridge } from '../../lib/agents/container-bridge.js';
import { createContainerBridge } from '../../lib/agents/container-bridge.js';
import { DEFAULT_AGENT_MODEL, getFullModelId } from '../../lib/constants/models.js';
import { CONTAINER_WORKSPACE_PATH } from '../../lib/constants/sandbox.js';
import type { SandboxError } from '../../lib/errors/sandbox-errors.js';
import { SandboxErrors } from '../../lib/errors/sandbox-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Sandbox } from '../../lib/sandbox/providers/sandbox-provider.js';
import { injectAgents, injectSkills } from '../../lib/sandbox/skill-injector.js';
import { SANDBOX_DEFAULTS } from '../../lib/sandbox/types.js';
import { softInvariant } from '../../lib/utils/invariant.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import { getAgentMaxRuntimeMs, getGlobalDefaultModel } from '../settings.service.js';
import { TemplateService } from '../template.service.js';
import type { SandboxStateManager } from './sandbox-state.js';
import {
  resolveOAuthToken,
  updateAgentStatus,
  updateTaskOnAgentComplete,
  updateTaskOnAgentError,
} from './shared-helpers.js';
import type {
  AgentConfig,
  AgentPhase,
  ContainerAgentDeps,
  RunningAgent,
  StartAgentInput,
  TaskPlanRow,
} from './types.js';
import type { WorktreeInitService } from './worktree-init.service.js';

const log = createLogger('ContainerExecService');

export class ContainerExecService {
  constructor(
    private deps: ContainerAgentDeps,
    private state: SandboxStateManager,
    private worktreeInit: WorktreeInitService,
    private onPlanReady: (
      taskId: string,
      sessionId: string,
      codespaceId: string,
      planData: {
        plan: string;
        turnCount: number;
        sdkSessionId: string;
        allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
        launchSwarm?: boolean;
        teammateCount?: number;
      }
    ) => Promise<void>,
    private onAgentCompleteCallback?: () =>
      | ((codespaceId: string, taskId: string) => Promise<void>)
      | undefined
  ) {}

  /**
   * Wait for a sandbox to reach 'running' status with exponential backoff.
   * Publishes status events to keep the UI informed.
   */
  private async waitForSandboxReady(
    codespaceId: string,
    sessionId: string,
    taskId: string,
    maxWaitMs = 30_000
  ): Promise<Sandbox> {
    const start = Date.now();
    let delay = 1000;
    const maxDelay = 5000;

    while (Date.now() - start < maxWaitMs) {
      const sandbox = await this.deps.provider.get(codespaceId);
      if (sandbox && sandbox.status === 'running') {
        return sandbox;
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      await this.deps.streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'creating_sandbox',
        message: `Waiting for sandbox to become ready... (${elapsed}s)`,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelay);
    }

    throw new Error(
      `Sandbox for codespace ${codespaceId} did not become ready within ${maxWaitMs}ms`
    );
  }

  /**
   * Build environment variables and create the container bridge for agent execution.
   */
  private prepareContainerExec(params: {
    taskId: string;
    sessionId: string;
    codespaceId: string;
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
      codespaceId,
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
    log.debug('Env vars prepared', {
      data: {
        ...env,
        AGENT_PROMPT: `[${prompt.length} chars]`,
        AGENT_PHASE: phase,
      },
    });

    log.debug('Creating container bridge', { data: { taskId, sessionId, codespaceId, phase } });
    const bridge = createContainerBridge({
      taskId,
      sessionId,
      codespaceId,
      streams: this.deps.streams,
      onComplete: (status, turnCount) => {
        log.info('Agent completed via bridge callback', { data: { taskId, status, turnCount } });
        void this.handleAgentComplete(taskId, status, turnCount);
      },
      onError: (error, turnCount) => {
        log.info('Agent error via bridge callback', { data: { taskId, error, turnCount } });
        void this.handleAgentError(taskId, error, turnCount);
      },
      onPlanReady: (planData) => {
        log.info('Plan ready via bridge callback', {
          data: { taskId, planLength: planData.plan.length, sdkSessionId: planData.sdkSessionId },
        });
        void this.onPlanReady(taskId, sessionId, codespaceId, planData);
      },
    });

    return { env, bridge };
  }

  /**
   * Start an agent for a task inside its codespace's sandbox container.
   */
  async startAgent(input: StartAgentInput): Promise<Result<void, SandboxError>> {
    const {
      codespaceId,
      taskId,
      sessionId,
      prompt,
      model,
      maxTurns,
      phase = 'plan',
      sdkSessionId,
    } = input;

    const { db, provider, streams, apiKeyService } = this.deps;

    log.info('Starting agent', {
      data: {
        taskId,
        codespaceId,
        sessionId,
        model,
        maxTurns,
        phase,
        sdkSessionId: sdkSessionId ? '[set]' : undefined,
      },
    });

    // Parallel fetch: codespace and sandbox lookup at the same time
    const [codespace, initialSandbox] = await Promise.all([
      db.query.codespaces.findFirst({ where: eq(codespaces.id, codespaceId) }),
      provider.get(codespaceId),
    ]);

    if (!codespace) {
      log.info('Codespace not found', { data: { codespaceId } });
      return err(SandboxErrors.PROJECT_NOT_FOUND);
    }

    // Use shared sandbox mode by default (fastest path - no per-codespace container creation)
    let sandbox = initialSandbox;

    // Recovery: if sandbox exists but is in terminal state, tear it down and recreate
    if (sandbox && (sandbox.status === 'error' || sandbox.status === 'stopped')) {
      log.info('Sandbox in terminal state, tearing down for recreation', {
        data: { codespaceId, sandboxId: sandbox.id, status: sandbox.status },
      });
      try {
        await sandbox.stop();
      } catch (stopErr) {
        log.info('Failed to stop terminal sandbox (continuing with recreate)', {
          data: { error: stopErr instanceof Error ? stopErr.message : String(stopErr) },
        });
      }
      sandbox = null;
    }

    // Auto-create sandbox if missing (K8s may not have a default yet)
    if (!sandbox) {
      log.info('No sandbox found, attempting auto-create', { data: { codespaceId } });
      try {
        sandbox = await provider.create({
          codespaceId,
          codespacePath: codespace.path ?? '/workspace',
          image: SANDBOX_DEFAULTS.image,
          memoryMb: 2048,
          cpuCores: 2,
          idleTimeoutMinutes: 30,
          volumeMounts: [],
        });
        log.info('Auto-created sandbox', { data: { codespaceId, sandboxId: sandbox.id } });
      } catch (createErr) {
        log.info('Auto-create sandbox failed', {
          data: {
            codespaceId,
            error: createErr instanceof Error ? createErr.message : String(createErr),
          },
        });
        return err(SandboxErrors.CONTAINER_NOT_FOUND);
      }
    }

    log.info('Sandbox ready', { data: { sandboxId: sandbox.id, status: sandbox.status } });

    if (sandbox.status !== 'running') {
      log.info('Sandbox not yet running, waiting for ready', {
        data: { sandboxId: sandbox.id, status: sandbox.status },
      });
      try {
        sandbox = await this.waitForSandboxReady(codespaceId, sessionId, taskId);
        log.info('Sandbox became ready after waiting', { data: { sandboxId: sandbox.id } });
      } catch (waitErr) {
        log.info('Sandbox did not become ready in time', {
          data: { error: waitErr instanceof Error ? waitErr.message : String(waitErr) },
        });
        return err(SandboxErrors.CONTAINER_NOT_RUNNING);
      }
    }

    // Check if sandbox supports streaming exec
    if (!sandbox.execStream) {
      log.info('Sandbox does not support streaming exec', { data: { sandboxId: sandbox.id } });
      return err(SandboxErrors.STREAMING_EXEC_NOT_SUPPORTED);
    }

    // Fetch task to get title for session
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task) {
      log.info('Task not found', { data: { taskId } });
      return err(SandboxErrors.TASK_NOT_FOUND(taskId));
    }

    // Create or reuse agent record for this container agent run
    const agentId = `agent-${taskId}`;
    log.debug('Creating agent record', { data: { agentId, codespaceId, taskId } });
    try {
      await db
        .insert(agents)
        .values({
          id: agentId,
          codespaceId,
          name: 'Container Agent',
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
          },
        });
      log.debug('Agent record created/updated', { data: { agentId } });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.error('Failed to create agent record', { data: { agentId, error: errorMessage } });
      return err(SandboxErrors.AGENT_RECORD_FAILED(errorMessage, dbErr));
    }

    // Create database session record
    log.debug('Creating session record', { data: { sessionId, taskId } });
    try {
      await db
        .insert(sessions)
        .values({
          id: sessionId,
          codespaceId,
          taskId,
          agentId,
          title: task.title ?? `Container Agent - ${taskId}`,
          url: `/codespaces/${codespaceId}/sessions/${sessionId}`,
          status: 'active',
          sandboxProvider: provider.name,
          sandboxContainerId: sandbox.containerId ?? null,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: sessions.id,
          set: {
            sandboxProvider: provider.name,
            sandboxContainerId: sandbox.containerId ?? null,
            agentId,
          },
        });
      log.debug('Session record created/updated', {
        data: { sessionId, sandboxProvider: provider.name },
      });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.error('Failed to create session record', {
        data: { sessionId, taskId, error: errorMessage },
      });
      return err(SandboxErrors.SESSION_CREATE_FAILED(errorMessage, dbErr));
    }

    // Link agent and session to task
    log.debug('Linking agent and session to task', { data: { taskId, agentId, sessionId } });
    try {
      const [linked] = await db
        .update(tasks)
        .set({ agentId, sessionId })
        .where(eq(tasks.id, taskId))
        .returning({ id: tasks.id });
      softInvariant(!!linked, 'task linking expected 1 row', { taskId, agentId });
      log.debug('Task linked to agent and session', { data: { taskId } });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.error('Failed to link task to agent/session', { data: { taskId, error: errorMessage } });
      // Continue anyway - linking is non-critical
    }

    // Create durable stream for real-time events
    log.debug('Creating durable stream', { data: { sessionId } });
    try {
      await streams.createStream(sessionId, { type: 'container-agent', codespaceId, taskId });
      log.debug('Stream created successfully', { data: { sessionId } });
    } catch (streamErr) {
      const errorMessage = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (!errorMessage.includes('already exists') && !errorMessage.includes('duplicate')) {
        log.error('Failed to create durable stream', { data: { sessionId, error: errorMessage } });
        return err(SandboxErrors.STREAM_CREATE_FAILED(errorMessage));
      }
      log.debug('Stream already exists, continuing', { data: { sessionId } });
    }

    // Publish initial status event
    try {
      await streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'initializing',
        message: 'Starting...',
      });
      log.debug('Initial status event published', { data: { sessionId } });
    } catch (publishErr) {
      const errorMessage = publishErr instanceof Error ? publishErr.message : String(publishErr);
      log.error('Failed to publish initial status event - aborting agent start', {
        data: { sessionId, error: errorMessage },
      });
      return err(SandboxErrors.STREAM_PUBLISH_FAILED(errorMessage));
    }

    // Stage: Validating
    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'validating',
      message: 'Validating configuration...',
    });
    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: `Validating codespace configuration for "${codespace.name}"...`,
    });
    log.info('Validating codespace configuration', { data: { codespaceId, taskId } });

    // Resolve agent configuration
    const codespaceModel = codespace.config?.model as string | undefined;
    const resolvedModel =
      (model ? getFullModelId(model) : undefined) ??
      (codespaceModel ? getFullModelId(codespaceModel) : undefined) ??
      (await getGlobalDefaultModel(db));
    const agentConfig: AgentConfig = {
      model: resolvedModel ?? getFullModelId(DEFAULT_AGENT_MODEL),
      maxTurns: maxTurns ?? codespace.config?.maxTurns ?? 50,
    };
    log.info('Resolved agent config', {
      data: { model: agentConfig.model, maxTurns: agentConfig.maxTurns },
    });

    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: `Configuration validated: model=${agentConfig.model}, maxTurns=${agentConfig.maxTurns}`,
    });
    log.info('Sandbox validated', {
      data: {
        sandboxId: sandbox.id,
        status: sandbox.status,
        containerId: sandbox.containerId?.slice(0, 12),
      },
    });

    // Create sentinel file path for cancellation
    const stopFilePath = `/tmp/.agent-stop-${taskId}`;

    // Clear any stale stop file from a previous run
    try {
      await sandbox.exec('rm', ['-f', stopFilePath]);
    } catch (cleanupErr) {
      log.debug('Failed to clean stale stop file (best effort)', {
        data: {
          stopFilePath,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        },
      });
    }

    // Stage: Credentials - get OAuth token
    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'credentials',
      message: 'Authenticating...',
    });
    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: 'Retrieving OAuth credentials...',
    });
    log.info('Retrieving OAuth credentials', { data: { taskId } });

    const oauthToken = await resolveOAuthToken(apiKeyService);

    if (!oauthToken) {
      log.info('No OAuth token available');
      await streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content: 'No OAuth token configured. Please add your Anthropic API key in Settings.',
      });
      return err(SandboxErrors.API_KEY_NOT_CONFIGURED);
    }

    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: 'OAuth credentials retrieved successfully',
    });

    // Stage: Injecting Skills - materialize org/template skills into sandbox
    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'injecting_skills',
      message: 'Injecting skills...',
    });

    const templateService = new TemplateService(db);
    let skillMessage = 'No template configuration to inject';

    try {
      const mergedResult = await templateService.getMergedConfig(codespaceId);

      if (mergedResult.ok) {
        const { skills, agents: agentTemplates } = mergedResult.value;
        const messageParts: string[] = [];

        // Inject skills
        if (skills.length > 0) {
          log.info('Injecting template skills into sandbox', {
            data: { codespaceId, skillCount: skills.length },
          });

          const injectionResult = await injectSkills(sandbox, skills, CONTAINER_WORKSPACE_PATH);

          if (injectionResult.injected === 0 && injectionResult.errors.length > 0) {
            messageParts.push(
              `WARNING: No skills could be injected (${injectionResult.errors.length} errors)`
            );
          } else {
            messageParts.push(
              `Skills: ${injectionResult.injected} new, ${injectionResult.skipped} already present${injectionResult.errors.length > 0 ? `, ${injectionResult.errors.length} errors` : ''}`
            );
          }

          if (injectionResult.errors.length > 0) {
            log.error('Some skills failed to inject', {
              data: { errors: injectionResult.errors },
            });
          }
        }

        // Inject agents (.claude/agents/*.md)
        if (agentTemplates.length > 0) {
          log.info('Injecting template agents into sandbox', {
            data: { codespaceId, agentCount: agentTemplates.length },
          });

          const agentResult = await injectAgents(sandbox, agentTemplates, CONTAINER_WORKSPACE_PATH);

          messageParts.push(
            `Agents: ${agentResult.injected} new, ${agentResult.skipped} already present`
          );

          if (agentResult.errors.length > 0) {
            log.error('Some agents failed to inject', {
              data: { errors: agentResult.errors },
            });
          }
        }

        if (messageParts.length > 0) {
          skillMessage = messageParts.join(' | ');
        } else {
          skillMessage = 'No template skills or agents to inject';
        }
      } else {
        log.debug('No template config to inject', { data: { codespaceId } });
      }
    } catch (skillErr) {
      // Skill injection is non-fatal — log and continue
      const errorMsg = skillErr instanceof Error ? skillErr.message : String(skillErr);
      log.error('Skill injection failed (non-fatal)', {
        data: { codespaceId, error: errorMsg },
      });
      skillMessage = `Skill injection skipped: ${errorMsg}`;
    }

    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: skillMessage,
    });

    // Stage: Creating Sandbox
    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'creating_sandbox',
      message: 'Preparing sandbox...',
    });
    const containerShort = sandbox.containerId?.slice(0, 12) ?? 'unknown';
    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: `Preparing sandbox container (${containerShort})...`,
    });
    log.info('Preparing sandbox environment', {
      data: { sandboxId: sandbox.id, containerId: containerShort },
    });

    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: 'Sandbox container ready',
    });

    // Stage: Worktree
    const needsRemoteWorkspaceInit = provider.name === 'kubernetes' || provider.name === 'nomad';
    let worktreeId: string | undefined;
    let worktreePath = CONTAINER_WORKSPACE_PATH;

    if (needsRemoteWorkspaceInit) {
      const k8sResult = await this.worktreeInit.initializeRemoteWorkspace({
        sandbox,
        codespace,
        task,
        taskId,
        sessionId,
        phase,
      });
      if (k8sResult) {
        worktreePath = k8sResult.worktreePath;
      }
    } else {
      const resolved = await this.worktreeInit.resolveWorktree({
        phase,
        taskId,
        sessionId,
        codespaceId,
        codespace,
        task,
        agentId,
        sandbox,
      });
      worktreeId = resolved.worktreeId;
      worktreePath = resolved.worktreePath;
    }

    // Build env vars and create container bridge
    const { env, bridge } = this.prepareContainerExec({
      taskId,
      sessionId,
      codespaceId,
      phase,
      sdkSessionId,
      prompt,
      agentConfig,
      worktreePath,
      stopFilePath,
      oauthToken,
    });

    // When a skill is assigned, tell the agent-runner to use acceptEdits mode
    // during planning so the skill workflow can use tools like WebSearch, AskUserQuestion
    if (task.skillId) {
      env.AGENT_HAS_SKILL = 'true';
    }

    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'executing',
      message: phase === 'plan' ? 'Planning...' : 'Executing...',
    });
    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content:
        phase === 'plan'
          ? `Starting planning phase with ${agentConfig.model}...`
          : `Starting execution phase with ${agentConfig.model}...`,
    });

    try {
      log.info('Executing agent-runner in container', {
        data: { sandboxId: sandbox.id, cmd: 'node /opt/agent-runner/dist/index.js' },
      });

      // TOCTOU guard: re-validate sandbox is still running before exec
      if ('refreshStatus' in sandbox && typeof sandbox.refreshStatus === 'function') {
        await sandbox.refreshStatus();
        if (sandbox.status !== 'running') {
          log.info('Sandbox went away between validation and exec', {
            data: { sandboxId: sandbox.id, status: sandbox.status },
          });
          if (worktreeId) {
            await this.worktreeInit.cleanupWorktree(taskId, worktreeId);
          }
          return err(SandboxErrors.CONTAINER_NOT_RUNNING);
        }
      }

      const execResult = await sandbox.execStream({
        cmd: 'node',
        args: ['/opt/agent-runner/dist/index.js'],
        env: {
          ...env,
          CLAUDE_OAUTH_TOKEN: oauthToken,
          AGENT_PROMPT: prompt,
        },
        cwd: worktreePath,
      });
      log.debug('Agent-runner process started', { data: { sandboxId: sandbox.id } });

      // Track the running agent
      const runningAgent: RunningAgent = {
        taskId,
        sessionId,
        codespaceId,
        sandboxId: sandbox.id,
        bridge,
        execResult,
        stopFilePath,
        startedAt: new Date(),
        stopRequested: false,
        phase,
        worktreeId,
      };

      this.state.setRunningAgent(taskId, runningAgent);

      // Set a maximum runtime timeout to prevent runaway agents
      const maxRuntimeMs = await getAgentMaxRuntimeMs(db);
      runningAgent.timeoutHandle = setTimeout(() => {
        log.info('Agent exceeded max runtime, stopping', { data: { taskId, maxRuntimeMs } });
        void this.stopAgent(taskId);
      }, maxRuntimeMs);
      runningAgent.timeoutHandle.unref();

      log.info('Agent registered as running', {
        data: { taskId, totalRunning: this.state.runningAgentCount },
      });

      // Update agent status to 'running' in database
      try {
        const [agentUpdated] = await db
          .update(agents)
          .set({
            status: phase === 'plan' ? 'planning' : 'running',
          })
          .where(eq(agents.id, agentId))
          .returning({ id: agents.id });
        softInvariant(!!agentUpdated, 'agent status update expected 1 row', { agentId, phase });
        log.debug('Agent status updated to running', { data: { agentId, phase } });
      } catch (dbErr) {
        const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
        log.info('Failed to update agent status', { data: { agentId, error: errorMessage } });
      }

      // Start processing the stdout stream (async, don't await)
      log.debug('Starting stdout stream processing', { data: { taskId } });
      this.processAgentOutput(runningAgent).catch(async (processErr) => {
        const message = processErr instanceof Error ? processErr.message : String(processErr);
        log.warn('Agent output stream failed - user will not see agent output', {
          data: { taskId, sessionId, error: message },
          error: processErr,
        });
        if (this.state.hasRunningAgent(taskId)) {
          try {
            await streams.publish(sessionId, 'container-agent:error', {
              taskId,
              sessionId,
              error: 'Agent output stream failed unexpectedly.',
              turnCount: 0,
            });
            await this.handleAgentError(taskId, message, 0);
          } catch (notifyErr) {
            log.warn('Failed to notify user of stream failure (best-effort)', {
              data: { taskId },
              error: notifyErr,
            });
          }
        }
      });

      // Await critical status events for persistence
      await streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'running',
        message: 'Running',
      });
      await streams.publish(sessionId, 'container-agent:started', {
        taskId,
        sessionId,
        model: agentConfig.model,
        maxTurns: agentConfig.maxTurns,
        sandboxProvider: provider.name,
        sandboxContainerId: sandbox.containerId ?? null,
      });
      log.info('Agent started', { data: { taskId, sessionId } });

      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to start agent', { data: { taskId, error: message } });
      if (worktreeId) {
        await this.worktreeInit.cleanupWorktree(taskId, worktreeId);
      }
      return err(SandboxErrors.AGENT_START_FAILED(message));
    }
  }

  /**
   * Stop a running container agent by writing a sentinel file.
   */
  async stopAgent(taskId: string): Promise<Result<void, SandboxError>> {
    log.info('Stopping agent', { data: { taskId } });

    const agent = this.state.getRunningAgent(taskId);
    if (!agent) {
      log.info('Agent not found in running agents', {
        data: { taskId, runningAgents: this.state.getRunningAgentKeys() },
      });
      return err(SandboxErrors.AGENT_NOT_RUNNING(taskId));
    }

    log.debug('Found running agent', {
      data: {
        taskId,
        sessionId: agent.sessionId,
        sandboxId: agent.sandboxId,
        runningFor: `${Date.now() - agent.startedAt.getTime()}ms`,
      },
    });

    try {
      log.debug('Getting sandbox to write sentinel file', { data: { sandboxId: agent.sandboxId } });
      const sandbox = await this.deps.provider.getById(agent.sandboxId);
      if (sandbox && sandbox.status === 'running') {
        log.debug('Writing sentinel file', { data: { stopFilePath: agent.stopFilePath } });
        await sandbox.exec('touch', [agent.stopFilePath]);
      } else {
        log.debug('Sandbox not available for sentinel file', {
          data: { sandboxExists: !!sandbox, status: sandbox?.status },
        });
      }

      agent.stopRequested = true;

      log.debug('Killing exec process', { data: { taskId } });
      try {
        await agent.execResult.kill();
      } catch (killError) {
        const killMessage = killError instanceof Error ? killError.message : String(killError);
        log.debug('Exec kill completed with warning', { data: { taskId, warning: killMessage } });
      }

      if (agent.worktreeId) {
        await this.worktreeInit.cleanupWorktree(taskId, agent.worktreeId);
      }

      await this.deps.streams.publish(agent.sessionId, 'container-agent:cancelled', {
        taskId,
        sessionId: agent.sessionId,
        turnCount: 0,
      });

      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to stop agent', { data: { taskId, error: message } });
      return err(SandboxErrors.AGENT_STOP_FAILED(message));
    }
  }

  /**
   * Process stdout from the agent-runner process.
   */
  private async processAgentOutput(agent: RunningAgent): Promise<void> {
    log.debug('Starting to process agent output', {
      data: { taskId: agent.taskId, sessionId: agent.sessionId, sandboxId: agent.sandboxId },
    });

    agent.bridge.processStderr(agent.execResult.stderr);

    try {
      log.debug('Processing stdout stream through bridge', { data: { taskId: agent.taskId } });
      await agent.bridge.processStream(agent.execResult.stdout);
      log.debug('Bridge finished processing stream', { data: { taskId: agent.taskId } });

      log.debug('Waiting for process to exit', { data: { taskId: agent.taskId } });
      const { exitCode } = await agent.execResult.wait();
      log.info('Process exited', { data: { taskId: agent.taskId, exitCode } });

      if (this.state.hasRunningAgent(agent.taskId) && !agent.completionHandled) {
        if (agent.stopRequested) {
          log.info('Agent stopped via cancellation request', {
            data: { taskId: agent.taskId, exitCode },
          });
          await this.handleAgentComplete(agent.taskId, 'cancelled', 0);
          return;
        }

        const errorMessage =
          exitCode === 0
            ? 'Agent exited without emitting a completion event'
            : `Agent process exited with code ${exitCode}`;

        log.info('Process exit without completion, publishing error', {
          data: { taskId: agent.taskId, exitCode },
        });

        await this.deps.streams.publish(agent.sessionId, 'container-agent:error', {
          taskId: agent.taskId,
          sessionId: agent.sessionId,
          error: errorMessage,
          turnCount: 0,
        });

        await this.handleAgentError(agent.taskId, errorMessage, 0);
      } else if (agent.completionHandled) {
        log.debug(
          'Skipping process-exit error path — completion already handled by bridge callback',
          {
            data: { taskId: agent.taskId, exitCode },
          }
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Error processing agent output', {
        data: { taskId: agent.taskId, error: message },
        error,
      });

      if (this.state.hasRunningAgent(agent.taskId) && !agent.completionHandled) {
        if (agent.stopRequested) {
          await this.handleAgentComplete(agent.taskId, 'cancelled', 0);
          return;
        }

        await this.deps.streams.publish(agent.sessionId, 'container-agent:error', {
          taskId: agent.taskId,
          sessionId: agent.sessionId,
          error: message,
          turnCount: 0,
        });

        await this.handleAgentError(agent.taskId, message, 0);
      } else if (agent.completionHandled) {
        log.debug('Skipping catch error path — completion already handled by bridge callback', {
          data: { taskId: agent.taskId, error: message },
        });
      }
    } finally {
      log.debug('Stream processing finished', {
        data: { taskId: agent.taskId, stillRunning: this.state.hasRunningAgent(agent.taskId) },
      });
    }
  }

  /**
   * Handle agent completion.
   */
  async handleAgentComplete(
    taskId: string,
    status: 'completed' | 'turn_limit' | 'cancelled',
    turnCount: number
  ): Promise<void> {
    log.info('Agent completion callback triggered', { data: { taskId, status, turnCount } });

    const agent = this.state.getRunningAgent(taskId);
    if (!agent) {
      log.debug('Agent not found in running agents map', {
        data: { taskId, runningAgents: this.state.getRunningAgentKeys() },
      });
      return;
    }

    // Guard: mark completion handled immediately to prevent the process-exit path
    // in processAgentOutput from racing against this callback and publishing a
    // spurious "Agent exited without emitting a completion event" error.
    agent.completionHandled = true;

    const { db, provider, streams, worktreeService } = this.deps;

    log.debug('Found running agent', {
      data: {
        taskId,
        sessionId: agent.sessionId,
        sandboxId: agent.sandboxId,
        runDuration: `${Date.now() - agent.startedAt.getTime()}ms`,
      },
    });

    // Auto-commit worktree changes when agent finishes
    if (
      agent.worktreeId &&
      worktreeService &&
      (status === 'completed' || status === 'turn_limit')
    ) {
      try {
        const reason = status === 'completed' ? 'completed' : 'reached turn limit';
        const commitResult = await worktreeService.commit(
          agent.worktreeId,
          `Agent ${reason}: ${agent.taskId}`
        );
        if (commitResult.ok) {
          const sha = commitResult.value;
          log.info('Worktree changes committed', {
            data: { taskId, worktreeId: agent.worktreeId, sha: sha || '(no changes)' },
          });
        } else {
          log.info('Worktree commit returned error', {
            data: { taskId, error: String(commitResult.error) },
          });
          await streams
            .publish(agent.sessionId, 'container-agent:message', {
              taskId,
              sessionId: agent.sessionId,
              role: 'system',
              content: `Failed to commit worktree changes: ${String(commitResult.error)}. Agent work may not be persisted.`,
            })
            .catch((publishErr) =>
              log.warn('Failed to notify commit failure', {
                error: publishErr instanceof Error ? publishErr.message : String(publishErr),
              })
            );
        }
      } catch (commitErr) {
        const errorMessage = commitErr instanceof Error ? commitErr.message : String(commitErr);
        log.info('Failed to commit worktree changes', {
          data: { taskId, worktreeId: agent.worktreeId, error: errorMessage },
        });
        await streams
          .publish(agent.sessionId, 'container-agent:message', {
            taskId,
            sessionId: agent.sessionId,
            role: 'system',
            content: `Failed to commit worktree changes: ${errorMessage}. Agent work may not be persisted.`,
          })
          .catch((publishErr) =>
            log.warn('Failed to notify commit failure', {
              error: publishErr instanceof Error ? publishErr.message : String(publishErr),
            })
          );
      }
    }

    // Update task status based on completion (using shared helper)
    await updateTaskOnAgentComplete(
      db,
      taskId,
      status,
      streams,
      agent.sessionId,
      this.deps.skillTrackingService
    );

    // Handle worktree cleanup on cancellation
    if (status === 'cancelled' && agent.worktreeId) {
      await this.worktreeInit.cleanupWorktree(taskId, agent.worktreeId);
    }

    // Update agent status to completed/idle (using shared helper)
    await updateAgentStatus(db, taskId, 'completed');

    // Clean up sentinel file
    try {
      log.debug('Cleaning up sentinel file', {
        data: { taskId, stopFilePath: agent.stopFilePath },
      });
      const sandbox = await provider.getById(agent.sandboxId);
      if (sandbox && sandbox.status === 'running') {
        await sandbox.exec('rm', ['-f', agent.stopFilePath]);
        log.debug('Sentinel file removed', { data: { taskId } });
      } else {
        log.debug('Sandbox not available for cleanup', {
          data: { taskId, sandboxExists: !!sandbox, status: sandbox?.status },
        });
      }
    } catch (cleanupError) {
      log.debug('Failed to cleanup sentinel file (ignoring)', {
        data: {
          taskId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        },
      });
    }

    // Clear runtime timeout and remove from running agents
    clearTimeout(agent.timeoutHandle);
    this.state.deleteRunningAgent(taskId);
    log.info('Agent completion handling finished', {
      data: { taskId, remainingAgents: this.state.runningAgentCount },
    });

    // Auto-dequeue
    const callback = this.onAgentCompleteCallback?.();
    if (status === 'completed' && callback) {
      callback(agent.codespaceId, taskId).catch((dequeueErr) => {
        log.warn('Failed to auto-dequeue next task', {
          data: { taskId },
          error: dequeueErr,
        });
      });
    }
  }

  /**
   * Handle agent error.
   */
  async handleAgentError(taskId: string, error: string, turnCount: number): Promise<void> {
    log.info('Agent error callback triggered', { data: { taskId, error, turnCount } });

    const agent = this.state.getRunningAgent(taskId);
    const { db, streams } = this.deps;

    if (!agent) {
      log.info('Agent not found in running agents map', {
        data: { taskId, runningAgents: this.state.getRunningAgentKeys() },
      });

      const existingTask = (await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
      })) as unknown as TaskPlanRow | undefined;

      if (existingTask?.lastAgentStatus === 'planning' && existingTask.plan) {
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
          log.info('Suppressing expected post-plan error', {
            data: { taskId, lastAgentStatus: existingTask.lastAgentStatus, error },
          });
          return;
        }

        log.info('Unexpected error after plan capture', {
          data: {
            taskId,
            error,
            lastAgentStatus: existingTask.lastAgentStatus,
            planLength: existingTask.plan.length,
          },
        });
      }

      // Update orphaned agent and task status (using shared helpers)
      await updateAgentStatus(db, taskId, 'error');
      await updateTaskOnAgentError(db, taskId);
      log.info('DB updated for orphaned agent', { data: { taskId } });
      return;
    }

    // Guard: mark completion handled before any async work so the process-exit
    // path in processAgentOutput doesn't race against this error handler.
    agent.completionHandled = true;

    log.debug('Found running agent', {
      data: {
        taskId,
        sessionId: agent.sessionId,
        sandboxId: agent.sandboxId,
        runDuration: `${Date.now() - agent.startedAt.getTime()}ms`,
      },
    });

    // Update task - clear agent refs on error (using shared helper)
    await updateTaskOnAgentError(db, taskId, streams, agent.sessionId);

    // Clean up worktree on error
    if (agent.worktreeId) {
      await this.worktreeInit.cleanupWorktree(taskId, agent.worktreeId);
    }

    // Update agent status to error (using shared helper)
    await updateAgentStatus(db, taskId, 'error');

    // Clear runtime timeout and remove from running agents
    clearTimeout(agent.timeoutHandle);
    this.state.deleteRunningAgent(taskId);
    log.info('Agent error handling finished', {
      data: { taskId, remainingAgents: this.state.runningAgentCount },
    });
  }
}
