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
 * - AGENT_HAS_SKILL: Optional. Set to 'true' when a skill is assigned — uses acceptEdits during planning.
 * - AGENT_SKILL_ID: Optional. The skill ID assigned to the task.
 * - AGENT_SKILL_NAME: Optional. The display name of the assigned skill.
 * - AGENT_ALLOWED_TOOLS: Optional. JSON array of tool names to allow through the permission layer.
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
import { createAgentRunnerLogger } from './logger.js';
// SC-023: Shared session utilities. index.ts still uses its own writeCredentialsFile
// and shouldStop variants (with additional debug logging), but types and file-change
// detection are imported from the shared module to reduce duplication.
import type { ExitPlanModeInput, ExitPlanModeOptions } from './shared-session.js';
import {
  extractFileChange as sharedExtractFileChange,
  getAssistantText as sharedGetAssistantText,
} from './shared-session.js';
import { buildEnrichedFields, createTrackingState, optionalSkillCalls } from './skill-tracking.js';

// F10-05: structured runner logger. Emits JSON on STDERR with correlation id
// from the CORRELATION_ID env var (set by the host in container-exec.service).
// The host bridge parses these lines and replays them via its own logger.
const log = createAgentRunnerLogger();

const VALID_TOPOLOGY_STATUSES = new Set(['completed', 'failed', 'stopped']);

/**
 * Load agent definitions from .claude/agents/*.md files.
 * Parses YAML frontmatter to create SDK AgentDefinition records.
 * Returns a Record<string, AgentDefinition> keyed by agent name.
 */
async function loadAgentDefinitions(
  cwd: string
): Promise<
  Record<string, { description: string; tools?: string[]; prompt: string; model?: string }>
> {
  const agentsDir = join(cwd, '.claude', 'agents');
  const agents: Record<
    string,
    { description: string; tools?: string[]; prompt: string; model?: string }
  > = {};

  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(agentsDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const content = await readFile(join(agentsDir, file), 'utf-8');
        // Parse YAML frontmatter between --- delimiters
        const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
        if (!match) continue;

        const frontmatter = match[1];
        const body = match[2]?.trim() ?? '';

        // Simple YAML parsing for key fields. Strip surrounding quotes so
        // `name: "my-agent"` is read as `my-agent`, matching how the SDK supplies
        // subagent_type values.
        const unquote = (v: string | undefined): string | undefined =>
          v?.replace(/^['"]|['"]$/g, '').trim();
        const name = unquote(frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim());
        const description = unquote(frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim());
        const model = unquote(frontmatter.match(/^model:\s*(.+)$/m)?.[1]?.trim());

        // Parse tools array
        const toolsMatch = frontmatter.match(/^tools:\n((?:\s+-\s+.+\n?)*)/m);
        const tools = toolsMatch
          ? toolsMatch[1]
              .split('\n')
              .map((l) => unquote(l.replace(/^\s+-\s+/, '').trim()))
              .filter((v): v is string => Boolean(v))
          : undefined;

        if (!name || !description) continue;

        agents[name] = {
          description,
          tools,
          prompt: body || description,
          ...(model && model !== 'inherit' ? { model } : {}),
        };
      } catch {
        // Skip individual file parse errors
      }
    }
    log.error(
      `[agent-runner] Loaded ${Object.keys(agents).length} agent definitions from ${agentsDir}`
    );
  } catch {
    log.error(`[agent-runner] No .claude/agents/ directory found at ${agentsDir}`);
  }

  return agents;
}

/** Normalize SDK status to a value the client Zod schema accepts */
function normalizeTopologyStatus(raw: unknown): 'completed' | 'failed' | 'stopped' {
  if (typeof raw === 'string' && VALID_TOPOLOGY_STATUSES.has(raw)) {
    return raw as 'completed' | 'failed' | 'stopped';
  }
  log.error(`[agent-runner] Unknown topology status: ${String(raw)}, defaulting to 'failed'`);
  return 'failed';
}

/**
 * Map SDK task_type to a visual role category (icon/color only).
 * Canonical source: src/lib/topology/map-agent-role.ts — keep in sync.
 * Duplicated here due to agent-runner build boundary (separate package).
 *
 * Uses suffix after last separator to avoid false matches in toolkit prefixes
 * (e.g., "pr-review-toolkit:pr-test-analyzer" should be tester, not reviewer).
 */
function mapAgentRole(agentType?: string): string {
  if (!agentType) return 'agent';
  const t = agentType.toLowerCase();
  // Use suffix after last separator to avoid false matches in toolkit prefixes
  const sep = t.lastIndexOf(':');
  const m = sep >= 0 ? t.slice(sep + 1) : t.includes('.') ? t.slice(t.lastIndexOf('.') + 1) : t;
  if (m.includes('plan')) return 'planner';
  if (m.includes('test') || m.includes('verif')) return 'tester';
  if (m.includes('scan') || m.includes('security') || m.includes('hunter')) return 'scanner';
  if (m.includes('review') || m.includes('analyz')) return 'reviewer';
  if (m.includes('deploy')) return 'deployer';
  return 'agent';
}

/**
 * Use the SDK description as the node name. Falls back to agentType, then "Agent".
 * Canonical source: src/lib/topology/map-agent-role.ts — keep in sync.
 */
function deriveAgentName(agentType?: string, description?: string): string {
  if (description) {
    return description.length > 50 ? `${description.slice(0, 47)}...` : description;
  }
  return agentType || 'Agent';
}

/** Tracks subagent topology state. Maps SDK task_id → generated node id. */
interface TopologyTracker {
  taskToNodeId: Map<string, string>;
  rootEmitted: boolean;
  /** Queue of subagent_type values from Agent tool calls, consumed by task_started events */
  pendingSubagentTypes: string[];
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
    const rawTaskType = msg.task_type as string | undefined;
    if (!sdkTaskId) return;

    // The SDK reports task_type: "local_agent" for Agent tool calls.
    // Substitute with the real subagent_type captured from the canUseTool callback.
    const taskType =
      rawTaskType === 'local_agent' && tracker.pendingSubagentTypes.length > 0
        ? tracker.pendingSubagentTypes.shift()
        : rawTaskType;

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
      role: mapAgentRole(taskType),
      agentType: taskType ?? null,
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

// Phase type
type AgentPhase = 'plan' | 'execute';

/**
 * Parse CLAUDE_OAUTH_EXPIRES_AT env var.
 *
 * theme-03 F11: Accept a real token expiry from the host. When absent, fall
 * back to a far-future sentinel so the SDK does not treat the token as expired
 * but we avoid pretending to know a specific lifetime. The previous "+24h"
 * default was a fiction — a token revoked externally still appeared valid to
 * the SDK and surfaced as opaque 401s mid-stream.
 */
function parseOAuthExpiresAt(raw: string | undefined): number {
  if (!raw) {
    // Far-future sentinel (~year 5138). Signals "unknown expiry" to the SDK
    // without masking real expirations when the host does supply them.
    return 100_000_000_000_000;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.error(
      `[agent-runner] CLAUDE_OAUTH_EXPIRES_AT is not a positive number ('${raw}'), using far-future default`
    );
    return 100_000_000_000_000;
  }
  return parsed;
}

// Configuration from environment (declared early for error handlers)
const config = {
  oauthToken: process.env.CLAUDE_OAUTH_TOKEN,
  // theme-03 F11: optional real OAuth metadata from the host. When absent the
  // credentials file still gets written, but with a sentinel expiry rather
  // than a fake Date.now()+24h value.
  oauthExpiresAt: parseOAuthExpiresAt(process.env.CLAUDE_OAUTH_EXPIRES_AT),
  oauthRefreshToken: process.env.CLAUDE_OAUTH_REFRESH_TOKEN ?? null,
  taskId: process.env.AGENT_TASK_ID,
  sessionId: process.env.AGENT_SESSION_ID,
  prompt: process.env.AGENT_PROMPT,
  phase: (process.env.AGENT_PHASE ?? 'execute') as AgentPhase,
  sdkSessionId: process.env.AGENT_SDK_SESSION_ID, // For resuming after plan approval
  maxTurns: parseInt(process.env.AGENT_MAX_TURNS ?? '50', 10),
  model: process.env.AGENT_MODEL ?? 'claude-opus-4-5-20251101',
  cwd: process.env.AGENT_CWD ?? '/workspace',
  stopFile: process.env.AGENT_STOP_FILE,
  skillId: process.env.AGENT_SKILL_ID,
  skillName: process.env.AGENT_SKILL_NAME,
};

// Global error handlers - catch EPIPE and other unhandled errors
// These must be registered early, before any async operations
process.on('uncaughtException', (error: Error & { code?: string }) => {
  log.error('[agent-runner] Uncaught exception:', { error: error.message });
  log.error('[agent-runner] Stack:', { stack: error.stack });

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
      log.error('[agent-runner] Failed to emit error event');
    }
  }

  // Use sync exit in global handlers to avoid re-entering async code
  // The event emitter uses writeSync for critical events, so it should already be flushed
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log.error('[agent-runner] Unhandled rejection:', { message: message });

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
      log.error('[agent-runner] Failed to emit error event');
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
 * Write OAuth credentials to $HOME/.claude/.credentials.json
 * The Claude Agent SDK reads this file for authentication.
 * OAuth tokens passed via ANTHROPIC_API_KEY env var are blocked by the API.
 *
 * theme-03 F11:
 * - `homedir()` (which reads `process.env.HOME`) is used so that the host
 *   can place each concurrent agent-runner invocation under a distinct HOME
 *   (e.g. /tmp/agents/<taskId>) and avoid interleaved writes to a shared
 *   `/home/node/.claude/.credentials.json`.
 * - `expiresAt` is read from the host via `CLAUDE_OAUTH_EXPIRES_AT` when
 *   available; otherwise a far-future sentinel is used. The previous
 *   `Date.now() + 24h` fiction caused revoked tokens to appear valid to the
 *   SDK for a day.
 * - `refreshToken` is threaded through from `CLAUDE_OAUTH_REFRESH_TOKEN`
 *   when the host has one; otherwise null (SDK rejects empty string).
 */
async function writeCredentialsFile(): Promise<void> {
  const home = homedir();
  const claudeDir = join(home, '.claude');
  const credentialsFile = join(claudeDir, '.credentials.json');

  // Debug: Log paths and token status (never log token contents for security)
  log.error(`[agent-runner] Home directory: ${home}`);
  log.error(`[agent-runner] Credentials path: ${credentialsFile}`);
  log.error(`[agent-runner] Token received: ${config.oauthToken ? 'YES' : 'NONE'}`);
  log.error(
    `[agent-runner] Token expiresAt: ${process.env.CLAUDE_OAUTH_EXPIRES_AT ? 'from host' : 'sentinel (far-future)'}`
  );
  log.error(`[agent-runner] Refresh token: ${config.oauthRefreshToken ? 'provided' : 'none'}`);

  if (!config.oauthToken) {
    throw new Error('No OAuth token provided via CLAUDE_OAUTH_TOKEN environment variable');
  }

  const credentials = {
    claudeAiOauth: {
      accessToken: config.oauthToken,
      refreshToken: config.oauthRefreshToken,
      expiresAt: config.oauthExpiresAt,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      subscriptionType: 'max',
    },
  };

  // Create .claude directory
  await mkdir(claudeDir, { recursive: true, mode: 0o700 });

  // Write credentials file
  await writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });

  log.error(`[agent-runner] Wrote credentials to ${credentialsFile}`);

  // Verify the file is readable and valid JSON
  try {
    const written = await readFile(credentialsFile, 'utf-8');
    const parsed = JSON.parse(written) as { claudeAiOauth?: { accessToken?: string } };
    if (!parsed.claudeAiOauth?.accessToken) {
      throw new Error('Credentials file written but accessToken missing');
    }
    log.error('[agent-runner] Credentials file verified successfully');
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
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.error(`[agent-runner] Error checking stop file: ${code}`);
    }
    return false;
  }
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
    ...(config.skillId ? { skillId: config.skillId } : {}),
    ...(config.skillName ? { skillName: config.skillName } : {}),
  });

  log.error('[agent-runner] Starting PLANNING phase...');

  // Track ExitPlanMode options - captured by canUseTool callback
  let exitPlanModeOptions: ExitPlanModeOptions | undefined;
  // Flag set when ExitPlanMode is detected via canUseTool - checked in stream loop
  let exitPlanModeDetected = false;
  // Plan content captured from canUseTool input (ExitPlanModeInput.plan)
  let exitPlanModePlan: string | undefined;
  // Timestamp when ExitPlanMode was detected (for timeout handling)
  let exitPlanModeTimestamp: number | undefined;
  const EXIT_PLAN_MODE_TIMEOUT_MS = 60_000;

  // Shared tracking state for skill calls, file changes, and token usage
  const tracking = createTrackingState();
  const { activeTools, skillCalls } = tracking;

  /** Build enriched fields for complete events */
  const enrichedFields = () => buildEnrichedFields(tracking, config);

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

      // Accumulate Skill tool calls for metrics
      if (tool.skillName) {
        skillCalls.push({
          skillName: tool.skillName,
          durationMs,
          isError,
        });
      }

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
    log.error('[agent-runner] Creating SDK session in plan mode...');

    // Create canUseTool callback to capture ExitPlanMode options
    // This is the official SDK mechanism for intercepting tool calls
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      log.error(`[agent-runner] canUseTool: ${toolName}`);

      // Track tool start
      const toolEntry: { toolName: string; startTime: number; skillName?: string } = {
        toolName,
        startTime: Date.now(),
      };

      // Enrich Skill tool calls with the skill name for downstream tracking
      if (toolName === 'Skill') {
        const skillInput = input as Record<string, unknown> | undefined;
        const sName = typeof skillInput?.skill === 'string' ? skillInput.skill : undefined;
        if (sName) {
          toolEntry.skillName = sName;
        } else {
          log.error(
            `[agent-runner] Skill tool invoked but skill name could not be extracted (toolUseID: ${options.toolUseID})`
          );
        }
      }

      // Capture subagent_type from Agent tool calls for topology grouping
      if (toolName === 'Agent') {
        const agentInput = input as Record<string, unknown> | undefined;
        const subagentType =
          typeof agentInput?.subagent_type === 'string' ? agentInput.subagent_type : null;
        if (subagentType) {
          topology.pendingSubagentTypes.push(subagentType);
        }
      }

      activeTools.set(options.toolUseID, toolEntry);

      // Emit tool start event for all tools
      events.toolStart({
        toolName,
        toolId: options.toolUseID,
        input: (input as Record<string, unknown>) ?? {},
      });

      // Detect file-modifying tools and emit file_changed event + accumulate
      {
        const fileChange = sharedExtractFileChange(
          toolName,
          (input as Record<string, unknown>) ?? {}
        );
        if (fileChange) {
          events.fileChanged(fileChange);
          tracking.fileChangeSet.add(fileChange.path);
          if (fileChange.additions) tracking.totalLinesAdded += fileChange.additions;
          if (fileChange.deletions) tracking.totalLinesRemoved += fileChange.deletions;
        }
      }

      // Capture ExitPlanMode options when the tool is called
      if (toolName === 'ExitPlanMode') {
        const planInput = input as ExitPlanModeInput | undefined;
        exitPlanModeOptions = planInput;
        exitPlanModeDetected = true;
        exitPlanModeTimestamp = Date.now();
        exitPlanModePlan = typeof planInput?.plan === 'string' ? planInput.plan : undefined;

        log.error(
          `[agent-runner] ExitPlanMode captured via canUseTool — plan from input: ${exitPlanModePlan ? `${exitPlanModePlan.length} chars` : 'none'}`
        );
      }

      // Allow all tools to proceed (we're in plan mode)
      return { behavior: 'allow' as const, toolUseID: options.toolUseID };
    };

    // Note: executableArgs with --add-dir causes EPIPE errors in SDK 0.2.x
    // The SDK/CLI handles directory access via cwd and environment
    // When a skill is assigned, use bypassPermissions so the skill workflow can
    // use all tools including Agent (subagent spawning), WebSearch, AskUserQuestion.
    // Without a skill, use plan mode for read-only exploration.
    const planPermissionMode =
      process.env.AGENT_HAS_SKILL === 'true' ? 'bypassPermissions' : 'plan';
    // Parse allowed tools from env so interactive tools (ExitPlanMode,
    // AskUserQuestion, WebSearch) are not blocked by the permission layer.
    let allowedTools: string[] = [];
    if (process.env.AGENT_ALLOWED_TOOLS) {
      try {
        const parsed = JSON.parse(process.env.AGENT_ALLOWED_TOOLS);
        allowedTools = Array.isArray(parsed)
          ? parsed.filter((t): t is string => typeof t === 'string')
          : [];
      } catch (parseErr) {
        log.error(
          `[agent-runner] Failed to parse AGENT_ALLOWED_TOOLS: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
        );
      }
    }
    // ExitPlanMode MUST be in allowedTools for plan mode sessions.
    // The SDK's CLI permission layer blocks tools not in allowedTools before
    // the canUseTool callback runs. Without this, agents cannot exit plan mode.
    const essentialPlanningTools = ['ExitPlanMode'];
    for (const tool of essentialPlanningTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
    // Load custom agent definitions from .claude/agents/ for SDK subagent support
    const agentDefs = await loadAgentDefinitions(config.cwd);

    session = unstable_v2_createSession({
      model: config.model,
      env: { ...process.env }, // Teams GA: env passed through for agent swarm support
      // Note: --add-dir causes EPIPE/exit-code-9; agent defs passed via 'agents' option
      // In bypassPermissions mode, don't restrict tools — allow all including Agent
      ...(planPermissionMode !== 'bypassPermissions' ? { allowedTools } : {}),
      ...(Object.keys(agentDefs).length > 0 ? { agents: agentDefs } : {}),
      permissionMode: planPermissionMode,
      canUseTool, // Use official SDK callback for tool interception
    });
    log.error('[agent-runner] SDK session created successfully');
  } catch (sessionError) {
    const errMsg = sessionError instanceof Error ? sessionError.message : String(sessionError);
    log.error('[agent-runner] Failed to create SDK session:', { errMsg: errMsg });
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

  // Topology tracker for subagent lifecycle events during planning
  // Skills can spawn subagents via the Agent tool when AGENT_HAS_SKILL=true
  const topology: TopologyTracker = {
    taskToNodeId: new Map(),
    rootEmitted: false,
    pendingSubagentTypes: [],
  };
  const rootAgentId = `agent-${config.taskId}`;

  try {
    // Send the initial prompt
    await session.send(config.prompt as string);

    log.error('[agent-runner] Processing SDK stream (planning)...');
    let messageCount = 0;

    for await (const msg of session.stream()) {
      messageCount++;
      log.error(`[agent-runner] Message ${messageCount}: type=${msg.type}`);

      // Check for cancellation
      if (await shouldStop()) {
        log.error('[agent-runner] Stop file detected, cancelling...');
        events.cancelled(turn);
        session.close();
        return;
      }

      // Check for ExitPlanMode timeout — if stream hangs after ExitPlanMode, force emit planReady
      if (exitPlanModeDetected && exitPlanModeTimestamp) {
        const elapsed = Date.now() - exitPlanModeTimestamp;
        if (elapsed > EXIT_PLAN_MODE_TIMEOUT_MS) {
          log.error(`[agent-runner] ExitPlanMode timeout (${elapsed}ms) — forcing plan_ready`);
          emitAllToolResults();
          session.close();
          const planContent = exitPlanModePlan || accumulatedText;
          events.planReady({
            plan: planContent,
            turnCount: turn,
            sdkSessionId: sdkSessionId ?? '',
            allowedPrompts: exitPlanModeOptions?.allowedPrompts,
            skillCalls: optionalSkillCalls(skillCalls),
          });
          return;
        }
      }

      // Capture SDK session ID from init message + handle subagent topology
      if (msg.type === 'system') {
        const sysMsg = msg as Record<string, unknown>;
        const sysSubtype = sysMsg.subtype as string | undefined;
        if (sysSubtype === 'init') {
          sdkSessionId = session.sessionId;
          log.error(`[agent-runner] SDK session ID: ${sdkSessionId}`);
        }

        // Handle subagent lifecycle events (task_started, task_progress, task_notification)
        if (
          sysSubtype === 'task_started' ||
          sysSubtype === 'task_progress' ||
          sysSubtype === 'task_notification'
        ) {
          handleTopologySystemMsg(sysMsg, topology, events, rootAgentId);
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
          log.error(`[agent-runner] Turn ${turn}/${config.maxTurns}`);
          events.turn({
            turn,
            maxTurns: config.maxTurns,
            remaining: config.maxTurns - turn,
          });

          // Check turn limit
          if (turn >= config.maxTurns) {
            log.error('[agent-runner] Turn limit reached during planning');
            emitAllToolResults();
            session.close();

            // If we have accumulated text, emit plan_ready so the plan approval
            // flow works. Emitting complete during planning would bypass plan
            // approval and leave tasks stuck without a proper plan.
            if (accumulatedText || exitPlanModeDetected) {
              const planContent = exitPlanModePlan || accumulatedText;
              log.error(
                `[agent-runner] Emitting plan_ready on turn limit (length: ${planContent.length})`
              );
              events.planReady({
                plan: planContent,
                turnCount: turn,
                sdkSessionId: sdkSessionId ?? '',
                allowedPrompts: exitPlanModeOptions?.allowedPrompts,
                skillCalls: optionalSkillCalls(skillCalls),
              });
            } else {
              events.complete({
                status: 'turn_limit',
                turnCount: turn,
                result: `Turn limit reached (${config.maxTurns}) during planning.`,
                skillCalls: optionalSkillCalls(skillCalls),
                ...enrichedFields(),
              });
            }
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
        log.error(
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
        log.error(`[agent-runner] Rate limit: ${rateLimitMsg.rate_limit_info.status}`);
      }

      // Handle tool_use_summary events (actual tool completion with results from SDK)
      if (msg.type === 'tool_use_summary') {
        const toolSummary = msg as {
          summary: string;
          preceding_tool_use_ids: string[];
          is_error?: boolean;
        };

        log.error(
          `[agent-runner] Tool summary: ids=${toolSummary.preceding_tool_use_ids.join(',')}`
        );

        const summaryIsError = toolSummary.is_error === true;

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
              isError: summaryIsError,
              durationMs,
            });

            // Accumulate Skill tool calls for metrics
            if (startInfo.skillName) {
              skillCalls.push({
                skillName: startInfo.skillName,
                durationMs,
                isError: summaryIsError,
              });
            }

            // ExitPlanMode tool completed — do NOT close session here.
            // The stream will naturally flow to a 'result' message, which is the safe exit point.
            // Closing mid-iteration causes "Operation aborted" unhandled rejections.
            if (startInfo.toolName === 'ExitPlanMode') {
              log.error('[agent-runner] ExitPlanMode tool completed — waiting for result message');
            }
          }
        }
      }

      // Handle assistant messages
      if (msg.type === 'assistant') {
        // Assistant message means all previous tools have completed
        emitAllToolResults();

        // Note: subagent_type is captured in the canUseTool callback (see ~line 566).
        // The assistant-message content is not re-scanned to avoid a double-push into
        // topology.pendingSubagentTypes, which would misalign subsequent local_agent
        // substitutions.

        // Accumulate token usage from assistant messages
        const assistantMsg = msg as {
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        };
        if (assistantMsg.message?.usage) {
          if (typeof assistantMsg.message.usage.input_tokens === 'number')
            tracking.totalInputTokens += assistantMsg.message.usage.input_tokens;
          if (typeof assistantMsg.message.usage.output_tokens === 'number')
            tracking.totalOutputTokens += assistantMsg.message.usage.output_tokens;
        }

        // ExitPlanMode was detected — do NOT close session here.
        // Continue consuming messages until the stream naturally yields 'result'.
        if (exitPlanModeDetected) {
          log.error('[agent-runner] ExitPlanMode detected — continuing to result message');
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

        // Extract final token usage from result message
        const resultUsage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } })
          .usage;
        if (resultUsage) {
          // Result usage is cumulative — use it as the authoritative total if available
          if (typeof resultUsage.input_tokens === 'number')
            tracking.totalInputTokens = resultUsage.input_tokens;
          if (typeof resultUsage.output_tokens === 'number')
            tracking.totalOutputTokens = resultUsage.output_tokens;
        }

        session.close(); // Clean close — stream is done, iterator complete

        // If ExitPlanMode was called, emit plan_ready
        if (exitPlanModeDetected || exitPlanModeOptions !== undefined || accumulatedText) {
          // Prefer plan from canUseTool input (ExitPlanModeInput.plan), fall back to accumulated text
          const planContent = exitPlanModePlan || accumulatedText;
          log.error(
            `[agent-runner] Emitting plan_ready (source: ${exitPlanModePlan ? 'ExitPlanModeInput.plan' : 'accumulated text'}, length: ${planContent.length})`
          );
          events.planReady({
            plan: planContent,
            turnCount: turn,
            sdkSessionId: sdkSessionId ?? '',
            allowedPrompts: exitPlanModeOptions?.allowedPrompts,
            skillCalls: optionalSkillCalls(skillCalls),
          });
        } else {
          // No plan was created - treat as completion
          events.complete({
            status: 'completed',
            turnCount: turn,
            result: accumulatedText || 'Planning completed without explicit plan',
            skillCalls: optionalSkillCalls(skillCalls),
            ...enrichedFields(),
          });
        }
        return;
      }
    }

    log.error(`[agent-runner] Planning stream ended. Messages: ${messageCount}, turns: ${turn}`);

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
        skillCalls: optionalSkillCalls(skillCalls),
      });
    } else {
      events.complete({
        status: 'completed',
        turnCount: turn,
        result: 'Planning completed',
        skillCalls: optionalSkillCalls(skillCalls),
        ...enrichedFields(),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = (error as { code?: string }).code;
    log.error('[agent-runner] Planning error:', { message: message });

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
    ...(config.skillId ? { skillId: config.skillId } : {}),
    ...(config.skillName ? { skillName: config.skillName } : {}),
  });

  // Topology tracker for subagent lifecycle events
  const topology: TopologyTracker = {
    taskToNodeId: new Map(),
    rootEmitted: true,
    pendingSubagentTypes: [],
  };
  const rootAgentId = `agent-${config.taskId}`;

  // Always emit root agent node in topology
  events.topologySpawned({
    agentId: rootAgentId,
    name: 'Agent',
    role: 'orchestrator',
    parentId: null,
  });

  log.error('[agent-runner] Starting EXECUTION phase...');
  if (config.sdkSessionId) {
    log.error(`[agent-runner] Resuming SDK session: ${config.sdkSessionId}`);
  }

  // Shared tracking state for skill calls, file changes, and token usage
  const tracking = createTrackingState();
  const { activeTools, skillCalls } = tracking;

  /** Build enriched fields for complete events */
  const enrichedFields = () => buildEnrichedFields(tracking, config);

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

      // Accumulate Skill tool calls for metrics
      if (tool.skillName) {
        skillCalls.push({
          skillName: tool.skillName,
          durationMs,
          isError,
        });
      }

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
    const toolEntry: { toolName: string; startTime: number; skillName?: string } = {
      toolName,
      startTime: Date.now(),
    };

    // Enrich Skill tool calls with the skill name for downstream tracking
    if (toolName === 'Skill') {
      const skillInput = input as Record<string, unknown> | undefined;
      const sName = typeof skillInput?.skill === 'string' ? skillInput.skill : undefined;
      if (sName) {
        toolEntry.skillName = sName;
      } else {
        log.error(
          `[agent-runner] Skill tool invoked but skill name could not be extracted (toolUseID: ${options.toolUseID})`
        );
      }
    }

    // Capture subagent_type from Agent tool calls for topology grouping.
    // The SDK reports task_type: "local_agent" — we substitute with the real name.
    if (toolName === 'Agent') {
      const agentInput = input as Record<string, unknown> | undefined;
      const subagentType =
        typeof agentInput?.subagent_type === 'string' ? agentInput.subagent_type : null;
      if (subagentType) {
        topology.pendingSubagentTypes.push(subagentType);
      }
    }

    activeTools.set(options.toolUseID, toolEntry);

    // Emit tool start event
    events.toolStart({
      toolName,
      toolId: options.toolUseID,
      input: (input as Record<string, unknown>) ?? {},
    });

    // Detect file-modifying tools and emit file_changed event + accumulate
    {
      const fileChange = sharedExtractFileChange(
        toolName,
        (input as Record<string, unknown>) ?? {}
      );
      if (fileChange) {
        events.fileChanged(fileChange);
        tracking.fileChangeSet.add(fileChange.path);
        if (fileChange.additions) tracking.totalLinesAdded += fileChange.additions;
        if (fileChange.deletions) tracking.totalLinesRemoved += fileChange.deletions;
      }
    }

    // Allow all tools in execution mode
    return { behavior: 'allow' as const, toolUseID: options.toolUseID };
  };

  // Create or resume Claude Agent SDK session
  let session: SDKSession | undefined;
  let sessionResumed = false;
  try {
    log.error('[agent-runner] Creating SDK session with bypass permissions...');

    // Note: executableArgs with --add-dir causes EPIPE errors in SDK 0.2.x
    // The SDK/CLI handles directory access via cwd and environment.
    // Load custom agent definitions once — both resume and fresh-session paths
    // need them so subagent spawning (Agent tool) can resolve `.claude/agents/*.md`
    // names. Omitting on resume would break subagent support mid-task.
    const agentDefs = await loadAgentDefinitions(config.cwd);
    const agentsOpt = Object.keys(agentDefs).length > 0 ? { agents: agentDefs } : {};

    if (config.sdkSessionId) {
      // Try to resume existing session — may fail if session state is corrupted or stale
      // (primary container-change detection is in approvePlan; this is defense-in-depth)
      try {
        session = unstable_v2_resumeSession(config.sdkSessionId, {
          model: config.model,
          env: { ...process.env }, // Teams GA: env passed through for agent swarm support
          ...agentsOpt,
          permissionMode: 'bypassPermissions',
          canUseTool, // Track tools even in bypass mode
        });
        sessionResumed = true;
        log.error('[agent-runner] SDK session resumed successfully');
      } catch (resumeError) {
        const resumeMsg = resumeError instanceof Error ? resumeError.message : String(resumeError);
        log.warn(
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
        ...agentsOpt,
        permissionMode: 'bypassPermissions',
        canUseTool, // Track tools even in bypass mode
      });
    }
    log.error('[agent-runner] SDK session ready');
  } catch (sessionError) {
    const errMsg = sessionError instanceof Error ? sessionError.message : String(sessionError);
    log.error('[agent-runner] Failed to create SDK session:', { errMsg: errMsg });
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

    log.error('[agent-runner] Processing SDK stream (execution)...');
    let messageCount = 0;

    for await (const msg of session.stream()) {
      messageCount++;
      log.error(`[agent-runner] Message ${messageCount}: type=${msg.type}`);

      // Check for cancellation
      if (await shouldStop()) {
        log.error('[agent-runner] Stop file detected, cancelling...');
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
          log.error(`[agent-runner] Turn ${turn}/${config.maxTurns}`);
          events.turn({
            turn,
            maxTurns: config.maxTurns,
            remaining: config.maxTurns - turn,
          });

          // Check turn limit
          if (turn >= config.maxTurns) {
            log.error('[agent-runner] Turn limit reached');
            events.complete({
              status: 'turn_limit',
              turnCount: turn,
              result: `Turn limit reached (${config.maxTurns}). Task may need manual completion.`,
              skillCalls: optionalSkillCalls(skillCalls),
              ...enrichedFields(),
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
        log.error(
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
        log.error(`[agent-runner] Rate limit: ${rateLimitMsg.rate_limit_info.status}`);
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
          is_error?: boolean;
        };

        log.error(
          `[agent-runner] Tool summary: ids=${toolSummary.preceding_tool_use_ids.join(',')}`
        );

        const summaryIsError = toolSummary.is_error === true;

        for (const toolId of toolSummary.preceding_tool_use_ids) {
          const startInfo = activeTools.get(toolId);
          if (startInfo) {
            activeTools.delete(toolId);
            const durationMs = Date.now() - startInfo.startTime;
            events.toolResult({
              toolName: startInfo.toolName,
              toolId,
              result: toolSummary.summary ?? '',
              isError: summaryIsError,
              durationMs,
            });

            // Accumulate Skill tool calls for metrics
            if (startInfo.skillName) {
              skillCalls.push({
                skillName: startInfo.skillName,
                durationMs,
                isError: summaryIsError,
              });
            }
          }
        }
      }

      // Handle assistant messages (complete turns)
      if (msg.type === 'assistant') {
        // Assistant message means all previous tools have completed
        emitAllToolResults();

        // Note: subagent_type is captured in the canUseTool callback (see ~line 1126).
        // The assistant-message content is not re-scanned to avoid a double-push into
        // topology.pendingSubagentTypes.

        // Accumulate token usage from assistant messages
        const assistantMsg = msg as {
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        };
        if (assistantMsg.message?.usage) {
          if (typeof assistantMsg.message.usage.input_tokens === 'number')
            tracking.totalInputTokens += assistantMsg.message.usage.input_tokens;
          if (typeof assistantMsg.message.usage.output_tokens === 'number')
            tracking.totalOutputTokens += assistantMsg.message.usage.output_tokens;
        }

        const text = getAssistantText(msg);
        if (text) {
          log.error(`[agent-runner] Assistant message: ${text.slice(0, 100)}...`);
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
        const result = msg as {
          text?: string;
          subtype?: string;
          is_error?: boolean;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        log.error(`[agent-runner] Result: subtype=${result.subtype}, is_error=${result.is_error}`);

        // Extract final token usage from result message
        if (result.usage) {
          if (typeof result.usage.input_tokens === 'number')
            tracking.totalInputTokens = result.usage.input_tokens;
          if (typeof result.usage.output_tokens === 'number')
            tracking.totalOutputTokens = result.usage.output_tokens;
        }

        if (result.is_error) {
          const errorText = result.text ?? 'Task ended with error';
          log.error(`[agent-runner] SDK error result: ${errorText}`);
          // Emit a single terminal event. The host maps status:'error' to the
          // error-handling path (agent:error semantics) and does not need a separate
          // agent:error event. Emitting both caused a race between handleAgentError
          // and handleAgentComplete.
          events.complete({
            status: 'error',
            turnCount: turn,
            result: errorText,
            skillCalls: optionalSkillCalls(skillCalls),
            ...enrichedFields(),
          });
        } else {
          events.complete({
            status: 'completed',
            turnCount: turn,
            result: result.text ?? (accumulatedText || 'Task completed'),
            skillCalls: optionalSkillCalls(skillCalls),
            ...enrichedFields(),
          });
        }
        session.close();
        return;
      }
    }

    log.error(`[agent-runner] Stream ended. Total messages: ${messageCount}, turns: ${turn}`);

    // Emit results for any remaining active tools
    emitAllToolResults();

    // Stream ended without explicit result
    events.complete({
      status: 'completed',
      turnCount: turn,
      result: accumulatedText || 'Task completed',
      skillCalls: optionalSkillCalls(skillCalls),
      ...enrichedFields(),
    });
  } catch (error) {
    // Emit results for any remaining active tools before reporting error
    emitAllToolResults();

    const message = error instanceof Error ? error.message : String(error);
    const errorCode = (error as { code?: string }).code;
    log.error('[agent-runner] Stream error:', { message: message });
    if (error instanceof Error && error.stack) {
      log.error('[agent-runner] Stack:', { stack: error.stack });
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

  log.error(`[agent-runner] Phase: ${config.phase}`);

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
    log.error(
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
