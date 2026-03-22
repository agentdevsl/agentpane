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
import { createEventEmitter } from './event-emitter.js';
// SC-023: Shared session utilities. index.ts still uses its own writeCredentialsFile
// and shouldStop variants (with additional debug logging), but types and file-change
// detection are imported from the shared module to reduce duplication.
import type { ExitPlanModeInput, ExitPlanModeOptions } from './shared-session.js';
import {
  extractFileChange as sharedExtractFileChange,
  getAssistantText as sharedGetAssistantText,
} from './shared-session.js';

const VALID_TOPOLOGY_STATUSES = new Set(['completed', 'failed', 'stopped']);

/** Normalize SDK status to a value the client Zod schema accepts */
function normalizeTopologyStatus(raw: unknown): 'completed' | 'failed' | 'stopped' {
  if (typeof raw === 'string' && VALID_TOPOLOGY_STATUSES.has(raw)) {
    return raw as 'completed' | 'failed' | 'stopped';
  }
  return 'completed';
}

/**
 * Map SDK agent_type or task description to a topology role.
 * Canonical source: src/lib/topology/map-agent-role.ts — keep in sync.
 * Duplicated here due to agent-runner build boundary (separate package).
 */
function mapAgentRole(agentType?: string, description?: string): string {
  const text = `${agentType ?? ''} ${description ?? ''}`.toLowerCase();
  if (text.includes('deploy')) return 'deployer';
  if (text.includes('plan')) return 'planner';
  if (text.includes('review') || text.includes('code-review')) return 'reviewer';
  if (text.includes('test') || text.includes('pr-test')) return 'tester';
  if (text.includes('scan') || text.includes('security') || text.includes('silent-failure'))
    return 'scanner';
  if (
    text.includes('orchestrat') ||
    text.includes('lead') ||
    text.includes('team') ||
    text.includes('coordinator')
  )
    return 'orchestrator';
  return 'coder';
}

/**
 * Derive display name from SDK task description or agent_type.
 * Canonical source: src/lib/topology/map-agent-role.ts — keep in sync.
 */
function deriveAgentName(agentType?: string, description?: string): string {
  if (description) {
    return description.length > 40 ? `${description.slice(0, 37)}...` : description;
  }
  if (agentType) {
    return agentType
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return 'Agent';
}

/** Tracks subagent topology state. Maps SDK task_id → generated node id. */
interface TopologyTracker {
  taskToNodeId: Map<string, string>;
  rootEmitted: boolean;
}

/** Handle SDK system messages for subagent lifecycle */
function handleTopologySystemMsg(
  msg: Record<string, unknown>,
  tracker: TopologyTracker,
  events: ReturnType<typeof createEventEmitter>,
  rootAgentId: string
): void {
  const subtype = msg.subtype as string | undefined;
  if (!subtype) return;

  if (subtype === 'task_started') {
    const sdkTaskId = msg.task_id as string;
    const description = msg.description as string | undefined;
    const taskType = msg.task_type as string | undefined;
    if (!sdkTaskId) return;

    // Emit root orchestrator on first subagent
    if (!tracker.rootEmitted) {
      tracker.rootEmitted = true;
      events.topologySpawned({
        agentId: rootAgentId,
        name: 'Orchestrator',
        role: 'orchestrator',
        parentId: null,
      });
    }

    const nodeId = `sub-${sdkTaskId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    tracker.taskToNodeId.set(sdkTaskId, nodeId);

    events.topologySpawned({
      agentId: nodeId,
      name: deriveAgentName(taskType, description),
      role: mapAgentRole(taskType, description),
      parentId: rootAgentId,
      sdkTaskId,
    });
  } else if (subtype === 'task_progress') {
    const sdkTaskId = msg.task_id as string;
    const nodeId = tracker.taskToNodeId.get(sdkTaskId);
    if (!nodeId) return;

    const usage = msg.usage as
      | { total_tokens?: number; tool_uses?: number; duration_ms?: number }
      | undefined;

    events.topologyProgress({
      agentId: nodeId,
      sdkTaskId,
      tokens: usage?.total_tokens ?? 0,
      toolUses: usage?.tool_uses ?? 0,
      durationMs: usage?.duration_ms ?? 0,
      summary: typeof msg.summary === 'string' ? msg.summary : undefined,
      lastToolName: typeof msg.last_tool_name === 'string' ? msg.last_tool_name : undefined,
    });
  } else if (subtype === 'task_notification') {
    const sdkTaskId = msg.task_id as string;
    const nodeId = tracker.taskToNodeId.get(sdkTaskId);
    if (!nodeId) return;

    const usage = msg.usage as
      | { total_tokens?: number; tool_uses?: number; duration_ms?: number }
      | undefined;

    events.topologyCompleted({
      agentId: nodeId,
      sdkTaskId,
      status: normalizeTopologyStatus(msg.status),
      summary: typeof msg.summary === 'string' ? msg.summary : undefined,
      tokens: usage?.total_tokens,
      toolUses: usage?.tool_uses,
      durationMs: usage?.duration_ms,
    });
    tracker.taskToNodeId.delete(sdkTaskId);
  }
}

// SC-023: FILE_MODIFY_TOOLS and extractFileChange are now in shared-session.ts

/** Detect file-modifying tools and emit file_changed event */
function emitFileChangeIfApplicable(
  toolName: string,
  input: unknown,
  events: ReturnType<typeof createEventEmitter>
): void {
  const fileChange = sharedExtractFileChange(toolName, (input as Record<string, unknown>) ?? {});
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

// SC-023: ExitPlanModeOptions and ExitPlanModeInput are now imported from shared-session.ts

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
      env: { ...process.env }, // Teams GA: env passed through for agent swarm support
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
        const sysMsg = msg as { subtype?: string };
        if (sysMsg.subtype === 'init') {
          sdkSessionId = session.sessionId;
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

      // Handle rate_limit_event (SDK v0.2.76+)
      if (msg.type === 'rate_limit_event') {
        const rateLimitMsg = msg as {
          rate_limit_info: { status: string; resetsAt?: number };
        };
        console.error(`[agent-runner] Rate limit: ${rateLimitMsg.rate_limit_info.status}`);
      }

      // Handle tool_use_summary events (actual tool completion with results from SDK)
      if (msg.type === 'tool_use_summary') {
        const toolSummary = msg as {
          summary: string;
          preceding_tool_use_ids: string[];
        };

        console.error(
          `[agent-runner] Tool summary: ids=${toolSummary.preceding_tool_use_ids.join(',')}`
        );

        // Emit tool results for each preceding tool using tracked activeTools
        for (const toolId of toolSummary.preceding_tool_use_ids) {
          const startInfo = activeTools.get(toolId);
          if (startInfo) {
            activeTools.delete(toolId);
            const durationMs = Date.now() - startInfo.startTime;
            events.toolResult({
              toolName: startInfo.toolName,
              toolId,
              result: toolSummary.summary ?? '',
              isError: false,
              durationMs,
            });

            // ExitPlanMode tool completed — do NOT close session here.
            // The stream will naturally flow to a 'result' message, which is the safe exit point.
            // Closing mid-iteration causes "Operation aborted" unhandled rejections.
            if (startInfo.toolName === 'ExitPlanMode') {
              console.error(
                '[agent-runner] ExitPlanMode tool completed — waiting for result message'
              );
            }
          }
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

  // Topology tracker for subagent lifecycle events
  const topology: TopologyTracker = { taskToNodeId: new Map(), rootEmitted: true };
  const rootAgentId = `agent-${config.taskId}`;

  // Always emit root agent node in topology
  events.topologySpawned({
    agentId: rootAgentId,
    name: 'Agent',
    role: 'orchestrator',
    parentId: null,
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
          env: { ...process.env }, // Teams GA: env passed through for agent swarm support
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
        env: { ...process.env }, // Teams GA: env passed through for agent swarm support
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

      // Handle rate_limit_event (SDK v0.2.76+)
      if (msg.type === 'rate_limit_event') {
        const rateLimitMsg = msg as {
          rate_limit_info: { status: string; resetsAt?: number };
        };
        console.error(`[agent-runner] Rate limit: ${rateLimitMsg.rate_limit_info.status}`);
      }

      // Handle system messages for subagent topology (task_started, task_progress, task_notification)
      if (msg.type === 'system') {
        const sysMsg = msg as Record<string, unknown>;
        const sysSubtype = sysMsg.subtype as string | undefined;
        if (
          sysSubtype === 'task_started' ||
          sysSubtype === 'task_progress' ||
          sysSubtype === 'task_notification'
        ) {
          handleTopologySystemMsg(sysMsg, topology, events, rootAgentId);
        }
      }

      // Handle tool_use_summary events (actual tool completion with results from SDK)
      if (msg.type === 'tool_use_summary') {
        const toolSummary = msg as {
          summary: string;
          preceding_tool_use_ids: string[];
        };

        console.error(
          `[agent-runner] Tool summary: ids=${toolSummary.preceding_tool_use_ids.join(',')}`
        );

        for (const toolId of toolSummary.preceding_tool_use_ids) {
          const startInfo = activeTools.get(toolId);
          if (startInfo) {
            activeTools.delete(toolId);
            const durationMs = Date.now() - startInfo.startTime;
            events.toolResult({
              toolName: startInfo.toolName,
              toolId,
              result: toolSummary.summary ?? '',
              isError: false,
              durationMs,
            });
          }
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

// SC-023: getAssistantText is now imported from shared-session.ts as sharedGetAssistantText
const getAssistantText = sharedGetAssistantText;

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
