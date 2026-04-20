import {
  type CanUseTool,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';
import { createId } from '@paralleldrive/cuid2';
import { createLogger } from '../../lib/logging/logger.js';
import { createSessionEventWithMetadata } from '../../services/session/event-metadata.js';
import type { SessionEvent } from '../../services/session.service.js';
import { DEFAULT_AGENT_MAX_RUNTIME_MS } from '../../services/settings.service.js';
import type { StreamDurability, StreamEventMetadata, StreamPartType } from '../streams/envelope.js';
import { deriveAgentName, mapAgentRole } from '../topology/map-agent-role.js';
import { buildSdkEnv } from './agent-sdk-utils.js';
import { ChunkBatcher } from './chunk-batcher.js';

const log = createLogger('StreamHandler');

function createStreamMetadata(params: {
  eventId: string;
  streamId: string;
  blockId?: string | null;
  partType: StreamPartType;
  durability: StreamDurability;
  sequence?: number | null;
  createdAt?: string;
}): StreamEventMetadata {
  return {
    schemaVersion: 1,
    eventId: params.eventId,
    streamId: params.streamId,
    blockId: params.blockId ?? null,
    partType: params.partType,
    durability: params.durability,
    sequence: params.sequence ?? null,
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}

function createMetadataEvent(params: {
  sessionId: string;
  type: SessionEvent['type'];
  partType: StreamPartType;
  durability?: StreamDurability;
  blockId?: string | null;
  sequence?: number | null;
  timestamp?: number;
  data: Record<string, unknown>;
}): SessionEvent {
  const timestamp = params.timestamp ?? Date.now();
  const eventId = createId();

  return {
    id: eventId,
    type: params.type,
    timestamp,
    data: {
      ...params.data,
      meta: createStreamMetadata({
        eventId,
        streamId: params.sessionId,
        blockId: params.blockId,
        partType: params.partType,
        durability: params.durability ?? 'durable',
        sequence: params.sequence,
        createdAt: new Date(timestamp).toISOString(),
      }),
    },
  };
}

export interface StreamHandlerOptions {
  agentId: string;
  sessionId: string;
  prompt: string;
  allowedTools: string[];
  maxTurns: number;
  model: string;
  cwd: string;
  signal?: AbortSignal;
  /** Maximum wall-clock runtime in ms. Read from global setting; falls back to DEFAULT_AGENT_MAX_RUNTIME_MS (4 hours). */
  maxRuntimeMs?: number;
  /** Skill identity from the task — threaded into session events for replay context. */
  skillId?: string | null;
  skillName?: string | null;
  /**
   * theme-03 F5: When provided, `runAgentExecution` tries to resume the given
   * Claude SDK session id via `unstable_v2_resumeSession`. On any failure the
   * handler falls back to a fresh session with the full plan prompt — same
   * defense-in-depth pattern the agent-runner uses.
   */
  sdkSessionId?: string;
  sessionService: {
    publish: (sessionId: string, event: SessionEvent) => Promise<unknown>;
    persistOnly?: (sessionId: string, event: SessionEvent) => Promise<unknown>;
    publishRealtimeOnly?: (sessionId: string, type: string, data: unknown) => Promise<number>;
  };
  /** Optional callback for memory capture. Fire-and-forget — errors must not propagate. */
  onMessage?: (params: {
    role: 'user' | 'assistant';
    content: string;
    turn: number;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}

export interface ExitPlanModeOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  remoteSessionId?: string;
  remoteSessionUrl?: string;
  remoteSessionTitle?: string;
}

export interface SkillCallRecord {
  skillName: string;
  durationMs: number;
  isError: boolean;
}

export interface AgentRunResult {
  runId: string;
  status: 'completed' | 'error' | 'turn_limit' | 'paused' | 'planning';
  turnCount: number;
  result?: string;
  plan?: string;
  planOptions?: ExitPlanModeOptions;
  /**
   * theme-03 F5: Claude SDK session id captured during planning so the
   * execution phase can resume the same conversation rather than paying the
   * full-context cost of a fresh session.
   */
  sdkSessionId?: string;
  error?: string;
  metrics?: {
    totalCostUsd?: number;
    durationMs?: number;
    durationApiMs?: number;
    numTurns?: number;
    stopReason?: string | null;
    inputTokens?: number;
    outputTokens?: number;
  };
  skillCalls?: SkillCallRecord[];
  fileChanges?: { filesModified: number; linesAdded: number | null; linesRemoved: number | null };
}

async function publishToolProgress(
  sessionService: { publish: (sessionId: string, event: SessionEvent) => Promise<unknown> },
  sessionId: string,
  agentId: string,
  msg: Record<string, unknown>
): Promise<void> {
  await sessionService.publish(
    sessionId,
    createMetadataEvent({
      sessionId,
      type: 'agent:tool_progress',
      partType: 'system',
      data: {
        agentId,
        toolUseId: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : 'unknown',
        toolName: typeof msg.tool_name === 'string' ? msg.tool_name : 'unknown',
        elapsedSeconds: typeof msg.elapsed_time_seconds === 'number' ? msg.elapsed_time_seconds : 0,
      },
    })
  );
}

async function publishCompactBoundary(
  sessionService: { publish: (sessionId: string, event: SessionEvent) => Promise<unknown> },
  sessionId: string,
  agentId: string,
  msg: Record<string, unknown>
): Promise<void> {
  const compact = msg as { compact_metadata?: { trigger?: string; pre_tokens?: number } };
  if (!compact.compact_metadata) return;
  await sessionService.publish(
    sessionId,
    createMetadataEvent({
      sessionId,
      type: 'agent:compacted',
      partType: 'system',
      data: {
        agentId,
        trigger: compact.compact_metadata.trigger ?? 'unknown',
        preTokens: compact.compact_metadata.pre_tokens ?? 0,
      },
    })
  );
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
  /** Queue of subagent_type values from Agent tool calls, consumed by task_started events */
  pendingSubagentTypes: string[];
}

function createTopologyTracker(): TopologyTracker {
  return { taskToNodeId: new Map(), rootEmitted: false, pendingSubagentTypes: [] };
}

/**
 * Create a ChunkBatcher wired to the session service's split publish paths.
 * Falls back to the unified `publish` method when split methods are unavailable.
 */
function createChunkBatcher(
  sessionId: string,
  agentId: string,
  phase: 'planning' | 'execution',
  sessionService: StreamHandlerOptions['sessionService']
): ChunkBatcher {
  const batcher = new ChunkBatcher({
    sessionId,
    agentId,
    persistEvent: async (sid, event) => {
      const result = await (sessionService.persistOnly?.(sid, event as SessionEvent) ??
        sessionService.publish(sid, event as SessionEvent));
      if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
        const errorMsg = (result as { error?: { message?: string } }).error?.message ?? 'unknown';
        throw new Error(`Chunk persist failed: ${JSON.stringify(errorMsg)}`);
      }
      return result;
    },
    publishRealtime: (sid, type, data) =>
      sessionService.publishRealtimeOnly?.(sid, type, data) ?? Promise.resolve(0),
  });
  batcher.setPhase(phase);
  return batcher;
}

/**
 * Safely destroy a ChunkBatcher, logging but not re-throwing errors.
 */
async function destroyBatcher(
  batcher: ChunkBatcher,
  agentId: string,
  sessionId: string
): Promise<void> {
  try {
    await batcher.destroy();
  } catch (err) {
    log.error('ChunkBatcher destroy failed during error cleanup', {
      error: err instanceof Error ? err : new Error(String(err)),
      data: { agentId, sessionId },
    });
  }
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
    const rawTaskType = msg.task_type as string | undefined;
    if (!sdkTaskId) return false;

    // The SDK reports task_type: "local_agent" for Agent tool calls.
    // Substitute with the real subagent_type captured from canUseTool.
    const taskType =
      rawTaskType === 'local_agent' && tracker.pendingSubagentTypes.length > 0
        ? tracker.pendingSubagentTypes.shift()
        : rawTaskType;

    // Emit root orchestrator node on first subagent spawn
    if (!tracker.rootEmitted) {
      tracker.rootEmitted = true;
      await sessionService.publish(
        sessionId,
        createMetadataEvent({
          sessionId,
          type: 'topology:agent_spawned',
          partType: 'lifecycle',
          blockId: agentId,
          data: {
            agentId,
            taskId: taskId ?? '',
            name: 'Orchestrator',
            role: 'orchestrator',
            parentId: null,
          },
        })
      );
    }

    const nodeId = createId();
    tracker.taskToNodeId.set(sdkTaskId, nodeId);

    await sessionService.publish(
      sessionId,
      createMetadataEvent({
        sessionId,
        type: 'topology:agent_spawned',
        partType: 'lifecycle',
        blockId: nodeId,
        data: {
          agentId: nodeId,
          taskId: taskId ?? '',
          name: deriveAgentName(taskType, description),
          role: mapAgentRole(taskType),
          agentType: taskType ?? null,
          parentId: agentId,
          sdkTaskId,
        },
      })
    );
    return true;
  }

  if (subtype === 'task_progress') {
    const sdkTaskId = msg.task_id as string;
    const nodeId = tracker.taskToNodeId.get(sdkTaskId);
    if (!nodeId) return false;

    const usage = msg.usage as
      | { total_tokens?: number; tool_uses?: number; duration_ms?: number }
      | undefined;

    await sessionService.publish(
      sessionId,
      createMetadataEvent({
        sessionId,
        type: 'topology:agent_progress',
        partType: 'system',
        blockId: nodeId,
        data: {
          agentId: nodeId,
          sdkTaskId,
          tokens: usage?.total_tokens ?? 0,
          toolUses: usage?.tool_uses ?? 0,
          durationMs: usage?.duration_ms ?? 0,
          summary: msg.summary as string | undefined,
          lastToolName: msg.last_tool_name as string | undefined,
        },
      })
    );
    return true;
  }

  if (subtype === 'task_notification') {
    const sdkTaskId = msg.task_id as string;
    const nodeId = tracker.taskToNodeId.get(sdkTaskId);
    if (!nodeId) return false;

    const usage = msg.usage as
      | { total_tokens?: number; tool_uses?: number; duration_ms?: number }
      | undefined;

    await sessionService.publish(
      sessionId,
      createMetadataEvent({
        sessionId,
        type: 'topology:agent_completed',
        partType: 'lifecycle',
        blockId: nodeId,
        data: {
          agentId: nodeId,
          sdkTaskId,
          status: normalizeTopologyStatus(msg.status),
          summary: typeof msg.summary === 'string' ? msg.summary : undefined,
          tokens: usage?.total_tokens,
          toolUses: usage?.tool_uses,
          durationMs: usage?.duration_ms,
        },
      })
    );
    tracker.taskToNodeId.delete(sdkTaskId);
    return true;
  }

  return false;
}

function extractResultMetrics(result: Record<string, unknown>): AgentRunResult['metrics'] {
  const usage =
    result.usage != null && typeof result.usage === 'object'
      ? (result.usage as { input_tokens?: number; output_tokens?: number })
      : undefined;

  return {
    totalCostUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
    durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : undefined,
    durationApiMs: typeof result.duration_api_ms === 'number' ? result.duration_api_ms : undefined,
    numTurns: typeof result.num_turns === 'number' ? result.num_turns : undefined,
    stopReason:
      result.stop_reason !== undefined ? (result.stop_reason as string | null) : undefined,
    inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
    outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined,
  };
}

async function publishMetrics(
  sessionService: { publish: (sessionId: string, event: SessionEvent) => Promise<unknown> },
  sessionId: string,
  agentId: string,
  runId: string,
  msg: Record<string, unknown>,
  skillId?: string | null,
  skillName?: string | null
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
  await sessionService.publish(
    sessionId,
    createSessionEventWithMetadata({
      sessionId,
      type: 'agent:metrics',
      partType: 'system',
      blockId: runId,
      data: {
        agentId,
        runId,
        skillId,
        skillName,
        totalCostUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
        durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
        durationApiMs: typeof msg.duration_api_ms === 'number' ? msg.duration_api_ms : undefined,
        numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : undefined,
        usage,
        modelUsage,
        stopReason: msg.stop_reason !== undefined ? (msg.stop_reason as string | null) : undefined,
      },
    })
  );
}

// AE-010: Deferred - functions share ~70% code but have enough phase-specific logic to make extraction risky
// Shared: skill tracking (skillCalls accumulation), file change tracking (modifiedFiles), topology tracking, metrics publishing
// Planning only: ExitPlanMode capture, planContent tracking, no turn limits
// Execution only: turn limit enforcement, different session params, different result events

/**
 * Run the agent in planning mode first.
 * The agent will explore the codebase and use ExitPlanMode when the plan is ready.
 * Returns after the plan is ready for user approval.
 */
export async function runAgentPlanning(options: StreamHandlerOptions): Promise<AgentRunResult> {
  const { agentId, sessionId, prompt, allowedTools, model, cwd, sessionService, signal } = options;
  const maxRuntimeMs = Math.max(options.maxRuntimeMs ?? DEFAULT_AGENT_MAX_RUNTIME_MS, 60_000); // minimum 1 minute

  const runId = createId();
  let accumulated = '';
  let turn = 0;
  let planContent = '';
  let exitPlanModeOptions: ExitPlanModeOptions | undefined;
  // theme-03 F5: capture the SDK session id once the session is initialized
  // so PlanApprovalService / TaskService.approvePlan can resume it on execute.
  let capturedSdkSessionId: string | undefined;

  // Topology tracker for subagent lifecycle events during planning.
  // Skills can spawn subagents via the Agent tool, which emit task_started/progress/notification.
  const topology = createTopologyTracker();

  // Runtime timeout — abort the agent if it exceeds the max wall-clock limit
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    log.warn('Agent planning timed out', {
      data: { agentId, sessionId, maxRuntimeMs },
    });
    timeoutController.abort();
  }, maxRuntimeMs);

  // Also abort timeout controller if the external signal fires
  const onExternalAbort = () => timeoutController.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  // Publish planning started event
  await sessionService.publish(
    sessionId,
    createSessionEventWithMetadata({
      sessionId,
      type: 'agent:planning',
      partType: 'lifecycle',
      blockId: runId,
      data: { agentId, runId, model, skillId: options.skillId, skillName: options.skillName },
    })
  );

  // Track active tools by toolUseID for correlating with tool_use_summary
  const activeTools = new Map<
    string,
    { toolName: string; startTime: number; skillName?: string }
  >();

  // Accumulate Skill tool calls for AgentRunResult
  const skillCalls: SkillCallRecord[] = [];

  // Track unique file paths modified by Write/Edit/NotebookEdit tools
  const modifiedFiles = new Set<string>();

  // Create canUseTool callback to capture ExitPlanMode options and emit tool:start events.
  // The SDK's tool_use_summary in v0.2.76+ no longer includes tool_name/tool_input,
  // so we intercept via canUseTool which always receives the full input.
  const canUseTool: CanUseTool = async (toolName, input, toolOptions) => {
    const toolEntry: { toolName: string; startTime: number; skillName?: string } = {
      toolName,
      startTime: Date.now(),
    };

    // Enrich Skill tool calls with the invoked skill name for downstream tracking
    if (toolName === 'Skill') {
      const skillInput = input as Record<string, unknown>;
      const invokedSkillName = typeof skillInput.skill === 'string' ? skillInput.skill : undefined;
      if (invokedSkillName) {
        toolEntry.skillName = invokedSkillName;
      } else {
        log.warn('Skill tool invoked but skill name could not be extracted', {
          data: { toolUseID: toolOptions.toolUseID, skillField: skillInput.skill },
        });
      }
    }

    // Capture subagent_type from Agent tool calls for topology grouping
    if (toolName === 'Agent') {
      const agentInput = input as Record<string, unknown>;
      const subagentType =
        typeof agentInput.subagent_type === 'string' ? agentInput.subagent_type : null;
      if (subagentType) {
        topology.pendingSubagentTypes.push(subagentType);
      }
    }

    activeTools.set(toolOptions.toolUseID, toolEntry);

    // Track file-modifying tools for file change metrics
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
      const filePath =
        ((input as Record<string, unknown>).file_path as string | undefined) ??
        ((input as Record<string, unknown>).notebook_path as string | undefined);
      if (filePath) modifiedFiles.add(filePath);
    }

    await sessionService.publish(
      sessionId,
      createMetadataEvent({
        sessionId,
        type: 'tool:start',
        partType: 'tool_start',
        blockId: toolOptions.toolUseID,
        data: {
          agentId,
          toolId: toolOptions.toolUseID,
          tool: toolName,
          input: input as Record<string, unknown>,
          phase: 'planning',
        },
      })
    );

    if (toolName === 'ExitPlanMode') {
      const planOptions = input as ExitPlanModeOptions | undefined;
      exitPlanModeOptions = planOptions;

      log.info('ExitPlanMode captured via canUseTool', { data: { agentId } });
    }
    return { behavior: 'allow' as const, toolUseID: toolOptions.toolUseID };
  };

  // Create Claude Agent SDK session in PLAN mode
  // In plan mode, the agent can read/explore but not execute changes
  // The agent will use ExitPlanMode tool when the plan is ready
  // allowedTools must be passed so interactive tools (ExitPlanMode,
  // AskUserQuestion, WebSearch) are not blocked by the permission layer.
  const session = unstable_v2_createSession({
    model,
    env: buildSdkEnv(),
    allowedTools,
    permissionMode: 'plan', // Planning mode - agent will use ExitPlanMode when done
    executableArgs: ['--add-dir', cwd],
    canUseTool,
  });

  const batcher = createChunkBatcher(sessionId, agentId, 'planning', sessionService);

  try {
    // Send the task prompt - the agent will automatically enter plan mode
    await session.send(prompt);

    // Capture user prompt for memory
    if (options.onMessage) {
      options
        .onMessage({ role: 'user', content: prompt, turn: 0, metadata: { phase: 'planning' } })
        .catch((captureErr) => {
          log.warn('Memory capture failed for user prompt', {
            error: captureErr instanceof Error ? captureErr : new Error(String(captureErr)),
          });
        });
    }

    // Stream the planning response
    for await (const msg of session.stream()) {
      // theme-03 F5: capture SDK session id as soon as it becomes available
      // so it can be persisted in plan options and used to resume on approval.
      if (!capturedSdkSessionId) {
        try {
          const sid = session.sessionId;
          if (typeof sid === 'string' && sid.length > 0) {
            capturedSdkSessionId = sid;
          }
        } catch {
          // sessionId throws until the first message is received — retry on next iteration.
        }
      }

      // Check if abort signal or runtime timeout has been triggered
      if (signal?.aborted || timeoutController.signal.aborted) {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onExternalAbort);
        const isTimeout = !signal?.aborted && timeoutController.signal.aborted;
        const reason = isTimeout ? 'timeout' : 'aborted';
        await batcher.destroy();
        session.close();
        await sessionService.publish(
          sessionId,
          createSessionEventWithMetadata({
            sessionId,
            type: 'agent:stopped',
            partType: 'lifecycle',
            blockId: runId,
            data: {
              agentId,
              runId,
              reason,
              phase: 'planning',
              ...(isTimeout ? { maxRuntimeMs } : {}),
            },
          })
        );
        return {
          runId,
          status: 'paused',
          turnCount: turn,
          result: isTimeout
            ? `Agent planning timed out after ${maxRuntimeMs / 1000}s`
            : 'Agent stopped by user during planning',
          skillCalls: skillCalls.length > 0 ? skillCalls : undefined,
          fileChanges:
            modifiedFiles.size > 0
              ? { filesModified: modifiedFiles.size, linesAdded: null, linesRemoved: null }
              : undefined,
        };
      }

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

          // Use ChunkBatcher: immediate SSE delivery + batched DB persistence
          await batcher.addDelta(event.delta.text);
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

        // Flush batcher before turn boundary event to ensure chunk ordering
        await batcher.flush();

        // Publish turn event for planning phase
        await sessionService.publish(
          sessionId,
          createSessionEventWithMetadata({
            sessionId,
            type: 'agent:turn',
            partType: 'lifecycle',
            blockId: runId,
            data: { agentId, turn, phase: 'planning' },
          })
        );

        // Capture assistant turn for memory
        if (options.onMessage && textContent && textContent.length >= 10) {
          options
            .onMessage({
              role: 'assistant',
              content: textContent,
              turn,
              metadata: { model: options.model, phase: 'planning' },
            })
            .catch((captureErr) => {
              log.warn('Memory capture failed', {
                error: captureErr instanceof Error ? captureErr : new Error(String(captureErr)),
              });
            });
        }

        // Check for SDK-level errors on assistant messages (v0.2.76+)
        const assistantError = (msg as { error?: string }).error;
        if (assistantError) {
          log.warn('Assistant error during planning', { data: { agentId, error: assistantError } });
          sessionService
            .publish(
              sessionId,
              createSessionEventWithMetadata({
                sessionId,
                type: 'agent:error',
                partType: 'lifecycle',
                blockId: runId,
                data: {
                  agentId,
                  runId,
                  error: `Assistant error: ${assistantError}`,
                  phase: 'planning',
                },
              })
            )
            .catch((publishErr) => {
              log.warn('Failed to publish assistant error', {
                error: publishErr,
              });
            });
        }
      }

      // Handle tool_use_summary (SDK v0.2.76+: summary + preceding_tool_use_ids)
      if (msg.type === 'tool_use_summary') {
        const toolSummary = msg as {
          summary: string;
          preceding_tool_use_ids: string[];
          is_error?: boolean;
        };

        const summaryIsError = toolSummary.is_error === true;

        for (const toolUseId of toolSummary.preceding_tool_use_ids) {
          const tracked = activeTools.get(toolUseId);
          if (!tracked) continue;

          await sessionService.publish(
            sessionId,
            createMetadataEvent({
              sessionId,
              type: 'tool:result',
              partType: 'tool_result',
              blockId: toolUseId,
              data: {
                agentId,
                toolId: toolUseId,
                tool: tracked.toolName,
                output: toolSummary.summary?.slice(0, 1000),
                isError: summaryIsError,
                phase: 'planning',
              },
            })
          );

          // Check if this is ExitPlanMode - this means the plan is ready
          if (tracked.toolName === 'ExitPlanMode') {
            planContent = accumulated;
            log.info('ExitPlanMode completed - plan is ready', { data: { agentId } });
          }

          // Accumulate Skill tool calls for metrics
          if (tracked.skillName) {
            skillCalls.push({
              skillName: tracked.skillName,
              durationMs: Date.now() - tracked.startTime,
              isError: summaryIsError,
            });
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
          .publish(
            sessionId,
            createSessionEventWithMetadata({
              sessionId,
              type: 'agent:rate_limit',
              partType: 'system',
              blockId: runId,
              data: {
                agentId,
                status: rateLimitMsg.rate_limit_info.status,
                resetsAt: rateLimitMsg.rate_limit_info.resetsAt,
              },
            })
          )
          .catch((publishErr) => {
            log.warn('Failed to publish rate_limit', { error: publishErr });
          });
      }

      // Handle system messages (compact_boundary + subagent topology) during planning
      if (msg.type === 'system') {
        const sysMsg = msg as Record<string, unknown>;
        const sysSubtype = sysMsg.subtype as string | undefined;

        if (sysSubtype === 'compact_boundary') {
          publishCompactBoundary(sessionService, sessionId, agentId, sysMsg).catch((publishErr) => {
            log.warn('Failed to publish compact_boundary', { error: publishErr });
          });
        }

        // Handle subagent lifecycle events (task_started, task_progress, task_notification)
        // Skills can spawn subagents via the Agent tool during planning
        if (
          sysSubtype === 'task_started' ||
          sysSubtype === 'task_progress' ||
          sysSubtype === 'task_notification'
        ) {
          await handleTopologySystemMessage(sysMsg, topology, sessionService, sessionId, agentId);
        }
      }

      // Handle result (planning session finished)
      if (msg.type === 'result') {
        const result = msg as Record<string, unknown>;

        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onExternalAbort);
        await batcher.destroy();
        session.close(); // Always close first — before any potentially-failing publishes

        publishMetrics(
          sessionService,
          sessionId,
          agentId,
          runId,
          result,
          options.skillId,
          options.skillName
        ).catch((publishErr) => {
          log.error('Failed to publish metrics', { error: publishErr });
        });

        // Publish plan ready event with plan options
        await sessionService.publish(
          sessionId,
          createSessionEventWithMetadata({
            sessionId,
            type: 'agent:plan_ready',
            partType: 'lifecycle',
            blockId: runId,
            data: {
              agentId,
              runId,
              plan: planContent || accumulated,
              allowedPrompts: exitPlanModeOptions?.allowedPrompts,
              sdkSessionId: capturedSdkSessionId,
            },
          })
        );

        return {
          runId,
          status: 'planning',
          turnCount: turn,
          plan: planContent || accumulated,
          planOptions: exitPlanModeOptions,
          sdkSessionId: capturedSdkSessionId,
          metrics: extractResultMetrics(result),
          skillCalls: skillCalls.length > 0 ? skillCalls : undefined,
          fileChanges:
            modifiedFiles.size > 0
              ? { filesModified: modifiedFiles.size, linesAdded: null, linesRemoved: null }
              : undefined,
        };
      }
    }

    // If we exit the loop, planning completed
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onExternalAbort);
    await batcher.destroy();
    session.close();

    await sessionService.publish(
      sessionId,
      createSessionEventWithMetadata({
        sessionId,
        type: 'agent:plan_ready',
        partType: 'lifecycle',
        blockId: runId,
        data: {
          agentId,
          runId,
          plan: planContent || accumulated,
          allowedPrompts: exitPlanModeOptions?.allowedPrompts,
          sdkSessionId: capturedSdkSessionId,
        },
      })
    );

    return {
      runId,
      status: 'planning',
      turnCount: turn,
      plan: planContent || accumulated || 'No plan generated',
      planOptions: exitPlanModeOptions,
      sdkSessionId: capturedSdkSessionId,
      skillCalls: skillCalls.length > 0 ? skillCalls : undefined,
      fileChanges:
        modifiedFiles.size > 0
          ? { filesModified: modifiedFiles.size, linesAdded: null, linesRemoved: null }
          : undefined,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onExternalAbort);
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Agent planning error', { error, data: { agentId } });

    await destroyBatcher(batcher, agentId, sessionId);

    await sessionService.publish(
      sessionId,
      createSessionEventWithMetadata({
        sessionId,
        type: 'agent:error',
        partType: 'lifecycle',
        blockId: runId,
        data: { agentId, runId, error: errorMessage, phase: 'planning' },
      })
    );

    session.close();
    return {
      runId,
      status: 'error',
      turnCount: 0,
      error: errorMessage,
      skillCalls: skillCalls.length > 0 ? skillCalls : undefined,
      fileChanges:
        modifiedFiles.size > 0
          ? { filesModified: modifiedFiles.size, linesAdded: null, linesRemoved: null }
          : undefined,
    };
  }
}

/**
 * Run the agent in execution mode after plan approval.
 */
export async function runAgentExecution(options: StreamHandlerOptions): Promise<AgentRunResult> {
  const {
    agentId,
    sessionId,
    prompt,
    allowedTools,
    maxTurns,
    model,
    cwd,
    sessionService,
    signal,
    skillId,
    skillName,
  } = options;
  const maxRuntimeMs = Math.max(options.maxRuntimeMs ?? DEFAULT_AGENT_MAX_RUNTIME_MS, 60_000); // minimum 1 minute

  const runId = createId();
  let turn = 0;
  let accumulated = '';

  // Runtime timeout — abort the agent if it exceeds the max wall-clock limit
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    log.warn('Agent execution timed out', {
      data: { agentId, sessionId, maxRuntimeMs },
    });
    timeoutController.abort();
  }, maxRuntimeMs);

  // Also abort timeout controller if the external signal fires
  const onExternalAbort = () => timeoutController.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  // Topology tracker for subagent lifecycle events
  const topology = createTopologyTracker();

  // Publish agent started event
  await sessionService.publish(
    sessionId,
    createSessionEventWithMetadata({
      sessionId,
      type: 'agent:started',
      partType: 'lifecycle',
      blockId: runId,
      data: { agentId, runId, maxTurns, model, phase: 'execution', skillId, skillName },
    })
  );

  // Always emit root agent node in topology
  topology.rootEmitted = true;
  await sessionService.publish(
    sessionId,
    createMetadataEvent({
      sessionId,
      type: 'topology:agent_spawned',
      partType: 'lifecycle',
      blockId: agentId,
      data: {
        agentId,
        name: 'Agent',
        role: 'orchestrator',
        parentId: null,
      },
    })
  );

  // Track active tools by toolUseID for correlating with tool_use_summary
  const activeTools = new Map<
    string,
    { toolName: string; startTime: number; skillName?: string }
  >();

  // Accumulate Skill tool calls for AgentRunResult
  const skillCalls: SkillCallRecord[] = [];

  // Track unique file paths modified by Write/Edit/NotebookEdit tools
  const modifiedFiles = new Set<string>();

  const canUseTool: CanUseTool = async (toolName, input, toolOptions) => {
    const toolEntry: { toolName: string; startTime: number; skillName?: string } = {
      toolName,
      startTime: Date.now(),
    };

    // Enrich Skill tool calls with the invoked skill name for downstream tracking
    if (toolName === 'Skill') {
      const skillInput = input as Record<string, unknown>;
      const invokedSkillName = typeof skillInput.skill === 'string' ? skillInput.skill : undefined;
      if (invokedSkillName) {
        toolEntry.skillName = invokedSkillName;
      } else {
        log.warn('Skill tool invoked but skill name could not be extracted', {
          data: { toolUseID: toolOptions.toolUseID, skillField: skillInput.skill },
        });
      }
    }

    // Capture subagent_type from Agent tool calls for topology grouping
    if (toolName === 'Agent') {
      const agentInput = input as Record<string, unknown>;
      const subagentType =
        typeof agentInput.subagent_type === 'string' ? agentInput.subagent_type : null;
      if (subagentType) {
        topology.pendingSubagentTypes.push(subagentType);
      }
    }

    activeTools.set(toolOptions.toolUseID, toolEntry);

    // Track file-modifying tools for file change metrics
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
      const filePath =
        ((input as Record<string, unknown>).file_path as string | undefined) ??
        ((input as Record<string, unknown>).notebook_path as string | undefined);
      if (filePath) modifiedFiles.add(filePath);
    }

    await sessionService.publish(
      sessionId,
      createMetadataEvent({
        sessionId,
        type: 'tool:start',
        partType: 'tool_start',
        blockId: toolOptions.toolUseID,
        data: {
          agentId,
          toolId: toolOptions.toolUseID,
          tool: toolName,
          input: input as Record<string, unknown>,
        },
      })
    );

    return { behavior: 'allow' as const, toolUseID: toolOptions.toolUseID };
  };

  // theme-03 F5: try to resume the planning-phase SDK session when the
  // caller supplied one. Mirrors the agent-runner flow: on resume failure
  // (stale session, SDK error) we fall back to a fresh session with the
  // full plan prompt. The fresh-session branch is the status quo behavior.
  const sdkSessionOptions = {
    model,
    env: buildSdkEnv(),
    allowedTools,
    permissionMode: 'acceptEdits' as const, // Auto-accept edits for execution
    executableArgs: ['--add-dir', cwd],
    canUseTool,
  };

  let session: ReturnType<typeof unstable_v2_createSession>;
  let sessionResumed = false;
  if (options.sdkSessionId) {
    try {
      session = unstable_v2_resumeSession(options.sdkSessionId, sdkSessionOptions);
      sessionResumed = true;
      log.info('SDK session resumed for execution', {
        data: { agentId, sdkSessionId: options.sdkSessionId },
      });
    } catch (resumeErr) {
      const msg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
      log.warn('SDK session resume failed, falling back to fresh session', {
        data: { agentId, sdkSessionId: options.sdkSessionId, error: msg },
      });
      session = unstable_v2_createSession(sdkSessionOptions);
    }
  } else {
    session = unstable_v2_createSession(sdkSessionOptions);
  }
  // Suppress unused-var warning in builds that don't strip it; sessionResumed
  // is retained for possible future telemetry / tests.
  void sessionResumed;

  const batcher = createChunkBatcher(sessionId, agentId, 'execution', sessionService);

  try {
    // Send the execution prompt
    await session.send(prompt);

    // Capture user prompt for memory
    if (options.onMessage) {
      options
        .onMessage({ role: 'user', content: prompt, turn: 0, metadata: { phase: 'execution' } })
        .catch((captureErr) => {
          log.warn('Memory capture failed for user prompt', {
            error: captureErr instanceof Error ? captureErr : new Error(String(captureErr)),
          });
        });
    }

    // Stream responses from the SDK
    for await (const msg of session.stream()) {
      // Check if abort signal or runtime timeout has been triggered
      if (signal?.aborted || timeoutController.signal.aborted) {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onExternalAbort);
        const isTimeout = !signal?.aborted && timeoutController.signal.aborted;
        const reason = isTimeout ? 'timeout' : 'aborted';
        await batcher.destroy();
        session.close();
        await sessionService.publish(
          sessionId,
          createSessionEventWithMetadata({
            sessionId,
            type: 'agent:stopped',
            partType: 'lifecycle',
            blockId: runId,
            data: {
              agentId,
              runId,
              reason,
              phase: 'execution',
              ...(isTimeout ? { maxRuntimeMs } : {}),
            },
          })
        );
        return {
          runId,
          status: 'paused',
          turnCount: turn,
          result: isTimeout
            ? `Agent execution timed out after ${maxRuntimeMs / 1000}s`
            : 'Agent stopped by user during execution',
          skillCalls: skillCalls.length > 0 ? skillCalls : undefined,
          fileChanges:
            modifiedFiles.size > 0
              ? { filesModified: modifiedFiles.size, linesAdded: null, linesRemoved: null }
              : undefined,
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

          // Use ChunkBatcher: immediate SSE delivery + batched DB persistence
          await batcher.addDelta(event.delta.text);
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

        // Flush batcher before turn boundary event to ensure chunk ordering
        await batcher.flush();

        await sessionService.publish(
          sessionId,
          createSessionEventWithMetadata({
            sessionId,
            type: 'agent:turn',
            partType: 'lifecycle',
            blockId: runId,
            data: {
              agentId,
              turn,
              maxTurns,
              remaining: maxTurns - turn,
              usage: message?.usage,
            },
          })
        );

        // Capture assistant turn for memory
        if (options.onMessage && textContent && textContent.length >= 10) {
          options
            .onMessage({
              role: 'assistant',
              content: textContent,
              turn,
              metadata: { model: options.model, phase: 'execution' },
            })
            .catch((captureErr) => {
              log.warn('Memory capture failed', {
                error: captureErr instanceof Error ? captureErr : new Error(String(captureErr)),
              });
            });
        }

        // Check for SDK-level errors on assistant messages (v0.2.76+)
        const assistantError = (msg as { error?: string }).error;
        if (assistantError) {
          log.warn('Assistant error during execution', {
            data: { agentId, error: assistantError },
          });
          sessionService
            .publish(
              sessionId,
              createSessionEventWithMetadata({
                sessionId,
                type: 'agent:error',
                partType: 'lifecycle',
                blockId: runId,
                data: { agentId, runId, error: `Assistant error: ${assistantError}` },
              })
            )
            .catch((publishErr) => {
              log.warn('Failed to publish assistant error', { error: publishErr });
            });
        }

        if (turn >= maxTurns) {
          await batcher.destroy();
          await sessionService.publish(
            sessionId,
            createSessionEventWithMetadata({
              sessionId,
              type: 'agent:turn_limit',
              partType: 'lifecycle',
              blockId: runId,
              data: { agentId, turn, maxTurns },
            })
          );

          session.close();
          return {
            runId,
            status: 'turn_limit',
            turnCount: turn,
            result: `Turn limit reached (${maxTurns}). Task moved to waiting approval.`,
            skillCalls: skillCalls.length > 0 ? skillCalls : undefined,
            fileChanges:
              modifiedFiles.size > 0
                ? { filesModified: modifiedFiles.size, linesAdded: null, linesRemoved: null }
                : undefined,
          };
        }
      }

      // Handle tool_use_summary events (SDK v0.2.76+: summary + preceding_tool_use_ids)
      if (msg.type === 'tool_use_summary') {
        const toolSummary = msg as {
          summary: string;
          preceding_tool_use_ids: string[];
          is_error?: boolean;
        };

        const summaryIsError = toolSummary.is_error === true;

        for (const toolUseId of toolSummary.preceding_tool_use_ids) {
          const tracked = activeTools.get(toolUseId);
          if (!tracked) continue;

          await sessionService.publish(
            sessionId,
            createMetadataEvent({
              sessionId,
              type: 'tool:result',
              partType: 'tool_result',
              blockId: toolUseId,
              data: {
                agentId,
                toolId: toolUseId,
                tool: tracked.toolName,
                output: toolSummary.summary?.slice(0, 1000),
                isError: summaryIsError,
              },
            })
          );

          // Accumulate Skill tool calls for metrics
          if (tracked.skillName) {
            skillCalls.push({
              skillName: tracked.skillName,
              durationMs: Date.now() - tracked.startTime,
              isError: summaryIsError,
            });
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
          .publish(
            sessionId,
            createSessionEventWithMetadata({
              sessionId,
              type: 'agent:rate_limit',
              partType: 'system',
              blockId: runId,
              data: {
                agentId,
                status: rateLimitMsg.rate_limit_info.status,
                resetsAt: rateLimitMsg.rate_limit_info.resetsAt,
              },
            })
          )
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

        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onExternalAbort);
        await batcher.destroy();
        session.close(); // Always close first — before any potentially-failing publishes

        publishMetrics(sessionService, sessionId, agentId, runId, result, skillId, skillName).catch(
          (publishErr) => {
            log.warn('Failed to publish metrics', { error: publishErr });
          }
        );

        const usage =
          result.usage != null && typeof result.usage === 'object'
            ? (result.usage as { input_tokens?: number; output_tokens?: number })
            : undefined;

        // Complete root topology node
        await sessionService.publish(
          sessionId,
          createMetadataEvent({
            sessionId,
            type: 'topology:agent_completed',
            partType: 'lifecycle',
            blockId: agentId,
            data: { agentId, status: 'completed' },
          })
        );

        await sessionService.publish(
          sessionId,
          createSessionEventWithMetadata({
            sessionId,
            type: 'agent:completed',
            partType: 'lifecycle',
            blockId: runId,
            data: { agentId, runId, turnCount: turn, usage, skillId, skillName },
          })
        );

        return {
          runId,
          status: 'completed',
          turnCount: turn,
          result: accumulated || 'Task completed successfully',
          metrics: extractResultMetrics(result),
          skillCalls: skillCalls.length > 0 ? skillCalls : undefined,
          fileChanges:
            modifiedFiles.size > 0
              ? { filesModified: modifiedFiles.size, linesAdded: null, linesRemoved: null }
              : undefined,
        };
      }
    }

    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onExternalAbort);
    await batcher.destroy();
    session.close();

    await sessionService.publish(
      sessionId,
      createSessionEventWithMetadata({
        sessionId,
        type: 'agent:completed',
        partType: 'lifecycle',
        blockId: runId,
        data: { agentId, runId, turnCount: turn, skillId, skillName },
      })
    );

    return {
      runId,
      status: 'completed',
      turnCount: turn,
      result: accumulated || 'Task completed successfully',
      skillCalls: skillCalls.length > 0 ? skillCalls : undefined,
      fileChanges:
        modifiedFiles.size > 0
          ? { filesModified: modifiedFiles.size, linesAdded: null, linesRemoved: null }
          : undefined,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onExternalAbort);
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Agent execution error', { error, data: { agentId } });

    await destroyBatcher(batcher, agentId, sessionId);

    // AE-008: Emit topology:agent_completed with status 'failed' for any tracked subagent nodes
    // that were still in-flight when the error occurred
    for (const [sdkTaskId, nodeId] of topology.taskToNodeId) {
      sessionService
        .publish(
          sessionId,
          createMetadataEvent({
            sessionId,
            type: 'topology:agent_completed',
            partType: 'lifecycle',
            blockId: nodeId,
            data: {
              agentId: nodeId,
              sdkTaskId,
              status: 'failed',
              summary: `Parent agent failed: ${errorMessage}`,
            },
          })
        )
        .catch((publishErr) => {
          log.warn('Failed to publish topology failure for subagent', {
            error: publishErr,
            data: { nodeId, sdkTaskId },
          });
        });
    }
    topology.taskToNodeId.clear();

    // Emit topology:agent_completed for root node
    await sessionService.publish(
      sessionId,
      createMetadataEvent({
        sessionId,
        type: 'topology:agent_completed',
        partType: 'lifecycle',
        blockId: agentId,
        data: { agentId, status: 'failed' },
      })
    );

    await sessionService.publish(
      sessionId,
      createSessionEventWithMetadata({
        sessionId,
        type: 'agent:error',
        partType: 'lifecycle',
        blockId: runId,
        data: { agentId, runId, error: errorMessage },
      })
    );

    session.close();
    return {
      runId,
      status: 'error',
      turnCount: turn,
      error: errorMessage,
      skillCalls: skillCalls.length > 0 ? skillCalls : undefined,
      fileChanges:
        modifiedFiles.size > 0
          ? { filesModified: modifiedFiles.size, linesAdded: null, linesRemoved: null }
          : undefined,
    };
  }
}
