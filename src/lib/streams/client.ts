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

// Re-export types for convenience
export type { SessionChunk, SessionToolCall, SessionPresence, SessionTerminal, SessionAgentState };

/**
 * Zod schemas for validating raw event data from server
 * These are partial schemas since some fields come from the event envelope
 */
const rawChunkDataSchema = z.object({
  text: z.string().default(''),
  agentId: z.string().optional(),
});

const rawToolCallDataSchema = z.object({
  id: z.string().min(1).optional(),
  tool: z.string().default('unknown'),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
});

const rawPresenceDataSchema = z.object({
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
});

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
  accumulated: z.string(),
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

const rawContainerAgentCompleteSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  status: z.enum(['completed', 'turn_limit', 'cancelled']),
  turnCount: z.number(),
  result: z.string().optional(),
});

const rawContainerAgentErrorSchema = z.object({
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

const rawContainerAgentStatusSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  stage: z.enum([
    'initializing',
    'validating',
    'credentials',
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
  | 'container-agent:file_changed';

/**
 * Raw event from the server
 */
export interface RawSessionEvent {
  type: SessionEventType;
  data: unknown;
  timestamp: number;
  offset?: number;
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
  accumulated: string;
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
 * Typed session event for callback routing
 */
export type TypedSessionEvent =
  | { channel: 'chunks'; data: SessionChunk; offset?: number }
  | { channel: 'toolCalls'; data: SessionToolCall; offset?: number }
  | { channel: 'presence'; data: SessionPresence; offset?: number }
  | { channel: 'terminal'; data: SessionTerminal; offset?: number }
  | { channel: 'agentState'; data: SessionAgentState; offset?: number }
  | { channel: 'containerAgent:status'; data: ContainerAgentStatus; offset?: number }
  | { channel: 'containerAgent:started'; data: ContainerAgentStarted; offset?: number }
  | { channel: 'containerAgent:token'; data: ContainerAgentToken; offset?: number }
  | { channel: 'containerAgent:turn'; data: ContainerAgentTurn; offset?: number }
  | { channel: 'containerAgent:toolStart'; data: ContainerAgentToolStart; offset?: number }
  | { channel: 'containerAgent:toolResult'; data: ContainerAgentToolResult; offset?: number }
  | { channel: 'containerAgent:message'; data: ContainerAgentMessage; offset?: number }
  | { channel: 'containerAgent:complete'; data: ContainerAgentComplete; offset?: number }
  | { channel: 'containerAgent:error'; data: ContainerAgentError; offset?: number }
  | { channel: 'containerAgent:cancelled'; data: ContainerAgentCancelled; offset?: number }
  | { channel: 'containerAgent:planReady'; data: ContainerAgentPlanReady; offset?: number }
  | { channel: 'containerAgent:worktree'; data: ContainerAgentWorktree; offset?: number }
  | { channel: 'containerAgent:fileChanged'; data: ContainerAgentFileChanged; offset?: number };

/**
 * Callbacks for session subscription
 */
export interface SessionCallbacks {
  onChunk?: (event: { channel: 'chunks'; data: SessionChunk; offset?: number }) => void;
  onToolCall?: (event: { channel: 'toolCalls'; data: SessionToolCall; offset?: number }) => void;
  onPresence?: (event: { channel: 'presence'; data: SessionPresence; offset?: number }) => void;
  onTerminal?: (event: { channel: 'terminal'; data: SessionTerminal; offset?: number }) => void;
  onAgentState?: (event: {
    channel: 'agentState';
    data: SessionAgentState;
    offset?: number;
  }) => void;
  // Container agent callbacks
  onContainerAgentStatus?: (event: {
    channel: 'containerAgent:status';
    data: ContainerAgentStatus;
    offset?: number;
  }) => void;
  onContainerAgentStarted?: (event: {
    channel: 'containerAgent:started';
    data: ContainerAgentStarted;
    offset?: number;
  }) => void;
  onContainerAgentToken?: (event: {
    channel: 'containerAgent:token';
    data: ContainerAgentToken;
    offset?: number;
  }) => void;
  onContainerAgentTurn?: (event: {
    channel: 'containerAgent:turn';
    data: ContainerAgentTurn;
    offset?: number;
  }) => void;
  onContainerAgentToolStart?: (event: {
    channel: 'containerAgent:toolStart';
    data: ContainerAgentToolStart;
    offset?: number;
  }) => void;
  onContainerAgentToolResult?: (event: {
    channel: 'containerAgent:toolResult';
    data: ContainerAgentToolResult;
    offset?: number;
  }) => void;
  onContainerAgentMessage?: (event: {
    channel: 'containerAgent:message';
    data: ContainerAgentMessage;
    offset?: number;
  }) => void;
  onContainerAgentComplete?: (event: {
    channel: 'containerAgent:complete';
    data: ContainerAgentComplete;
    offset?: number;
  }) => void;
  onContainerAgentError?: (event: {
    channel: 'containerAgent:error';
    data: ContainerAgentError;
    offset?: number;
  }) => void;
  onContainerAgentCancelled?: (event: {
    channel: 'containerAgent:cancelled';
    data: ContainerAgentCancelled;
    offset?: number;
  }) => void;
  onContainerAgentPlanReady?: (event: {
    channel: 'containerAgent:planReady';
    data: ContainerAgentPlanReady;
    offset?: number;
  }) => void;
  onContainerAgentWorktree?: (event: {
    channel: 'containerAgent:worktree';
    data: ContainerAgentWorktree;
    offset?: number;
  }) => void;
  onContainerAgentFileChanged?: (event: {
    channel: 'containerAgent:fileChanged';
    data: ContainerAgentFileChanged;
    offset?: number;
  }) => void;
  onError?: (error: Error) => void;
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
  /** Get the last received offset for resume */
  getLastOffset: () => number;
}

/**
 * Raw stream event shape as delivered by the durable stream (NDJSON items).
 */
interface StreamEventItem {
  type: string;
  data: unknown;
  timestamp?: number;
}

/**
 * Durable Streams Client
 *
 * Uses @durable-streams/client for automatic SSE reconnection and offset tracking.
 */
export class DurableStreamsClient {
  private streamsBaseUrl: string;

  constructor(options: { url: string; reconnect?: Partial<ReconnectConfig> }) {
    // In the new architecture, the base URL points to the streams endpoint
    this.streamsBaseUrl = options.url;
  }

  /**
   * Subscribe to a session's event stream via @durable-streams/client
   */
  subscribeToSession(sessionId: string, callbacks: SessionCallbacks): Subscription {
    let state: ConnectionState = 'disconnected';
    let lastOffset: string = '-1';
    let unsubscribeFn: (() => void) | null = null;
    let responseCancelFn: (() => void) | null = null;
    let isUnsubscribed = false;
    let reconnectCount = 0;

    const connect = async () => {
      if (isUnsubscribed) return;

      state = reconnectCount > 0 ? 'reconnecting' : 'connecting';

      try {
        const url = `${this.streamsBaseUrl}/${sessionId}`;
        const response: StreamResponse = await durableStream({
          url,
          live: 'sse',
          offset: lastOffset,
          json: true,
          onError: (error) => {
            if (!isUnsubscribed) {
              callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
            }
            // Return empty object to signal retry
            return {};
          },
        });

        if (isUnsubscribed) {
          response.cancel();
          return;
        }

        state = 'connected';
        responseCancelFn = () => response.cancel();

        if (reconnectCount > 0) {
          callbacks.onReconnect?.();
        }

        // Subscribe to JSON batches from the stream
        unsubscribeFn = response.subscribeJson<StreamEventItem>((batch) => {
          // Update offset tracking from the batch metadata
          if (batch.offset) {
            lastOffset = batch.offset;
          }

          for (const item of batch.items) {
            try {
              const rawEvent: RawSessionEvent = {
                type: item.type as SessionEventType,
                data: item.data,
                timestamp: item.timestamp ?? Date.now(),
                offset: undefined, // Durable streams use opaque string offsets
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
        response.closed.then(() => {
          if (!isUnsubscribed) {
            state = 'disconnected';
            callbacks.onDisconnect?.();
            // Auto-reconnect unless stream is permanently closed
            if (!response.streamClosed) {
              reconnectCount++;
              connect();
            }
          }
        });
      } catch (error) {
        if (!isUnsubscribed) {
          state = 'disconnected';
          callbacks.onError?.(
            error instanceof Error ? error : new Error('Failed to connect to stream')
          );
          // Retry after delay with exponential backoff (capped at 30s)
          const delay = Math.min(2000 * 2 ** reconnectCount, 30000);
          reconnectCount++;
          setTimeout(() => connect(), delay);
        }
      }
    };

    const unsubscribe = () => {
      isUnsubscribed = true;
      state = 'disconnected';
      if (unsubscribeFn) {
        unsubscribeFn();
        unsubscribeFn = null;
      }
      if (responseCancelFn) {
        responseCancelFn();
        responseCancelFn = null;
      }
    };

    // Start initial connection
    connect();

    return {
      unsubscribe,
      getState: () => state,
      getLastOffset: () => {
        if (lastOffset === '-1') return 0;
        // Durable stream offsets are opaque strings (e.g. "3_128").
        // Parse the leading read-sequence number as a numeric approximation
        // for callers that expect a number.
        const num = parseInt(lastOffset, 10);
        return Number.isNaN(num) ? 0 : num;
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
        console.warn(
          '[DurableStreamsClient] Invalid chunk event data:',
          parsed.error.message,
          'raw:',
          raw.data
        );
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
      };
    }

    case 'tool:start': {
      const parsed = rawToolCallDataSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid tool:start event data:',
          parsed.error.message,
          'raw:',
          raw.data
        );
        return null;
      }
      return {
        channel: 'toolCalls',
        data: {
          id: parsed.data.id ?? crypto.randomUUID(),
          tool: parsed.data.tool,
          input: parsed.data.input,
          status: 'running',
          timestamp: raw.timestamp,
        },
        offset: raw.offset,
      };
    }

    case 'tool:result': {
      const parsed = rawToolCallDataSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid tool:result event data:',
          parsed.error.message,
          'raw:',
          raw.data
        );
        return null;
      }
      return {
        channel: 'toolCalls',
        data: {
          id: parsed.data.id ?? '',
          tool: parsed.data.tool,
          input: parsed.data.input,
          output: parsed.data.output,
          status: 'complete',
          timestamp: raw.timestamp,
        },
        offset: raw.offset,
      };
    }

    case 'presence:joined':
    case 'presence:left':
    case 'presence:cursor': {
      const parsed = rawPresenceDataSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid presence event data:',
          parsed.error.message,
          'raw:',
          raw.data
        );
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
      };
    }

    case 'terminal:input':
    case 'terminal:output': {
      const parsed = rawTerminalDataSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid terminal event data:',
          parsed.error.message,
          'raw:',
          raw.data
        );
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
      };
    }

    case 'state:update': {
      const parsed = rawAgentStateDataSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid state:update event data:',
          parsed.error.message,
          'raw:',
          raw.data
        );
        return null;
      }
      return {
        channel: 'agentState',
        data: parsed.data as SessionAgentState,
        offset: raw.offset,
      };
    }

    // Container agent events
    case 'container-agent:status': {
      const parsed = rawContainerAgentStatusSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid container-agent:status:',
          parsed.error.message
        );
        return null;
      }
      return {
        channel: 'containerAgent:status',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:started': {
      const parsed = rawContainerAgentStartedSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid container-agent:started:',
          parsed.error.message
        );
        return null;
      }
      return {
        channel: 'containerAgent:started',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:token': {
      const parsed = rawContainerAgentTokenSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn('[DurableStreamsClient] Invalid container-agent:token:', parsed.error.message);
        return null;
      }
      return {
        channel: 'containerAgent:token',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:turn': {
      const parsed = rawContainerAgentTurnSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn('[DurableStreamsClient] Invalid container-agent:turn:', parsed.error.message);
        return null;
      }
      return {
        channel: 'containerAgent:turn',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:tool:start': {
      const parsed = rawContainerAgentToolStartSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid container-agent:tool:start:',
          parsed.error.message
        );
        return null;
      }
      return {
        channel: 'containerAgent:toolStart',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:tool:result': {
      const parsed = rawContainerAgentToolResultSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid container-agent:tool:result:',
          parsed.error.message
        );
        return null;
      }
      return {
        channel: 'containerAgent:toolResult',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:message': {
      const parsed = rawContainerAgentMessageSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid container-agent:message:',
          parsed.error.message
        );
        return null;
      }
      return {
        channel: 'containerAgent:message',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:complete': {
      const parsed = rawContainerAgentCompleteSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid container-agent:complete:',
          parsed.error.message
        );
        return null;
      }
      return {
        channel: 'containerAgent:complete',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:error': {
      const parsed = rawContainerAgentErrorSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn('[DurableStreamsClient] Invalid container-agent:error:', parsed.error.message);
        return null;
      }
      return {
        channel: 'containerAgent:error',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:cancelled': {
      const parsed = rawContainerAgentCancelledSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid container-agent:cancelled:',
          parsed.error.message
        );
        return null;
      }
      return {
        channel: 'containerAgent:cancelled',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:plan_ready': {
      const parsed = rawContainerAgentPlanReadySchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid container-agent:plan_ready:',
          parsed.error.message
        );
        return null;
      }
      return {
        channel: 'containerAgent:planReady',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:worktree': {
      const parsed = rawContainerAgentWorktreeSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid container-agent:worktree:',
          parsed.error.message
        );
        return null;
      }
      return {
        channel: 'containerAgent:worktree',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    case 'container-agent:file_changed': {
      const parsed = rawContainerAgentFileChangedSchema.safeParse(raw.data);
      if (!parsed.success) {
        console.warn(
          '[DurableStreamsClient] Invalid container-agent:file_changed:',
          parsed.error.message
        );
        return null;
      }
      return {
        channel: 'containerAgent:fileChanged',
        data: { ...parsed.data, timestamp: raw.timestamp },
        offset: raw.offset,
      };
    }

    default:
      console.warn(
        '[DurableStreamsClient] Unknown event type received:',
        raw.type,
        'data:',
        raw.data
      );
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
  }
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
 * Convenience function to subscribe to a session
 */
export function subscribeToSession(sessionId: string, callbacks: SessionCallbacks): Subscription {
  return getDurableStreamsClient().subscribeToSession(sessionId, callbacks);
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
    onReconnect?: () => void;
  }
): Subscription {
  return getDurableStreamsClient().subscribeToAgent(agentId, callbacks);
}
