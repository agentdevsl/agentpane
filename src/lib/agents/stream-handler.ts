import { type CanUseTool, unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';
import { createId } from '@paralleldrive/cuid2';
import { createLogger } from '../../lib/logging/logger.js';
import type { SessionEvent } from '../../services/session.service.js';
import { deriveAgentName, mapAgentRole } from '../topology/map-agent-role.js';
import { errorMessage } from '../utils/error-message';
import { buildSdkEnv } from './agent-sdk-utils.js';

const log = createLogger('StreamHandler');

export interface StreamHandlerOptions {
  agentId: string;
  sessionId: string;
  prompt: string;
  allowedTools: string[];
  maxTurns: number;
  model: string;
  cwd: string;
  signal?: AbortSignal;
  sessionService: {
    publish: (sessionId: string, event: SessionEvent) => Promise<unknown>;
  };
}

export interface ExitPlanModeOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  pushToRemote?: boolean;
  remoteSessionId?: string;
  remoteSessionUrl?: string;
  remoteSessionTitle?: string;
  launchSwarm?: boolean;
  teammateCount?: number;
}

export interface AgentRunResult {
  runId: string;
  status: 'completed' | 'error' | 'turn_limit' | 'paused' | 'planning';
  turnCount: number;
  result?: string;
  plan?: string;
  planOptions?: ExitPlanModeOptions;
  error?: string;
  metrics?: {
    totalCostUsd?: number;
    durationMs?: number;
    durationApiMs?: number;
    numTurns?: number;
    stopReason?: string | null;
  };
}

async function publishToolProgress(
  sessionService: { publish: (sessionId: string, event: SessionEvent) => Promise<unknown> },
  sessionId: string,
  agentId: string,
  msg: Record<string, unknown>
): Promise<void> {
  await sessionService.publish(sessionId, {
    id: createId(),
    type: 'agent:tool_progress',
    timestamp: Date.now(),
    data: {
      agentId,
      toolUseId: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : 'unknown',
      toolName: typeof msg.tool_name === 'string' ? msg.tool_name : 'unknown',
      elapsedSeconds: typeof msg.elapsed_time_seconds === 'number' ? msg.elapsed_time_seconds : 0,
    },
  });
}

async function publishCompactBoundary(
  sessionService: { publish: (sessionId: string, event: SessionEvent) => Promise<unknown> },
  sessionId: string,
  agentId: string,
  msg: Record<string, unknown>
): Promise<void> {
  const compact = msg as { compact_metadata?: { trigger?: string; pre_tokens?: number } };
  if (!compact.compact_metadata) return;
  await sessionService.publish(sessionId, {
    id: createId(),
    type: 'agent:compacted',
    timestamp: Date.now(),
    data: {
      agentId,
      trigger: compact.compact_metadata.trigger ?? 'unknown',
      preTokens: compact.compact_metadata.pre_tokens ?? 0,
    },
  });
}

const VALID_TOPOLOGY_STATUSES = new Set(['completed', 'failed', 'stopped']);

/** Normalize SDK status to a value the client Zod schema accepts */
function normalizeTopologyStatus(raw: unknown): 'completed' | 'failed' | 'stopped' {
  if (typeof raw === 'string' && VALID_TOPOLOGY_STATUSES.has(raw)) {
    return raw as 'completed' | 'failed' | 'stopped';
  }
  return 'completed';
}

/**
 * Tracks subagent topology state during a session.
 * Maps SDK task_id → topology node id for correlating progress/completion events.
 */
interface TopologyTracker {
  /** SDK task_id → generated topology node id */
  taskToNodeId: Map<string, string>;
  /** Whether the root orchestrator node has been emitted */
  rootEmitted: boolean;
}

function createTopologyTracker(): TopologyTracker {
  return { taskToNodeId: new Map(), rootEmitted: false };
}

/**
 * Handle SDK system messages related to subagent lifecycle.
 * Returns true if the message was a topology event (consumed).
 */
async function handleTopologySystemMessage(
  msg: Record<string, unknown>,
  tracker: TopologyTracker,
  sessionService: { publish: (sessionId: string, event: SessionEvent) => Promise<unknown> },
  sessionId: string,
  agentId: string,
  taskId?: string
): Promise<boolean> {
  const subtype = msg.subtype as string | undefined;
  if (!subtype) return false;

  if (subtype === 'task_started') {
    const sdkTaskId = msg.task_id as string;
    const description = msg.description as string | undefined;
    const taskType = msg.task_type as string | undefined;
    if (!sdkTaskId) return false;

    // Emit root orchestrator node on first subagent spawn
    if (!tracker.rootEmitted) {
      tracker.rootEmitted = true;
      await sessionService.publish(sessionId, {
        id: createId(),
        type: 'topology:agent_spawned',
        timestamp: Date.now(),
        data: {
          agentId,
          taskId: taskId ?? '',
          name: 'Orchestrator',
          role: 'orchestrator',
          parentId: null,
        },
      });
    }

    const nodeId = createId();
    tracker.taskToNodeId.set(sdkTaskId, nodeId);

    await sessionService.publish(sessionId, {
      id: createId(),
      type: 'topology:agent_spawned',
      timestamp: Date.now(),
      data: {
        agentId: nodeId,
        taskId: taskId ?? '',
        name: deriveAgentName(taskType, description),
        role: mapAgentRole(taskType, description),
        parentId: agentId,
        sdkTaskId,
      },
    });
    return true;
  }

  if (subtype === 'task_progress') {
    const sdkTaskId = msg.task_id as string;
    const nodeId = tracker.taskToNodeId.get(sdkTaskId);
    if (!nodeId) return false;

    const usage = msg.usage as
      | { total_tokens?: number; tool_uses?: number; duration_ms?: number }
      | undefined;

    await sessionService.publish(sessionId, {
      id: createId(),
      type: 'topology:agent_progress',
      timestamp: Date.now(),
      data: {
        agentId: nodeId,
        sdkTaskId,
        tokens: usage?.total_tokens ?? 0,
        toolUses: usage?.tool_uses ?? 0,
        durationMs: usage?.duration_ms ?? 0,
        summary: msg.summary as string | undefined,
        lastToolName: msg.last_tool_name as string | undefined,
      },
    });
    return true;
  }

  if (subtype === 'task_notification') {
    const sdkTaskId = msg.task_id as string;
    const nodeId = tracker.taskToNodeId.get(sdkTaskId);
    if (!nodeId) return false;

    const usage = msg.usage as
      | { total_tokens?: number; tool_uses?: number; duration_ms?: number }
      | undefined;

    await sessionService.publish(sessionId, {
      id: createId(),
      type: 'topology:agent_completed',
      timestamp: Date.now(),
      data: {
        agentId: nodeId,
        sdkTaskId,
        status: normalizeTopologyStatus(msg.status),
        summary: typeof msg.summary === 'string' ? msg.summary : undefined,
        tokens: usage?.total_tokens,
        toolUses: usage?.tool_uses,
        durationMs: usage?.duration_ms,
      },
    });
    tracker.taskToNodeId.delete(sdkTaskId);
    return true;
  }

  return false;
}

function extractResultMetrics(result: Record<string, unknown>): AgentRunResult['metrics'] {
  return {
    totalCostUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
    durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : undefined,
    durationApiMs: typeof result.duration_api_ms === 'number' ? result.duration_api_ms : undefined,
    numTurns: typeof result.num_turns === 'number' ? result.num_turns : undefined,
    stopReason:
      result.stop_reason !== undefined ? (result.stop_reason as string | null) : undefined,
  };
}

async function publishMetrics(
  sessionService: { publish: (sessionId: string, event: SessionEvent) => Promise<unknown> },
  sessionId: string,
  agentId: string,
  runId: string,
  msg: Record<string, unknown>
): Promise<void> {
  const modelUsage =
    msg.modelUsage != null && typeof msg.modelUsage === 'object'
      ? (msg.modelUsage as Record<
          string,
          {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens: number;
            costUSD: number;
          }
        >)
      : undefined;
  const usage =
    msg.usage != null && typeof msg.usage === 'object'
      ? (msg.usage as { input_tokens?: number; output_tokens?: number })
      : undefined;
  await sessionService.publish(sessionId, {
    id: createId(),
    type: 'agent:metrics',
    timestamp: Date.now(),
    data: {
      agentId,
      runId,
      totalCostUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
      durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
      durationApiMs: typeof msg.duration_api_ms === 'number' ? msg.duration_api_ms : undefined,
      numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : undefined,
      usage,
      modelUsage,
      stopReason: msg.stop_reason !== undefined ? (msg.stop_reason as string | null) : undefined,
    },
  });
}

// =============================================================================
// Shared session runner (AE-010)
// =============================================================================

/** Phase-specific configuration for `runAgentSession` */
interface AgentSessionPhaseConfig {
  /** SDK permission mode */
  permissionMode: 'plan' | 'acceptEdits';
  /** Phase label for events */
  phase: 'planning' | 'execution';
  /** Initial event type to publish */
  startEventType: 'agent:planning' | 'agent:started';
  /** Whether to enable topology tracking for subagents */
  enableTopology: boolean;
  /** When true, enforce maxTurns as a hard stop within the stream loop */
  enforceTurnLimit: boolean;
  /** Callback invoked when ExitPlanMode tool is used (planning only) */
  onExitPlanMode?: (options: ExitPlanModeOptions | undefined) => void;
  /** Callback invoked when the plan content is captured via tool_use_summary */
  onPlanCaptured?: (content: string) => void;
  /** Build the final result when the session completes normally */
  buildResult: (opts: {
    runId: string;
    turn: number;
    accumulated: string;
    metrics?: AgentRunResult['metrics'];
    planContent?: string;
    exitPlanModeOptions?: ExitPlanModeOptions;
  }) => AgentRunResult;
  /** Build the result for end-of-stream without a result message */
  buildFallbackResult: (opts: {
    runId: string;
    turn: number;
    accumulated: string;
    planContent?: string;
    exitPlanModeOptions?: ExitPlanModeOptions;
  }) => AgentRunResult;
  /** Optional callback on result to publish phase-specific events (e.g. plan_ready, topology completed) */
  onResult?: (opts: {
    runId: string;
    turn: number;
    accumulated: string;
    result: Record<string, unknown>;
    sessionService: StreamHandlerOptions['sessionService'];
    sessionId: string;
    agentId: string;
    topology?: TopologyTracker;
    planContent?: string;
    exitPlanModeOptions?: ExitPlanModeOptions;
  }) => Promise<void>;
}

/**
 * Shared agent session runner extracted from runAgentPlanning/runAgentExecution.
 * Parameterized by phase config to support both planning and execution phases.
 */
async function runAgentSession(
  options: StreamHandlerOptions,
  config: AgentSessionPhaseConfig
): Promise<AgentRunResult> {
  const { agentId, sessionId, prompt, allowedTools, maxTurns, model, cwd, sessionService, signal } =
    options;

  const runId = createId();
  let accumulated = '';
  let turn = 0;
  let planContent = '';
  let exitPlanModeOptions: ExitPlanModeOptions | undefined;

  // Topology tracker (only used in execution phase)
  const topology = config.enableTopology ? createTopologyTracker() : undefined;

  // Publish start event
  await sessionService.publish(sessionId, {
    id: createId(),
    type: config.startEventType,
    timestamp: Date.now(),
    data: { agentId, runId, maxTurns, model, phase: config.phase },
  });

  // Emit root topology node in execution phase
  if (config.enableTopology && topology) {
    topology.rootEmitted = true;
    await sessionService.publish(sessionId, {
      id: createId(),
      type: 'topology:agent_spawned',
      timestamp: Date.now(),
      data: {
        agentId,
        name: 'Agent',
        role: 'orchestrator',
        parentId: null,
      },
    });
<<<<<<< ours
=======

    return {
      runId,
      status: 'planning',
      turnCount: turn,
      plan: planContent || accumulated || 'No plan generated',
      planOptions: exitPlanModeOptions,
    };
  } catch (error) {
    const errMsg = errorMessage(error);
    log.error('Agent planning error', { error, data: { agentId } });

    await sessionService.publish(sessionId, {
      id: createId(),
      type: 'agent:error',
      timestamp: Date.now(),
      data: { agentId, runId, error: errMsg, phase: 'planning' },
    });

    session.close();
    return {
      runId,
      status: 'error',
      turnCount: 0,
      error: errMsg,
    };
>>>>>>> theirs
  }

  // Track active tools by toolUseID for correlating with tool_use_summary
  const activeTools = new Map<string, { toolName: string; startTime: number }>();

  const canUseTool: CanUseTool = async (toolName, input, toolOptions) => {
    activeTools.set(toolOptions.toolUseID, { toolName, startTime: Date.now() });

    await sessionService.publish(sessionId, {
      id: createId(),
      type: 'tool:start',
      timestamp: Date.now(),
      data: {
        agentId,
        toolId: toolOptions.toolUseID,
        tool: toolName,
        input: input as Record<string, unknown>,
        ...(config.phase === 'planning' ? { phase: 'planning' } : {}),
      },
    });

    if (toolName === 'ExitPlanMode' && config.onExitPlanMode) {
      const planOptions = input as ExitPlanModeOptions | undefined;
      exitPlanModeOptions = planOptions;
      config.onExitPlanMode(planOptions);
      log.info('ExitPlanMode captured via canUseTool', { data: { agentId } });
    }

    return { behavior: 'allow' as const, toolUseID: toolOptions.toolUseID };
  };

  // Create Claude Agent SDK session
  const session = unstable_v2_createSession({
    model,
    env: buildSdkEnv(),
    ...(config.permissionMode === 'acceptEdits' ? { allowedTools } : {}),
    permissionMode: config.permissionMode,
    executableArgs: ['--add-dir', cwd],
    canUseTool,
  });

  try {
    await session.send(prompt);

    for await (const msg of session.stream()) {
      // Check abort signal
      if (signal?.aborted) {
        session.close();
        await sessionService.publish(sessionId, {
          id: createId(),
          type: 'agent:stopped',
          timestamp: Date.now(),
          data: { agentId, runId, reason: 'aborted', phase: config.phase },
        });
        return {
          runId,
          status: 'paused',
          turnCount: turn,
          result: `Agent stopped by user during ${config.phase}`,
        };
      }

      // Handle stream events (token-by-token streaming)
      if (msg.type === 'stream_event') {
        const event = msg.event as {
          type: string;
          delta?: { type: string; text?: string };
          message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          event.delta.text
        ) {
          accumulated += event.delta.text;

          await sessionService.publish(sessionId, {
            id: createId(),
            type: 'chunk',
            timestamp: Date.now(),
            data: { agentId, delta: event.delta.text, accumulated, phase: config.phase },
          });
        }
      }

      // Handle complete assistant messages
      if (msg.type === 'assistant') {
        turn++;
        const message = msg.message as {
          content?: Array<{ type: string; text?: string }>;
          model?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        const textContent = message?.content
          ?.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');

        if (textContent) {
          accumulated = textContent;
        }

        await sessionService.publish(sessionId, {
          id: createId(),
          type: 'agent:turn',
          timestamp: Date.now(),
          data: {
            agentId,
            turn,
            ...(config.enforceTurnLimit ? { maxTurns, remaining: maxTurns - turn } : {}),
            ...(message?.usage ? { usage: message.usage } : {}),
            phase: config.phase,
          },
        });

        // Check for SDK-level errors on assistant messages (v0.2.76+)
        const assistantError = (msg as { error?: string }).error;
        if (assistantError) {
          log.warn(`Assistant error during ${config.phase}`, {
            data: { agentId, error: assistantError },
          });
          sessionService
            .publish(sessionId, {
              id: createId(),
              type: 'agent:error',
              timestamp: Date.now(),
              data: {
                agentId,
                runId,
                error: `Assistant error: ${assistantError}`,
                phase: config.phase,
              },
            })
            .catch((publishErr) => {
              log.warn('Failed to publish assistant error', { error: publishErr });
            });
        }

        // Enforce turn limit (execution phase)
        if (config.enforceTurnLimit && turn >= maxTurns) {
          await sessionService.publish(sessionId, {
            id: createId(),
            type: 'agent:turn_limit',
            timestamp: Date.now(),
            data: { agentId, turn, maxTurns },
          });

          session.close();
          return {
            runId,
            status: 'turn_limit',
            turnCount: turn,
            result: `Turn limit reached (${maxTurns}). Task moved to waiting approval.`,
          };
        }
      }

      // Handle tool_use_summary (SDK v0.2.76+)
      if (msg.type === 'tool_use_summary') {
        const toolSummary = msg as {
          summary: string;
          preceding_tool_use_ids: string[];
        };

        for (const toolUseId of toolSummary.preceding_tool_use_ids) {
          const tracked = activeTools.get(toolUseId);
          if (!tracked) continue;

          await sessionService.publish(sessionId, {
            id: createId(),
            type: 'tool:result',
            timestamp: Date.now(),
            data: {
              agentId,
              toolId: toolUseId,
              tool: tracked.toolName,
              output: toolSummary.summary?.slice(0, 1000),
              isError: false,
              ...(config.phase === 'planning' ? { phase: 'planning' } : {}),
            },
          });

          // Check if this is ExitPlanMode - plan is ready
          if (tracked.toolName === 'ExitPlanMode' && config.onPlanCaptured) {
            planContent = accumulated;
            config.onPlanCaptured(accumulated);
            log.info('ExitPlanMode completed - plan is ready', { data: { agentId } });
          }

          activeTools.delete(toolUseId);
        }
      }

      // Handle tool_progress events
      if (msg.type === 'tool_progress') {
        publishToolProgress(
          sessionService,
          sessionId,
          agentId,
          msg as Record<string, unknown>
        ).catch((publishErr) => {
          log.warn('Failed to publish tool_progress', { error: publishErr });
        });
      }

      // Handle rate_limit_event (SDK v0.2.76+)
      if (msg.type === 'rate_limit_event') {
        const rateLimitMsg = msg as {
          rate_limit_info: { status: string; resetsAt?: number };
        };
        sessionService
          .publish(sessionId, {
            id: createId(),
            type: 'agent:rate_limit',
            timestamp: Date.now(),
            data: {
              agentId,
              status: rateLimitMsg.rate_limit_info.status,
              resetsAt: rateLimitMsg.rate_limit_info.resetsAt,
            },
          })
          .catch((publishErr) => {
            log.warn('Failed to publish rate_limit', { error: publishErr });
          });
      }

      // Handle system messages (compact_boundary + subagent topology)
      if (msg.type === 'system') {
        const sysMsg = msg as Record<string, unknown>;
        const sysSubtype = sysMsg.subtype as string | undefined;

        if (sysSubtype === 'compact_boundary') {
          publishCompactBoundary(sessionService, sessionId, agentId, sysMsg).catch((publishErr) => {
            log.warn('Failed to publish compact_boundary', { error: publishErr });
          });
        }

        // Handle subagent lifecycle events (execution phase only)
        if (
          topology &&
          (sysSubtype === 'task_started' ||
            sysSubtype === 'task_progress' ||
            sysSubtype === 'task_notification')
        ) {
          await handleTopologySystemMessage(sysMsg, topology, sessionService, sessionId, agentId);
        }
      }

      // Handle result (session finished)
      if (msg.type === 'result') {
        const result = msg as Record<string, unknown>;

        session.close();

        publishMetrics(sessionService, sessionId, agentId, runId, result).catch((publishErr) => {
          log.warn('Failed to publish metrics', { error: publishErr });
        });

        // Invoke phase-specific result handler
        if (config.onResult) {
          await config.onResult({
            runId,
            turn,
            accumulated,
            result,
            sessionService,
            sessionId,
            agentId,
            topology,
            planContent,
            exitPlanModeOptions,
          });
        }

        return config.buildResult({
          runId,
          turn,
          accumulated,
          metrics: extractResultMetrics(result),
          planContent,
          exitPlanModeOptions,
        });
      }
    }

    // End of stream without result message
    session.close();

    // Invoke phase-specific result handler for fallback
    if (config.onResult) {
      await config.onResult({
        runId,
        turn,
        accumulated,
        result: {},
        sessionService,
        sessionId,
        agentId,
        topology,
        planContent,
        exitPlanModeOptions,
      });
    }

    return config.buildFallbackResult({
      runId,
      turn,
      accumulated,
      planContent,
      exitPlanModeOptions,
    });
  } catch (error) {
<<<<<<< ours
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`Agent ${config.phase} error`, { error, data: { agentId } });
=======
    const errMsg = errorMessage(error);
    log.error('Agent execution error', { error, data: { agentId } });
>>>>>>> theirs

    await sessionService.publish(sessionId, {
      id: createId(),
      type: 'agent:error',
      timestamp: Date.now(),
<<<<<<< ours
      data: { agentId, runId, error: errorMessage, phase: config.phase },
=======
      data: { agentId, runId, error: errMsg },
>>>>>>> theirs
    });

    // AE-008: Emit topology:agent_completed with status 'failed' for orphaned subagent nodes
    if (topology) {
      for (const [sdkTaskId, nodeId] of topology.taskToNodeId) {
        await sessionService.publish(sessionId, {
          id: createId(),
          type: 'topology:agent_completed',
          timestamp: Date.now(),
          data: {
            agentId: nodeId,
            sdkTaskId,
            status: 'failed',
            summary: `Parent agent failed: ${errorMessage}`,
          },
        });
      }
      topology.taskToNodeId.clear();
    }

    session.close();
    return {
      runId,
      status: 'error',
      turnCount: turn,
      error: errMsg,
    };
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run the agent in planning mode first.
 * The agent will explore the codebase and use ExitPlanMode when the plan is ready.
 * Returns after the plan is ready for user approval.
 */
export async function runAgentPlanning(options: StreamHandlerOptions): Promise<AgentRunResult> {
  return runAgentSession(options, {
    permissionMode: 'plan',
    phase: 'planning',
    startEventType: 'agent:planning',
    enableTopology: false,
    enforceTurnLimit: false,
    onExitPlanMode: (_opts) => {
      /* captured via closure in runAgentSession */
    },
    onPlanCaptured: (_content) => {
      /* captured via closure in runAgentSession */
    },
    buildResult: ({ runId, turn, accumulated, metrics, planContent, exitPlanModeOptions }) => ({
      runId,
      status: 'planning',
      turnCount: turn,
      plan: planContent || accumulated,
      planOptions: exitPlanModeOptions,
      metrics,
    }),
    buildFallbackResult: ({ runId, turn, accumulated, planContent, exitPlanModeOptions }) => ({
      runId,
      status: 'planning',
      turnCount: turn,
      plan: planContent || accumulated || 'No plan generated',
      planOptions: exitPlanModeOptions,
    }),
    onResult: async ({
      runId,
      accumulated,
      sessionService,
      sessionId,
      agentId,
      planContent,
      exitPlanModeOptions,
    }) => {
      await sessionService.publish(sessionId, {
        id: createId(),
        type: 'agent:plan_ready',
        timestamp: Date.now(),
        data: {
          agentId,
          runId,
          plan: planContent || accumulated,
          allowedPrompts: exitPlanModeOptions?.allowedPrompts,
        },
      });
    },
  });
}

/**
 * Run the agent in execution mode after plan approval.
 */
export async function runAgentExecution(options: StreamHandlerOptions): Promise<AgentRunResult> {
  return runAgentSession(options, {
    permissionMode: 'acceptEdits',
    phase: 'execution',
    startEventType: 'agent:started',
    enableTopology: true,
    enforceTurnLimit: true,
    buildResult: ({ runId, turn, accumulated, metrics }) => ({
      runId,
      status: 'completed',
      turnCount: turn,
      result: accumulated || 'Task completed successfully',
      metrics,
    }),
    buildFallbackResult: ({ runId, turn, accumulated }) => ({
      runId,
      status: 'completed',
      turnCount: turn,
      result: accumulated || 'Task completed successfully',
    }),
    onResult: async ({ runId, turn, result, sessionService, sessionId, agentId, topology }) => {
      const usage =
        result.usage != null && typeof result.usage === 'object'
          ? (result.usage as { input_tokens?: number; output_tokens?: number })
          : undefined;

      // Complete root topology node
      if (topology) {
        await sessionService.publish(sessionId, {
          id: createId(),
          type: 'topology:agent_completed',
          timestamp: Date.now(),
          data: { agentId, status: 'completed' },
        });
      }

      await sessionService.publish(sessionId, {
        id: createId(),
        type: 'agent:completed',
        timestamp: Date.now(),
        data: { agentId, runId, turnCount: turn, usage },
      });
    },
  });
}
