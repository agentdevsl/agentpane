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
import { statSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  type CanUseTool,
  type HookCallbackMatcher,
  type PreToolUseHookInput,
  type SDKSession,
  type SubagentStartHookInput,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';
import { type AgentDefinition, parseAgentFrontmatter } from './agent-frontmatter.js';
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
 *
 * Each file is parsed via {@link parseAgentFrontmatter}, which uses a real
 * YAML parser (`yaml` package) and a strict schema. The previous hand-rolled
 * regex parser was bypassable by injecting `\n`-laden fields that the host
 * serialiser correctly quoted but the runner mis-decoded — see F06-NEW-04
 * in `specs/arch_review_april29/06-security.md` and the comment block in
 * `agent-frontmatter.ts`.
 *
 * Returns a Record<string, AgentDefinition> keyed by agent name. Files that
 * fail validation are logged and skipped — one bad file never aborts the
 * whole load, matching the prior behaviour.
 */
/**
 * Read all `.md` agent definitions from `dir`, parsing frontmatter and
 * indexing by `name`. Files with invalid frontmatter are skipped (logged).
 * Returns an empty map when the directory does not exist — the caller is
 * responsible for combining results from multiple directories.
 */
async function readAgentDefinitionsFromDir(
  dir: string,
  source: 'bundle' | 'workspace'
): Promise<Record<string, AgentDefinition>> {
  const agents: Record<string, AgentDefinition> = {};
  let files: string[];
  try {
    const { readdir } = await import('node:fs/promises');
    files = await readdir(dir);
  } catch {
    log.error(`[agent-runner] No agent directory at ${dir} (${source})`);
    return agents;
  }
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const content = await readFile(join(dir, file), 'utf-8');
      const parsed = parseAgentFrontmatter(content);
      if (!parsed) {
        log.error(`[agent-runner] Skipped agent file (invalid frontmatter): ${dir}/${file}`);
        continue;
      }
      agents[parsed.name] = parsed.definition;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`[agent-runner] Failed to read agent file ${dir}/${file}: ${errMsg}`);
    }
  }
  log.error(
    `[agent-runner] Loaded ${Object.keys(agents).length} agent definitions from ${dir} (${source})`
  );
  return agents;
}

/**
 * Mirror image-baked subagent `.md` files into the workspace's
 * `.claude/agents/` directory, skipping files that already exist (workspace
 * wins). The Claude Agent SDK builds Claude's system-prompt list of
 * available subagents from `.claude/agents/*.md` on disk in the working
 * directory; passing `agents:` programmatically registers the type but
 * does not always make Claude aware of it. Mirroring the bundle files
 * gives Claude a concrete listing to reference without forcing every
 * codespace template to enumerate them.
 *
 * Idempotent: re-running on an existing worktree leaves user-authored
 * agents intact and just adds anything missing.
 */
async function syncBundleAgentsIntoWorkspace(cwd: string): Promise<void> {
  const bundleDir = process.env.AGENT_BUNDLE_DIR;
  if (!bundleDir) return;
  const workspaceDir = join(cwd, '.claude', 'agents');
  try {
    await mkdir(workspaceDir, { recursive: true });
  } catch (err) {
    log.error(
      `[agent-runner] Could not ensure ${workspaceDir}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  let bundleFiles: string[];
  try {
    const { readdir } = await import('node:fs/promises');
    bundleFiles = await readdir(bundleDir);
  } catch {
    log.error(`[agent-runner] No bundle dir at ${bundleDir} to sync`);
    return;
  }
  let copied = 0;
  let skipped = 0;
  for (const file of bundleFiles) {
    if (!file.endsWith('.md')) continue;
    const target = join(workspaceDir, file);
    try {
      await access(target);
      skipped++;
    } catch {
      try {
        const content = await readFile(join(bundleDir, file), 'utf-8');
        await writeFile(target, content, 'utf-8');
        copied++;
      } catch (err) {
        log.error(
          `[agent-runner] Failed to copy ${file} into workspace: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  log.error(
    `[agent-runner] Bundle agents synced into ${workspaceDir}: ${copied} copied, ${skipped} already present`
  );
}

/**
 * Build the SDK `agents` registry by merging two sources:
 *
 * 1. **Bundle directory** (`AGENT_BUNDLE_DIR`, e.g. `/opt/agents-cache` in
 *    the Docker image) — image-baked subagent definitions like
 *    `tf-module-research`, `tf-module-design`, etc. that ship with the
 *    sandbox so skill prompts referencing them just work without
 *    per-codespace template configuration.
 * 2. **Workspace directory** (`${cwd}/.claude/agents/`) — codespace- or
 *    user-supplied overrides. Wins on name collision.
 *
 * The workspace directory is also synced to disk first via
 * `syncBundleAgentsIntoWorkspace` so the SDK's project-aware discovery
 * sees the bundle agents alongside the in-memory registration we pass to
 * `unstable_v2_createSession`.
 *
 * If `AGENT_BUNDLE_DIR` is unset (e.g. local dev), only the workspace
 * directory is read — backwards compatible.
 */
async function loadAgentDefinitions(cwd: string): Promise<Record<string, AgentDefinition>> {
  await syncBundleAgentsIntoWorkspace(cwd);

  const bundleDir = process.env.AGENT_BUNDLE_DIR;
  const workspaceDir = join(cwd, '.claude', 'agents');

  const merged: Record<string, AgentDefinition> = {};
  if (bundleDir) {
    Object.assign(merged, await readAgentDefinitionsFromDir(bundleDir, 'bundle'));
  }
  Object.assign(merged, await readAgentDefinitionsFromDir(workspaceDir, 'workspace'));

  // Surface the merged registry on stderr so it shows in the host log AND
  // (when AGENT_DEBUG_AGENTS=1) emit each registered name. Helps diagnose
  // why the orchestrator might think a subagent type isn't available.
  const names = Object.keys(merged);
  log.error(
    `[agent-runner] Total registered agent definitions: ${names.length} (bundle=${bundleDir ?? '(unset)'} workspace=${workspaceDir}) — names: ${names.sort().join(', ')}`
  );
  return merged;
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

/**
 * Resolve `pathToClaudeCodeExecutable` per the SDK's documented escape hatch.
 *
 * The SDK (≥0.2.113) spawns a per-platform native binary installed as an
 * optional dependency. Auto-detection inside this Docker image is wrong
 * because Bun (used to install) is statically linked to musl libc, so the
 * SDK resolves to the `*-musl` binary on a glibc host and fails with
 * "Claude Code native binary not found". We override explicitly:
 *
 * 1. `CLAUDE_CODE_PATH` — full path to the binary, takes precedence
 * 2. `CLAUDE_CODE_LIBC` + `CLAUDE_CODE_SDK_ROOT` — set by the Dockerfile
 *    so the runtime can compose the path for the current arch + libc
 * 3. Otherwise return undefined and let the SDK auto-detect (works on
 *    macOS / npm-installed environments)
 */
function resolveClaudeCodeBinaryPath(): string | undefined {
  if (process.env.CLAUDE_CODE_PATH) return process.env.CLAUDE_CODE_PATH;

  const libc = process.env.CLAUDE_CODE_LIBC;
  const sdkRoot = process.env.CLAUDE_CODE_SDK_ROOT;
  if (!libc || !sdkRoot) return undefined;

  const archSegment =
    process.arch === 'arm64' ? 'linux-arm64' : process.arch === 'x64' ? 'linux-x64' : null;
  if (!archSegment) return undefined;

  // glibc package: claude-agent-sdk-linux-arm64
  // musl package:  claude-agent-sdk-linux-arm64-musl
  const suffix = libc === 'musl' ? '-musl' : '';
  const candidate = `${sdkRoot}/claude-agent-sdk-${archSegment}${suffix}/claude`;
  return statSync(candidate, { throwIfNoEntry: false })?.isFile() ? candidate : undefined;
}

/** Tracks subagent topology state. Maps SDK task_id → generated node id. */
interface TopologyTracker {
  taskToNodeId: Map<string, string>;
  rootEmitted: boolean;
  /** Queue of subagent_type values from Agent tool calls, consumed by task_started events */
  pendingSubagentTypes: string[];
}

/**
 * Build a SubagentStart hook matcher that captures the SDK-resolved
 * `agent_type` and queues it for the next `task_started` system message
 * to consume. Provides a reliable agent_type even when the orchestrator
 * invokes the `Agent` tool without an explicit `subagent_type` (in which
 * case `canUseTool` cannot capture one).
 *
 * SubagentStart fires when the subagent process begins; canUseTool fires
 * when the orchestrator calls the Agent tool. To avoid double-pushing the
 * same value (when both paths fire for the same subagent), we skip pushing
 * if the queue's tail already matches what SubagentStart wants to add.
 *
 * The queue reference is captured once and remains valid because tracker
 * objects assign the same array; mutating the array updates both views.
 */
function buildSubagentStartHook(pendingSubagentTypes: string[]): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        const subagentInput = input as SubagentStartHookInput;
        const agentType = subagentInput.agent_type;
        if (typeof agentType !== 'string' || agentType.length === 0) {
          return {};
        }
        if (pendingSubagentTypes[pendingSubagentTypes.length - 1] !== agentType) {
          pendingSubagentTypes.push(agentType);
        }
        return {};
      },
    ],
  };
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

/**
 * Module-level reference to the currently-running phase's event emitter
 * and active-tools map. Set by `runAgentPlanning` / `runAgentExecution`
 * at the start of a run and cleared on graceful exit. Signal handlers
 * read this so a SIGTERM (e.g. K8s pod eviction or `kill` from the
 * host) can flush a `tool:result` for any in-flight tool before the
 * process terminates — without it, the host sees orphan tool:start
 * events and the UI shows tools stuck on "running" indefinitely.
 */
let currentRunFlush:
  | ((reason: 'SIGTERM' | 'SIGINT' | 'uncaughtException' | 'unhandledRejection') => void)
  | null = null;

/**
 * Register or clear the in-flight flush hook for the current phase.
 * Phases call this at start (with their own emitter + activeTools) and
 * at end (with `null`) so signal handlers always see the live state.
 */
function setRunFlushHook(hook: typeof currentRunFlush): void {
  currentRunFlush = hook;
}

/**
 * SIGTERM/SIGINT handler. The phase loops have their own
 * `emitAllToolResults` helper closed over the local `activeTools` —
 * we delegate to that via `currentRunFlush` so the in-flight tools
 * get a tool:result with isError=true and the agent runner exits
 * cleanly. Without this the host re-spawns or reconciles into an
 * inconsistent UI state where tools appear stuck running.
 */
async function handleTerminationSignal(signal: 'SIGTERM' | 'SIGINT'): Promise<never> {
  log.error(`[agent-runner] Received ${signal}, flushing in-flight tool tracking…`);
  try {
    currentRunFlush?.(signal);
  } catch (err) {
    log.error('[agent-runner] Flush hook threw during shutdown', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Drain stdout before exiting. The runner emits events as JSON lines
  // on stdout; the host reads them via kubectl exec and forwards to
  // durable streams. A bare `process.exit` here lost the synthetic
  // tool:result events the flush hook just wrote because Bun's stdout
  // buffer hadn't drained yet — when the kubectl exec stdout pipe
  // closed, the events never reached the host. flushAndExit awaits the
  // stdout flush callback (and a 50ms kernel-buffer settle) before
  // exiting, so events make it through within the K8s grace period.
  // Exit codes 143 / 130 are the conventional "killed by SIGTERM /
  // SIGINT" values that K8s and most schedulers treat as graceful.
  await flushAndExit(signal === 'SIGTERM' ? 143 : 130);
}
process.on('SIGTERM', () => {
  void handleTerminationSignal('SIGTERM');
});
process.on('SIGINT', () => {
  void handleTerminationSignal('SIGINT');
});

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
  // arch29-W2-I (F04-07, F06-NEW-05): CLAUDE_OAUTH_TOKEN is no longer required.
  // The host writes ~/.claude/.credentials.json before exec via the sandbox
  // provider's `writeFile` (out-of-band tar upload), so the token never
  // appears in argv or env. The agent-runner now trusts the pre-injected
  // file. If the env var IS set (local dev / legacy callers), the runner
  // still rewrites the file to remain backward-compatible.
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
 * Ensure the OAuth credentials file at $HOME/.claude/.credentials.json is
 * present and well-formed before starting the SDK session.
 *
 * arch29-W2-I (F04-07, F06-NEW-05): the host writes this file via the sandbox
 * provider's `writeFile` (out-of-band tar upload) before exec, so the token
 * never appears in argv or env. This function now:
 *   1. Verifies the host-injected file exists and is valid JSON with an
 *      `accessToken` (the canonical pre-injected path).
 *   2. Falls back to writing from `CLAUDE_OAUTH_TOKEN` env vars when the file
 *      is absent — preserves local-dev / legacy callers that still set the
 *      env var directly without involving the host injector.
 *
 * theme-03 F11:
 * - `homedir()` (which reads `process.env.HOME`) is used so that the host
 *   can place each concurrent agent-runner invocation under a distinct HOME
 *   (e.g. /tmp/agents/<taskId>) and avoid interleaved writes to a shared
 *   `/home/node/.claude/.credentials.json`.
 * - `expiresAt` is read from the host via `CLAUDE_OAUTH_EXPIRES_AT` when
 *   available; otherwise a far-future sentinel is used.
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
  log.error(`[agent-runner] Env-var token received: ${config.oauthToken ? 'YES' : 'NONE'}`);

  // arch29-W2-I: Try the host-injected file first. The host writes it in the
  // SDK-compatible CLI shape (`{ claudeAiOauth: { accessToken, ... } }`) via
  // `injectCredentialsBeforeExec` in container-exec.service.ts.
  let preInjectedValid = false;
  try {
    const existing = await readFile(credentialsFile, 'utf-8');
    const parsed = JSON.parse(existing) as { claudeAiOauth?: { accessToken?: string } };
    if (parsed.claudeAiOauth?.accessToken) {
      preInjectedValid = true;
      log.error(`[agent-runner] Using host-injected credentials at ${credentialsFile}`);
    }
  } catch {
    // File missing or unparseable — fall through to env-var path.
  }

  if (preInjectedValid) {
    return;
  }

  // arch29-W2-I: env-var fallback (local dev only). Production deployments
  // should always use host-injected files because the env-var path leaks the
  // token via `/proc/<pid>/environ`.
  if (!config.oauthToken) {
    throw new Error(
      'No credentials available: host-injected ~/.claude/.credentials.json missing AND CLAUDE_OAUTH_TOKEN env var unset. The host should write the file via sandbox.writeFile() before exec.'
    );
  }

  log.error(
    `[agent-runner] Token expiresAt: ${process.env.CLAUDE_OAUTH_EXPIRES_AT ? 'from host' : 'sentinel (far-future)'}`
  );
  log.error(`[agent-runner] Refresh token: ${config.oauthRefreshToken ? 'provided' : 'none'}`);
  log.error(
    `[agent-runner] WARNING: writing credentials from CLAUDE_OAUTH_TOKEN env var (legacy/dev path). The token is visible in /proc/<pid>/environ.`
  );

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

  // Register flush hook so a SIGTERM mid-run (pod eviction, dev server
  // restart, etc.) can flag every in-flight tool as terminated before
  // exiting. Without this, the host sees orphan tool:start events and
  // the UI keeps the tools stuck on "running" forever.
  setRunFlushHook((signal) => {
    for (const [toolId, tool] of activeTools) {
      const durationMs = Date.now() - tool.startTime;
      events.toolResult({
        toolName: tool.toolName,
        toolId,
        result: `Agent runner terminated by ${signal} mid-tool`,
        isError: true,
        durationMs,
      });
    }
    activeTools.clear();
  });

  // Create Claude Agent SDK session in PLAN mode
  let session: SDKSession | undefined;
  // Shared queue for subagent_type capture (planning phase). Both
  // SubagentStart hook (SDK-authoritative) and canUseTool (legacy fallback
  // when subagent_type is passed explicitly) push into this; task_started
  // consumes from it. The same array reference is assigned to
  // TopologyTracker.pendingSubagentTypes after the session is created.
  const pendingSubagentTypesRef: string[] = [];
  try {
    log.error('[agent-runner] Creating SDK session in plan mode...');

    /**
     * Side-effect-only tracking for a tool invocation. Idempotent on
     * `toolUseId`: safe to call from both `canUseTool` (which may not
     * fire when `permissionMode: 'bypassPermissions'` is set) and the
     * `PreToolUse` hook (which always fires). Whichever path runs first
     * records; subsequent calls are no-ops.
     */
    const trackToolInvocation = (
      toolName: string,
      input: unknown,
      toolUseId: string | undefined
    ) => {
      if (!toolUseId || activeTools.has(toolUseId)) return;

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
            `[agent-runner] Skill tool invoked but skill name could not be extracted (toolUseID: ${toolUseId})`
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

      activeTools.set(toolUseId, toolEntry);

      events.toolStart({
        toolName,
        toolId: toolUseId,
        input: (input as Record<string, unknown>) ?? {},
      });

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
    };

    // Create canUseTool callback. Permission decisions only — the actual
    // tracking moved to `trackToolInvocation` so it works in both this
    // path *and* the PreToolUse hook (which fires when bypass mode skips
    // canUseTool entirely).
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      log.error(`[agent-runner] canUseTool: ${toolName}`);
      trackToolInvocation(toolName, input, options.toolUseID);

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

    const claudeCodePath = resolveClaudeCodeBinaryPath();
    if (claudeCodePath) log.error(`[agent-runner] pathToClaudeCodeExecutable=${claudeCodePath}`);

    session = unstable_v2_createSession({
      model: config.model,
      env: { ...process.env }, // Teams GA: env passed through for agent swarm support
      // Note: --add-dir causes EPIPE/exit-code-9; agent defs passed via 'agents' option
      // In bypassPermissions mode, don't restrict tools — allow all including Agent
      ...(planPermissionMode !== 'bypassPermissions' ? { allowedTools } : {}),
      ...(Object.keys(agentDefs).length > 0 ? { agents: agentDefs } : {}),
      ...(claudeCodePath ? { pathToClaudeCodeExecutable: claudeCodePath } : {}),
      // Tell the SDK to surface project-scoped settings — most importantly
      // `.claude/agents/*.md` files in the cwd — to Claude. Without this,
      // the SDK defaults `settingSources` to `[]` and Claude never sees
      // the workspace agents in its system-prompt list of available
      // subagent types, even though we register them programmatically via
      // the `agents:` option above.
      settingSources: ['project'],
      permissionMode: planPermissionMode,
      canUseTool, // Use official SDK callback for tool interception
      hooks: {
        // SubagentStart provides authoritative agent_type from the SDK
        // even when the orchestrator omits subagent_type from Agent calls.
        // Pushes into the same queue canUseTool uses (see TopologyTracker
        // hoisted below).
        SubagentStart: [buildSubagentStartHook(pendingSubagentTypesRef)],
        // PreToolUse mirrors `canUseTool`'s tracking. Necessary because
        // `permissionMode: 'bypassPermissions'` (used when AGENT_HAS_SKILL)
        // skips the canUseTool callback entirely, and any tools that
        // matched a `permissions.allow` rule in the workspace's
        // `.claude/settings.local.json` (loaded by `settingSources:
        // ['project']`) also bypass canUseTool. The hook fires
        // unconditionally and `trackToolInvocation` is idempotent, so
        // this just patches the gap without double-emitting.
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const i = input as PreToolUseHookInput;
                trackToolInvocation(i.tool_name, i.tool_input, i.tool_use_id);
                return {};
              },
            ],
          },
        ],
      },
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

  // Topology tracker for subagent lifecycle events during planning.
  // Skills can spawn subagents via the Agent tool when AGENT_HAS_SKILL=true.
  // pendingSubagentTypes references the same array the SubagentStart hook
  // pushes into, so SDK-emitted agent_type values flow through the existing
  // task_started consumer.
  const topology: TopologyTracker = {
    taskToNodeId: new Map(),
    rootEmitted: false,
    pendingSubagentTypes: pendingSubagentTypesRef,
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

  // Topology tracker for subagent lifecycle events.
  // pendingSubagentTypes is shared with the SubagentStart hook below so
  // SDK-emitted agent_type values populate the queue alongside the legacy
  // canUseTool path.
  const pendingSubagentTypesRef: string[] = [];
  const topology: TopologyTracker = {
    taskToNodeId: new Map(),
    rootEmitted: true,
    pendingSubagentTypes: pendingSubagentTypesRef,
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

  // Same flush hook as the planning phase — see comment there for why.
  // Re-registering on every phase entry is fine because the previous
  // registration was cleared in the phase's `finally` block.
  setRunFlushHook((signal) => {
    for (const [toolId, tool] of activeTools) {
      const durationMs = Date.now() - tool.startTime;
      events.toolResult({
        toolName: tool.toolName,
        toolId,
        result: `Agent runner terminated by ${signal} mid-tool`,
        isError: true,
        durationMs,
      });
    }
    activeTools.clear();
  });

  /**
   * Idempotent tool tracking — see the planning-phase variant for the
   * full rationale. Called from both `canUseTool` (when the SDK invokes
   * it) and the `PreToolUse` hook (which always fires, including when
   * `permissionMode: 'bypassPermissions'` skips canUseTool).
   */
  const trackToolInvocation = (toolName: string, input: unknown, toolUseId: string | undefined) => {
    if (!toolUseId || activeTools.has(toolUseId)) return;

    const toolEntry: { toolName: string; startTime: number; skillName?: string } = {
      toolName,
      startTime: Date.now(),
    };

    if (toolName === 'Skill') {
      const skillInput = input as Record<string, unknown> | undefined;
      const sName = typeof skillInput?.skill === 'string' ? skillInput.skill : undefined;
      if (sName) {
        toolEntry.skillName = sName;
      } else {
        log.error(
          `[agent-runner] Skill tool invoked but skill name could not be extracted (toolUseID: ${toolUseId})`
        );
      }
    }

    if (toolName === 'Agent') {
      const agentInput = input as Record<string, unknown> | undefined;
      const subagentType =
        typeof agentInput?.subagent_type === 'string' ? agentInput.subagent_type : null;
      if (subagentType) {
        topology.pendingSubagentTypes.push(subagentType);
      }
    }

    activeTools.set(toolUseId, toolEntry);

    events.toolStart({
      toolName,
      toolId: toolUseId,
      input: (input as Record<string, unknown>) ?? {},
    });

    const fileChange = sharedExtractFileChange(toolName, (input as Record<string, unknown>) ?? {});
    if (fileChange) {
      events.fileChanged(fileChange);
      tracking.fileChangeSet.add(fileChange.path);
      if (fileChange.additions) tracking.totalLinesAdded += fileChange.additions;
      if (fileChange.deletions) tracking.totalLinesRemoved += fileChange.deletions;
    }
  };

  // canUseTool callback. Tracking moved to `trackToolInvocation` so it
  // works in both this path and the PreToolUse hook below.
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    trackToolInvocation(toolName, input, options.toolUseID);
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

    const claudeCodePath = resolveClaudeCodeBinaryPath();
    if (claudeCodePath) log.error(`[agent-runner] pathToClaudeCodeExecutable=${claudeCodePath}`);

    if (config.sdkSessionId) {
      // Try to resume existing session — may fail if session state is corrupted or stale
      // (primary container-change detection is in approvePlan; this is defense-in-depth)
      try {
        session = unstable_v2_resumeSession(config.sdkSessionId, {
          model: config.model,
          env: { ...process.env }, // Teams GA: env passed through for agent swarm support
          ...agentsOpt,
          ...(claudeCodePath ? { pathToClaudeCodeExecutable: claudeCodePath } : {}),
          // See planning-phase comment for why settingSources is needed.
          settingSources: ['project'],
          permissionMode: 'bypassPermissions',
          canUseTool, // Track tools even in bypass mode
          hooks: {
            SubagentStart: [buildSubagentStartHook(pendingSubagentTypesRef)],
            // Also track tools via PreToolUse — bypassPermissions skips
            // canUseTool, so without this the Tools tab is empty.
            PreToolUse: [
              {
                hooks: [
                  async (input) => {
                    const i = input as PreToolUseHookInput;
                    trackToolInvocation(i.tool_name, i.tool_input, i.tool_use_id);
                    return {};
                  },
                ],
              },
            ],
          },
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
        ...(claudeCodePath ? { pathToClaudeCodeExecutable: claudeCodePath } : {}),
        // See planning-phase comment for why settingSources is needed.
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        canUseTool, // Track tools even in bypass mode
        hooks: {
          SubagentStart: [buildSubagentStartHook(pendingSubagentTypesRef)],
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  const i = input as PreToolUseHookInput;
                  trackToolInvocation(i.tool_name, i.tool_input, i.tool_use_id);
                  return {};
                },
              ],
            },
          ],
        },
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
    // Fatal error before agent could start. The container bridge parses
    // JSON-line agent events from stdout (see event-emitter.ts); logging a
    // JSON blob via log.error writes to stderr and would be wrapped in a
    // structured log record, so the bridge would never see it as an event.
    // Emit through the proper event path so the UI gets an `agent:error`.
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = (error as { code?: string }).code;
    log.error('[agent-runner] Fatal error before run:', { message });
    if (error instanceof Error && error.stack) {
      log.error('[agent-runner] Stack:', { stack: error.stack });
    }

    if (config.taskId && config.sessionId) {
      try {
        const events = createEventEmitter(config.taskId, config.sessionId);
        events.error({
          error: message,
          code: errorCode ?? 'FATAL_ERROR',
          turnCount: 0,
        });
      } catch (emitErr) {
        // Best-effort — if even the emitter fails, the stderr log above is
        // the last-resort signal.
        log.error('[agent-runner] Failed to emit fatal error event', {
          error: emitErr instanceof Error ? emitErr.message : String(emitErr),
        });
      }
    }
    await flushAndExit(1);
  });
