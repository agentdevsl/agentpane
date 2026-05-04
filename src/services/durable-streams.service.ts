import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { sessionEvents } from '../db/schema';
import { getDbDialect } from '../lib/db/dialect.js';
import { type AppError, createError } from '../lib/errors/base.js';
import { createLogger } from '../lib/logging/logger.js';
import {
  requirePayloadStreamMetadata,
  STREAM_PROTOCOL_MIGRATION_GATE,
  type StreamEventMetadata,
  type StreamPartType,
  streamEventMetadataSchema,
} from '../lib/streams/envelope.js';
import {
  classifyStreamId,
  expectedStreamIdKindForEventType,
  type StreamId,
} from '../lib/streams/stream-id.js';
import type {
  ClarifyingQuestion,
  ComposeStage,
  GeneratedFile,
  ModuleMatch,
} from '../lib/terraform/types.js';
import { err, ok, type Result } from '../lib/utils/result.js';
import type { AgentFileChangedData } from '../types/agent-events.js';
import type { Database } from '../types/database.js';
import { enqueueOutboxEvent, enqueueOutboxEventSync } from './event-outbox-relay.service.js';
import { createStreamPayloadWithMetadata } from './session/event-metadata.js';
import type { SessionEvent, SessionEventType } from './session.service.js';

const log = createLogger('DurableStreamsService');

/**
 * Durable Streams server interface for real-time event streaming
 */
export interface DurableStreamsServer {
  createStream: (id: string, schema: unknown) => Promise<void>;
  publish: (id: string, type: string, data: unknown) => Promise<number>;
  subscribe: (
    id: string,
    options?: { fromOffset?: number }
  ) => AsyncIterable<{ type: string; data: unknown; offset: number }>;
  deleteStream?: (id: string) => Promise<boolean>;
}

// ============================================
// Event Data Interfaces
// ============================================

/**
 * Plan mode events
 */
export interface PlanStartedEvent {
  sessionId: string;
  taskId: string;
  codespaceId: string;
}

export interface PlanTurnEvent {
  sessionId: string;
  turnId: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface PlanTokenEvent {
  sessionId: string;
  delta: string;
}

export interface PlanInteractionEvent {
  sessionId: string;
  interactionId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export interface PlanCompletedEvent {
  sessionId: string;
  issueUrl?: string;
  issueNumber?: number;
}

export interface PlanErrorEvent {
  sessionId: string;
  error: string;
  code?: string;
}

/**
 * Sandbox events
 */
export interface SandboxCreatingEvent {
  sandboxId: string;
  codespaceId: string;
  image: string;
}

export interface SandboxReadyEvent {
  sandboxId: string;
  codespaceId: string;
  containerId: string;
}

export interface SandboxIdleEvent {
  sandboxId: string;
  codespaceId: string;
  idleSince: number;
  timeoutMinutes: number;
}

export interface SandboxStoppingEvent {
  sandboxId: string;
  codespaceId: string;
  reason: 'idle_timeout' | 'manual' | 'error';
}

export interface SandboxStoppedEvent {
  sandboxId: string;
  codespaceId: string;
}

export interface SandboxErrorEvent {
  sandboxId: string;
  codespaceId: string;
  error: string;
  code?: string;
}

export interface SandboxTmuxCreatedEvent {
  sandboxId: string;
  sessionName: string;
  taskId?: string;
}

export interface SandboxTmuxDestroyedEvent {
  sandboxId: string;
  sessionName: string;
}

/**
 * Container agent events - emitted from agent-runner inside Docker containers
 */
export interface ContainerAgentStartedEvent {
  taskId: string;
  sessionId: string;
  model: string;
  maxTurns: number;
  sandboxProvider?: string;
  sandboxContainerId?: string;
}

export interface ContainerAgentTokenEvent {
  taskId: string;
  sessionId: string;
  delta: string;
}

export interface ContainerAgentTurnEvent {
  taskId: string;
  sessionId: string;
  turn: number;
  maxTurns: number;
  remaining: number;
}

export interface ContainerAgentToolStartEvent {
  taskId: string;
  sessionId: string;
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
}

export interface ContainerAgentToolResultEvent {
  taskId: string;
  sessionId: string;
  toolName: string;
  toolId: string;
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface ContainerAgentMessageEvent {
  taskId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ContainerAgentCompleteEvent {
  taskId: string;
  sessionId: string;
  status: 'completed' | 'turn_limit' | 'cancelled';
  turnCount: number;
  result?: string;
}

export interface ContainerAgentErrorEvent {
  taskId: string;
  sessionId: string;
  error: string;
  code?: string;
  turnCount: number;
}

export interface ContainerAgentCancelledEvent {
  taskId: string;
  sessionId: string;
  turnCount: number;
}

export interface ContainerAgentPlanReadyEvent {
  taskId: string;
  sessionId: string;
  plan: string;
  turnCount: number;
  sdkSessionId: string;
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
}

export interface ContainerAgentTaskUpdateFailedEvent {
  taskId: string;
  sessionId: string;
  error: string;
  attemptedStatus: string;
}

export interface ContainerAgentStatusEvent {
  taskId: string;
  sessionId: string;
  stage:
    | 'initializing'
    | 'validating'
    | 'credentials'
    | 'injecting_skills'
    | 'creating_sandbox'
    | 'executing'
    | 'running';
  message: string;
}

export interface ContainerAgentFileChangedEvent extends AgentFileChangedData {
  taskId: string;
  sessionId: string;
}

/**
 * Task creation events
 */
export interface TaskCreationStartedEvent {
  sessionId: string;
  codespaceId: string;
}

export interface TaskCreationMessageEvent {
  sessionId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface TaskCreationTokenEvent {
  sessionId: string;
  delta: string;
}

export interface TaskCreationSuggestionEvent {
  sessionId: string;
  suggestion: {
    title: string;
    description: string;
    labels: string[];
    priority: 'high' | 'medium' | 'low';
  };
}

export interface TaskCreationQuestionsEvent {
  sessionId: string;
  questions: {
    id: string;
    questions: Array<{
      header: string;
      question: string;
      options: Array<{ label: string; description?: string }>;
    }>;
    round: number;
    totalAsked: number;
    maxQuestions: number;
  };
}

export interface TaskCreationCompletedEvent {
  sessionId: string;
  taskId: string;
  suggestion: {
    title: string;
    description: string;
    labels: string[];
    priority: 'high' | 'medium' | 'low';
  };
}

export interface TaskCreationCancelledEvent {
  sessionId: string;
}

export interface TaskCreationErrorEvent {
  sessionId: string;
  error: string;
  code?: string;
}

export interface TaskCreationProcessingEvent {
  sessionId: string;
  message?: string;
}

export interface ContainerAgentWorktreeEvent {
  taskId: string;
  sessionId: string;
  worktreeId: string;
  branch: string;
  containerPath: string;
}

/**
 * Terraform compose events
 */
export interface TerraformStatusEvent {
  jobId: string;
  stage: ComposeStage;
  message?: string;
}

export interface TerraformTextEvent {
  jobId: string;
  delta: string;
}

export interface TerraformModulesEvent {
  jobId: string;
  modules: ModuleMatch[];
}

export interface TerraformQuestionsEvent {
  jobId: string;
  questions: ClarifyingQuestion[];
}

export interface TerraformCodeEvent {
  jobId: string;
  code: string;
  files?: GeneratedFile[];
}

export interface TerraformDoneEvent {
  jobId: string;
  generatedCode?: string;
  matchedModules?: ModuleMatch[];
  validationResult?: unknown;
  generatedFiles?: GeneratedFile[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface TerraformErrorEvent {
  jobId: string;
  error: string;
  code?: string;
}

// ============================================
// Topology events
// ============================================

export interface TopologyAgentSpawnedEvent {
  agentId: string;
  taskId?: string;
  name: string;
  role: string;
  agentType?: string;
  parentId: string | null;
  sdkTaskId?: string;
}

export interface TopologyAgentProgressEvent {
  agentId: string;
  sdkTaskId: string;
  tokens: number;
  toolUses: number;
  durationMs: number;
  summary?: string;
  lastToolName?: string;
}

export interface TopologyAgentCompletedEvent {
  agentId: string;
  sdkTaskId?: string;
  status: 'completed' | 'failed' | 'stopped';
  summary?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

// ============================================
// Type-safe Event Map
// ============================================

/**
 * Maps event type strings to their corresponding data types.
 * This single source of truth enables type-safe publishing without
 * requiring individual helper methods for each event type.
 *
 * RS-005: Event naming convention -- colon-delimited hierarchical format:
 *   `category:action`  (e.g. 'plan:started', 'sandbox:ready')
 * Sub-categories add another colon level:
 *   `category:subcategory:action`  (e.g. 'container-agent:tool:start')
 * The category prefix maps to a storage channel in getChannelForType().
 */
export interface StreamEventMap {
  // Plan events
  'plan:started': PlanStartedEvent;
  'plan:turn': PlanTurnEvent;
  'plan:token': PlanTokenEvent;
  'plan:interaction': PlanInteractionEvent;
  'plan:completed': PlanCompletedEvent;
  'plan:error': PlanErrorEvent;
  'plan:cancelled': { sessionId: string };

  // Sandbox events
  'sandbox:creating': SandboxCreatingEvent;
  'sandbox:ready': SandboxReadyEvent;
  'sandbox:idle': SandboxIdleEvent;
  'sandbox:stopping': SandboxStoppingEvent;
  'sandbox:stopped': SandboxStoppedEvent;
  'sandbox:error': SandboxErrorEvent;
  'sandbox:tmux:created': SandboxTmuxCreatedEvent;
  'sandbox:tmux:destroyed': SandboxTmuxDestroyedEvent;

  // Task creation events
  'task-creation:started': TaskCreationStartedEvent;
  'task-creation:message': TaskCreationMessageEvent;
  'task-creation:token': TaskCreationTokenEvent;
  'task-creation:suggestion': TaskCreationSuggestionEvent;
  'task-creation:questions': TaskCreationQuestionsEvent;
  'task-creation:processing': TaskCreationProcessingEvent;
  'task-creation:completed': TaskCreationCompletedEvent;
  'task-creation:cancelled': TaskCreationCancelledEvent;
  'task-creation:error': TaskCreationErrorEvent;

  // Container agent events
  'container-agent:status': ContainerAgentStatusEvent;
  'container-agent:started': ContainerAgentStartedEvent;
  'container-agent:token': ContainerAgentTokenEvent;
  'container-agent:turn': ContainerAgentTurnEvent;
  'container-agent:tool:start': ContainerAgentToolStartEvent;
  'container-agent:tool:result': ContainerAgentToolResultEvent;
  'container-agent:message': ContainerAgentMessageEvent;
  'container-agent:complete': ContainerAgentCompleteEvent;
  'container-agent:error': ContainerAgentErrorEvent;
  'container-agent:cancelled': ContainerAgentCancelledEvent;
  'container-agent:task-update-failed': ContainerAgentTaskUpdateFailedEvent;
  'container-agent:plan_ready': ContainerAgentPlanReadyEvent;
  'container-agent:worktree': ContainerAgentWorktreeEvent;
  'container-agent:file_changed': ContainerAgentFileChangedEvent;

  // Topology events
  'topology:agent_spawned': TopologyAgentSpawnedEvent;
  'topology:agent_progress': TopologyAgentProgressEvent;
  'topology:agent_completed': TopologyAgentCompletedEvent;

  // Terraform compose events
  'terraform:status': TerraformStatusEvent;
  'terraform:text': TerraformTextEvent;
  'terraform:modules': TerraformModulesEvent;
  'terraform:questions': TerraformQuestionsEvent;
  'terraform:code': TerraformCodeEvent;
  'terraform:done': TerraformDoneEvent;
  'terraform:error': TerraformErrorEvent;
}

/**
 * All typed event types derived from the event map
 */
export type TypedEventType = keyof StreamEventMap;

/**
 * Combined event type for all stream events (includes session events)
 */
export type StreamEventType = SessionEventType | TypedEventType;

/**
 * Generic stream event
 */
export interface StreamEvent<T = unknown> {
  id: string;
  type: StreamEventType;
  timestamp: number;
  data: T;
  offset?: number;
}

/**
 * DurableStreamsService provides a centralized interface for real-time event streaming.
 *
 * Events are persisted to the database and published to the CaddyDurableStreamsServer
 * (which forwards to Caddy/DurableStreamTestServer). Clients subscribe directly to
 * Caddy streams via SSE — no in-process subscriber mechanism is needed.
 */
/**
 * Result of a publish that may signal backpressure to the caller.
 * F05-13: When the p95 publish latency over the recent window exceeds the
 * threshold, `signalPause` is set so the agent code can throttle.
 */
export interface PublishResultMeta {
  offset: number;
  /** True if recent publish latency exceeded the backpressure threshold. */
  signalPause?: boolean;
}

export class DurableStreamsService {
  /** F05-13: rolling window of recent publish durations (ms) for backpressure. */
  private readonly publishLagWindow: Array<{ ts: number; ms: number }> = [];
  private readonly PUBLISH_LAG_WINDOW_MS = 30_000;
  private readonly PUBLISH_LAG_MAX_SAMPLES = 500;
  private readonly PUBLISH_LAG_P95_PAUSE_THRESHOLD_MS = 500;

  constructor(
    private server: DurableStreamsServer,
    private db?: Database
  ) {}

  /** F05-13: snapshot the current publish-lag metrics for the admin endpoint. */
  getPublishLagMetrics(): {
    sampleCount: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    signalPause: boolean;
  } {
    const now = Date.now();
    this.pruneLagWindow(now);
    if (this.publishLagWindow.length === 0) {
      return { sampleCount: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, signalPause: false };
    }
    const sorted = [...this.publishLagWindow].sort((a, b) => a.ms - b.ms);
    const p50 = sorted[Math.floor(sorted.length * 0.5)]?.ms ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]?.ms ?? 0;
    const max = sorted[sorted.length - 1]?.ms ?? 0;
    return {
      sampleCount: this.publishLagWindow.length,
      p50Ms: p50,
      p95Ms: p95,
      maxMs: max,
      signalPause: p95 > this.PUBLISH_LAG_P95_PAUSE_THRESHOLD_MS,
    };
  }

  private pruneLagWindow(now: number): void {
    const cutoff = now - this.PUBLISH_LAG_WINDOW_MS;
    while (this.publishLagWindow.length > 0 && (this.publishLagWindow[0]?.ts ?? 0) < cutoff) {
      this.publishLagWindow.shift();
    }
    // Hard cap on in-memory samples as a safety net.
    while (this.publishLagWindow.length > this.PUBLISH_LAG_MAX_SAMPLES) {
      this.publishLagWindow.shift();
    }
  }

  private recordLagSample(ms: number): void {
    const now = Date.now();
    this.publishLagWindow.push({ ts: now, ms });
    this.pruneLagWindow(now);
  }

  /**
   * F05-01 / F05-20: validate that a raw stream-ID string matches the expected
   * kind for the event type. Returns an AppError on mismatch, null on success.
   * Callers (publish, publishSessionEvent) MUST treat the AppError as a hard
   * reject so the runtime invariant is binding.
   */
  private validateStreamIdKind(streamId: string, type: string): AppError | null {
    const expected = expectedStreamIdKindForEventType(type);
    const actual = classifyStreamId(streamId);
    if (actual !== expected) {
      return this.createProtocolMismatchError(
        type,
        'STREAM_ID_KIND_MISMATCH',
        `Stream event '${type}' requires a ${expected} stream ID but '${streamId}' is classified as '${actual ?? 'unknown'}'.`
      );
    }
    return null;
  }

  private createProtocolMismatchError(type: string, reason: string, message: string): AppError {
    return createError('STREAM_PROTOCOL_MISMATCH', message, 409, {
      gate: STREAM_PROTOCOL_MIGRATION_GATE,
      type,
      reason,
    });
  }

  /**
   * Map event type to channel for database storage.
   * Channels group related events (e.g., all container-agent events go to 'containerAgent').
   */
  private getChannelForType(type: TypedEventType): string {
    // Map event types to their channels
    if (type.startsWith('plan:')) return 'plan';
    if (type.startsWith('sandbox:')) return 'sandbox';
    if (type.startsWith('task-creation:')) return 'taskCreation';
    if (type.startsWith('container-agent:')) return 'containerAgent';
    if (type.startsWith('topology:')) return 'topology';
    if (type.startsWith('terraform:')) return 'terraform';
    return 'default';
  }

  /**
   * Create a new stream for a session or plan
   */
  async createStream(id: string, schema: unknown): Promise<Result<void, AppError>> {
    if (!id || typeof id !== 'string' || id.trim() === '') {
      return err(
        createError(
          'STREAM_VALIDATION',
          '[DurableStreamsService] createStream: streamId is required and must be a non-empty string',
          400
        )
      );
    }

    try {
      await this.server.createStream(id, schema);
      return ok(undefined);
    } catch (error) {
      return err(
        createError(
          'STREAM_CREATE_FAILED',
          `[DurableStreamsService] Failed to create stream '${id}': ${error instanceof Error ? error.message : String(error)}`,
          500
        )
      );
    }
  }

  /**
   * Delete a stream and clean up resources
   */
  async deleteStream(id: string): Promise<void> {
    // Call server.deleteStream if available
    if ('deleteStream' in this.server && this.server.deleteStream) {
      await this.server.deleteStream(id);
    }
  }

  /**
   * Persist an event to the database with retry on offset collision.
   * Returns the assigned offset.
   */
  private async persistToDb(
    db: Pick<Database, 'insert'>,
    streamId: string,
    eventId: string,
    type: string,
    channel: string,
    data: unknown,
    timestamp: number
  ): Promise<number> {
    // F05-25: derive the stream-kind discriminator from the streamId prefix at
    // publish time so cleanup paths and admin queries can filter rows without
    // re-parsing the prefix at runtime.
    const streamKind = classifyStreamId(streamId) ?? 'session';

    // QW-2: Atomic offset computation — single INSERT with subquery eliminates
    // the read-then-write retry loop and reduces contention from O(retries) to O(1).
    // Retry up to 3 times on unique constraint violations (concurrent inserts).
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await db
          .insert(sessionEvents)
          .values({
            id: attempt === 0 ? eventId : `${eventId}-r${attempt}`,
            sessionId: streamId,
            streamKind,
            offset: sql`(SELECT COALESCE(MAX(${sessionEvents.offset}), -1) + 1 FROM ${sessionEvents} WHERE ${sessionEvents.sessionId} = ${streamId})`,
            type,
            channel,
            data,
            timestamp,
          })
          .returning({ offset: sessionEvents.offset });

        const offset = result[0]?.offset;
        if (offset === undefined) {
          throw new Error(`Failed to persist event ${eventId}: insert returned no row`);
        }
        return offset;
      } catch (insertErr) {
        const isConstraintViolation =
          insertErr instanceof Error &&
          (insertErr.message.includes('UNIQUE constraint') ||
            insertErr.message.includes('duplicate key'));
        if (isConstraintViolation && attempt < MAX_RETRIES - 1) {
          continue;
        }
        throw insertErr;
      }
    }
    throw new Error(`Failed to persist event ${eventId} after ${MAX_RETRIES} attempts`);
  }

  private persistToDbSync(
    db: Pick<Database, 'insert'>,
    streamId: string,
    eventId: string,
    type: string,
    channel: string,
    data: unknown,
    timestamp: number
  ): number {
    const streamKind = classifyStreamId(streamId) ?? 'session';
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = db
          .insert(sessionEvents)
          .values({
            id: attempt === 0 ? eventId : `${eventId}-r${attempt}`,
            sessionId: streamId,
            streamKind,
            offset: sql`(SELECT COALESCE(MAX(${sessionEvents.offset}), -1) + 1 FROM ${sessionEvents} WHERE ${sessionEvents.sessionId} = ${streamId})`,
            type,
            channel,
            data,
            timestamp,
          })
          .returning({ offset: sessionEvents.offset })
          .all() as Array<{ offset: number }>;

        const offset = result[0]?.offset;
        if (offset === undefined) {
          throw new Error(`Failed to persist event ${eventId}: insert returned no row`);
        }
        return offset;
      } catch (insertErr) {
        const isConstraintViolation =
          insertErr instanceof Error &&
          (insertErr.message.includes('UNIQUE constraint') ||
            insertErr.message.includes('duplicate key'));
        if (isConstraintViolation && attempt < MAX_RETRIES - 1) {
          continue;
        }
        throw insertErr;
      }
    }
    throw new Error(`Failed to persist event ${eventId} after ${MAX_RETRIES} attempts`);
  }

  /**
   * Persist durable replay state and enqueue live delivery in one DB transaction.
   * This keeps the outbox row inseparable from the `session_events` row that
   * produced it, so a crash cannot leave a replayable event that current
   * subscribers will never receive.
   */
  private async persistToDbAndOutbox(
    streamId: string,
    eventId: string,
    type: string,
    channel: string,
    payload: unknown,
    timestamp: number
  ): Promise<number> {
    if (!this.db) return 0;

    if (getDbDialect() === 'sqlite') {
      return this.db.transaction((tx) => {
        const offset = this.persistToDbSync(
          tx as Pick<Database, 'insert'>,
          streamId,
          eventId,
          type,
          channel,
          payload,
          timestamp
        );
        enqueueOutboxEventSync(tx as Pick<Database, 'insert'>, {
          streamId,
          type,
          payload,
        });
        return offset;
      });
    }

    return this.db.transaction(async (tx) => {
      const offset = await this.persistToDb(
        tx as Pick<Database, 'insert'>,
        streamId,
        eventId,
        type,
        channel,
        payload,
        timestamp
      );
      await enqueueOutboxEvent(tx as Pick<Database, 'insert'>, {
        streamId,
        type,
        payload,
      });
      return offset;
    });
  }

  /**
   * Type-safe publish for mapped event types.
   * Ensures the data type matches the event type at compile time.
   *
   * Events are persisted to the database FIRST, then published to the Caddy streams server.
   * This ensures events are durable and available after page refresh or server restart.
   *
   * @example
   * // TypeScript enforces correct data shape:
   * await streams.publish(streamId, 'plan:started', { sessionId, taskId, codespaceId });
   * await streams.publish(streamId, 'sandbox:ready', { sandboxId, codespaceId, containerId });
   */
  async publish<T extends TypedEventType>(
    streamId: StreamId | string,
    type: T,
    data: StreamEventMap[T]
  ): Promise<Result<number, AppError>> {
    if (!streamId || typeof streamId !== 'string' || streamId.trim() === '') {
      return err(
        createError(
          'STREAM_VALIDATION',
          '[DurableStreamsService] publish: streamId is required and must be a non-empty string',
          400
        )
      );
    }

    // F05-20: hard-reject stream-ID kind mismatches. The previous warn-only
    // path silently allowed plan-typed events on session stream IDs (and
    // vice-versa), violating the documented invariant. Returning the AppError
    // forces producers either to (a) use the correct prefix, or (b) migrate to
    // the branded factory functions in `lib/streams/stream-id.ts`.
    const kindMismatch = this.validateStreamIdKind(streamId, type);
    if (kindMismatch) {
      log.warn('Stream ID kind mismatch — rejected (F05-20)', {
        data: { streamId, type, reason: kindMismatch.message },
      });
      return err(kindMismatch);
    }

    const startedAt = Date.now();
    try {
      const timestamp = startedAt;
      const payload = this.ensurePayloadMetadata(streamId, type, data, timestamp);
      const metadataResult = requirePayloadStreamMetadata(payload, `Stream event '${type}'`);
      if (!metadataResult.ok) {
        return err(
          this.createProtocolMismatchError(
            type,
            metadataResult.error.code,
            metadataResult.error.message
          )
        );
      }
      const payloadMeta = this.extractPayloadMeta(payload);
      if (payloadMeta && payloadMeta.streamId !== streamId) {
        return err(
          this.createProtocolMismatchError(
            type,
            'CONFLICTING_METADATA',
            `Stream event '${type}' targets stream '${payloadMeta.streamId}' but was published to '${streamId}'.`
          )
        );
      }
      const eventId = payloadMeta?.eventId ?? createId();

      // Terraform compose streams are ephemeral (single request-response, stream
      // deleted after each turn). All other streams (session, plan, sandbox,
      // task-creation, container-agent) are durable and persisted to the DB.
      const isEphemeral = streamId.startsWith('terraform:');

      let offset = 0;
      if (!isEphemeral) {
        // Persist durable replay state and enqueue live delivery atomically.
        offset = await this.persistToDbAndOutbox(
          streamId,
          eventId,
          type,
          this.getChannelForType(type),
          payload as unknown,
          timestamp
        );
      }

      // F05-19: enqueue durable streams via the outbox so the relay
      // (`EventOutboxRelayService`) handles delivery + retries. The previous
      // best-effort dual-write swallowed Caddy failures at log.debug; now a
      // failed Caddy publish stays in `event_outbox` until the relay drains
      // it, restoring at-least-once delivery for non-ephemeral streams.
      // Ephemeral streams (terraform:*) have no DB fallback so they remain
      // on the direct-publish path.
      let memoryOffset = 0;
      if (isEphemeral) {
        try {
          memoryOffset = await this.server.publish(streamId, type, payload);
        } catch (caddyErr) {
          // Ephemeral streams have no DB fallback — surface the error so callers
          // can decide how to handle it (e.g., throw for terminal events, swallow for status).
          return err(
            createError(
              'STREAM_PUBLISH_FAILED',
              caddyErr instanceof Error ? caddyErr.message : String(caddyErr),
              500
            )
          );
        }
      } else if (!this.db) {
        // No db (legacy in-memory mode): fall back to direct publish.
        try {
          memoryOffset = await this.server.publish(streamId, type, payload);
        } catch (caddyErr) {
          log.debug('Caddy publish failed (no DB, no outbox)', {
            error: caddyErr instanceof Error ? caddyErr.message : String(caddyErr),
          });
        }
      }

      // F05-13: record publish lag for backpressure metrics.
      this.recordLagSample(Date.now() - startedAt);

      return ok(!isEphemeral && this.db ? offset : memoryOffset);
    } catch (error) {
      this.recordLagSample(Date.now() - startedAt);
      return err(
        createError(
          'STREAM_PUBLISH_FAILED',
          `[DurableStreamsService] Failed to publish event '${type}' to stream '${streamId}': ${error instanceof Error ? error.message : String(error)}`,
          500
        )
      );
    }
  }

  /**
   * F05-13: publish with backpressure metadata.
   * Returns the offset and a `signalPause` flag that callers may use to throttle.
   */
  async publishWithBackpressure<T extends TypedEventType>(
    streamId: StreamId | string,
    type: T,
    data: StreamEventMap[T]
  ): Promise<Result<PublishResultMeta, AppError>> {
    const result = await this.publish(streamId, type, data);
    if (!result.ok) return result;
    const metrics = this.getPublishLagMetrics();
    return ok({ offset: result.value, signalPause: metrics.signalPause });
  }

  private extractPayloadMeta(data: unknown): StreamEventMetadata | null {
    if (!data || typeof data !== 'object' || !('meta' in data)) {
      return null;
    }

    const parsed = streamEventMetadataSchema.safeParse(data.meta);
    return parsed.success ? parsed.data : null;
  }

  private ensurePayloadMetadata<T extends TypedEventType>(
    streamId: string,
    type: T,
    data: StreamEventMap[T],
    timestamp: number
  ): StreamEventMap[T] {
    if (!this.isMetadataEligiblePayload(data) || this.extractPayloadMeta(data)) {
      return data;
    }

    return createStreamPayloadWithMetadata({
      streamId,
      partType: this.derivePartType(type, data),
      blockId: this.deriveBlockId(data),
      data,
      timestamp,
    }) as StreamEventMap[T];
  }

  private isMetadataEligiblePayload(data: unknown): data is Record<string, unknown> {
    return data !== null && typeof data === 'object' && !Array.isArray(data);
  }

  private derivePartType(type: TypedEventType, data: Record<string, unknown>): StreamPartType {
    if (type.endsWith(':token') || type === 'terraform:text') {
      return 'chunk_delta';
    }

    if (
      type === 'task-creation:message' ||
      type === 'container-agent:message' ||
      type === 'plan:turn'
    ) {
      return 'chunk_end';
    }

    if (type.includes(':tool:start')) {
      return 'tool_start';
    }

    if (type.includes(':tool:result')) {
      return data.isError === true ? 'tool_error' : 'tool_result';
    }

    if (type === 'container-agent:file_changed' || type === 'terraform:code') {
      return 'diff';
    }

    if (
      type.startsWith('topology:') ||
      type.startsWith('sandbox:') ||
      type.endsWith(':started') ||
      type.endsWith(':completed') ||
      type.endsWith(':complete') ||
      type.endsWith(':cancelled') ||
      type.endsWith(':error') ||
      type.endsWith(':plan_ready')
    ) {
      return 'lifecycle';
    }

    return 'system';
  }

  private deriveBlockId(data: Record<string, unknown>): string | null {
    const directKeys = [
      'toolId',
      'messageId',
      'turnId',
      'interactionId',
      'worktreeId',
      'sandboxId',
      'sessionName',
      'jobId',
      'agentId',
      'taskId',
    ] as const;

    for (const key of directKeys) {
      const value = data[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }

    if (typeof data.path === 'string' && data.path.length > 0) {
      return data.path;
    }

    if (
      'questions' in data &&
      data.questions &&
      typeof data.questions === 'object' &&
      'id' in data.questions &&
      typeof data.questions.id === 'string'
    ) {
      return data.questions.id;
    }

    return null;
  }

  // ============================================
  // Compatibility helpers (plan + task creation)
  // ============================================

  async publishPlanStarted(streamId: string, data: PlanStartedEvent): Promise<void> {
    await this.publish(streamId, 'plan:started', data);
  }

  async publishPlanTurn(streamId: string, data: PlanTurnEvent): Promise<void> {
    await this.publish(streamId, 'plan:turn', data);
  }

  async publishPlanToken(streamId: string, data: PlanTokenEvent): Promise<void> {
    await this.publish(streamId, 'plan:token', data);
  }

  async publishPlanInteraction(streamId: string, data: PlanInteractionEvent): Promise<void> {
    await this.publish(streamId, 'plan:interaction', data);
  }

  async publishPlanCompleted(streamId: string, data: PlanCompletedEvent): Promise<void> {
    await this.publish(streamId, 'plan:completed', data);
  }

  async publishPlanError(streamId: string, data: PlanErrorEvent): Promise<void> {
    await this.publish(streamId, 'plan:error', data);
  }

  async publishPlanCancelled(streamId: string, data: { sessionId: string }): Promise<void> {
    await this.publish(streamId, 'plan:cancelled', data);
  }

  async publishTaskCreationStarted(
    streamId: string,
    data: TaskCreationStartedEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:started', data);
  }

  async publishTaskCreationMessage(
    streamId: string,
    data: TaskCreationMessageEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:message', data);
  }

  async publishTaskCreationToken(streamId: string, data: TaskCreationTokenEvent): Promise<void> {
    await this.publish(streamId, 'task-creation:token', data);
  }

  async publishTaskCreationSuggestion(
    streamId: string,
    data: TaskCreationSuggestionEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:suggestion', data);
  }

  async publishTaskCreationQuestions(
    streamId: string,
    data: TaskCreationQuestionsEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:questions', data);
  }

  async publishTaskCreationCompleted(
    streamId: string,
    data: TaskCreationCompletedEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:completed', data);
  }

  async publishTaskCreationCancelled(
    streamId: string,
    data: TaskCreationCancelledEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:cancelled', data);
  }

  async publishTaskCreationError(streamId: string, data: TaskCreationErrorEvent): Promise<void> {
    await this.publish(streamId, 'task-creation:error', data);
  }

  async publishTaskCreationProcessing(
    streamId: string,
    data: TaskCreationProcessingEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:processing', data);
  }

  /**
   * Publish a session event (uses SessionEvent's own type/data structure).
   * Persists to database if available, then publishes to Caddy streams.
   */
  async publishSessionEvent(
    streamId: string,
    event: SessionEvent
  ): Promise<Result<void, AppError>> {
    if (!streamId || typeof streamId !== 'string' || streamId.trim() === '') {
      return err(
        createError(
          'STREAMS_VALIDATION',
          'publishSessionEvent: streamId is required and must be a non-empty string',
          400
        )
      );
    }

    // F05-20: hard-reject stream-ID kind mismatches on publishSessionEvent
    // too. Previously this path skipped kind validation entirely, so
    // session-typed events published to plan/sandbox stream IDs leaked
    // silently. Calling validateStreamIdKind keeps the invariant binding
    // across both publish entry points.
    const kindMismatch = this.validateStreamIdKind(streamId, event.type);
    if (kindMismatch) {
      log.warn('Session event stream ID kind mismatch — rejected (F05-20)', {
        data: { streamId, type: event.type, reason: kindMismatch.message },
      });
      return err(kindMismatch);
    }

    try {
      const timestamp = event.timestamp || Date.now();
      const metadataResult = requirePayloadStreamMetadata(
        event.data,
        `Session event '${event.type}'`
      );
      if (!metadataResult.ok) {
        return err(
          this.createProtocolMismatchError(
            event.type,
            metadataResult.error.code,
            metadataResult.error.message
          )
        );
      }

      if (metadataResult.value.streamId !== streamId) {
        return err(
          this.createProtocolMismatchError(
            event.type,
            'CONFLICTING_METADATA',
            `Session event '${event.type}' targets stream '${metadataResult.value.streamId}' but was published to '${streamId}'.`
          )
        );
      }

      if (this.db) {
        await this.persistToDbAndOutbox(
          streamId,
          event.id || createId(),
          event.type,
          'session',
          event.data as unknown,
          timestamp
        );
      }

      if (!this.db) {
        try {
          await this.server.publish(streamId, event.type, event.data);
        } catch (caddyErr) {
          log.debug('Caddy publish failed for session event', {
            error: caddyErr instanceof Error ? caddyErr.message : String(caddyErr),
          });
        }
      }

      return ok(undefined);
    } catch (error) {
      return err(
        createError(
          'STREAMS_PUBLISH',
          `Failed to publish session event '${event.type}' to stream '${streamId}': ${error instanceof Error ? error.message : String(error)}`,
          500
        )
      );
    }
  }
}
