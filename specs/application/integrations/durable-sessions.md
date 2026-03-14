# Durable Sessions Integration Specification

## Overview

Specification for integrating Durable Streams (@durable-streams/* v0.2.x) into AgentPane. This document covers the DurableStreamsService, event type system, server/client setup, event persistence, and streaming transport.

Pattern reference: [Electric SQL Durable Sessions](https://electric-sql.com/blog/2026/01/12/durable-sessions-for-collaborative-ai)

---

## Package Information

| Package | Version | Purpose |
|---------|---------|---------|
| @durable-streams/client | ^0.2.1 | Client-side stream subscription |
| @durable-streams/server | ^0.2.2 | Server-side event publishing (Caddy integration) |
| @durable-streams/state | ^0.2.0 | Schema-aware structured state |
| @tanstack/db | 0.5.20 | Client state collections |
| @tanstack/react-db | 0.1.64 | React bindings for live queries |

---

## Protocol Stack

```text
+-------------------------------------------------------------+
|  Application Protocol                                        |
|  (agent tokens, tool calls, terminal I/O, presence)         |
+-------------------------------------------------------------+
|  Durable State (@durable-streams/state)                     |
|  Schema-aware structured state with Standard Schema         |
+-------------------------------------------------------------+
|  Durable Streams (@durable-streams/client)                  |
|  Persistent, addressable binary streams                     |
+-------------------------------------------------------------+
|  HTTP Transport                                              |
|  Reads: SSE/long-poll | Writes: HTTP POST (append)          |
+-------------------------------------------------------------+
```

### Transport Model

Durable Streams uses **HTTP-based transport** (not WebSocket):

| Operation | Method | Description |
|-----------|--------|-------------|
| **Read** | `stream.stream()` | SSE or long-poll for live tailing |
| **Write** | `stream.append()` | HTTP POST with exactly-once semantics |

This separation enables:

- CDN caching for reads
- Exactly-once delivery via offset tracking
- Resumable streams after disconnection

---

## Session Schema Definition

### createStateSchema Usage

```typescript
// lib/sessions/schema.ts
import { createStateSchema } from '@durable-streams/state';
import { z } from 'zod';

// Token chunk schema - streaming text from agent
const chunkSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  text: z.string(),
  accumulated: z.string().optional(),
  turn: z.number().optional(),
  timestamp: z.number(),
});

// Tool call schema - agent tool invocations
const toolCallSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  tool: z.string(),
  input: z.unknown(),
  output: z.unknown().optional(),
  status: z.enum(['pending', 'running', 'complete', 'error']),
  duration: z.number().optional(),
  timestamp: z.number(),
});

// Presence schema - who's watching the session
const presenceSchema = z.object({
  userId: z.string(),
  sessionId: z.string(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
  cursor: z.object({
    x: z.number(),
    y: z.number(),
  }).optional(),
  lastSeen: z.number(),
  joinedAt: z.number(),
});

// Terminal I/O schema - interactive input/output
const terminalSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: z.enum(['input', 'output', 'error']),
  data: z.string(),
  source: z.enum(['user', 'agent', 'system']),
  timestamp: z.number(),
});

// Workflow events schema - approval workflow
const workflowSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  taskId: z.string().optional(),
  type: z.enum([
    'approval:requested',
    'approval:approved',
    'approval:rejected',
    'worktree:created',
    'worktree:merged',
    'worktree:removed',
  ]),
  payload: z.record(z.unknown()),
  actor: z.string().optional(),
  timestamp: z.number(),
});

// Agent state schema - overall agent status
const agentStateSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  status: z.enum(['idle', 'starting', 'running', 'paused', 'error', 'completed']),
  taskId: z.string().optional(),
  turn: z.number().optional(),
  progress: z.number().optional(),
  currentTool: z.string().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
  timestamp: z.number(),
});

// Combined session schema with multiplexed channels
export const sessionSchema = createStateSchema({
  // Text streaming
  chunks: { schema: chunkSchema, type: 'chunk' },

  // Tool execution
  toolCalls: { schema: toolCallSchema, type: 'tool' },

  // User presence
  presence: { schema: presenceSchema, type: 'presence' },

  // Terminal I/O
  terminal: { schema: terminalSchema, type: 'terminal' },

  // Workflow events
  workflow: { schema: workflowSchema, type: 'workflow' },

  // Agent state updates
  agentState: { schema: agentStateSchema, type: 'state' },
});

// Export inferred types
export type ChunkEvent = z.infer<typeof chunkSchema>;
export type ToolCallEvent = z.infer<typeof toolCallSchema>;
export type PresenceEvent = z.infer<typeof presenceSchema>;
export type TerminalEvent = z.infer<typeof terminalSchema>;
export type WorkflowEvent = z.infer<typeof workflowSchema>;
export type AgentStateEvent = z.infer<typeof agentStateSchema>;

// Union of all session events
export type SessionEvent =
  | { channel: 'chunks'; data: ChunkEvent }
  | { channel: 'toolCalls'; data: ToolCallEvent }
  | { channel: 'presence'; data: PresenceEvent }
  | { channel: 'terminal'; data: TerminalEvent }
  | { channel: 'workflow'; data: WorkflowEvent }
  | { channel: 'agentState'; data: AgentStateEvent };
```

### Type-safe Event Creators

```typescript
// lib/sessions/events.ts
import { createId } from '@paralleldrive/cuid2';
import type {
  ChunkEvent,
  ToolCallEvent,
  PresenceEvent,
  TerminalEvent,
  WorkflowEvent,
  AgentStateEvent,
} from './schema';

export const createChunkEvent = (
  agentId: string,
  sessionId: string,
  text: string,
  options?: { accumulated?: string; turn?: number }
): ChunkEvent => ({
  id: createId(),
  agentId,
  sessionId,
  text,
  accumulated: options?.accumulated,
  turn: options?.turn,
  timestamp: Date.now(),
});

export const createToolCallEvent = (
  agentId: string,
  sessionId: string,
  tool: string,
  input: unknown,
  status: ToolCallEvent['status'] = 'pending'
): ToolCallEvent => ({
  id: createId(),
  agentId,
  sessionId,
  tool,
  input,
  status,
  timestamp: Date.now(),
});

export const createPresenceEvent = (
  userId: string,
  sessionId: string,
  options?: { displayName?: string; avatarUrl?: string }
): PresenceEvent => ({
  userId,
  sessionId,
  displayName: options?.displayName,
  avatarUrl: options?.avatarUrl,
  lastSeen: Date.now(),
  joinedAt: Date.now(),
});

export const createTerminalEvent = (
  sessionId: string,
  type: TerminalEvent['type'],
  data: string,
  source: TerminalEvent['source']
): TerminalEvent => ({
  id: createId(),
  sessionId,
  type,
  data,
  source,
  timestamp: Date.now(),
});

export const createWorkflowEvent = (
  sessionId: string,
  type: WorkflowEvent['type'],
  payload: Record<string, unknown>,
  actor?: string
): WorkflowEvent => ({
  id: createId(),
  sessionId,
  type,
  payload,
  actor,
  timestamp: Date.now(),
});

export const createAgentStateEvent = (
  agentId: string,
  sessionId: string,
  status: AgentStateEvent['status'],
  options?: Partial<Omit<AgentStateEvent, 'agentId' | 'sessionId' | 'status' | 'timestamp'>>
): AgentStateEvent => ({
  agentId,
  sessionId,
  status,
  ...options,
  timestamp: Date.now(),
});
```

---

## Server Publisher Setup

### DurableStreamsServer Configuration

```typescript
// lib/streams/server.ts
import { DurableStreamsServer } from '@durable-streams/server';
import { StateProtocol } from '@durable-streams/state';
import { sessionSchema } from '../sessions/schema';
import type {
  ChunkEvent,
  ToolCallEvent,
  AgentStateEvent,
  TerminalEvent,
  WorkflowEvent,
} from '../sessions/schema';

// Initialize server with database connection
const streams = new DurableStreamsServer({
  database: process.env.DATABASE_URL,
  schema: sessionSchema,
});

// Type-safe publish functions for each channel

/**
 * Publish agent state change
 */
export function publishAgentState(agentId: string, state: Omit<AgentStateEvent, 'agentId' | 'timestamp'>) {
  const sessionId = state.sessionId;

  streams.publish(`session:${sessionId}`, {
    channel: 'agentState',
    data: {
      agentId,
      ...state,
      timestamp: Date.now(),
    },
  });
}

/**
 * Publish agent execution step (tool calls, tokens, etc.)
 */
export function publishAgentStep(
  agentId: string,
  step:
    | { type: 'tool:start'; sessionId: string; tool: string; input: unknown; timestamp: number }
    | { type: 'tool:result'; sessionId: string; tool: string; input: unknown; output: unknown; duration?: number; timestamp: number }
    | { type: 'stream:token'; sessionId: string; text: string; accumulated?: string; timestamp: number }
    | { type: 'agent:turn'; sessionId: string; turn: number; content: unknown; timestamp: number }
    | { type: 'agent:complete'; sessionId: string; result: string; turns: number; timestamp: number }
    | { type: 'tool:invoke'; sessionId: string; toolId: string; tool: string; input: unknown; timestamp: number }
) {
  const { sessionId, timestamp, ...rest } = step;

  if (step.type === 'tool:start' || step.type === 'tool:invoke') {
    streams.publish(`session:${sessionId}`, {
      channel: 'toolCalls',
      data: {
        id: step.type === 'tool:invoke' ? step.toolId : `${agentId}-${timestamp}`,
        agentId,
        sessionId,
        tool: step.tool,
        input: step.input,
        status: 'running',
        timestamp,
      },
    });
  } else if (step.type === 'tool:result') {
    streams.publish(`session:${sessionId}`, {
      channel: 'toolCalls',
      data: {
        id: `${agentId}-${timestamp}`,
        agentId,
        sessionId,
        tool: step.tool,
        input: step.input,
        output: step.output,
        status: 'complete',
        duration: step.duration,
        timestamp,
      },
    });
  } else if (step.type === 'stream:token') {
    streams.publish(`session:${sessionId}`, {
      channel: 'chunks',
      data: {
        id: `${agentId}-${timestamp}`,
        agentId,
        sessionId,
        text: step.text,
        accumulated: step.accumulated,
        timestamp,
      },
    });
  } else if (step.type === 'agent:complete') {
    streams.publish(`session:${sessionId}`, {
      channel: 'agentState',
      data: {
        agentId,
        sessionId,
        status: 'completed',
        message: step.result,
        turn: step.turns,
        timestamp,
      },
    });
  }
}

/**
 * Publish terminal event
 */
export function publishTerminalEvent(
  sessionId: string,
  type: 'input' | 'output' | 'error',
  data: string,
  source: 'user' | 'agent' | 'system'
) {
  streams.publish(`session:${sessionId}`, {
    channel: 'terminal',
    data: {
      id: `terminal-${Date.now()}`,
      sessionId,
      type,
      data,
      source,
      timestamp: Date.now(),
    },
  });
}

/**
 * Publish workflow event
 */
export function publishWorkflowEvent(
  sessionId: string,
  type: WorkflowEvent['type'],
  payload: Record<string, unknown>,
  actor?: string
) {
  streams.publish(`session:${sessionId}`, {
    channel: 'workflow',
    data: {
      id: `workflow-${Date.now()}`,
      sessionId,
      type,
      payload,
      actor,
      timestamp: Date.now(),
    },
  });
}

/**
 * Publish presence update
 */
export function publishPresence(
  sessionId: string,
  userId: string,
  action: 'join' | 'leave' | 'update',
  metadata?: { displayName?: string; cursor?: { x: number; y: number } }
) {
  streams.publish(`session:${sessionId}`, {
    channel: 'presence',
    data: {
      userId,
      sessionId,
      displayName: metadata?.displayName,
      cursor: metadata?.cursor,
      lastSeen: Date.now(),
      joinedAt: action === 'join' ? Date.now() : 0,
    },
  });
}

// Export server instance for route handlers
export { streams };
```

### Server Route Handler

```typescript
// app/routes/api/streams.ts
import { createServerFileRoute } from '@tanstack/react-start/server';
import { streams } from '@/lib/streams/server';

export const ServerRoute = createServerFileRoute().methods({
  // SSE endpoint for session subscriptions (reads)
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    const offset = url.searchParams.get('offset'); // For resumability

    if (!sessionId) {
      return new Response('Missing sessionId', { status: 400 });
    }

    // Create SSE stream with offset-based resumption
    const stream = streams.stream(`session:${sessionId}`, {
      offset: offset ? parseInt(offset, 10) : undefined,
      live: true, // Enable live tailing
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  },

  // HTTP POST endpoint for writes (terminal input, presence)
  POST: async ({ request }) => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
      return new Response('Missing sessionId', { status: 400 });
    }

    const body = await request.json();
    const { channel, data } = body;

    // Append to the session stream
    const result = await streams.append(`session:${sessionId}`, {
      channel,
      data: {
        ...data,
        id: data.id ?? `${channel}-${Date.now()}`,
        timestamp: data.timestamp ?? Date.now(),
      },
    });

    return Response.json({
      ok: true,
      offset: result.offset, // Return offset for client tracking
    });
  },
});
```

> **Note:** Durable Streams uses HTTP for both reads (SSE) and writes (POST). This enables CDN caching, exactly-once delivery via offsets, and automatic reconnection handling.

---

## Client Subscriber Setup

### DurableStreamsClient Configuration

```typescript
// lib/streams/client.ts
import { DurableStreamsClient } from '@durable-streams/client';
import { StateProtocol } from '@durable-streams/state';
import { sessionSchema, type SessionEvent } from '../sessions/schema';

// Client configuration
const client = new DurableStreamsClient({
  url: '/api/streams',
  schema: sessionSchema,
  reconnect: {
    enabled: true,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
  },
});

export interface SessionCallbacks {
  onChunk?: (chunk: SessionEvent & { channel: 'chunks' }) => void;
  onToolCall?: (tool: SessionEvent & { channel: 'toolCalls' }) => void;
  onPresence?: (presence: SessionEvent & { channel: 'presence' }) => void;
  onTerminal?: (terminal: SessionEvent & { channel: 'terminal' }) => void;
  onWorkflow?: (workflow: SessionEvent & { channel: 'workflow' }) => void;
  onAgentState?: (state: SessionEvent & { channel: 'agentState' }) => void;
  onError?: (error: Error) => void;
  onReconnect?: () => void;
}

/**
 * Subscribe to a session's event stream
 */
export function subscribeToSession(
  sessionId: string,
  callbacks: SessionCallbacks
): () => void {
  return client.subscribe(`session:${sessionId}`, (event: SessionEvent) => {
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
      case 'workflow':
        callbacks.onWorkflow?.(event);
        break;
      case 'agentState':
        callbacks.onAgentState?.(event);
        break;
    }
  }, {
    onError: callbacks.onError,
    onReconnect: callbacks.onReconnect,
  });
}

/**
 * Subscribe to agent-specific events across sessions
 */
export function subscribeToAgent(
  agentId: string,
  callbacks: {
    onState: (state: SessionEvent & { channel: 'agentState' }) => void;
    onStep: (step: SessionEvent) => void;
  }
): () => void {
  return client.subscribe(`agent:${agentId}`, (event: SessionEvent) => {
    if (event.channel === 'agentState') {
      callbacks.onState(event);
    } else {
      callbacks.onStep(event);
    }
  });
}

// Export client for direct access
export { client };
```

---

## Event Multiplexing

### Channel Router

```typescript
// lib/sessions/router.ts
import type { SessionEvent } from './schema';

export type ChannelHandler<T> = (event: T) => void;

export class SessionEventRouter {
  private handlers = new Map<string, Set<ChannelHandler<SessionEvent>>>();

  /**
   * Register a handler for a specific channel
   */
  on<C extends SessionEvent['channel']>(
    channel: C,
    handler: ChannelHandler<Extract<SessionEvent, { channel: C }>>
  ): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
    }

    this.handlers.get(channel)!.add(handler as ChannelHandler<SessionEvent>);

    // Return unsubscribe function
    return () => {
      this.handlers.get(channel)?.delete(handler as ChannelHandler<SessionEvent>);
    };
  }

  /**
   * Route an incoming event to registered handlers
   */
  route(event: SessionEvent): void {
    const channelHandlers = this.handlers.get(event.channel);
    if (channelHandlers) {
      channelHandlers.forEach(handler => handler(event));
    }
  }

  /**
   * Clear all handlers
   */
  clear(): void {
    this.handlers.clear();
  }
}

// Factory for session-specific routers
export function createSessionRouter(): SessionEventRouter {
  return new SessionEventRouter();
}
```

### Multiplexed Subscription

```typescript
// lib/sessions/multiplexer.ts
import { subscribeToSession, type SessionCallbacks } from '../streams/client';
import { createSessionRouter, type SessionEventRouter } from './router';

export interface MultiplexedSession {
  router: SessionEventRouter;
  unsubscribe: () => void;
}

/**
 * Create a multiplexed session subscription
 * Routes events to multiple handlers by channel
 */
export function createMultiplexedSession(sessionId: string): MultiplexedSession {
  const router = createSessionRouter();

  const unsubscribe = subscribeToSession(sessionId, {
    onChunk: (event) => router.route(event),
    onToolCall: (event) => router.route(event),
    onPresence: (event) => router.route(event),
    onTerminal: (event) => router.route(event),
    onWorkflow: (event) => router.route(event),
    onAgentState: (event) => router.route(event),
    onError: (error) => console.error('Session error:', error),
    onReconnect: () => console.log('Session reconnected'),
  });

  return { router, unsubscribe };
}
```

---

## Optimistic Writes

### Terminal Input with Optimistic Updates

```typescript
// lib/sessions/optimistic.ts
import { createId } from '@paralleldrive/cuid2';
import type { TerminalEvent } from './schema';

interface OptimisticWriteOptions {
  onOptimistic: (event: TerminalEvent) => void;
  onConfirm: (event: TerminalEvent, offset: number) => void;
  onRollback: (event: TerminalEvent, error: Error) => void;
}

/**
 * Send terminal input with optimistic UI update
 * Uses HTTP POST to append to the session stream
 */
export async function sendTerminalInput(
  sessionId: string,
  input: string,
  options: OptimisticWriteOptions
): Promise<void> {
  // Create optimistic event
  const optimisticEvent: TerminalEvent = {
    id: createId(),
    sessionId,
    type: 'input',
    data: input,
    source: 'user',
    timestamp: Date.now(),
  };

  // Apply optimistic update immediately
  options.onOptimistic(optimisticEvent);

  try {
    // HTTP POST to append to the stream
    const response = await fetch(`/api/streams?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'terminal',
        data: optimisticEvent,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send: ${response.status}`);
    }

    const result = await response.json();
    options.onConfirm(optimisticEvent, result.offset);
  } catch (error) {
    options.onRollback(optimisticEvent, error as Error);
  }
}

/**
 * Send presence update with optimistic cursor position
 * Uses HTTP POST to append to the session stream
 */
export function sendPresenceUpdate(
  sessionId: string,
  userId: string,
  cursor: { x: number; y: number },
  options: {
    onOptimistic: (cursor: { x: number; y: number }) => void;
  }
): void {
  // Apply optimistic update immediately
  options.onOptimistic(cursor);

  // Debounced HTTP POST (presence updates can be batched)
  fetch(`/api/streams?sessionId=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: 'presence',
      data: {
        userId,
        sessionId,
        cursor,
        lastSeen: Date.now(),
        joinedAt: 0, // Ignored for updates
      },
    }),
  }).catch(console.error); // Fire-and-forget for presence
}
```

### Optimistic Write Manager

```typescript
// lib/sessions/optimistic-manager.ts
import type { TerminalEvent } from './schema';

interface PendingWrite {
  event: TerminalEvent;
  timestamp: number;
  retries: number;
}

export class OptimisticWriteManager {
  private pending = new Map<string, PendingWrite>();
  private confirmed = new Set<string>();
  private maxRetries = 3;
  private retryDelay = 1000;

  /**
   * Track a pending optimistic write
   */
  trackWrite(event: TerminalEvent): void {
    this.pending.set(event.id, {
      event,
      timestamp: Date.now(),
      retries: 0,
    });
  }

  /**
   * Confirm a write was successful
   */
  confirmWrite(eventId: string): void {
    this.pending.delete(eventId);
    this.confirmed.add(eventId);
  }

  /**
   * Handle write failure
   */
  handleFailure(eventId: string): { shouldRetry: boolean; event?: TerminalEvent } {
    const write = this.pending.get(eventId);

    if (!write) {
      return { shouldRetry: false };
    }

    write.retries++;

    if (write.retries >= this.maxRetries) {
      this.pending.delete(eventId);
      return { shouldRetry: false, event: write.event };
    }

    return { shouldRetry: true, event: write.event };
  }

  /**
   * Get pending writes for reconciliation
   */
  getPendingWrites(): TerminalEvent[] {
    return Array.from(this.pending.values()).map(w => w.event);
  }

  /**
   * Check if an event ID is confirmed
   */
  isConfirmed(eventId: string): boolean {
    return this.confirmed.has(eventId);
  }

  /**
   * Clear old confirmed entries
   */
  cleanup(maxAge: number = 60000): void {
    const now = Date.now();

    // Remove stale pending writes
    for (const [id, write] of this.pending) {
      if (now - write.timestamp > maxAge) {
        this.pending.delete(id);
      }
    }
  }
}
```

---

## Session URL Generation

### Session Service

```typescript
// lib/services/session-service.ts
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { sessions } from '../db/schema';
import { ok, err, type Result } from '../utils/result';
import { SessionErrors, type SessionError } from '../errors/session-errors';

export interface CreateSessionInput {
  projectId: string;
  taskId?: string;
  agentId?: string;
  title?: string;
}

export interface SessionInfo {
  id: string;
  url: string;
  projectId: string;
  taskId?: string;
  agentId?: string;
}

export class SessionService {
  /**
   * Create a new addressable session
   */
  async createSession(input: CreateSessionInput): Promise<Result<SessionInfo, SessionError>> {
    const id = createId();
    const url = `/sessions/${id}`;

    const [session] = await db.insert(sessions).values({
      id,
      url,
      projectId: input.projectId,
      taskId: input.taskId,
      agentId: input.agentId,
      title: input.title,
      isActive: true,
    }).returning();

    return ok({
      id: session.id,
      url: session.url,
      projectId: session.projectId,
      taskId: session.taskId ?? undefined,
      agentId: session.agentId ?? undefined,
    });
  }

  /**
   * Get session by ID
   */
  async getSession(sessionId: string): Promise<Result<SessionInfo, SessionError>> {
    const session = await db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });

    if (!session) {
      return err(SessionErrors.NOT_FOUND);
    }

    return ok({
      id: session.id,
      url: session.url,
      projectId: session.projectId,
      taskId: session.taskId ?? undefined,
      agentId: session.agentId ?? undefined,
    });
  }

  /**
   * Generate shareable session URL
   */
  generateShareUrl(sessionId: string, baseUrl: string = 'https://agentpane.dev'): string {
    return `${baseUrl}/sessions/${sessionId}`;
  }

  /**
   * Join an existing session (returns session info and history)
   */
  async joinSession(
    sessionId: string,
    userId: string
  ): Promise<Result<{ session: SessionInfo; history: unknown[] }, SessionError>> {
    const sessionResult = await this.getSession(sessionId);

    if (!sessionResult.ok) {
      return sessionResult;
    }

    const session = sessionResult.value;

    // Check if session is still active
    const dbSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });

    if (!dbSession?.isActive) {
      return err(SessionErrors.CLOSED);
    }

    // Update active users
    const activeUsers = (dbSession.activeUsers ?? []) as { userId: string; joinedAt: number; lastSeen: number }[];
    const existingIndex = activeUsers.findIndex(u => u.userId === userId);

    if (existingIndex >= 0) {
      activeUsers[existingIndex].lastSeen = Date.now();
    } else {
      activeUsers.push({
        userId,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
      });
    }

    await db.update(sessions)
      .set({ activeUsers, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));

    // Fetch session history (would come from Durable Streams)
    const history: unknown[] = []; // TODO: Fetch from durable streams

    return ok({ session, history });
  }

  /**
   * Leave a session
   */
  async leaveSession(sessionId: string, userId: string): Promise<void> {
    const session = await db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });

    if (session) {
      const activeUsers = ((session.activeUsers ?? []) as { userId: string }[])
        .filter(u => u.userId !== userId);

      await db.update(sessions)
        .set({ activeUsers, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));
    }
  }

  /**
   * Close a session
   */
  async closeSession(sessionId: string): Promise<Result<void, SessionError>> {
    const session = await db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });

    if (!session) {
      return err(SessionErrors.NOT_FOUND);
    }

    await db.update(sessions)
      .set({
        isActive: false,
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));

    return ok(undefined);
  }
}

// Export singleton
export const sessionService = new SessionService();
```

---

## TanStack DB Integration

### Collections for Session Data

```typescript
// lib/sessions/collections.ts
import { createCollection } from '@tanstack/db';
import type {
  ChunkEvent,
  ToolCallEvent,
  PresenceEvent,
  TerminalEvent,
  AgentStateEvent,
} from './schema';

// Messages derived from chunks
export interface Message {
  id: string;
  agentId: string;
  sessionId: string;
  text: string;
  turn: number;
  timestamp: number;
}

// Chunks collection (raw streaming data)
export const chunksCollection = createCollection<ChunkEvent>({
  id: 'session-chunks',
  primaryKey: 'id',
});

// Tool calls collection
export const toolCallsCollection = createCollection<ToolCallEvent>({
  id: 'session-tool-calls',
  primaryKey: 'id',
});

// Presence collection
export const presenceCollection = createCollection<PresenceEvent>({
  id: 'session-presence',
  primaryKey: 'userId',
});

// Terminal events collection
export const terminalCollection = createCollection<TerminalEvent>({
  id: 'session-terminal',
  primaryKey: 'id',
});

// Agent state collection
export const agentStateCollection = createCollection<AgentStateEvent>({
  id: 'agent-state',
  primaryKey: 'agentId',
});

// Derived messages collection (aggregated from chunks)
export const messagesCollection = createCollection<Message>({
  id: 'session-messages',
  primaryKey: 'id',
  derive: (chunks: ChunkEvent[]) => {
    const messages = new Map<string, Message>();

    // Group chunks by agent and turn, aggregate text
    for (const chunk of chunks) {
      const key = `${chunk.agentId}-${chunk.turn ?? 0}`;

      if (messages.has(key)) {
        const existing = messages.get(key)!;
        existing.text += chunk.text;
        existing.timestamp = Math.max(existing.timestamp, chunk.timestamp);
      } else {
        messages.set(key, {
          id: key,
          agentId: chunk.agentId,
          sessionId: chunk.sessionId,
          text: chunk.text,
          turn: chunk.turn ?? 0,
          timestamp: chunk.timestamp,
        });
      }
    }

    return Array.from(messages.values());
  },
});
```

### Collection Sync with Durable Streams

```typescript
// lib/sessions/sync.ts
import { subscribeToSession } from '../streams/client';
import {
  chunksCollection,
  toolCallsCollection,
  presenceCollection,
  terminalCollection,
  agentStateCollection,
} from './collections';

/**
 * Sync a session's events to TanStack DB collections
 */
export function syncSessionToCollections(sessionId: string): () => void {
  return subscribeToSession(sessionId, {
    onChunk: (event) => {
      chunksCollection.insert(event.data);
    },

    onToolCall: (event) => {
      const existing = toolCallsCollection.get(event.data.id);
      if (existing) {
        toolCallsCollection.update(event.data.id, event.data);
      } else {
        toolCallsCollection.insert(event.data);
      }
    },

    onPresence: (event) => {
      const existing = presenceCollection.get(event.data.userId);
      if (existing) {
        presenceCollection.update(event.data.userId, event.data);
      } else {
        presenceCollection.insert(event.data);
      }
    },

    onTerminal: (event) => {
      terminalCollection.insert(event.data);
    },

    onAgentState: (event) => {
      const existing = agentStateCollection.get(event.data.agentId);
      if (existing) {
        agentStateCollection.update(event.data.agentId, event.data);
      } else {
        agentStateCollection.insert(event.data);
      }
    },

    onError: (error) => {
      console.error('Session sync error:', error);
    },

    onReconnect: () => {
      console.log('Session reconnected, syncing state...');
    },
  });
}
```

---

## React Hooks

### Core Session Hook

```typescript
// lib/sessions/hooks/use-session.ts
import { useEffect, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-db';
import { subscribeToSession } from '../../streams/client';
import { syncSessionToCollections } from '../sync';
import {
  messagesCollection,
  toolCallsCollection,
  presenceCollection,
  terminalCollection,
  agentStateCollection,
} from '../collections';
import type { Message, AgentStateEvent, PresenceEvent, ToolCallEvent, TerminalEvent } from '../schema';

export interface UseSessionResult {
  // Data
  messages: Message[];
  toolCalls: ToolCallEvent[];
  presence: PresenceEvent[];
  terminal: TerminalEvent[];
  agentState: AgentStateEvent | null;

  // Status
  isConnected: boolean;
  isLoading: boolean;
  error: Error | null;

  // Actions
  sendInput: (input: string) => void;
  updatePresence: (cursor: { x: number; y: number }) => void;
}

export function useSession(sessionId: string, userId: string): UseSessionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Subscribe to session events and sync to collections
  useEffect(() => {
    setIsLoading(true);

    const unsubscribe = syncSessionToCollections(sessionId);

    // Additional connection status tracking
    const statusUnsubscribe = subscribeToSession(sessionId, {
      onAgentState: () => setIsConnected(true),
      onError: (err) => setError(err),
      onReconnect: () => {
        setIsConnected(true);
        setError(null);
      },
    });

    setIsLoading(false);
    setIsConnected(true);

    return () => {
      unsubscribe();
      statusUnsubscribe();
    };
  }, [sessionId]);

  // Live queries from collections
  const messages = useQuery(messagesCollection, (q) =>
    q.where('sessionId', '==', sessionId).orderBy('timestamp', 'asc')
  );

  const toolCalls = useQuery(toolCallsCollection, (q) =>
    q.where('sessionId', '==', sessionId).orderBy('timestamp', 'desc')
  );

  const presence = useQuery(presenceCollection, (q) =>
    q.where('sessionId', '==', sessionId)
  );

  const terminal = useQuery(terminalCollection, (q) =>
    q.where('sessionId', '==', sessionId).orderBy('timestamp', 'asc')
  );

  const agentStateResult = useQuery(agentStateCollection, (q) =>
    q.where('sessionId', '==', sessionId).first()
  );

  // Actions
  const sendInput = useCallback((input: string) => {
    // Import optimistic write helper
    import('../optimistic').then(({ sendTerminalInput }) => {
      sendTerminalInput(sessionId, input, {
        onOptimistic: (event) => {
          terminalCollection.insert(event);
        },
        onConfirm: () => {},
        onRollback: (event, error) => {
          terminalCollection.delete(event.id);
          setError(error);
        },
      });
    });
  }, [sessionId]);

  const updatePresence = useCallback((cursor: { x: number; y: number }) => {
    import('../optimistic').then(({ sendPresenceUpdate }) => {
      sendPresenceUpdate(sessionId, userId, cursor, {
        onOptimistic: () => {},
      });
    });
  }, [sessionId, userId]);

  return {
    messages,
    toolCalls,
    presence,
    terminal,
    agentState: agentStateResult ?? null,
    isConnected,
    isLoading,
    error,
    sendInput,
    updatePresence,
  };
}
```

### Agent Stream Hook

```typescript
// lib/sessions/hooks/use-agent-stream.ts
import { useEffect, useState, useCallback } from 'react';
import { subscribeToAgent } from '../../streams/client';
import type { ToolCallEvent, AgentStateEvent } from '../schema';

export interface ToolExecution {
  id: string;
  tool: string;
  input: unknown;
  output?: unknown;
  status: ToolCallEvent['status'];
  duration?: number;
}

export interface UseAgentStreamResult {
  // State
  status: AgentStateEvent['status'];
  streaming: string;
  tools: ToolExecution[];
  turn: number;
  progress: number;
  message: string | null;
  error: string | null;

  // Actions
  clearStreaming: () => void;
}

export function useAgentStream(agentId: string): UseAgentStreamResult {
  const [status, setStatus] = useState<AgentStateEvent['status']>('idle');
  const [streaming, setStreaming] = useState('');
  const [tools, setTools] = useState<ToolExecution[]>([]);
  const [turn, setTurn] = useState(0);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToAgent(agentId, {
      onState: (event) => {
        const state = event.data;
        setStatus(state.status);
        setTurn(state.turn ?? 0);
        setProgress(state.progress ?? 0);
        setMessage(state.message ?? null);
        setError(state.error ?? null);

        // Clear streaming on completion
        if (state.status === 'completed' || state.status === 'error') {
          setStreaming('');
        }
      },

      onStep: (event) => {
        if (event.channel === 'chunks') {
          const chunk = event.data;
          setStreaming(prev => prev + chunk.text);
        }

        if (event.channel === 'toolCalls') {
          const tool = event.data as ToolCallEvent;

          setTools(prev => {
            const existing = prev.find(t => t.id === tool.id);

            if (existing) {
              return prev.map(t => t.id === tool.id
                ? {
                    ...t,
                    status: tool.status,
                    output: tool.output,
                    duration: tool.duration,
                  }
                : t
              );
            }

            return [...prev, {
              id: tool.id,
              tool: tool.tool,
              input: tool.input,
              output: tool.output,
              status: tool.status,
              duration: tool.duration,
            }];
          });
        }
      },
    });

    return unsubscribe;
  }, [agentId]);

  const clearStreaming = useCallback(() => {
    setStreaming('');
  }, []);

  return {
    status,
    streaming,
    tools,
    turn,
    progress,
    message,
    error,
    clearStreaming,
  };
}
```

### Presence Hook

```typescript
// lib/sessions/hooks/use-presence.ts
import { useEffect, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-db';
import { presenceCollection } from '../collections';
import { sendPresenceUpdate } from '../optimistic';
import type { PresenceEvent } from '../schema';

export interface UsePresenceResult {
  participants: PresenceEvent[];
  onlineCount: number;
  updateCursor: (cursor: { x: number; y: number }) => void;
}

export function usePresence(sessionId: string, userId: string): UsePresenceResult {
  // Live query for participants
  const participants = useQuery(presenceCollection, (q) =>
    q.where('sessionId', '==', sessionId)
      .where('lastSeen', '>', Date.now() - 30000) // Active in last 30s
  );

  // Heartbeat to maintain presence
  useEffect(() => {
    const interval = setInterval(() => {
      sendPresenceUpdate(sessionId, userId, { x: 0, y: 0 }, {
        onOptimistic: () => {},
      });
    }, 10000);

    return () => clearInterval(interval);
  }, [sessionId, userId]);

  const updateCursor = useCallback((cursor: { x: number; y: number }) => {
    sendPresenceUpdate(sessionId, userId, cursor, {
      onOptimistic: () => {},
    });
  }, [sessionId, userId]);

  return {
    participants,
    onlineCount: participants.length,
    updateCursor,
  };
}
```

### Terminal Hook

```typescript
// lib/sessions/hooks/use-terminal.ts
import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-db';
import { terminalCollection } from '../collections';
import { sendTerminalInput } from '../optimistic';
import type { TerminalEvent } from '../schema';

export interface UseTerminalResult {
  // Data
  lines: TerminalEvent[];
  inputHistory: string[];

  // Actions
  sendCommand: (command: string) => void;
}

export function useTerminal(sessionId: string): UseTerminalResult {
  // Live query for terminal lines
  const lines = useQuery(terminalCollection, (q) =>
    q.where('sessionId', '==', sessionId).orderBy('timestamp', 'asc')
  );

  // Extract input history for command completion
  const inputHistory = useMemo(() =>
    lines
      .filter(l => l.type === 'input' && l.source === 'user')
      .map(l => l.data)
      .reverse()
      .slice(0, 50),
    [lines]
  );

  const sendCommand = useCallback((command: string) => {
    sendTerminalInput(sessionId, command, {
      onOptimistic: (event) => {
        terminalCollection.insert(event);
      },
      onConfirm: () => {},
      onRollback: (event) => {
        terminalCollection.delete(event.id);
      },
    });
  }, [sessionId]);

  return {
    lines,
    inputHistory,
    sendCommand,
  };
}
```

---

## SessionService Integration

### Complete Session Lifecycle

```typescript
// lib/services/session-service-extended.ts
import { sessionService, type SessionInfo } from './session-service';
import { syncSessionToCollections } from '../sessions/sync';
import { publishPresence, publishWorkflowEvent } from '../streams/server';
import type { Result } from '../utils/result';
import type { SessionError } from '../errors/session-errors';

export interface ExtendedSessionService {
  // Session lifecycle
  create: typeof sessionService.createSession;
  get: typeof sessionService.getSession;
  join: (sessionId: string, userId: string) => Promise<Result<{
    session: SessionInfo;
    unsubscribe: () => void;
  }, SessionError>>;
  leave: (sessionId: string, userId: string) => Promise<void>;
  close: typeof sessionService.closeSession;

  // URL utilities
  getShareUrl: (sessionId: string) => string;
}

export const extendedSessionService: ExtendedSessionService = {
  create: sessionService.createSession.bind(sessionService),
  get: sessionService.getSession.bind(sessionService),

  async join(sessionId: string, userId: string) {
    const result = await sessionService.joinSession(sessionId, userId);

    if (!result.ok) {
      return result;
    }

    // Start syncing session events to collections
    const unsubscribe = syncSessionToCollections(sessionId);

    // Publish presence join event
    publishPresence(sessionId, userId, 'join');

    return {
      ok: true as const,
      value: {
        session: result.value.session,
        unsubscribe,
      },
    };
  },

  async leave(sessionId: string, userId: string) {
    // Publish presence leave event
    publishPresence(sessionId, userId, 'leave');

    // Update database
    await sessionService.leaveSession(sessionId, userId);
  },

  close: sessionService.closeSession.bind(sessionService),

  getShareUrl(sessionId: string) {
    const baseUrl = typeof window !== 'undefined'
      ? window.location.origin
      : process.env.APP_URL ?? 'https://agentpane.dev';

    return sessionService.generateShareUrl(sessionId, baseUrl);
  },
};
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Claude Agent SDK](./claude-agent-sdk.md) | Agent events published to sessions |
| [Database Schema](../database/schema.md) | Sessions table stores metadata |
| [Error Catalog](../errors/error-catalog.md) | SessionError types |
| [User Stories](../user-stories.md) | Collaborative session requirements |
| [Wireframes](../wireframes/) | Session presence UI, terminal I/O |
| [API Endpoints](../api/endpoints.md) | Session REST API routes (SSE + HTTP POST) |

---

## Transport Summary

| Feature | Transport | Endpoint |
|---------|-----------|----------|
| Agent output streaming | SSE (GET) | `/api/streams?sessionId=X` |
| Tool call events | SSE (GET) | `/api/streams?sessionId=X` |
| Presence updates (read) | SSE (GET) | `/api/streams?sessionId=X` |
| Terminal input (write) | HTTP POST | `/api/streams?sessionId=X` |
| Presence updates (write) | HTTP POST | `/api/streams?sessionId=X` |
| Session history replay | SSE with offset | `/api/streams?sessionId=X&offset=N` |

All writes use HTTP POST with `append()` semantics. This provides exactly-once delivery via offset tracking and enables automatic retry on failure.
