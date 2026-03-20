/**
 * AgentCoreBridgeService - AgentCore-specific start/stop and SSE bridge.
 *
 * Responsibilities:
 * - Start agents via AgentCore invoke + SSE (no container exec)
 * - Stop AgentCore agents
 * - Process SSE output from AgentCore invocations
 * - Handle AgentCore-specific completion and error callbacks
 * - Clean up AgentCore runtime state
 */

import { eq } from 'drizzle-orm';

import { agents, sessions, tasks } from '../../db/schema';
import { createAgentCoreBridge } from '../../lib/agents/agentcore-bridge.js';
import { DEFAULT_AGENT_MODEL, getFullModelId } from '../../lib/constants/models.js';
import type { SandboxError } from '../../lib/errors/sandbox-errors.js';
import { SandboxErrors } from '../../lib/errors/sandbox-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { SSEEvent } from '../../lib/sandbox/providers/agentcore-sandbox-instance.js';
import type { AgentCoreSandboxProvider } from '../../lib/sandbox/providers/agentcore-sandbox-provider.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import { getGlobalDefaultModel } from '../settings.service.js';
import type { ContainerExecService } from './container-exec.service.js';
import type { SandboxStateManager } from './sandbox-state.js';
import type {
  AgentConfig,
  ContainerAgentDeps,
  RunningAgentCoreAgent,
  StartAgentInput,
} from './types.js';

const log = createLogger('AgentCoreBridgeService');

export class AgentCoreBridgeService {
  constructor(
    private deps: ContainerAgentDeps,
    private state: SandboxStateManager,
    private containerExec: ContainerExecService,
    private getAgentCoreProvider: () => AgentCoreSandboxProvider | undefined,
    private onPlanReady: (
      taskId: string,
      sessionId: string,
      projectId: string,
      planData: {
        plan: string;
        turnCount: number;
        sdkSessionId: string;
        allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
      }
    ) => Promise<void>,
    private onAgentCompleteCallback?: () =>
      | ((projectId: string, taskId: string) => Promise<void>)
      | undefined
  ) {}

  /**
   * Start an agent via AgentCore invoke + SSE (no container exec).
   */
  async startAgentCoreAgent(
    input: StartAgentInput,
    project: {
      id: string;
      name: string;
      path: string | null;
      config?: Record<string, unknown> | null;
    }
  ): Promise<Result<void, SandboxError>> {
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

    const provider = this.getAgentCoreProvider();
    if (!provider) {
      log.info('AgentCore provider was cleared during startup', { data: { taskId } });
      return err(
        SandboxErrors.AGENT_START_FAILED(
          'AgentCore provider was removed while agent was starting. Please retry.'
        )
      );
    }

    const { db, streams, apiKeyService } = this.deps;

    log.info('Starting agent via AgentCore', {
      data: { taskId, projectId, sessionId, phase },
    });

    // Fetch task
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task) {
      log.info('Task not found', { data: { taskId } });
      return err(SandboxErrors.TASK_NOT_FOUND(taskId));
    }

    // Create or reuse agent record
    const agentId = `agent-${taskId}`;
    try {
      await db
        .insert(agents)
        .values({
          id: agentId,
          projectId,
          name: 'AgentCore Agent',
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
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.info('Failed to create agent record', { data: { agentId, error: errorMessage } });
      return err(SandboxErrors.AGENT_RECORD_FAILED(errorMessage));
    }

    // Create session record
    const sandboxId = `agentcore-${projectId}`;
    try {
      await db
        .insert(sessions)
        .values({
          id: sessionId,
          projectId,
          taskId,
          agentId,
          title: task.title ?? `AgentCore Agent - ${taskId}`,
          url: `/projects/${projectId}/sessions/${sessionId}`,
          status: 'active',
          sandboxProvider: 'agentcore',
          sandboxContainerId: null,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: sessions.id,
          set: {
            sandboxProvider: 'agentcore',
            sandboxContainerId: null,
            agentId,
          },
        });
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.info('Failed to create session record', { data: { sessionId, error: errorMessage } });
      return err(SandboxErrors.SESSION_CREATE_FAILED(errorMessage));
    }

    // Link agent and session to task
    try {
      await db
        .update(tasks)
        .set({ agentId, sessionId, updatedAt: new Date().toISOString() })
        .where(eq(tasks.id, taskId));
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.info('Failed to link task (non-critical)', { data: { taskId, error: errorMessage } });
    }

    // Create durable stream
    try {
      await streams.createStream(sessionId, { type: 'container-agent', projectId, taskId });
    } catch (streamErr) {
      const errorMessage = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (!errorMessage.includes('already exists') && !errorMessage.includes('duplicate')) {
        log.info('Failed to create durable stream', { data: { sessionId, error: errorMessage } });
        return err(SandboxErrors.STREAM_CREATE_FAILED(errorMessage));
      }
    }

    // Publish initial status
    try {
      await streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'initializing',
        message: 'Starting via AgentCore...',
      });
    } catch (publishErr) {
      const errorMessage = publishErr instanceof Error ? publishErr.message : String(publishErr);
      log.info('Failed to publish initial status', { data: { sessionId, error: errorMessage } });
      return err(SandboxErrors.STREAM_PUBLISH_FAILED(errorMessage));
    }

    // Resolve agent configuration
    const projectModel = project.config?.model as string | undefined;
    const resolvedModel =
      (model ? getFullModelId(model) : undefined) ??
      (projectModel ? getFullModelId(projectModel) : undefined) ??
      (await getGlobalDefaultModel(db));
    const agentConfig: AgentConfig = {
      model: resolvedModel ?? getFullModelId(DEFAULT_AGENT_MODEL),
      maxTurns: maxTurns ?? (project.config?.maxTurns as number | undefined) ?? 50,
    };

    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'validating',
      message: 'Configuration validated',
    });

    // Get OAuth token
    let oauthToken: string | null = null;
    try {
      oauthToken = await apiKeyService.getDecryptedKey('anthropic');
    } catch (keyErr) {
      log.info('Failed to get OAuth token from database', {
        data: { error: keyErr instanceof Error ? keyErr.message : String(keyErr) },
      });
    }
    if (!oauthToken) {
      oauthToken = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? null;
    }
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

    // Build invocation payload
    const payload: Record<string, unknown> = {
      prompt,
      taskId,
      sessionId,
      model: agentConfig.model,
      maxTurns: agentConfig.maxTurns,
      phase,
      oauthToken,
      cwd: '/workspace',
      ...(sdkSessionId ? { sdkSessionId } : {}),
    };

    // Get or create AgentCore instance and runtime session
    const instance = provider.get(projectId) ?? provider.create(projectId, sandboxId);
    const runtimeSessionId = provider.getOrCreateSession(projectId, taskId);

    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'executing',
      message: phase === 'plan' ? 'Planning via AgentCore...' : 'Executing via AgentCore...',
    });

    try {
      const events = instance.invoke(payload, runtimeSessionId);

      const bridge = createAgentCoreBridge({
        taskId,
        sessionId,
        projectId,
        streams,
        onComplete: (status, turnCount) => {
          log.info('AgentCore agent completed', { data: { taskId, status, turnCount } });
          this.handleAgentCoreComplete(taskId, status, turnCount);
        },
        onError: (error, turnCount) => {
          log.info('AgentCore agent error', { data: { taskId, error, turnCount } });
          this.handleAgentCoreError(taskId, error, turnCount);
        },
        onPlanReady: (planData) => {
          log.info('AgentCore plan ready', {
            data: { taskId, planLength: planData.plan.length, sdkSessionId: planData.sdkSessionId },
          });
          this.onPlanReady(taskId, sessionId, projectId, planData);
        },
      });

      const runningAgent: RunningAgentCoreAgent = {
        taskId,
        sessionId,
        projectId,
        sandboxId,
        bridge,
        instance,
        runtimeSessionId,
        startedAt: new Date(),
        stopRequested: false,
        phase,
      };

      this.state.setRunningAgentCoreAgent(taskId, runningAgent);

      // Set max runtime timeout
      const maxRuntimeMs = Number(process.env.AGENT_MAX_RUNTIME_MS) || 2 * 60 * 60 * 1000;
      runningAgent.timeoutHandle = setTimeout(() => {
        log.info('Agent exceeded max runtime, stopping', { data: { taskId, maxRuntimeMs } });
        this.stopAgentCoreAgent(runningAgent);
      }, maxRuntimeMs);
      runningAgent.timeoutHandle.unref();

      // Update agent status
      try {
        await db
          .update(agents)
          .set({
            status: phase === 'plan' ? 'planning' : 'running',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));
      } catch (dbErr) {
        const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
        log.info('Failed to update agent status (non-critical)', {
          data: { agentId, error: errorMessage },
        });
      }

      // Process the SSE stream asynchronously
      this.processAgentCoreOutput(runningAgent, events).catch(async (streamErr) => {
        const message = streamErr instanceof Error ? streamErr.message : String(streamErr);
        log.warn('AgentCore output stream failed', {
          data: { taskId, sessionId, error: message },
        });
        if (this.state.hasRunningAgentCoreAgent(taskId)) {
          try {
            await streams.publish(sessionId, 'container-agent:error', {
              taskId,
              sessionId,
              error: 'Agent output stream failed unexpectedly.',
              turnCount: 0,
            });
            await this.handleAgentCoreError(taskId, message, 0);
          } catch (notifyErr) {
            log.warn('Failed to notify user of stream failure (best-effort)', {
              data: { taskId },
              error: notifyErr,
            });
          }
        }
      });

      // Publish running status
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
        sandboxProvider: 'agentcore',
      });

      log.info('Agent started via AgentCore', { data: { taskId, sessionId } });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.info('Failed to start agent', { data: { taskId, error: message } });
      provider.removeSession(taskId);
      return err(SandboxErrors.AGENT_START_FAILED(message));
    }
  }

  /**
   * Process SSE output from an AgentCore invocation.
   */
  private async processAgentCoreOutput(
    agent: RunningAgentCoreAgent,
    events: AsyncIterable<SSEEvent>
  ): Promise<void> {
    log.debug('Starting to process AgentCore SSE stream', {
      data: { taskId: agent.taskId, sessionId: agent.sessionId },
    });

    try {
      await agent.bridge.processStream(events);
      log.debug('Bridge finished processing stream', { data: { taskId: agent.taskId } });

      if (this.state.hasRunningAgentCoreAgent(agent.taskId)) {
        if (agent.stopRequested) {
          log.info('Agent stopped via cancellation request', { data: { taskId: agent.taskId } });
          await this.handleAgentCoreComplete(agent.taskId, 'cancelled', 0);
          return;
        }

        const errorMessage = 'Agent stream ended without emitting a completion event';
        log.info('Stream ended without completion', { data: { taskId: agent.taskId } });

        await this.deps.streams.publish(agent.sessionId, 'container-agent:error', {
          taskId: agent.taskId,
          sessionId: agent.sessionId,
          error: errorMessage,
          turnCount: 0,
        });

        await this.handleAgentCoreError(agent.taskId, errorMessage, 0);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.info('Error processing AgentCore stream', {
        data: { taskId: agent.taskId, error: message },
      });

      if (this.state.hasRunningAgentCoreAgent(agent.taskId)) {
        if (agent.stopRequested) {
          await this.handleAgentCoreComplete(agent.taskId, 'cancelled', 0);
          return;
        }

        await this.deps.streams.publish(agent.sessionId, 'container-agent:error', {
          taskId: agent.taskId,
          sessionId: agent.sessionId,
          error: message,
          turnCount: 0,
        });

        await this.handleAgentCoreError(agent.taskId, message, 0);
      }
    } finally {
      log.debug('Stream processing finished', {
        data: {
          taskId: agent.taskId,
          stillRunning: this.state.hasRunningAgentCoreAgent(agent.taskId),
        },
      });
    }
  }

  /**
   * Stop an AgentCore agent by stopping the bridge and instance.
   */
  async stopAgentCoreAgent(agent: RunningAgentCoreAgent): Promise<Result<void, SandboxError>> {
    const { taskId, sessionId } = agent;
    log.info('Stopping AgentCore agent', {
      data: { taskId, runtimeSessionId: agent.runtimeSessionId },
    });

    try {
      agent.bridge.stop();
      agent.stopRequested = true;
      await agent.instance.stop();

      const provider = this.getAgentCoreProvider();
      if (provider) {
        provider.removeSession(taskId);
      }

      await this.deps.streams.publish(sessionId, 'container-agent:cancelled', {
        taskId,
        sessionId,
        turnCount: 0,
      });

      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.info('Failed to stop agent', { data: { taskId, error: message } });
      return err(SandboxErrors.AGENT_STOP_FAILED(message));
    }
  }

  /**
   * Shared cleanup for AgentCore agents.
   */
  private async cleanupAgentCoreRunState(
    taskId: string,
    agent: RunningAgentCoreAgent,
    agentDbStatus: 'completed' | 'error',
    context: string
  ): Promise<void> {
    const agentId = `agent-${taskId}`;
    try {
      await this.deps.db
        .update(agents)
        .set({
          status: agentDbStatus,
          currentTaskId: null,
          currentSessionId: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agents.id, agentId));
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.warn(`[${context}] Failed to update agent status`, {
        data: { agentId, error: errorMessage },
      });
    }

    const provider = this.getAgentCoreProvider();
    if (provider) {
      provider.removeSession(taskId);
    }

    clearTimeout(agent.timeoutHandle);
    this.state.deleteRunningAgentCoreAgent(taskId);
    log.info(`[${context}] AgentCore agent cleanup finished`, {
      data: { taskId, remainingAgents: this.state.totalRunningAgentCount },
    });
  }

  /**
   * Handle AgentCore agent completion.
   */
  async handleAgentCoreComplete(
    taskId: string,
    status: 'completed' | 'turn_limit' | 'cancelled',
    turnCount: number
  ): Promise<void> {
    log.info('AgentCore agent completion', { data: { taskId, status, turnCount } });

    const agent = this.state.getRunningAgentCoreAgent(taskId);
    if (!agent) {
      log.debug('Agent not found in AgentCore agents map', { data: { taskId } });
      return this.containerExec.handleAgentComplete(taskId, status, turnCount);
    }

    const { db, streams } = this.deps;

    // Update task status (same logic as container path)
    try {
      if (status === 'completed') {
        await db
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
      } else if (status === 'turn_limit') {
        await db
          .update(tasks)
          .set({
            column: 'waiting_approval',
            agentId: null,
            sessionId: null,
            lastAgentStatus: 'turn_limit',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));
      } else {
        await db
          .update(tasks)
          .set({
            agentId: null,
            sessionId: null,
            lastAgentStatus: 'cancelled',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(tasks.id, taskId));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.info('Failed to update task status', { data: { taskId, error: errorMessage } });
      try {
        await streams.publish(agent.sessionId, 'container-agent:task-update-failed', {
          taskId,
          sessionId: agent.sessionId,
          error: errorMessage,
          attemptedStatus: status,
        });
      } catch (publishErr) {
        log.warn('Failed to publish task-update-failed event (best-effort)', {
          data: { taskId },
          error: publishErr,
        });
      }
    }

    await this.cleanupAgentCoreRunState(taskId, agent, 'completed', 'handleAgentCoreComplete');

    // Auto-dequeue
    const callback = this.onAgentCompleteCallback?.();
    if (status === 'completed' && callback) {
      callback(agent.projectId, taskId).catch((dequeueErr) => {
        log.warn('Failed to auto-dequeue next task', {
          data: { taskId },
          error: dequeueErr,
        });
      });
    }
  }

  /**
   * Handle AgentCore agent error.
   */
  async handleAgentCoreError(taskId: string, error: string, turnCount: number): Promise<void> {
    log.info('AgentCore agent error', { data: { taskId, error, turnCount } });

    const agent = this.state.getRunningAgentCoreAgent(taskId);
    if (!agent) {
      return this.containerExec.handleAgentError(taskId, error, turnCount);
    }

    const { db, streams } = this.deps;

    // Update task -- clear agent refs on error
    try {
      await db
        .update(tasks)
        .set({
          agentId: null,
          sessionId: null,
          lastAgentStatus: 'error',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(tasks.id, taskId));
    } catch (dbErr) {
      const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.info('Failed to update task status', { data: { taskId, error: errorMessage } });
      try {
        await streams.publish(agent.sessionId, 'container-agent:task-update-failed', {
          taskId,
          sessionId: agent.sessionId,
          error: errorMessage,
          attemptedStatus: 'error',
        });
      } catch (publishErr) {
        log.warn('Failed to publish task-update-failed event (best-effort)', {
          data: { taskId },
          error: publishErr,
        });
      }
    }

    await this.cleanupAgentCoreRunState(taskId, agent, 'error', 'handleAgentCoreError');
  }
}
