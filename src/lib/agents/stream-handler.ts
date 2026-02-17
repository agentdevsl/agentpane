import { type CanUseTool, unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';
import { createId } from '@paralleldrive/cuid2';
import type { SessionEvent } from '../../services/session.service.js';
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

  // Create canUseTool callback to capture ExitPlanMode options.
  // The SDK's tool_use_summary may not include tool_input in newer versions,
  // so we intercept via canUseTool which always receives the full input.
  const canUseTool: CanUseTool = async (toolName, input, toolOptions) => {
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
    env: { ...process.env },
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
      }

      // Handle tool_use_summary - detect ExitPlanMode
      if (msg.type === 'tool_use_summary') {
        const toolSummary = msg as {
          tool_name?: string;
          tool_input?: Record<string, unknown>;
          tool_result?: string;
        };

        // Publish tool event
        await sessionService.publish(sessionId, {
          id: createId(),
          type: 'tool:start',
          timestamp: Date.now(),
          data: {
            agentId,
            tool: toolSummary.tool_name,
            input: toolSummary.tool_input,
            phase: 'planning',
          },
        });

        // Check if this is ExitPlanMode - this means the plan is ready
        if (toolSummary.tool_name === 'ExitPlanMode') {
          // Prefer options already captured by canUseTool callback (reliable).
          // Fall back to tool_use_summary.tool_input if canUseTool didn't fire.
          if (
            !exitPlanModeOptions &&
            toolSummary.tool_input &&
            Object.keys(toolSummary.tool_input).length > 0
          ) {
            exitPlanModeOptions = toolSummary.tool_input as ExitPlanModeOptions;
          }

          console.log(`[StreamHandler] Agent ${agentId} ExitPlanMode completed - plan is ready`);

          // The plan content is in the accumulated text
          planContent = accumulated;
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

      // Handle compact_boundary events
      if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'compact_boundary') {
        publishCompactBoundary(
          sessionService,
          sessionId,
          agentId,
          msg as Record<string, unknown>
        ).catch((err) => {
          console.warn(
            '[StreamHandler] Failed to publish compact_boundary:',
            err instanceof Error ? err.message : String(err)
          );
        });
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

  // Publish agent started event
  await sessionService.publish(sessionId, {
    id: createId(),
    type: 'agent:started',
    timestamp: Date.now(),
    data: { agentId, runId, maxTurns, model, phase: 'execution' },
  });

  // Create Claude Agent SDK session for execution
  const session = unstable_v2_createSession({
    model,
    env: { ...process.env },
    allowedTools,
    permissionMode: 'acceptEdits', // Auto-accept edits for execution
    executableArgs: ['--add-dir', cwd],
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

      // Handle tool_use_summary events
      if (msg.type === 'tool_use_summary') {
        const toolSummary = msg as {
          tool_name?: string;
          tool_input?: Record<string, unknown>;
          tool_result?: string;
          is_error?: boolean;
        };

        await sessionService.publish(sessionId, {
          id: createId(),
          type: 'tool:start',
          timestamp: Date.now(),
          data: { agentId, tool: toolSummary.tool_name, input: toolSummary.tool_input },
        });

        await sessionService.publish(sessionId, {
          id: createId(),
          type: 'tool:result',
          timestamp: Date.now(),
          data: {
            agentId,
            tool: toolSummary.tool_name,
            output: toolSummary.tool_result?.slice(0, 1000),
            isError: toolSummary.is_error,
          },
        });
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

      // Handle compact_boundary events
      if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'compact_boundary') {
        publishCompactBoundary(
          sessionService,
          sessionId,
          agentId,
          msg as Record<string, unknown>
        ).catch((err) => {
          console.warn(
            '[StreamHandler] Failed to publish compact_boundary:',
            err instanceof Error ? err.message : String(err)
          );
        });
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
