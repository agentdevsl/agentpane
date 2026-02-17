#!/usr/bin/env node
/**
 * Agent Runner - Entry point for running Claude Agent SDK inside Docker containers.
 *
 * Supports two execution phases:
 * 1. Planning phase (AGENT_PHASE=plan): Agent explores and creates a plan, emits plan_ready when done
 * 2. Execution phase (AGENT_PHASE=execute): Agent executes the approved plan with full permissions
 *
 * Environment variables:
 * - CLAUDE_OAUTH_TOKEN: Required. OAuth token for Claude authentication.
 * - AGENT_TASK_ID: Required. Task ID being worked on.
 * - AGENT_SESSION_ID: Required. Session ID for event streaming.
 * - AGENT_PROMPT: Required. The task prompt.
 * - AGENT_PHASE: Optional. 'plan' or 'execute' (default: 'execute' for backwards compatibility).
 * - AGENT_SDK_SESSION_ID: Optional. SDK session ID to resume (for execute phase after plan approval).
 * - AGENT_MAX_TURNS: Optional. Maximum turns (default: 50).
 * - AGENT_MODEL: Optional. Model to use (default: claude-opus-4-5-20251101).
 * - AGENT_CWD: Optional. Working directory (default: /workspace).
 * - AGENT_STOP_FILE: Optional. Sentinel file path for cancellation.
 *
 * The OAuth token is written to ~/.claude/.credentials.json before starting the SDK.
 * This is required because OAuth tokens passed via ANTHROPIC_API_KEY env var are blocked.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  type CanUseTool,
  type SDKSession,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentFileChangedData } from './event-emitter.js';
import { createEventEmitter } from './event-emitter.js';

/** File-modifying tool names and how to extract the path from their input */
const FILE_MODIFY_TOOLS: Record<
  string,
  { pathKey: string; action: (input: Record<string, unknown>) => AgentFileChangedData['action'] }
> = {
  Write: { pathKey: 'file_path', action: () => 'create' },
  Edit: { pathKey: 'file_path', action: () => 'modify' },
  NotebookEdit: { pathKey: 'notebook_path', action: () => 'modify' },
};

/** Extract file change info from a tool call, if applicable */
function extractFileChange(
  toolName: string,
  input: Record<string, unknown>
): AgentFileChangedData | null {
  const spec = FILE_MODIFY_TOOLS[toolName];
  if (!spec) return null;
  const filePath = input[spec.pathKey];
  if (typeof filePath !== 'string' || !filePath) return null;
  return {
    path: filePath,
    action: spec.action(input),
    toolName,
  };
}

/** Detect file-modifying tools and emit file_changed event */
function emitFileChangeIfApplicable(
  toolName: string,
  input: unknown,
  events: ReturnType<typeof createEventEmitter>
): void {
  const fileChange = extractFileChange(toolName, (input as Record<string, unknown>) ?? {});
  if (fileChange) {
    events.fileChanged(fileChange);
  }
}

// Phase type
type AgentPhase = 'plan' | 'execute';

// Configuration from environment (declared early for error handlers)
const config = {
  oauthToken: process.env.CLAUDE_OAUTH_TOKEN,
  taskId: process.env.AGENT_TASK_ID,
  sessionId: process.env.AGENT_SESSION_ID,
  prompt: process.env.AGENT_PROMPT,
  phase: (process.env.AGENT_PHASE ?? 'execute') as AgentPhase,
  sdkSessionId: process.env.AGENT_SDK_SESSION_ID, // For resuming after plan approval
  maxTurns: parseInt(process.env.AGENT_MAX_TURNS ?? '50', 10),
  model: process.env.AGENT_MODEL ?? 'claude-opus-4-5-20251101',
  cwd: process.env.AGENT_CWD ?? '/workspace',
  stopFile: process.env.AGENT_STOP_FILE,
};

// Global error handlers - catch EPIPE and other unhandled errors
// These must be registered early, before any async operations
process.on('uncaughtException', (error: Error & { code?: string }) => {
  console.error('[agent-runner] Uncaught exception:', error.message);
  console.error('[agent-runner] Stack:', error.stack);

  // Try to emit error event if we have config
  if (config.taskId && config.sessionId) {
    try {
      const events = createEventEmitter(config.taskId, config.sessionId);
      events.error({
        error: `Uncaught: ${error.message}`,
        code: error.code || 'UNCAUGHT_ERROR',
        turnCount: 0,
      });
    } catch {
      // Best effort - event emitter might also fail
      console.error('[agent-runner] Failed to emit error event');
    }
  }

  // Use sync exit in global handlers to avoid re-entering async code
  // The event emitter uses writeSync for critical events, so it should already be flushed
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('[agent-runner] Unhandled rejection:', message);

  // Try to emit error event if we have config
  if (config.taskId && config.sessionId) {
    try {
      const events = createEventEmitter(config.taskId, config.sessionId);
      events.error({
        error: `Unhandled rejection: ${message}`,
        code: 'UNHANDLED_REJECTION',
        turnCount: 0,
      });
    } catch {
      // Best effort - event emitter might also fail
      console.error('[agent-runner] Failed to emit error event');
    }
  }

  // Use sync exit in global handlers to avoid re-entering async code
  process.exit(1);
});

const WORKSPACE_ROOT = process.env.AGENT_WORKSPACE_ROOT ?? '/workspace';
const ALLOWED_STOP_ROOTS = [WORKSPACE_ROOT, '/tmp'];

/**
 * Flush stdout and exit with the given code.
 * This ensures all buffered output (including JSON events) is written before the process exits.
 * Critical for error events that must reach the host process.
 */
async function flushAndExit(code: number): Promise<never> {
  // Wait for stdout to flush
  await new Promise<void>((resolve) => {
    // If stdout is already finished/closed, resolve immediately
    if (!process.stdout.writable) {
      resolve();
      return;
    }
    // Write empty string to trigger flush callback
    process.stdout.write('', () => resolve());
  });

  // Small delay to ensure kernel buffer is flushed
  await new Promise((resolve) => setTimeout(resolve, 50));

  process.exit(code);
}

// Validate required configuration
function validateConfig(): void {
  if (!config.oauthToken) {
    throw new Error('CLAUDE_OAUTH_TOKEN is required');
  }
  if (!config.taskId) {
    throw new Error('AGENT_TASK_ID is required');
  }
  if (!config.sessionId) {
    throw new Error('AGENT_SESSION_ID is required');
  }
  if (!config.prompt) {
    throw new Error('AGENT_PROMPT is required');
  }
  if (config.phase !== 'plan' && config.phase !== 'execute') {
    throw new Error('AGENT_PHASE must be "plan" or "execute"');
  }

  config.cwd = resolveWorkspacePath(config.cwd, WORKSPACE_ROOT);

  if (config.stopFile) {
    config.stopFile = resolveStopFilePath(config.stopFile);
  }
}

/**
 * Write OAuth credentials to ~/.claude/.credentials.json
 * The Claude Agent SDK reads this file for authentication.
 * OAuth tokens passed via ANTHROPIC_API_KEY env var are blocked by the API.
 */
async function writeCredentialsFile(): Promise<void> {
  const home = homedir();
  const claudeDir = join(home, '.claude');
  const credentialsFile = join(claudeDir, '.credentials.json');

  // Debug: Log paths and token status (never log token contents for security)
  console.error(`[agent-runner] Home directory: ${home}`);
  console.error(`[agent-runner] Credentials path: ${credentialsFile}`);
  console.error(`[agent-runner] Token received: ${config.oauthToken ? 'YES' : 'NONE'}`);

  if (!config.oauthToken) {
    throw new Error('No OAuth token provided via CLAUDE_OAUTH_TOKEN environment variable');
  }

  // Use null instead of empty string for refreshToken - SDK may reject empty string
  // expiresAt as milliseconds (matching SDK's expected format from `claude login`)
  const credentials = {
    claudeAiOauth: {
      accessToken: config.oauthToken,
      refreshToken: null,
      expiresAt: Date.now() + 86400000, // 24h from now in milliseconds
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      subscriptionType: 'max',
    },
  };

  // Create .claude directory
  await mkdir(claudeDir, { recursive: true, mode: 0o700 });

  // Write credentials file
  await writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });

  console.error(`[agent-runner] Wrote credentials to ${credentialsFile}`);

  // Verify the file is readable and valid JSON
  try {
    const written = await readFile(credentialsFile, 'utf-8');
    const parsed = JSON.parse(written) as { claudeAiOauth?: { accessToken?: string } };
    if (!parsed.claudeAiOauth?.accessToken) {
      throw new Error('Credentials file written but accessToken missing');
    }
    console.error('[agent-runner] Credentials file verified successfully');
  } catch (verifyError) {
    const errMsg = verifyError instanceof Error ? verifyError.message : String(verifyError);
    throw new Error(`Credentials file verification failed: ${errMsg}`);
  }
}

function resolveWorkspacePath(path: string, fallbackCwd: string): string {
  const resolved = isAbsolute(path) ? path : resolve(fallbackCwd, path);
  const normalized = resolve(resolved);

  if (!normalized.startsWith(`${WORKSPACE_ROOT}/`) && normalized !== WORKSPACE_ROOT) {
    throw new Error(`AGENT_CWD must be within ${WORKSPACE_ROOT}`);
  }

  return normalized;
}

function resolveStopFilePath(path: string): string {
  const resolved = isAbsolute(path) ? path : resolve('/tmp', path);
  const normalized = resolve(resolved);

  const allowed = ALLOWED_STOP_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`)
  );

  if (!allowed) {
    throw new Error(`AGENT_STOP_FILE must be within ${ALLOWED_STOP_ROOTS.join(' or ')}`);
  }

  return normalized;
}

/**
 * Check if the agent should stop (sentinel file exists).
 */
async function shouldStop(): Promise<boolean> {
  if (!config.stopFile) {
    return false;
  }
  try {
    await access(config.stopFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * ExitPlanMode options captured from the tool call.
 */
interface ExitPlanModeOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  // TODO: Pending GA — swarm and remote session features
  // launchSwarm?: boolean;
  // teammateCount?: number;
  // pushToRemote?: boolean;
  // remoteSessionId?: string;
  // remoteSessionUrl?: string;
  // remoteSessionTitle?: string;
}

/**
 * Typed input from ExitPlanMode tool call, extending options with plan content.
 */
interface ExitPlanModeInput extends ExitPlanModeOptions {
  plan?: string;
}

/**
 * Run the agent in planning mode.
 * The agent explores the codebase and creates a plan.
 * When ExitPlanMode is called, emits plan_ready event and exits.
 */
async function runPlanningPhase(): Promise<void> {
  const events = createEventEmitter(config.taskId as string, config.sessionId as string);

  // Emit started event with phase info
  events.started({
    model: config.model,
    maxTurns: config.maxTurns,
  });

  console.error('[agent-runner] Starting PLANNING phase...');

  // Track ExitPlanMode options - captured by canUseTool callback
  let exitPlanModeOptions: ExitPlanModeOptions | undefined;
  // Flag set when ExitPlanMode is detected via canUseTool - checked in stream loop
  let exitPlanModeDetected = false;
  // Plan content captured from canUseTool input (ExitPlanModeInput.plan)
  let exitPlanModePlan: string | undefined;
  // Timestamp when ExitPlanMode was detected (for timeout handling)
  let exitPlanModeTimestamp: number | undefined;
  const EXIT_PLAN_MODE_TIMEOUT_MS = 60_000;

  // Track active tool executions for emitting toolResult events
  const activeTools = new Map<string, { toolName: string; startTime: number }>();

  // Helper to emit tool result for a completed tool
  const emitToolResult = (toolId: string, isError = false, result = '') => {
    const tool = activeTools.get(toolId);
    if (tool) {
      const durationMs = Date.now() - tool.startTime;
      events.toolResult({
        toolName: tool.toolName,
        toolId,
        result,
        isError,
        durationMs,
      });
      activeTools.delete(toolId);
    }
  };

  // Helper to emit results for all active tools (called on completion/error)
  const emitAllToolResults = () => {
    for (const [toolId] of activeTools) {
      emitToolResult(toolId, false, 'completed');
    }
  };

  // Create Claude Agent SDK session in PLAN mode
  let session: SDKSession | undefined;
  try {
    console.error('[agent-runner] Creating SDK session in plan mode...');

    // Create canUseTool callback to capture ExitPlanMode options
    // This is the official SDK mechanism for intercepting tool calls
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      console.error(`[agent-runner] canUseTool: ${toolName}`);

      // Track tool start
      activeTools.set(options.toolUseID, { toolName, startTime: Date.now() });

      // Emit tool start event for all tools
      events.toolStart({
        toolName,
        toolId: options.toolUseID,
        input: (input as Record<string, unknown>) ?? {},
      });

      // Detect file-modifying tools and emit file_changed event
      emitFileChangeIfApplicable(toolName, input, events);

      // Capture ExitPlanMode options when the tool is called
      if (toolName === 'ExitPlanMode') {
        const planInput = input as ExitPlanModeInput | undefined;
        exitPlanModeOptions = planInput;
        exitPlanModeDetected = true;
        exitPlanModeTimestamp = Date.now();
        exitPlanModePlan = typeof planInput?.plan === 'string' ? planInput.plan : undefined;

        console.error(
          `[agent-runner] ExitPlanMode captured via canUseTool — plan from input: ${exitPlanModePlan ? `${exitPlanModePlan.length} chars` : 'none'}`
        );
      }

      // Allow all tools to proceed (we're in plan mode)
      return { behavior: 'allow' as const, toolUseID: options.toolUseID };
    };

    // Note: executableArgs with --add-dir causes EPIPE errors in SDK 0.2.x
    // The SDK/CLI handles directory access via cwd and environment
    session = unstable_v2_createSession({
      model: config.model,
      env: { ...process.env }, // TODO: Pending GA — CLAUDE_CODE_AGENT_SWARMS env removed
      permissionMode: 'plan', // Planning mode - read-only exploration
      canUseTool, // Use official SDK callback for tool interception
    });
    console.error('[agent-runner] SDK session created successfully');
  } catch (sessionError) {
    const errMsg = sessionError instanceof Error ? sessionError.message : String(sessionError);
    console.error('[agent-runner] Failed to create SDK session:', errMsg);
    events.error({
      error: `SDK session creation failed: ${errMsg}`,
      code: 'SDK_SESSION_FAILED',
      turnCount: 0,
    });
    await flushAndExit(1);
  }

  if (!session) {
    throw new Error('Session not initialized');
  }

  let turn = 0;
  let accumulatedText = '';
  let sdkSessionId: string | undefined;

  try {
    // Send the initial prompt
    await session.send(config.prompt as string);

    console.error('[agent-runner] Processing SDK stream (planning)...');
    let messageCount = 0;

    for await (const msg of session.stream()) {
      messageCount++;
      console.error(`[agent-runner] Message ${messageCount}: type=${msg.type}`);

      // Check for cancellation
      if (await shouldStop()) {
        console.error('[agent-runner] Stop file detected, cancelling...');
        events.cancelled(turn);
        session.close();
        return;
      }

      // Check for ExitPlanMode timeout — if stream hangs after ExitPlanMode, force emit planReady
      if (exitPlanModeDetected && exitPlanModeTimestamp) {
        const elapsed = Date.now() - exitPlanModeTimestamp;
        if (elapsed > EXIT_PLAN_MODE_TIMEOUT_MS) {
          console.error(`[agent-runner] ExitPlanMode timeout (${elapsed}ms) — forcing plan_ready`);
          emitAllToolResults();
          session.close();
          const planContent = exitPlanModePlan || accumulatedText;
          events.planReady({
            plan: planContent,
            turnCount: turn,
            sdkSessionId: sdkSessionId ?? '',
            allowedPrompts: exitPlanModeOptions?.allowedPrompts,
          });
          return;
        }
      }

      // Capture SDK session ID from init message
      if (msg.type === 'system') {
        const sysMsg = msg as { subtype?: string; session_id?: string };
        if (sysMsg.subtype === 'init' && sysMsg.session_id) {
          sdkSessionId = sysMsg.session_id;
          console.error(`[agent-runner] SDK session ID: ${sdkSessionId}`);
        }
      }

      // Handle streaming events (token deltas)
      if (msg.type === 'stream_event') {
        const event = msg.event as {
          type: string;
          delta?: { type: string; text?: string };
          message?: { model?: string };
        };

        // Track turns on message_start
        if (event.type === 'message_start') {
          turn++;
          console.error(`[agent-runner] Turn ${turn}/${config.maxTurns}`);
          events.turn({
            turn,
            maxTurns: config.maxTurns,
            remaining: config.maxTurns - turn,
          });

          // Check turn limit
          if (turn >= config.maxTurns) {
            console.error('[agent-runner] Turn limit reached during planning');
            events.complete({
              status: 'turn_limit',
              turnCount: turn,
              result: `Turn limit reached (${config.maxTurns}) during planning.`,
            });
            session.close();
            return;
          }
        }

        // Capture text deltas for streaming output
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          event.delta.text
        ) {
          const delta = event.delta.text;
          accumulatedText += delta;
          events.token({
            delta,
            accumulated: accumulatedText,
          });
        }
      }

      // Handle tool progress events (for UI feedback on long-running tools)
      if (msg.type === 'tool_progress') {
        const toolMsg = msg as {
          tool_use_id: string;
          tool_name: string;
          elapsed_time_seconds: number;
        };
        console.error(
          `[agent-runner] Tool progress: ${toolMsg.tool_name} (${toolMsg.elapsed_time_seconds}s)`
        );
        events.toolStart({
          toolName: toolMsg.tool_name,
          toolId: toolMsg.tool_use_id,
          input: {},
        });
      }

      // Handle tool_use_summary events (actual tool completion with results from SDK)
      if (msg.type === 'tool_use_summary') {
        const toolSummary = msg as {
          tool_use_id?: string;
          tool_name?: string;
          tool_input?: Record<string, unknown>;
          tool_result?: string;
          is_error?: boolean;
        };

        console.error(
          `[agent-runner] Tool summary: ${toolSummary.tool_name} (id: ${toolSummary.tool_use_id ?? 'none'}, error: ${toolSummary.is_error})`
        );

        if (toolSummary.tool_use_id) {
          // Remove from activeTools to avoid duplicate emission
          const startInfo = activeTools.get(toolSummary.tool_use_id);
          activeTools.delete(toolSummary.tool_use_id);

          // Emit tool result with actual content from SDK
          const startTime = startInfo?.startTime ?? Date.now();
          events.toolResult({
            toolName: toolSummary.tool_name ?? 'unknown',
            toolId: toolSummary.tool_use_id,
            result: toolSummary.tool_result ?? '',
            isError: toolSummary.is_error ?? false,
            durationMs: Date.now() - startTime,
          });
        }

        // ExitPlanMode tool completed — do NOT close session here.
        // The stream will naturally flow to a 'result' message, which is the safe exit point.
        // Closing mid-iteration causes "Operation aborted" unhandled rejections.
        if (toolSummary.tool_name === 'ExitPlanMode' && !toolSummary.is_error) {
          console.error('[agent-runner] ExitPlanMode tool completed — waiting for result message');
        }
      }

      // Handle assistant messages
      if (msg.type === 'assistant') {
        // Assistant message means all previous tools have completed
        emitAllToolResults();

        // ExitPlanMode was detected — do NOT close session here.
        // Continue consuming messages until the stream naturally yields 'result'.
        if (exitPlanModeDetected) {
          console.error('[agent-runner] ExitPlanMode detected — continuing to result message');
        }

        const text = getAssistantText(msg);
        if (text) {
          accumulatedText = text;
          events.message({
            role: 'assistant',
            content: text,
          });
        }
      }

      // Handle result (planning session finished)
      // This is the ONLY safe place to close the session — the stream iterator is done.
      if (msg.type === 'result') {
        // Emit results for any remaining active tools
        emitAllToolResults();
        session.close(); // Clean close — stream is done, iterator complete

        // If ExitPlanMode was called, emit plan_ready
        if (exitPlanModeDetected || exitPlanModeOptions !== undefined || accumulatedText) {
          // Prefer plan from canUseTool input (ExitPlanModeInput.plan), fall back to accumulated text
          const planContent = exitPlanModePlan || accumulatedText;
          console.error(
            `[agent-runner] Emitting plan_ready (source: ${exitPlanModePlan ? 'ExitPlanModeInput.plan' : 'accumulated text'}, length: ${planContent.length})`
          );
          events.planReady({
            plan: planContent,
            turnCount: turn,
            sdkSessionId: sdkSessionId ?? '',
            allowedPrompts: exitPlanModeOptions?.allowedPrompts,
          });
        } else {
          // No plan was created - treat as completion
          events.complete({
            status: 'completed',
            turnCount: turn,
            result: accumulatedText || 'Planning completed without explicit plan',
          });
        }
        return;
      }
    }

    console.error(
      `[agent-runner] Planning stream ended. Messages: ${messageCount}, turns: ${turn}`
    );

    // Emit results for any remaining active tools
    emitAllToolResults();

    // Stream ended - emit plan_ready if we have content
    session.close();
    if (accumulatedText) {
      events.planReady({
        plan: accumulatedText,
        turnCount: turn,
        sdkSessionId: sdkSessionId ?? '',
        allowedPrompts: exitPlanModeOptions?.allowedPrompts,
      });
    } else {
      events.complete({
        status: 'completed',
        turnCount: turn,
        result: 'Planning completed',
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = (error as { code?: string }).code;
    console.error('[agent-runner] Planning error:', message);

    events.error({
      error: message,
      code: errorCode || 'PLANNING_ERROR',
      turnCount: turn,
    });

    session.close();
    await flushAndExit(1);
  }
}

/**
 * Run the agent in execution mode.
 * The agent executes the approved plan with full permissions.
 * Can optionally resume from a previous SDK session.
 */
async function runExecutionPhase(): Promise<void> {
  const events = createEventEmitter(config.taskId as string, config.sessionId as string);

  // Emit started event
  events.started({
    model: config.model,
    maxTurns: config.maxTurns,
  });

  console.error('[agent-runner] Starting EXECUTION phase...');
  if (config.sdkSessionId) {
    console.error(`[agent-runner] Resuming SDK session: ${config.sdkSessionId}`);
  }

  // Track active tool executions for emitting toolResult events
  const activeTools = new Map<string, { toolName: string; startTime: number }>();

  // Helper to emit tool result for a completed tool
  const emitToolResult = (toolId: string, isError = false, result = '') => {
    const tool = activeTools.get(toolId);
    if (tool) {
      const durationMs = Date.now() - tool.startTime;
      events.toolResult({
        toolName: tool.toolName,
        toolId,
        result,
        isError,
        durationMs,
      });
      activeTools.delete(toolId);
    }
  };

  // Helper to emit results for all active tools (called on completion/error)
  const emitAllToolResults = () => {
    for (const [toolId] of activeTools) {
      emitToolResult(toolId, false, 'completed');
    }
  };

  // canUseTool callback to track tool executions (even in bypass mode)
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    // Track tool start
    activeTools.set(options.toolUseID, { toolName, startTime: Date.now() });

    // Emit tool start event
    events.toolStart({
      toolName,
      toolId: options.toolUseID,
      input: (input as Record<string, unknown>) ?? {},
    });

    // Detect file-modifying tools and emit file_changed event
    emitFileChangeIfApplicable(toolName, input, events);

    // Allow all tools in execution mode
    return { behavior: 'allow' as const, toolUseID: options.toolUseID };
  };

  // Create or resume Claude Agent SDK session
  let session: SDKSession | undefined;
  let sessionResumed = false;
  try {
    console.error('[agent-runner] Creating SDK session with bypass permissions...');

    // Note: executableArgs with --add-dir causes EPIPE errors in SDK 0.2.x
    // The SDK/CLI handles directory access via cwd and environment
    if (config.sdkSessionId) {
      // Try to resume existing session — may fail if session state is corrupted or stale
      // (primary container-change detection is in approvePlan; this is defense-in-depth)
      try {
        session = unstable_v2_resumeSession(config.sdkSessionId, {
          model: config.model,
          env: { ...process.env }, // TODO: Pending GA — CLAUDE_CODE_AGENT_SWARMS env removed
          permissionMode: 'bypassPermissions',
          canUseTool, // Track tools even in bypass mode
        });
        sessionResumed = true;
        console.error('[agent-runner] SDK session resumed successfully');
      } catch (resumeError) {
        const resumeMsg = resumeError instanceof Error ? resumeError.message : String(resumeError);
        console.warn(
          `[agent-runner] SDK session resume failed (${config.sdkSessionId}), falling back to fresh session: ${resumeMsg}`
        );
        // Notify the user via structured event so the host process can relay to UI
        events.message({
          role: 'assistant',
          content: `⚠️ Previous session could not be resumed (${resumeMsg}). Starting fresh execution with full plan context.`,
        });
        // Fall through to create a fresh session
      }
    }

    if (!session) {
      // Create new session (either no sdkSessionId provided, or resume failed)
      session = unstable_v2_createSession({
        model: config.model,
        env: { ...process.env }, // TODO: Pending GA — CLAUDE_CODE_AGENT_SWARMS env removed
        permissionMode: 'bypassPermissions',
        canUseTool, // Track tools even in bypass mode
      });
    }
    console.error('[agent-runner] SDK session ready');
  } catch (sessionError) {
    const errMsg = sessionError instanceof Error ? sessionError.message : String(sessionError);
    console.error('[agent-runner] Failed to create SDK session:', errMsg);
    events.error({
      error: `SDK session creation failed: ${errMsg}`,
      code: 'SDK_SESSION_FAILED',
      turnCount: 0,
    });
    await flushAndExit(1);
  }

  if (!session) {
    throw new Error('Session not initialized');
  }

  let turn = 0;
  let accumulatedText = '';

  try {
    // Send the prompt — if we successfully resumed the session, the agent already
    // has the plan in its conversation history. Otherwise send the full plan text.
    const executionPrompt = sessionResumed
      ? 'The plan has been approved. Please proceed with the implementation.'
      : (config.prompt as string);

    await session.send(executionPrompt);

    console.error('[agent-runner] Processing SDK stream (execution)...');
    let messageCount = 0;

    for await (const msg of session.stream()) {
      messageCount++;
      console.error(`[agent-runner] Message ${messageCount}: type=${msg.type}`);

      // Check for cancellation
      if (await shouldStop()) {
        console.error('[agent-runner] Stop file detected, cancelling...');
        events.cancelled(turn);
        session.close();
        return;
      }

      // Handle streaming events (token deltas)
      if (msg.type === 'stream_event') {
        const event = msg.event as {
          type: string;
          delta?: { type: string; text?: string };
          message?: { model?: string };
        };

        // Track turns on message_start
        if (event.type === 'message_start') {
          turn++;
          console.error(`[agent-runner] Turn ${turn}/${config.maxTurns}`);
          events.turn({
            turn,
            maxTurns: config.maxTurns,
            remaining: config.maxTurns - turn,
          });

          // Check turn limit
          if (turn >= config.maxTurns) {
            console.error('[agent-runner] Turn limit reached');
            events.complete({
              status: 'turn_limit',
              turnCount: turn,
              result: `Turn limit reached (${config.maxTurns}). Task may need manual completion.`,
            });
            session.close();
            return;
          }
        }

        // Capture text deltas for streaming output
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          event.delta.text
        ) {
          const delta = event.delta.text;
          accumulatedText += delta;
          events.token({
            delta,
            accumulated: accumulatedText,
          });
        }
      }

      // Handle tool progress events (fallback for tools not caught by canUseTool)
      if (msg.type === 'tool_progress') {
        const toolMsg = msg as {
          tool_use_id: string;
          tool_name: string;
          elapsed_time_seconds: number;
        };
        console.error(
          `[agent-runner] Tool progress: ${toolMsg.tool_name} (${toolMsg.elapsed_time_seconds}s)`
        );
        // Only emit toolStart if not already tracked via canUseTool
        if (!activeTools.has(toolMsg.tool_use_id)) {
          activeTools.set(toolMsg.tool_use_id, {
            toolName: toolMsg.tool_name,
            startTime: Date.now(),
          });
          events.toolStart({
            toolName: toolMsg.tool_name,
            toolId: toolMsg.tool_use_id,
            input: {},
          });
        }
      }

      // Handle tool_use_summary events (actual tool completion with results from SDK)
      if (msg.type === 'tool_use_summary') {
        const toolSummary = msg as {
          tool_use_id?: string;
          tool_name?: string;
          tool_input?: Record<string, unknown>;
          tool_result?: string;
          is_error?: boolean;
        };

        console.error(
          `[agent-runner] Tool summary: ${toolSummary.tool_name} (error: ${toolSummary.is_error})`
        );

        if (toolSummary.tool_use_id) {
          // Remove from activeTools to avoid duplicate emission
          const startInfo = activeTools.get(toolSummary.tool_use_id);
          activeTools.delete(toolSummary.tool_use_id);

          // Emit tool result with actual content from SDK
          const startTime = startInfo?.startTime ?? Date.now();
          events.toolResult({
            toolName: toolSummary.tool_name ?? 'unknown',
            toolId: toolSummary.tool_use_id,
            result: toolSummary.tool_result ?? '',
            isError: toolSummary.is_error ?? false,
            durationMs: Date.now() - startTime,
          });
        }
      }

      // Handle assistant messages (complete turns)
      if (msg.type === 'assistant') {
        // Assistant message means all previous tools have completed
        emitAllToolResults();

        const text = getAssistantText(msg);
        if (text) {
          console.error(`[agent-runner] Assistant message: ${text.slice(0, 100)}...`);
          events.message({
            role: 'assistant',
            content: text,
          });
        }
      }

      // Handle result (completion)
      if (msg.type === 'result') {
        // Emit results for any remaining active tools
        emitAllToolResults();
        const result = msg as { text?: string; subtype?: string; is_error?: boolean };
        console.error(
          `[agent-runner] Result: subtype=${result.subtype}, is_error=${result.is_error}`
        );

        if (result.is_error) {
          events.complete({
            status: 'turn_limit',
            turnCount: turn,
            result: result.text ?? 'Task ended with error',
          });
        } else {
          events.complete({
            status: 'completed',
            turnCount: turn,
            result: result.text ?? (accumulatedText || 'Task completed'),
          });
        }
        session.close();
        return;
      }
    }

    console.error(`[agent-runner] Stream ended. Total messages: ${messageCount}, turns: ${turn}`);

    // Emit results for any remaining active tools
    emitAllToolResults();

    // Stream ended without explicit result
    events.complete({
      status: 'completed',
      turnCount: turn,
      result: accumulatedText || 'Task completed',
    });
  } catch (error) {
    // Emit results for any remaining active tools before reporting error
    emitAllToolResults();

    const message = error instanceof Error ? error.message : String(error);
    const errorCode = (error as { code?: string }).code;
    console.error('[agent-runner] Stream error:', message);
    if (error instanceof Error && error.stack) {
      console.error('[agent-runner] Stack:', error.stack);
    }

    events.error({
      error: message,
      code: errorCode || 'STREAM_ERROR',
      turnCount: turn,
    });

    session.close();
    await flushAndExit(1);
  } finally {
    session.close();
  }
}

/**
 * Main agent entry point - routes to planning or execution phase.
 */
async function runAgent(): Promise<void> {
  validateConfig();

  // Write OAuth credentials to ~/.claude/.credentials.json
  // This must be done before creating the SDK session
  await writeCredentialsFile();

  console.error(`[agent-runner] Phase: ${config.phase}`);

  if (config.phase === 'plan') {
    await runPlanningPhase();
  } else {
    await runExecutionPhase();
  }
}

/**
 * Extract text content from an assistant message.
 */
function getAssistantText(msg: unknown): string | null {
  const message = (msg as { message?: unknown }).message as {
    content?: Array<{ type: string; text?: string }>;
  };

  if (!message?.content) return null;

  const textBlocks = message.content.filter(
    (block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string'
  );

  return textBlocks.map((b) => b.text).join('') || null;
}

// Run the agent
runAgent()
  .then(async () => {
    await flushAndExit(0);
  })
  .catch(async (error) => {
    // Fatal error before agent could start - write JSON error to stderr
    // The container bridge reads stderr for JSON error events
    console.error(
      JSON.stringify({
        type: 'agent:error',
        timestamp: Date.now(),
        taskId: config.taskId ?? 'unknown',
        sessionId: config.sessionId ?? 'unknown',
        data: {
          error: error instanceof Error ? error.message : String(error),
          turnCount: 0,
        },
      })
    );
    await flushAndExit(1);
  });
