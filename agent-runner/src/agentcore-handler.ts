#!/usr/bin/env node
/**
 * AgentCore Handler — Entry point for running Claude Agent SDK inside an
 * AWS Bedrock AgentCore microVM.
 *
 * The BedrockAgentCoreApp exposes an HTTP server on port 8080.  When the
 * AgentCore runtime posts to /invocations, the async-generator handler
 * receives the invocation payload, creates (or resumes) a Claude Agent SDK
 * session, and yields SSE events back through the runtime's native streaming.
 *
 * Each `runtimeSessionId` maps to a dedicated microVM, so state isolation
 * is guaranteed by the runtime itself.
 *
 * Event shapes intentionally mirror the `AgentEvent` interface from
 * `./event-emitter.ts` so that the AgentPane bridge can handle events from
 * both Docker-based and AgentCore-based agents uniformly.
 */

import {
  type CanUseTool,
  type SDKSession,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import type {
  AgentCompleteData,
  AgentErrorData,
  AgentEventType,
  AgentMessageData,
  AgentPlanReadyData,
  AgentStartedData,
  AgentTokenData,
  AgentToolResultData,
  AgentToolStartData,
  AgentTurnData,
} from './event-emitter.js';
// SC-023: Use shared logic extracted from index.ts and agentcore-handler.ts
import {
  type ExitPlanModeInput,
  type ExitPlanModeOptions,
  extractFileChange,
  getAssistantText,
  shouldStop,
  writeCredentialsFile,
} from './shared-session.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Payload sent to /invocations by the AgentPane server. */
interface InvocationPayload {
  /** The prompt / task description. */
  prompt: string;
  /** AgentPane task ID. */
  taskId: string;
  /** AgentPane session ID for event correlation. */
  sessionId: string;
  /** Claude model to use. */
  model?: string;
  /** Maximum conversation turns. */
  maxTurns?: number;
  /** Agent phase: 'plan' for planning, 'execute' for execution. */
  phase?: 'plan' | 'execute';
  /** SDK session ID to resume (for execution after plan approval). */
  sdkSessionId?: string;
  /** Allowed bash prompts from a previous ExitPlanMode call. */
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
  /** Working directory inside the microVM. */
  cwd?: string;
  /** OAuth token for Claude authentication. */
  oauthToken?: string;
  /** Path to a sentinel file — when it exists the agent stops. */
  stopFile?: string;
}

/** Shape yielded from the async generator — matches AgentCore SSE expectations. */
interface SSEEvent {
  type: AgentEventType;
  timestamp: number;
  taskId: string;
  sessionId: string;
  data: Record<string, unknown>;
}

// SC-023: File-change detection, credentials, stop-file, and ExitPlanMode
// types are now imported from shared-session.ts (see imports above).

// ---------------------------------------------------------------------------
// Helper: build an SSE event object
// ---------------------------------------------------------------------------

function makeEvent(
  type: AgentEventType,
  taskId: string,
  sessionId: string,
  data: Record<string, unknown>
): SSEEvent {
  return { type, timestamp: Date.now(), taskId, sessionId, data };
}

// SC-023: getAssistantText is now imported from shared-session.ts

/** Drain all events from a queue, returning them as an array. */
function drainQueue(queue: SSEEvent[]): SSEEvent[] {
  const items = queue.splice(0, queue.length);
  return items;
}

// ---------------------------------------------------------------------------
// Core invocation handler
// ---------------------------------------------------------------------------

async function* handleInvocation(
  payload: InvocationPayload,
  _context: unknown
): AsyncGenerator<SSEEvent> {
  const {
    prompt,
    taskId,
    sessionId,
    model = 'claude-sonnet-4-6',
    maxTurns = 50,
    phase = 'execute',
    sdkSessionId,
    allowedPrompts,
    oauthToken,
    stopFile,
  } = payload;

  // -- Helpers that close over taskId / sessionId -------------------------
  const evt = (type: AgentEventType, data: Record<string, unknown>) =>
    makeEvent(type, taskId, sessionId, data);

  // -- Validate -----------------------------------------------------------
  if (!prompt || !taskId || !sessionId) {
    yield evt('agent:error', {
      error: 'Missing required fields: prompt, taskId, sessionId',
      code: 'INVALID_PAYLOAD',
      turnCount: 0,
    });
    return;
  }

  // -- Write OAuth credentials --------------------------------------------
  const token = oauthToken || process.env.CLAUDE_OAUTH_TOKEN;
  if (!token) {
    yield evt('agent:error', {
      error: 'No OAuth token — provide oauthToken in payload or CLAUDE_OAUTH_TOKEN env',
      code: 'MISSING_TOKEN',
      turnCount: 0,
    });
    return;
  }

  try {
    await writeCredentialsFile(token);
  } catch (credErr) {
    yield evt('agent:error', {
      error: `Credential setup failed: ${credErr instanceof Error ? credErr.message : String(credErr)}`,
      code: 'CREDENTIAL_ERROR',
      turnCount: 0,
    });
    return;
  }

  // -- Emit started -------------------------------------------------------
  yield evt('agent:started', { model, maxTurns, phase } satisfies AgentStartedData & {
    phase: string;
  });

  console.error(`[agentcore-handler] Phase: ${phase}, model: ${model}, maxTurns: ${maxTurns}`);

  // -- Tool tracking (mirrors index.ts) -----------------------------------
  const activeTools = new Map<string, { toolName: string; startTime: number }>();
  const pendingToolResults: SSEEvent[] = [];

  const trackToolResult = (toolId: string, isError = false, result = '') => {
    const tool = activeTools.get(toolId);
    if (!tool) return;
    const durationMs = Date.now() - tool.startTime;
    pendingToolResults.push(
      evt('agent:tool:result', {
        toolName: tool.toolName,
        toolId,
        result,
        isError,
        durationMs,
      } satisfies AgentToolResultData)
    );
    activeTools.delete(toolId);
  };

  const flushAllToolResults = () => {
    for (const [toolId] of activeTools) {
      trackToolResult(toolId, false, 'completed');
    }
  };

  // -- Plan-mode state (only used when phase === 'plan') ------------------
  let exitPlanModeDetected = false;
  let exitPlanModeOptions: ExitPlanModeOptions | undefined;
  let exitPlanModePlan: string | undefined;

  // -- canUseTool callback ------------------------------------------------
  const pendingToolStarts: SSEEvent[] = [];
  const pendingFileChanges: SSEEvent[] = [];

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    activeTools.set(options.toolUseID, { toolName, startTime: Date.now() });

    // Queue tool:start event (will be yielded in main loop)
    pendingToolStarts.push(
      evt('agent:tool:start', {
        toolName,
        toolId: options.toolUseID,
        input: (input as Record<string, unknown>) ?? {},
      } satisfies AgentToolStartData)
    );

    // Detect file modifications
    const fileChange = extractFileChange(toolName, (input as Record<string, unknown>) ?? {});
    if (fileChange) {
      pendingFileChanges.push(evt('agent:file_changed', { ...fileChange }));
    }

    // Capture ExitPlanMode in planning phase
    if (phase === 'plan' && toolName === 'ExitPlanMode') {
      const planInput = input as ExitPlanModeInput | undefined;
      exitPlanModeOptions = planInput;
      exitPlanModeDetected = true;
      exitPlanModePlan = typeof planInput?.plan === 'string' ? planInput.plan : undefined;
      console.error(
        `[agentcore-handler] ExitPlanMode captured — plan: ${exitPlanModePlan ? `${exitPlanModePlan.length} chars` : 'none'}`
      );
    }

    // In execution phase, auto-approve Bash commands that match allowedPrompts from planning
    if (phase === 'execute' && toolName === 'Bash' && allowedPrompts) {
      const bashInput = input as { command?: string } | undefined;
      if (bashInput?.command) {
        const isAllowed = allowedPrompts.some(
          (ap) => ap.tool === 'Bash' && ap.prompt === bashInput.command
        );
        if (isAllowed) {
          console.error(`[agentcore-handler] Auto-approved Bash command from allowedPrompts`);
        }
      }
    }

    return { behavior: 'allow' as const, toolUseID: options.toolUseID };
  };

  // -- Create / resume SDK session ----------------------------------------
  let session: SDKSession | undefined;
  let sessionResumed = false;

  try {
    const permissionMode = phase === 'plan' ? 'plan' : 'bypassPermissions';
    console.error(
      `[agentcore-handler] Creating SDK session (permissionMode: ${permissionMode})...`
    );

    if (sdkSessionId && phase === 'execute') {
      try {
        session = unstable_v2_resumeSession(sdkSessionId, {
          model,
          env: { ...process.env },
          permissionMode,
          canUseTool,
        });
        sessionResumed = true;
        console.error(`[agentcore-handler] Resumed SDK session: ${sdkSessionId}`);
      } catch (resumeErr) {
        const msg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
        console.warn(`[agentcore-handler] Resume failed, creating fresh session: ${msg}`);
        yield evt('agent:message', {
          role: 'assistant',
          content: `Previous session could not be resumed (${msg}). Starting fresh execution with full plan context.`,
        } satisfies AgentMessageData);
      }
    }

    if (!session) {
      session = unstable_v2_createSession({
        model,
        env: { ...process.env },
        permissionMode,
        canUseTool,
      });
    }
    console.error('[agentcore-handler] SDK session ready');
  } catch (sessionErr) {
    const errMsg = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
    console.error('[agentcore-handler] SDK session creation failed:', errMsg);
    yield evt('agent:error', {
      error: `SDK session creation failed: ${errMsg}`,
      code: 'SDK_SESSION_FAILED',
      turnCount: 0,
    } satisfies AgentErrorData);
    return;
  }

  if (!session) {
    yield evt('agent:error', {
      error: 'Session not initialized',
      code: 'SDK_SESSION_FAILED',
      turnCount: 0,
    });
    return;
  }

  // -- Stream processing --------------------------------------------------
  let turn = 0;
  let accumulatedText = '';
  let capturedSdkSessionId: string | undefined;
  let sessionClosed = false;

  const closeSession = () => {
    if (!sessionClosed && session) {
      sessionClosed = true;
      session.close();
    }
  };

  try {
    // Send prompt — use abbreviated prompt when resuming a planned session
    const sendPrompt = sessionResumed
      ? 'The plan has been approved. Please proceed with the implementation.'
      : prompt;

    await session.send(sendPrompt);
    console.error(`[agentcore-handler] Processing SDK stream (${phase})...`);

    let messageCount = 0;

    for await (const msg of session.stream()) {
      messageCount++;

      // Yield any queued tool events from canUseTool callback
      yield* drainQueue(pendingToolStarts);
      yield* drainQueue(pendingFileChanges);
      yield* drainQueue(pendingToolResults);

      // Check for cancellation
      if (await shouldStop(stopFile)) {
        console.error('[agentcore-handler] Stop file detected, cancelling...');
        yield evt('agent:cancelled', { turnCount: turn });
        closeSession();
        return;
      }

      // -- system: capture SDK session ID ---------------------------------
      if (msg.type === 'system') {
        const sysMsg = msg as { subtype?: string };
        if (sysMsg.subtype === 'init') {
          capturedSdkSessionId = session.sessionId;
          console.error(`[agentcore-handler] SDK session ID: ${capturedSdkSessionId}`);
        }
      }

      // -- stream_event: token deltas and turn tracking -------------------
      if (msg.type === 'stream_event') {
        const event = msg.event as {
          type: string;
          delta?: { type: string; text?: string };
          message?: { model?: string };
        };

        // Turn tracking on message_start
        if (event.type === 'message_start') {
          turn++;
          console.error(`[agentcore-handler] Turn ${turn}/${maxTurns}`);
          yield evt('agent:turn', {
            turn,
            maxTurns,
            remaining: maxTurns - turn,
          } satisfies AgentTurnData);

          if (turn >= maxTurns) {
            console.error('[agentcore-handler] Turn limit reached');
            yield evt('agent:complete', {
              status: 'turn_limit',
              turnCount: turn,
              result: `Turn limit reached (${maxTurns}).${phase === 'plan' ? ' Planning incomplete.' : ' Task may need manual completion.'}`,
            } satisfies AgentCompleteData);
            closeSession();
            return;
          }
        }

        // Text deltas
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          event.delta.text
        ) {
          const delta = event.delta.text;
          accumulatedText += delta;
          yield evt('agent:token', {
            delta,
            accumulated: accumulatedText,
          } satisfies AgentTokenData);
        }
      }

      // -- tool_progress --------------------------------------------------
      if (msg.type === 'tool_progress') {
        const toolMsg = msg as {
          tool_use_id: string;
          tool_name: string;
          elapsed_time_seconds: number;
        };
        if (!activeTools.has(toolMsg.tool_use_id)) {
          activeTools.set(toolMsg.tool_use_id, {
            toolName: toolMsg.tool_name,
            startTime: Date.now(),
          });
          yield evt('agent:tool:start', {
            toolName: toolMsg.tool_name,
            toolId: toolMsg.tool_use_id,
            input: {},
          } satisfies AgentToolStartData);
        }
      }

      // -- rate_limit_event (SDK v0.2.76+) ---------------------------------
      if (msg.type === 'rate_limit_event') {
        const rateLimitMsg = msg as {
          rate_limit_info: { status: string; resetsAt?: number };
        };
        console.error(`[agentcore-handler] Rate limit: ${rateLimitMsg.rate_limit_info.status}`);
      }

      // -- tool_use_summary -----------------------------------------------
      if (msg.type === 'tool_use_summary') {
        const toolSummary = msg as {
          summary: string;
          preceding_tool_use_ids: string[];
        };

        for (const toolId of toolSummary.preceding_tool_use_ids) {
          const startInfo = activeTools.get(toolId);
          if (startInfo) {
            activeTools.delete(toolId);
            const durationMs = Date.now() - startInfo.startTime;
            yield evt('agent:tool:result', {
              toolName: startInfo.toolName,
              toolId,
              result: toolSummary.summary ?? '',
              isError: false,
              durationMs,
            } satisfies AgentToolResultData);

            if (startInfo.toolName === 'ExitPlanMode') {
              console.error('[agentcore-handler] ExitPlanMode tool completed — waiting for result');
            }
          }
        }
      }

      // -- assistant message ----------------------------------------------
      if (msg.type === 'assistant') {
        // Flush remaining tool results
        flushAllToolResults();
        yield* drainQueue(pendingToolResults);

        const text = getAssistantText(msg);
        if (text) {
          accumulatedText = text;
          yield evt('agent:message', {
            role: 'assistant',
            content: text,
          } satisfies AgentMessageData);
        }
      }

      // -- result (stream end) --------------------------------------------
      if (msg.type === 'result') {
        flushAllToolResults();
        yield* drainQueue(pendingToolResults);
        closeSession();

        if (phase === 'plan') {
          // Planning phase: emit plan_ready if ExitPlanMode was called
          if (exitPlanModeDetected || exitPlanModeOptions !== undefined || accumulatedText) {
            const planContent = exitPlanModePlan || accumulatedText;
            console.error(
              `[agentcore-handler] Emitting plan_ready (source: ${exitPlanModePlan ? 'ExitPlanModeInput' : 'accumulated'}, length: ${planContent.length})`
            );
            yield evt('agent:plan_ready', {
              plan: planContent,
              turnCount: turn,
              sdkSessionId: capturedSdkSessionId ?? '',
              allowedPrompts: exitPlanModeOptions?.allowedPrompts,
            } satisfies AgentPlanReadyData);
          } else {
            yield evt('agent:complete', {
              status: 'completed',
              turnCount: turn,
              result: accumulatedText || 'Planning completed without explicit plan',
            } satisfies AgentCompleteData);
          }
        } else {
          // Execution phase
          const result = msg as { text?: string; subtype?: string; is_error?: boolean };
          if (result.is_error) {
            yield evt('agent:complete', {
              status: 'turn_limit',
              turnCount: turn,
              result: result.text ?? 'Task ended with error',
            } satisfies AgentCompleteData);
          } else {
            yield evt('agent:complete', {
              status: 'completed',
              turnCount: turn,
              result: result.text ?? (accumulatedText || 'Task completed'),
            } satisfies AgentCompleteData);
          }
        }
        return;
      }
    }

    // Stream ended without explicit result
    console.error(`[agentcore-handler] Stream ended. Messages: ${messageCount}, turns: ${turn}`);
    flushAllToolResults();
    yield* drainQueue(pendingToolResults);
    closeSession();

    if (phase === 'plan' && accumulatedText) {
      yield evt('agent:plan_ready', {
        plan: accumulatedText,
        turnCount: turn,
        sdkSessionId: capturedSdkSessionId ?? '',
        allowedPrompts: exitPlanModeOptions?.allowedPrompts,
      } satisfies AgentPlanReadyData);
    } else {
      yield evt('agent:complete', {
        status: 'completed',
        turnCount: turn,
        result: accumulatedText || `${phase === 'plan' ? 'Planning' : 'Task'} completed`,
      } satisfies AgentCompleteData);
    }
  } catch (error) {
    flushAllToolResults();
    yield* drainQueue(pendingToolResults);

    const message = error instanceof Error ? error.message : String(error);
    const errorCode = (error as { code?: string }).code;
    console.error(`[agentcore-handler] ${phase} error:`, message);
    if (error instanceof Error && error.stack) {
      console.error('[agentcore-handler] Stack:', error.stack);
    }

    yield evt('agent:error', {
      error: message,
      code: errorCode || (phase === 'plan' ? 'PLANNING_ERROR' : 'STREAM_ERROR'),
      turnCount: turn,
    } satisfies AgentErrorData);

    closeSession();
  }
}

// ---------------------------------------------------------------------------
// BedrockAgentCoreApp bootstrap
// ---------------------------------------------------------------------------

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: handleInvocation as (payload: unknown, context: unknown) => AsyncGenerator<SSEEvent>,
  },
});

console.error('[agentcore-handler] Starting BedrockAgentCoreApp on port 8080...');
app.run();
