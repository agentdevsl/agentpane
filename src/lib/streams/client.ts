/**
 * Durable Streams Client
 *
 * Client-side wrapper for durable streams with:
 * - Automatic reconnection via @durable-streams/client
 * - Offset-based resume for missed events
 * - Typed event callbacks
 *
 * @module lib/streams/client
 */

import type { StreamResponse } from '@durable-streams/client';
import { stream as durableStream } from '@durable-streams/client';
import { z } from 'zod';
import type {
  SessionAgentState,
  SessionChunk,
  SessionPresence,
  SessionTerminal,
  SessionToolCall,
} from '../../app/hooks/use-session';
import {
  cursorToApproxOffset,
  getPayloadStreamMetadata,
  normalizeStructuredStreamWireEvent,
  type StreamEventMetadata,
} from './envelope';

// Re-export types for convenience
export type {
  SessionAgentState,
  SessionChunk,
  SessionPresence,
  SessionTerminal,
  SessionToolCall,
  StreamEventMetadata,
};

export type StreamCursor = string;

/**
 * Zod schemas for validating raw event data from server
 * These are partial schemas since some fields come from the event envelope
 */
export const rawChunkDataSchema = z.object({
  text: z.string().default(''),
  agentId: z.string().optional(),
  meta: z.unknown().optional(),
});

export const rawToolCallDataSchema = z.object({
  id: z.string().min(1).optional(),
  tool: z.string().default('unknown'),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  meta: z.unknown().optional(),
});

export const rawPresenceDataSchema = z.object({
  userId: z.string().min(1),
  cursor: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .optional(),
});

const rawTerminalDataSchema = z.object({
  data: z.string().default(''),
  meta: z.unknown().optional(),
});

function extractPayloadMeta(data: unknown): StreamEventMetadata | undefined {
  return getPayloadStreamMetadata(data) ?? undefined;
}

export function parseStreamChunkItems(text: string): unknown[] | null {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmedText);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // DurableStreamTestServer catch-up can concatenate multiple JSON payloads
    // into a single text chunk, e.g. `[...][]`. Parse them sequentially.
  }

  const items: unknown[] = [];
  let index = 0;

  while (index < trimmedText.length) {
    while (index < trimmedText.length && /\s/u.test(trimmedText[index] ?? '')) {
      index++;
    }

    if (index >= trimmedText.length) {
      break;
    }

    const firstCharacter = trimmedText[index];
    if (firstCharacter !== '[' && firstCharacter !== '{') {
      return null;
    }

    let depth = 0;
    let endIndex = -1;
    let inString = false;
    let isEscaped = false;

    for (let cursor = index; cursor < trimmedText.length; cursor++) {
      const character = trimmedText[cursor];
      if (!character) {
        continue;
      }

      if (inString) {
        if (isEscaped) {
          isEscaped = false;
          continue;
        }

        if (character === '\\') {
          isEscaped = true;
          continue;
        }

        if (character === '"') {
          inString = false;
        }

        continue;
      }

      if (character === '"') {
        inString = true;
        continue;
      }

      if (character === '[' || character === '{') {
        depth++;
        continue;
      }

      if (character === ']' || character === '}') {
        depth--;
        if (depth === 0) {
          endIndex = cursor + 1;
          break;
        }
      }
    }

    if (endIndex === -1) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmedText.slice(index, endIndex));
      if (Array.isArray(parsed)) {
        items.push(...parsed);
      } else {
        items.push(parsed);
      }
    } catch {
      return null;
    }

    index = endIndex;
  }

  return items;
}

const rawAgentStateDataSchema = z.object({
  agentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  status: z.enum(['idle', 'starting', 'running', 'paused', 'error', 'completed']).optional(),
  taskId: z.string().optional(),
  turn: z.number().optional(),
  progress: z.number().optional(),
  currentTool: z.string().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Container agent event schemas
 */
const rawContainerAgentStartedSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  model: z.string(),
  maxTurns: z.number(),
  sandboxProvider: z.string().optional(),
  sandboxContainerId: z.string().optional(),
});

const rawContainerAgentTokenSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  delta: z.string(),
});

const rawContainerAgentTurnSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  turn: z.number(),
  maxTurns: z.number(),
  remaining: z.number(),
});

const rawContainerAgentToolStartSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  toolId: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const rawContainerAgentToolResultSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  toolId: z.string(),
  result: z.string(),
  isError: z.boolean(),
  durationMs: z.number(),
});

const rawContainerAgentMessageSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

export const rawContainerAgentCompleteSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  status: z.enum(['completed', 'turn_limit', 'cancelled']),
  turnCount: z.number(),
  result: z.string().optional(),
});

export const rawContainerAgentErrorSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  error: z.string(),
  code: z.string().optional(),
  turnCount: z.number(),
});

const rawContainerAgentCancelledSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  turnCount: z.number(),
});

const rawContainerAgentPlanReadySchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  plan: z.string().min(1),
  turnCount: z.number().optional(),
  sdkSessionId: z.string().optional(),
});

export const rawContainerAgentStatusSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  stage: z.enum([
    'initializing',
    'validating',
    'credentials',
    'injecting_skills',
    'creating_sandbox',
    'executing',
    'running',
  ]),
  message: z.string(),
});

const rawContainerAgentWorktreeSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  worktreeId: z.string(),
  branch: z.string(),
  containerPath: z.string(),
});

const rawContainerAgentFileChangedSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  path: z.string(),
  action: z.enum(['create', 'modify', 'delete']),
  toolName: z.string(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
});

/**
 * Topology event schemas
 */
export const rawTopologyAgentSpawnedSchema = z.object({
  agentId: z.string(),
  taskId: z.string().optional(),
  name: z.string(),
  role: z.string(),
  agentType: z.string().optional(),
  parentId: z.string().nullable(),
  sdkTaskId: z.string().optional(),
});

const rawTopologyAgentProgressSchema = z.object({
  agentId: z.string(),
  sdkTaskId: z.string(),
  tokens: z.number(),
  toolUses: z.number(),
  durationMs: z.number(),
  summary: z.string().optional(),
  lastToolName: z.string().optional(),
});

export const rawTopologyAgentCompletedSchema = z.object({
  agentId: z.string(),
  sdkTaskId: z.string().optional(),
  status: z.enum(['completed', 'failed', 'stopped']),
  summary: z.string().optional(),
  tokens: z.number().optional(),
  toolUses: z.number().optional(),
  durationMs: z.number().optional(),
});

/**
 * Fatal error codes that should not be retried
 */
const FATAL_ERROR_CODES = [
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'BAD_REQUEST',
  'ALREADY_CONSUMED',
  'ALREADY_CLOSED',
] as const;

/**
 * Reconnection configuration
 */
export interface ReconnectConfig {
  /** Whether reconnection is enabled */
  enabled: boolean;
  /** Initial delay in ms before first reconnect attempt */
  initialDelay: number;
  /** Maximum delay in ms between reconnect attempts */
  maxDelay: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
}

/**
 * Default reconnection configuration
 */
export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  enabled: true,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
};

/**
 * Maximum number of reconnection attempts on clean stream closure
 * before giving up and staying disconnected.
 */
const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * Session event types from the server
 */
export type SessionEventType =
  // Control events
  | 'connected'
  // Content events
  | 'chunk'
  | 'tool:start'
  | 'tool:result'
  | 'presence:joined'
  | 'presence:left'
  | 'presence:cursor'
  | 'terminal:input'
  | 'terminal:output'
  | 'state:update'
  // Container agent events
  | 'container-agent:status'
  | 'container-agent:started'
  | 'container-agent:token'
  | 'container-agent:turn'
  | 'container-agent:tool:start'
  | 'container-agent:tool:result'
  | 'container-agent:message'
  | 'container-agent:complete'
  | 'container-agent:error'
  | 'container-agent:cancelled'
  | 'container-agent:plan_ready'
  | 'container-agent:worktree'
  | 'container-agent:file_changed'
  // Topology events
  | 'topology:agent_spawned'
  | 'topology:agent_progress'
  | 'topology:agent_completed';

/**
 * Raw event from the server
 */
export interface RawSessionEvent {
  type: SessionEventType;
  data: unknown;
  timestamp: number;
  offset?: number;
  cursor?: StreamCursor;
  meta?: StreamEventMetadata;
}

type TypedSessionEventMetadata = {
  offset?: number;
  cursor?: StreamCursor;
  meta?: StreamEventMetadata;
};

function getStableToolCallId(raw: RawSessionEvent, payloadId?: string): string {
  if (payloadId && payloadId.length > 0) {
    return payloadId;
  }

  if (raw.meta?.blockId) {
    return raw.meta.blockId;
  }

  if (raw.meta?.eventId) {
    return raw.meta.eventId;
  }

  if (raw.cursor) {
    return raw.cursor;
  }

  return `tool:${raw.type}:${raw.timestamp}`;
}

/**
 * Container agent event types
 */
export interface ContainerAgentStatus {
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
  timestamp: number;
}

export interface ContainerAgentStarted {
  taskId: string;
  sessionId: string;
  model: string;
  maxTurns: number;
  sandboxProvider?: string;
  sandboxContainerId?: string;
  timestamp: number;
}

export interface ContainerAgentToken {
  taskId: string;
  sessionId: string;
  delta: string;
  timestamp: number;
}

export interface ContainerAgentTurn {
  taskId: string;
  sessionId: string;
  turn: number;
  maxTurns: number;
  remaining: number;
  timestamp: number;
}

export interface ContainerAgentToolStart {
  taskId: string;
  sessionId: string;
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  timestamp: number;
}

export interface ContainerAgentToolResult {
  taskId: string;
  sessionId: string;
  toolName: string;
  toolId: string;
  result: string;
  isError: boolean;
  durationMs: number;
  timestamp: number;
}

export interface ContainerAgentMessage {
  taskId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ContainerAgentComplete {
  taskId: string;
  sessionId: string;
  status: 'completed' | 'turn_limit' | 'cancelled';
  turnCount: number;
  result?: string;
  timestamp: number;
}

export interface ContainerAgentError {
  taskId: string;
  sessionId: string;
  error: string;
  code?: string;
  turnCount: number;
  timestamp: number;
}

export interface ContainerAgentCancelled {
  taskId: string;
  sessionId: string;
  turnCount: number;
  timestamp: number;
}

export interface ContainerAgentPlanReady {
  taskId: string;
  sessionId: string;
  plan: string;
  turnCount?: number;
  sdkSessionId?: string;
  timestamp: number;
}

export interface ContainerAgentWorktree {
  taskId: string;
  sessionId: string;
  worktreeId: string;
  branch: string;
  containerPath: string;
  timestamp: number;
}

export interface ContainerAgentFileChanged {
  taskId: string;
  sessionId: string;
  path: string;
  action: 'create' | 'modify' | 'delete';
  toolName: string;
  additions?: number;
  deletions?: number;
  timestamp: number;
}

/**
 * Topology event types
 */
export interface TopologyAgentSpawned {
  agentId: string;
  taskId?: string;
  name: string;
  role: string;
  /** Real SDK agent type (subagent_type / task_type) passed through from the stream handler */
  agentType?: string | null;
  parentId: string | null;
  sdkTaskId?: string;
  timestamp: number;
}

export interface TopologyAgentProgress {
  agentId: string;
  sdkTaskId: string;
  tokens: number;
  toolUses: number;
  durationMs: number;
  summary?: string;
  lastToolName?: string;
  timestamp: number;
}

export interface TopologyAgentCompleted {
  agentId: string;
  sdkTaskId?: string;
  status: 'completed' | 'failed' | 'stopped';
  summary?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  timestamp: number;
}

/**
 * Typed session event for callback routing
 */
export type TypedSessionEvent =
  | ({ channel: 'chunks'; data: SessionChunk } & TypedSessionEventMetadata)
  | ({ channel: 'toolCalls'; data: SessionToolCall } & TypedSessionEventMetadata)
  | ({ channel: 'presence'; data: SessionPresence } & TypedSessionEventMetadata)
  | ({ channel: 'terminal'; data: SessionTerminal } & TypedSessionEventMetadata)
  | ({ channel: 'agentState'; data: SessionAgentState } & TypedSessionEventMetadata)
  | ({ channel: 'containerAgent:status'; data: ContainerAgentStatus } & TypedSessionEventMetadata)
  | ({ channel: 'containerAgent:started'; data: ContainerAgentStarted } & TypedSessionEventMetadata)
  | ({ channel: 'containerAgent:token'; data: ContainerAgentToken } & TypedSessionEventMetadata)
  | ({ channel: 'containerAgent:turn'; data: ContainerAgentTurn } & TypedSessionEventMetadata)
  | ({
      channel: 'containerAgent:toolStart';
      data: ContainerAgentToolStart;
    } & TypedSessionEventMetadata)
  | ({
      channel: 'containerAgent:toolResult';
      data: ContainerAgentToolResult;
    } & TypedSessionEventMetadata)
  | ({ channel: 'containerAgent:message'; data: ContainerAgentMessage } & TypedSessionEventMetadata)
  | ({
      channel: 'containerAgent:complete';
      data: ContainerAgentComplete;
    } & TypedSessionEventMetadata)
  | ({ channel: 'containerAgent:error'; data: ContainerAgentError } & TypedSessionEventMetadata)
  | ({
      channel: 'containerAgent:cancelled';
      data: ContainerAgentCancelled;
    } & TypedSessionEventMetadata)
  | ({
      channel: 'containerAgent:planReady';
      data: ContainerAgentPlanReady;
    } & TypedSessionEventMetadata)
  | ({
      channel: 'containerAgent:worktree';
      data: ContainerAgentWorktree;
    } & TypedSessionEventMetadata)
  | ({
      channel: 'containerAgent:fileChanged';
      data: ContainerAgentFileChanged;
    } & TypedSessionEventMetadata)
  | ({ channel: 'topology:agentSpawned'; data: TopologyAgentSpawned } & TypedSessionEventMetadata)
  | ({ channel: 'topology:agentProgress'; data: TopologyAgentProgress } & TypedSessionEventMetadata)
  | ({
      channel: 'topology:agentCompleted';
      data: TopologyAgentCompleted;
    } & TypedSessionEventMetadata);

export type ChunkSessionEvent = Extract<TypedSessionEvent, { channel: 'chunks' }>;
export type ToolCallSessionEvent = Extract<TypedSessionEvent, { channel: 'toolCalls' }>;
export type PresenceSessionEvent = Extract<TypedSessionEvent, { channel: 'presence' }>;
export type TerminalSessionEvent = Extract<TypedSessionEvent, { channel: 'terminal' }>;
export type AgentStateSessionEvent = Extract<TypedSessionEvent, { channel: 'agentState' }>;
export type ContainerAgentStatusSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:status' }
>;
export type ContainerAgentStartedSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:started' }
>;
export type ContainerAgentTokenSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:token' }
>;
export type ContainerAgentTurnSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:turn' }
>;
export type ContainerAgentToolStartSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:toolStart' }
>;
export type ContainerAgentToolResultSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:toolResult' }
>;
export type ContainerAgentMessageSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:message' }
>;
export type ContainerAgentCompleteSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:complete' }
>;
export type ContainerAgentErrorSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:error' }
>;
export type ContainerAgentCancelledSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:cancelled' }
>;
export type ContainerAgentPlanReadySessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:planReady' }
>;
export type ContainerAgentWorktreeSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:worktree' }
>;
export type ContainerAgentFileChangedSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'containerAgent:fileChanged' }
>;
export type TopologyAgentSpawnedSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'topology:agentSpawned' }
>;
export type TopologyAgentProgressSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'topology:agentProgress' }
>;
export type TopologyAgentCompletedSessionEvent = Extract<
  TypedSessionEvent,
  { channel: 'topology:agentCompleted' }
>;

/**
 * Callbacks for session subscription
 */
export interface SessionCallbacks {
  onChunk?: (event: ChunkSessionEvent) => void;
  onToolCall?: (event: ToolCallSessionEvent) => void;
  onPresence?: (event: PresenceSessionEvent) => void;
  onTerminal?: (event: TerminalSessionEvent) => void;
  onAgentState?: (event: AgentStateSessionEvent) => void;
  // Container agent callbacks
  onContainerAgentStatus?: (event: ContainerAgentStatusSessionEvent) => void;
  onContainerAgentStarted?: (event: ContainerAgentStartedSessionEvent) => void;
  onContainerAgentToken?: (event: ContainerAgentTokenSessionEvent) => void;
  onContainerAgentTurn?: (event: ContainerAgentTurnSessionEvent) => void;
  onContainerAgentToolStart?: (event: ContainerAgentToolStartSessionEvent) => void;
  onContainerAgentToolResult?: (event: ContainerAgentToolResultSessionEvent) => void;
  onContainerAgentMessage?: (event: ContainerAgentMessageSessionEvent) => void;
  onContainerAgentComplete?: (event: ContainerAgentCompleteSessionEvent) => void;
  onContainerAgentError?: (event: ContainerAgentErrorSessionEvent) => void;
  onContainerAgentCancelled?: (event: ContainerAgentCancelledSessionEvent) => void;
  onContainerAgentPlanReady?: (event: ContainerAgentPlanReadySessionEvent) => void;
  onContainerAgentWorktree?: (event: ContainerAgentWorktreeSessionEvent) => void;
  onContainerAgentFileChanged?: (event: ContainerAgentFileChangedSessionEvent) => void;
  // Topology callbacks
  onTopologyAgentSpawned?: (event: TopologyAgentSpawnedSessionEvent) => void;
  onTopologyAgentProgress?: (event: TopologyAgentProgressSessionEvent) => void;
  onTopologyAgentCompleted?: (event: TopologyAgentCompletedSessionEvent) => void;
  onError?: (error: Error) => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onReconnect?: () => void;
  onDisconnect?: () => void;
}

/**
 * Connection state
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Subscription handle returned by subscribe functions
 */
export interface Subscription {
  /** Unsubscribe and close the connection */
  unsubscribe: () => void;
  /** Get current connection state */
  getState: () => ConnectionState;
  /** Get the last received opaque cursor for resume */
  getLastCursor: () => StreamCursor | null;
  /** Get the last received offset for resume */
  getLastOffset: () => number;
}

/**
 * Durable Streams Client
 *
 * Uses @durable-streams/client for automatic SSE reconnection and offset tracking.
 */
export class DurableStreamsClient {
  private streamsBaseUrl: string;

  constructor(options: { url: string }) {
    // In the new architecture, the base URL points to the streams endpoint
    this.streamsBaseUrl = options.url;
  }

  /**
   * Subscribe to a session's event stream via @durable-streams/client
   */
  subscribeToSession(sessionId: string, callbacks: SessionCallbacks): Subscription {
    let state: ConnectionState = 'disconnected';
    let lastCursor: StreamCursor | null = null;
    let unsubscribeFn: (() => void) | null = null;
    let responseCancelFn: (() => void) | null = null;
    let isUnsubscribed = false;
    let hasConnected = false;
    let reconnectCount = 0;
    let reconnectTimerId: ReturnType<typeof setTimeout> | null = null;

    const setConnectionState = (nextState: ConnectionState) => {
      if (state === nextState) {
        return;
      }

      state = nextState;
      callbacks.onConnectionStateChange?.(nextState);
    };

    const markConnected = () => {
      const previousState = state;
      hasConnected = true;
      setConnectionState('connected');

      if (previousState === 'reconnecting') {
        callbacks.onReconnect?.();
      }
    };

    const connect = async () => {
      if (isUnsubscribed) return;

      if (!streamsAvailable) {
        setConnectionState('disconnected');
        callbacks.onError?.(new Error('Streams endpoint not available'));
        return;
      }
      setConnectionState(hasConnected ? 'reconnecting' : 'connecting');

      try {
        // Build absolute URL — durableStream() requires a full URL for SSE
        const base =
          typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
        const url = `${base}${this.streamsBaseUrl}/${sessionId}`;
        const response: StreamResponse = await durableStream({
          url,
          live: 'sse',
          offset: lastCursor ?? '-1',
          onError: (error) => {
            const normalizedError = error instanceof Error ? error : new Error(String(error));

            if (!isUnsubscribed) {
              callbacks.onError?.(normalizedError);
            }

            // Fatal errors should not be retried — except NOT_FOUND before
            // first connection, which means the stream hasn't been created yet
            // (server hasn't published the first event). Allow retries so the
            // client can pick up the stream once the agent starts producing output.
            const errorStr = String(error);
            const isNotFound = errorStr.includes('NOT_FOUND') || errorStr.includes('404');
            const isFatal =
              FATAL_ERROR_CODES.some((code) => errorStr.includes(code)) &&
              !(isNotFound && !hasConnected);
            if (isFatal) {
              setConnectionState('disconnected');
              return; // Return void to stop retrying
            }

            setConnectionState(hasConnected ? 'reconnecting' : 'connecting');
            return {}; // Return empty object to signal retry
          },
        });

        if (isUnsubscribed) {
          response.cancel();
          return;
        }

        responseCancelFn = () => response.cancel();
        markConnected();

        // Subscribe to text chunks and parse JSON manually.
        // Using subscribeText instead of subscribeJson avoids the `json: true`
        // requirement which causes parse errors with DurableStreamTestServer's
        // catch-up response format (JSON array vs NDJSON).
        unsubscribeFn = response.subscribeText((chunk) => {
          if (state !== 'connected') {
            markConnected();
          }

          // Update offset from chunk metadata
          if (chunk.offset) {
            lastCursor = chunk.offset;
          }

          const items = parseStreamChunkItems(chunk.text);
          if (!items) {
            return;
          }

          for (const item of items) {
            try {
              const wireEventResult = normalizeStructuredStreamWireEvent(item);
              if (!wireEventResult.ok) {
                callbacks.onError?.(new Error(wireEventResult.error.message));
                continue;
              }
              const wireEvent = wireEventResult.value;

              const rawEvent: RawSessionEvent = {
                type: wireEvent.type as SessionEventType,
                data: wireEvent.data,
                timestamp: wireEvent.timestamp ?? Date.now(),
                offset: cursorToApproxOffset(lastCursor),
                cursor: lastCursor ?? undefined,
                meta: wireEvent.meta ?? extractPayloadMeta(wireEvent.data),
              };

              const typedEvent = mapRawEventToTyped(rawEvent);
              if (typedEvent) {
                routeEventToCallback(typedEvent, callbacks);
              }
            } catch (error) {
              callbacks.onError?.(
                error instanceof Error ? error : new Error('Failed to process event')
              );
            }
          }
        });

        // Monitor for stream closure
        response.closed
          .then(() => {
            if (isUnsubscribed) return;
            setConnectionState('disconnected');
            callbacks.onDisconnect?.();
            // Auto-reconnect on clean closure (server restart, proxy timeout)
            // unless the stream was explicitly closed or we've been unsubscribed
            if (!response.streamClosed && reconnectCount < MAX_RECONNECT_ATTEMPTS) {
              const delay = Math.min(2000 * 2 ** reconnectCount, 30000);
              reconnectCount++;
              reconnectTimerId = setTimeout(() => {
                if (!isUnsubscribed) void connect();
              }, delay);
            }
          })
          .catch((err) => {
            if (!isUnsubscribed) {
              callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
            }
          });
      } catch (error) {
        if (!isUnsubscribed) {
          const normalizedError =
            error instanceof Error ? error : new Error('Failed to connect to stream');
          callbacks.onError?.(normalizedError);

          // Check if error is fatal before retrying — includes URL/TypeError to prevent infinite loops
          const errorStr = String(error);
          const isFatal =
            FATAL_ERROR_CODES.some((code) => errorStr.includes(code)) || error instanceof TypeError;
          setConnectionState(
            isFatal ? 'disconnected' : hasConnected ? 'reconnecting' : 'connecting'
          );
        }
      }
    };

    const unsubscribe = () => {
      isUnsubscribed = true;
      state = 'disconnected';
      if (reconnectTimerId !== null) {
        clearTimeout(reconnectTimerId);
        reconnectTimerId = null;
      }
      if (unsubscribeFn) {
        unsubscribeFn();
        unsubscribeFn = null;
      }
      if (responseCancelFn) {
        responseCancelFn();
        responseCancelFn = null;
      }
    };
    connect().catch((err) => {
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    return {
      unsubscribe,
      getState: () => state,
      getLastCursor: () => lastCursor,
      getLastOffset: () => {
        return cursorToApproxOffset(lastCursor) ?? 0;
      },
    };
  }

  /**
   * Subscribe to agent-specific events
   */
  subscribeToAgent(
    agentId: string,
    callbacks: {
      onState: (event: { channel: 'agentState'; data: SessionAgentState }) => void;
      onStep: (event: TypedSessionEvent) => void;
      onError?: (error: Error) => void;
      onConnectionStateChange?: (state: ConnectionState) => void;
      onReconnect?: () => void;
    }
  ): Subscription {
    // Agent subscriptions use the same infrastructure but filter by agent
    return this.subscribeToSession(`agent:${agentId}`, {
      onAgentState: callbacks.onState,
      onChunk: callbacks.onStep,
      onToolCall: callbacks.onStep,
      onTerminal: callbacks.onStep,
      onError: callbacks.onError,
      onConnectionStateChange: callbacks.onConnectionStateChange,
      onReconnect: callbacks.onReconnect,
    });
  }
}

/**
 * Map raw server event to typed channel event with Zod validation
 */
function mapRawEventToTyped(raw: RawSessionEvent): TypedSessionEvent | null {
  switch (raw.type) {
    // Control events - not routed to callbacks
    case 'connected':
      // Handshake event from server, no action needed
      return null;

    case 'chunk': {
      const parsed = rawChunkDataSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'chunks',
        data: {
          text: parsed.data.text,
          timestamp: raw.timestamp,
          agentId: parsed.data.agentId,
        },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'tool:start': {
      const parsed = rawToolCallDataSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'toolCalls',
        data: {
          id: getStableToolCallId(raw, parsed.data.id),
          tool: parsed.data.tool,
          input: parsed.data.input,
          status: 'running',
          timestamp: raw.timestamp,
        },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'tool:result': {
      const parsed = rawToolCallDataSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'toolCalls',
        data: {
          id: getStableToolCallId(raw, parsed.data.id),
          tool: parsed.data.tool,
          input: parsed.data.input,
          output: parsed.data.output,
          status: 'complete',
          timestamp: raw.timestamp,
        },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'presence:joined':
    case 'presence:left':
    case 'presence:cursor': {
      const parsed = rawPresenceDataSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'presence',
        data: {
          userId: parsed.data.userId,
          lastSeen: raw.timestamp,
          cursor: parsed.data.cursor,
        },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'terminal:input':
    case 'terminal:output': {
      const parsed = rawTerminalDataSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'terminal',
        data: {
          type: raw.type === 'terminal:input' ? 'input' : 'output',
          data: parsed.data.data,
          timestamp: raw.timestamp,
        },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'state:update': {
      const parsed = rawAgentStateDataSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'agentState',
        data: parsed.data as SessionAgentState,
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    // Container agent events
    case 'container-agent:status': {
      const parsed = rawContainerAgentStatusSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:status',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:started': {
      const parsed = rawContainerAgentStartedSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:started',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:token': {
      const parsed = rawContainerAgentTokenSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:token',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:turn': {
      const parsed = rawContainerAgentTurnSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:turn',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:tool:start': {
      const parsed = rawContainerAgentToolStartSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:toolStart',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:tool:result': {
      const parsed = rawContainerAgentToolResultSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:toolResult',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:message': {
      const parsed = rawContainerAgentMessageSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:message',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:complete': {
      const parsed = rawContainerAgentCompleteSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:complete',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:error': {
      const parsed = rawContainerAgentErrorSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:error',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:cancelled': {
      const parsed = rawContainerAgentCancelledSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:cancelled',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:plan_ready': {
      const parsed = rawContainerAgentPlanReadySchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:planReady',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:worktree': {
      const parsed = rawContainerAgentWorktreeSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:worktree',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'container-agent:file_changed': {
      const parsed = rawContainerAgentFileChangedSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'containerAgent:fileChanged',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    // Topology events
    case 'topology:agent_spawned': {
      const parsed = rawTopologyAgentSpawnedSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'topology:agentSpawned',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'topology:agent_progress': {
      const parsed = rawTopologyAgentProgressSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'topology:agentProgress',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    case 'topology:agent_completed': {
      const parsed = rawTopologyAgentCompletedSchema.safeParse(raw.data);
      if (!parsed.success) {
        return null;
      }
      return {
        channel: 'topology:agentCompleted',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
        cursor: raw.cursor,
        meta: raw.meta,
      };
    }

    default:
      return null;
  }
}

/**
 * Route typed event to appropriate callback
 */
function routeEventToCallback(event: TypedSessionEvent, callbacks: SessionCallbacks): void {
  switch (event.channel) {
    case 'chunks':
      callbacks.onChunk?.(event);
      break;
    case 'toolCalls':
      callbacks.onToolCall?.(event);
      break;
    case 'presence':
      callbacks.onPresence?.(event);
      break;
    case 'terminal':
      callbacks.onTerminal?.(event);
      break;
    case 'agentState':
      callbacks.onAgentState?.(event);
      break;
    // Container agent events
    case 'containerAgent:status':
      callbacks.onContainerAgentStatus?.(event);
      break;
    case 'containerAgent:started':
      callbacks.onContainerAgentStarted?.(event);
      break;
    case 'containerAgent:token':
      callbacks.onContainerAgentToken?.(event);
      break;
    case 'containerAgent:turn':
      callbacks.onContainerAgentTurn?.(event);
      break;
    case 'containerAgent:toolStart':
      callbacks.onContainerAgentToolStart?.(event);
      break;
    case 'containerAgent:toolResult':
      callbacks.onContainerAgentToolResult?.(event);
      break;
    case 'containerAgent:message':
      callbacks.onContainerAgentMessage?.(event);
      break;
    case 'containerAgent:complete':
      callbacks.onContainerAgentComplete?.(event);
      break;
    case 'containerAgent:error':
      callbacks.onContainerAgentError?.(event);
      break;
    case 'containerAgent:cancelled':
      callbacks.onContainerAgentCancelled?.(event);
      break;
    case 'containerAgent:planReady':
      callbacks.onContainerAgentPlanReady?.(event);
      break;
    case 'containerAgent:worktree':
      callbacks.onContainerAgentWorktree?.(event);
      break;
    case 'containerAgent:fileChanged':
      callbacks.onContainerAgentFileChanged?.(event);
      break;
    // Topology events
    case 'topology:agentSpawned':
      callbacks.onTopologyAgentSpawned?.(event);
      break;
    case 'topology:agentProgress':
      callbacks.onTopologyAgentProgress?.(event);
      break;
    case 'topology:agentCompleted':
      callbacks.onTopologyAgentCompleted?.(event);
      break;
  }
}

/**
 * Streams availability flag — set by bootstrap, checked before connecting.
 * When false (e.g. Caddy not running in dev), subscriptions are skipped
 * to avoid exhausting the browser's HTTP/1.1 connection limit with retries.
 */
let streamsAvailable = false;

export function setStreamsAvailable(available: boolean): void {
  streamsAvailable = available;
}

export function isStreamsAvailable(): boolean {
  return streamsAvailable;
}

// Create singleton client instance
let clientInstance: DurableStreamsClient | null = null;

/**
 * Get or create the durable streams client
 */
export function getDurableStreamsClient(): DurableStreamsClient {
  if (!clientInstance) {
    clientInstance = new DurableStreamsClient({
      url: '/v1/stream/sessions', // Durable streams endpoint
    });
  }
  return clientInstance;
}

/**
 * Shared subscription manager — multiplexes multiple subscribers over a single
 * SSE connection per session to avoid exhausting the HTTP/1.1 6-connection limit.
 */
interface SharedEntry {
  /** The single underlying SSE subscription */
  subscription: Subscription;
  /** All active callback sets for this session */
  subscribers: Map<number, SessionCallbacks>;
  /** Auto-incrementing subscriber ID */
  nextId: number;
}

const sharedSubscriptions = new Map<string, SharedEntry>();

/**
 * RS-010: Periodic audit interval for subscription map cleanup.
 * Runs every 60 seconds to detect and remove orphaned entries where
 * all subscribers have been removed but the entry persists in the map.
 */
const SUBSCRIPTION_AUDIT_INTERVAL_MS = 60_000;
let subscriptionAuditTimer: ReturnType<typeof setInterval> | null = null;

function ensureSubscriptionAudit(): void {
  if (subscriptionAuditTimer) return;
  subscriptionAuditTimer = setInterval(() => {
    for (const [sessionId, entry] of sharedSubscriptions) {
      if (entry.subscribers.size === 0) {
        entry.subscription.unsubscribe();
        sharedSubscriptions.delete(sessionId);
      }
    }
    // Stop auditing if no subscriptions remain
    if (sharedSubscriptions.size === 0 && subscriptionAuditTimer) {
      clearInterval(subscriptionAuditTimer);
      subscriptionAuditTimer = null;
    }
  }, SUBSCRIPTION_AUDIT_INTERVAL_MS);
}

/**
 * Subscribe to a session's event stream, sharing the underlying SSE connection
 * with other subscribers for the same sessionId.
 */
export function subscribeToSession(sessionId: string, callbacks: SessionCallbacks): Subscription {
  let entry = sharedSubscriptions.get(sessionId);

  if (!entry) {
    const subscriberMap = new Map<number, SessionCallbacks>();

    // Fan-out callbacks: route each event to all registered subscribers
    const fanOutCallbacks: SessionCallbacks = {};
    const callbackKeys: Array<keyof SessionCallbacks> = [
      'onChunk',
      'onToolCall',
      'onPresence',
      'onTerminal',
      'onAgentState',
      'onContainerAgentStatus',
      'onContainerAgentStarted',
      'onContainerAgentToken',
      'onContainerAgentTurn',
      'onContainerAgentToolStart',
      'onContainerAgentToolResult',
      'onContainerAgentMessage',
      'onContainerAgentComplete',
      'onContainerAgentError',
      'onContainerAgentCancelled',
      'onContainerAgentPlanReady',
      'onContainerAgentWorktree',
      'onContainerAgentFileChanged',
      'onTopologyAgentSpawned',
      'onTopologyAgentProgress',
      'onTopologyAgentCompleted',
      'onError',
      'onConnectionStateChange',
      'onReconnect',
      'onDisconnect',
    ];

    for (const key of callbackKeys) {
      // Type-safe fan-out: route each event to all registered subscribers.
      // We use a type assertion here because the callback keys are dynamically
      // iterated and TypeScript cannot narrow the union per-iteration.
      const fanOutKey = key as keyof SessionCallbacks;
      (fanOutCallbacks as Record<string, (...args: unknown[]) => void>)[fanOutKey] = (
        ...args: unknown[]
      ) => {
        for (const sub of subscriberMap.values()) {
          const handler = sub[fanOutKey];
          if (typeof handler === 'function') {
            (handler as (...a: unknown[]) => void)(...args);
          }
        }
      };
    }

    const subscription = getDurableStreamsClient().subscribeToSession(sessionId, fanOutCallbacks);

    entry = { subscription, subscribers: subscriberMap, nextId: 0 };
    sharedSubscriptions.set(sessionId, entry);
    // RS-010: Start periodic audit to catch orphaned subscriptions
    ensureSubscriptionAudit();
  }

  // Register this subscriber
  const subscriberId = entry.nextId++;
  entry.subscribers.set(subscriberId, callbacks);
  callbacks.onConnectionStateChange?.(entry.subscription.getState());

  const currentEntry = entry;

  return {
    unsubscribe: () => {
      currentEntry.subscribers.delete(subscriberId);
      // If no more subscribers, tear down the actual SSE connection
      if (currentEntry.subscribers.size === 0) {
        currentEntry.subscription.unsubscribe();
        sharedSubscriptions.delete(sessionId);
      }
    },
    getState: () => currentEntry.subscription.getState(),
    getLastCursor: () => currentEntry.subscription.getLastCursor(),
    getLastOffset: () => currentEntry.subscription.getLastOffset(),
  };
}

/**
 * Convenience function to subscribe to an agent
 */
export function subscribeToAgent(
  agentId: string,
  callbacks: {
    onState: (event: { channel: 'agentState'; data: SessionAgentState }) => void;
    onStep: (event: TypedSessionEvent) => void;
    onError?: (error: Error) => void;
    onConnectionStateChange?: (state: ConnectionState) => void;
    onReconnect?: () => void;
  }
): Subscription {
  return getDurableStreamsClient().subscribeToAgent(agentId, callbacks);
}
