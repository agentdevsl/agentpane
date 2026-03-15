import { type CanUseTool, unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';
import { createId } from '@paralleldrive/cuid2';
import type { SessionEvent } from '../../services/session.service.js';
import { deriveAgentName, mapAgentRole } from '../topology/map-agent-role.js';
import { buildSdkEnv } from './agent-sdk-utils.js';
import { getToolHandler } from './tools/index.js';
import type { AgentHooks, ToolContext, ToolResponse } from './types.js';

export interface StreamHandlerOptions {
  agentId: string;
  sessionId: string;
  prompt: string;
  allowedTools: string[];
  maxTurns: number;
  model: string;
  cwd: string;
  hooks: AgentHooks;
  sessionService: {
    publish: (sessionId: string, event: SessionEvent) => Promise<unknown>;
  };
}

export interface ExitPlanModeOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  // TODO: Pending GA — swarm and remote session features
  // pushToRemote?: boolean;
  // remoteSessionId?: string;
  // remoteSessionUrl?: string;
  // remoteSessionTitle?: string;
  // launchSwarm?: boolean;
  // teammateCount?: number;
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

async function runPreToolHooks(
  hooks: AgentHooks,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<{ allowed: boolean; message?: string }> {
  for (const hookGroup of hooks.PreToolUse) {
    for (const hook of hookGroup.hooks) {
      const result = await hook({ tool_name: toolName, tool_input: toolInput });
      if (result.decision === 'block') {
        return { allowed: false, message: result.message };
      }
    }
  }
  return { allowed: true };
}

async function runPostToolHooks(
  hooks: AgentHooks,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: ToolResponse,
  durationMs: number
): Promise<void> {
  for (const hookGroup of hooks.PostToolUse) {
    for (const hook of hookGroup.hooks) {
      await hook({
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        duration_ms: durationMs,
      });
    }
  }
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

/**
 * Run the agent in planning mode first.
 * The agent will explore the codebase and use ExitPlanMode when the plan is ready.
 * Returns after the plan is ready for user approval.
 */
export async function runAgentPlanning(options: StreamHandlerOptions): Promise<AgentRunResult> {
  const { agentId, sessionId, prompt, model, cwd, sessionService } = options;

  const runId = createId();
  let accumulated = '';
  let turn = 0;
  let planContent = '';
  let exitPlanModeOptions: ExitPlanModeOptions | undefined;

  // Publish planning started event
  await sessionService.publish(sessionId, {
    id: createId(),
    type: 'agent:planning',
    timestamp: Date.now(),
    data: { agentId, runId, model },
  });

  // Track active tools by toolUseID for correlating with tool_use_summary
  const activeTools = new Map<string, { toolName: string; startTime: number }>();

  // Create canUseTool callback to capture ExitPlanMode options and emit tool:start events.
  // The SDK's tool_use_summary in v0.2.76+ no longer includes tool_name/tool_input,
  // so we intercept via canUseTool which always receives the full input.
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
        phase: 'planning',
      },
    });

    if (toolName === 'ExitPlanMode') {
      const planOptions = input as ExitPlanModeOptions | undefined;
      exitPlanModeOptions = planOptions;

      console.log(`[StreamHandler] Agent ${agentId} ExitPlanMode captured via canUseTool`);
    }
    return { behavior: 'allow' as const, toolUseID: toolOptions.toolUseID };
  };

  // Create Claude Agent SDK session in PLAN mode
  // In plan mode, the agent can read/explore but not execute changes
  // The agent will use ExitPlanMode tool when the plan is ready
  const session = unstable_v2_createSession({
    model,
    env: buildSdkEnv(),
    permissionMode: 'plan', // Planning mode - agent will use ExitPlanMode when done
    executableArgs: ['--add-dir', cwd],
    canUseTool,
  });

  try {
    // Send the task prompt - the agent will automatically enter plan mode
    await session.send(prompt);

    // Stream the planning response
    for await (const msg of session.stream()) {
      // Handle stream events (token-by-token streaming)
      if (msg.type === 'stream_event') {
        const event = msg.event as {
          type: string;
          delta?: { type: string; text?: string };
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
            data: { agentId, delta: event.delta.text, accumulated, phase: 'planning' },
          });
        }
      }

      // Handle complete assistant message
      if (msg.type === 'assistant') {
        turn++;
        const message = msg.message as {
          content?: Array<{ type: string; text?: string }>;
        };

        const textContent = message?.content
          ?.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');

        if (textContent) {
          accumulated = textContent;
        }

        // Publish turn event for planning phase
        await sessionService.publish(sessionId, {
          id: createId(),
          type: 'agent:turn',
          timestamp: Date.now(),
          data: { agentId, turn, phase: 'planning' },
        });

        // Check for SDK-level errors on assistant messages (v0.2.76+)
        const assistantError = (msg as { error?: string }).error;
        if (assistantError) {
          console.warn(`[StreamHandler] Agent ${agentId} assistant error: ${assistantError}`);
          sessionService
            .publish(sessionId, {
              id: createId(),
              type: 'agent:error',
              timestamp: Date.now(),
              data: {
                agentId,
                runId,
                error: `Assistant error: ${assistantError}`,
                phase: 'planning',
              },
            })
            .catch((err) => {
              console.warn(
                '[StreamHandler] Failed to publish assistant error:',
                err instanceof Error ? err.message : String(err)
              );
            });
        }
      }

      // Handle tool_use_summary (SDK v0.2.76+: summary + preceding_tool_use_ids)
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
              phase: 'planning',
            },
          });

          // Check if this is ExitPlanMode - this means the plan is ready
          if (tracked.toolName === 'ExitPlanMode') {
            planContent = accumulated;
            console.log(`[StreamHandler] Agent ${agentId} ExitPlanMode completed - plan is ready`);
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
        ).catch((err) => {
          console.warn(
            '[StreamHandler] Failed to publish tool_progress:',
            err instanceof Error ? err.message : String(err)
          );
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
          .catch((err) => {
            console.warn(
              '[StreamHandler] Failed to publish rate_limit:',
              err instanceof Error ? err.message : String(err)
            );
          });
      }

      // Handle system messages (compact_boundary) during planning
      if (msg.type === 'system') {
        const sysMsg = msg as Record<string, unknown>;
        if ((sysMsg.subtype as string) === 'compact_boundary') {
          publishCompactBoundary(sessionService, sessionId, agentId, sysMsg).catch((err) => {
            console.warn(
              '[StreamHandler] Failed to publish compact_boundary:',
              err instanceof Error ? err.message : String(err)
            );
          });
        }
      }

      // Handle result (planning session finished)
      if (msg.type === 'result') {
        const result = msg as Record<string, unknown>;

        session.close(); // Always close first — before any potentially-failing publishes

        publishMetrics(sessionService, sessionId, agentId, runId, result).catch((err) => {
          console.warn(
            '[StreamHandler] Failed to publish metrics:',
            err instanceof Error ? err.message : String(err)
          );
        });

        // Publish plan ready event with plan options
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

        return {
          runId,
          status: 'planning',
          turnCount: turn,
          plan: planContent || accumulated,
          planOptions: exitPlanModeOptions,
          metrics: extractResultMetrics(result),
        };
      }
    }

    // If we exit the loop, planning completed
    session.close();

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

    return {
      runId,
      status: 'planning',
      turnCount: turn,
      plan: planContent || accumulated || 'No plan generated',
      planOptions: exitPlanModeOptions,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[StreamHandler] Agent ${agentId} planning error:`, error);

    await sessionService.publish(sessionId, {
      id: createId(),
      type: 'agent:error',
      timestamp: Date.now(),
      data: { agentId, runId, error: errorMessage, phase: 'planning' },
    });

    session.close();
    return {
      runId,
      status: 'error',
      turnCount: 0,
      error: errorMessage,
    };
  }
}

/**
 * Run the agent in execution mode after plan approval.
 */
export async function runAgentExecution(options: StreamHandlerOptions): Promise<AgentRunResult> {
  const { agentId, sessionId, prompt, allowedTools, maxTurns, model, cwd, sessionService } =
    options;

  const runId = createId();
  let turn = 0;
  let accumulated = '';

  // Topology tracker for subagent lifecycle events
  const topology = createTopologyTracker();

  // Publish agent started event
  await sessionService.publish(sessionId, {
    id: createId(),
    type: 'agent:started',
    timestamp: Date.now(),
    data: { agentId, runId, maxTurns, model, phase: 'execution' },
  });

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
      },
    });

    return { behavior: 'allow' as const, toolUseID: toolOptions.toolUseID };
  };

  // Create Claude Agent SDK session for execution
  const session = unstable_v2_createSession({
    model,
    env: buildSdkEnv(),
    allowedTools,
    permissionMode: 'acceptEdits', // Auto-accept edits for execution
    executableArgs: ['--add-dir', cwd],
    canUseTool,
  });

  try {
    // Send the execution prompt
    await session.send(prompt);

    // Stream responses from the SDK
    for await (const msg of session.stream()) {
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
            data: { agentId, delta: event.delta.text, accumulated, phase: 'execution' },
          });
        }
      }

      // Handle complete assistant messages (turn completed)
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
            maxTurns,
            remaining: maxTurns - turn,
            usage: message?.usage,
          },
        });

        // Check for SDK-level errors on assistant messages (v0.2.76+)
        const assistantError = (msg as { error?: string }).error;
        if (assistantError) {
          console.warn(`[StreamHandler] Agent ${agentId} assistant error: ${assistantError}`);
          sessionService
            .publish(sessionId, {
              id: createId(),
              type: 'agent:error',
              timestamp: Date.now(),
              data: { agentId, runId, error: `Assistant error: ${assistantError}` },
            })
            .catch((err) => {
              console.warn(
                '[StreamHandler] Failed to publish assistant error:',
                err instanceof Error ? err.message : String(err)
              );
            });
        }

        if (turn >= maxTurns) {
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

      // Handle tool_use_summary events (SDK v0.2.76+: summary + preceding_tool_use_ids)
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
            },
          });

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
        ).catch((err) => {
          console.warn(
            '[StreamHandler] Failed to publish tool_progress:',
            err instanceof Error ? err.message : String(err)
          );
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
          .catch((err) => {
            console.warn(
              '[StreamHandler] Failed to publish rate_limit:',
              err instanceof Error ? err.message : String(err)
            );
          });
      }

      // Handle system messages (compact_boundary + subagent topology)
      if (msg.type === 'system') {
        const sysMsg = msg as Record<string, unknown>;
        const sysSubtype = sysMsg.subtype as string | undefined;

        if (sysSubtype === 'compact_boundary') {
          publishCompactBoundary(sessionService, sessionId, agentId, sysMsg).catch((err) => {
            console.warn(
              '[StreamHandler] Failed to publish compact_boundary:',
              err instanceof Error ? err.message : String(err)
            );
          });
        }

        // Handle subagent lifecycle events (task_started, task_progress, task_notification)
        // Awaited (not fire-and-forget) to preserve event ordering — spawned must precede progress/completed
        if (
          sysSubtype === 'task_started' ||
          sysSubtype === 'task_progress' ||
          sysSubtype === 'task_notification'
        ) {
          await handleTopologySystemMessage(sysMsg, topology, sessionService, sessionId, agentId);
        }
      }

      // Handle result (agent finished)
      if (msg.type === 'result') {
        const result = msg as Record<string, unknown>;

        session.close(); // Always close first — before any potentially-failing publishes

        publishMetrics(sessionService, sessionId, agentId, runId, result).catch((err) => {
          console.warn(
            '[StreamHandler] Failed to publish metrics:',
            err instanceof Error ? err.message : String(err)
          );
        });

        const usage =
          result.usage != null && typeof result.usage === 'object'
            ? (result.usage as { input_tokens?: number; output_tokens?: number })
            : undefined;

        await sessionService.publish(sessionId, {
          id: createId(),
          type: 'agent:completed',
          timestamp: Date.now(),
          data: { agentId, runId, turnCount: turn, usage },
        });

        return {
          runId,
          status: 'completed',
          turnCount: turn,
          result: accumulated || 'Task completed successfully',
          metrics: extractResultMetrics(result),
        };
      }
    }

    session.close();

    await sessionService.publish(sessionId, {
      id: createId(),
      type: 'agent:completed',
      timestamp: Date.now(),
      data: { agentId, runId, turnCount: turn },
    });

    return {
      runId,
      status: 'completed',
      turnCount: turn,
      result: accumulated || 'Task completed successfully',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[StreamHandler] Agent ${agentId} execution error:`, error);

    await sessionService.publish(sessionId, {
      id: createId(),
      type: 'agent:error',
      timestamp: Date.now(),
      data: { agentId, runId, error: errorMessage },
    });

    session.close();
    return {
      runId,
      status: 'error',
      turnCount: turn,
      error: errorMessage,
    };
  }
}

/**
 * Legacy function - delegates to runAgentPlanning.
 * @deprecated Use runAgentPlanning and runAgentExecution separately
 */
export async function runAgentWithStreaming(
  options: StreamHandlerOptions
): Promise<AgentRunResult> {
  // Start with planning phase
  return runAgentPlanning(options);
}

// Helper to execute a single tool call with hooks
export async function executeToolWithHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  context: ToolContext,
  hooks: AgentHooks
): Promise<ToolResponse> {
  // Run pre-tool hooks
  const preResult = await runPreToolHooks(hooks, toolName, toolInput);
  if (!preResult.allowed) {
    return {
      content: [{ type: 'text', text: preResult.message ?? 'Tool blocked by policy' }],
      is_error: true,
    };
  }

  // Get tool handler
  const handler = getToolHandler(toolName);
  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      is_error: true,
    };
  }

  // Execute tool
  const startTime = Date.now();
  const response = await handler(toolInput as never, context);
  const duration = Date.now() - startTime;

  // Run post-tool hooks
  await runPostToolHooks(hooks, toolName, toolInput, response, duration);

  return response;
}
