# Session Lifecycle State Machine Specification

## Overview

Formal state machine definition for session lifecycle in AgentPane. This machine governs session state transitions from initialization through graceful shutdown, managing presence, timeouts, event publishing, and error recovery.

---

## State Diagram

```
                                   ERROR (recoverable)
                                  +--------------------+
                                  |                    |
                                  v                    |
+--------+   INITIALIZE   +--------------+   READY   +--------+
|  idle  |--------------->| initializing |---------->| active |<--+
+--------+                +--------------+           +--------+   |
                               |                       |  |  |    |
                               |                       |  |  |    |
           ERROR               |            PAUSE      |  |  +----+
       (unrecoverable)         |               +-------+  |  HEARTBEAT
             +                 |               |          |
             |                 |               v          |
             |                 |          +--------+      |
             |                 |          | paused |------+
             |                 |          +--------+   RESUME
             |                 |               |
             |                 |               | CLOSE
             v                 v               v
         +-------+         +-------+      +---------+
         | error |<--------|       |<-----| closing |
         +-------+         +-------+      +---------+
             |                                |
             |                                |
             | (after cleanup)                | (after cleanup)
             v                                v
         +--------+                      +--------+
         | closed |                      | closed |
         +--------+                      +--------+


ASCII State Diagram (Session Flow):

    +------+      +--------------+      +--------+      +--------+      +---------+      +--------+
    | idle |----->| initializing |----->| active |----->| paused |----->| closing |----->| closed |
    +------+      +--------------+      +--------+      +--------+      +---------+      +--------+
                        |                  |  ^             |              |
                        |                  |  |             |              |
                        v                  v  +-------------+              v
                   +-------+          +-------+  RESUME               +-------+
                   | error |<---------| error |                       | error |
                   +-------+          +-------+                       +-------+
                        |                                                 |
                        v                                                 v
                   +--------+                                        +--------+
                   | closed |                                        | closed |
                   +--------+                                        +--------+
```

---

## States

| State | Description | Accepts Connections | Accepts Events | Resources Allocated |
|-------|-------------|---------------------|----------------|---------------------|
| `idle` | Session not yet created | No | No | No |
| `initializing` | Setting up session resources | No | No | Partially |
| `active` | Session live and accepting connections | Yes | Yes | Yes |
| `paused` | Session temporarily suspended | No (existing only) | Limited | Yes |
| `closing` | Graceful shutdown in progress | No | No | Yes (draining) |
| `closed` | Session terminated | No | No | No |
| `error` | Session in error state | No | Recovery only | Partially |

### State Properties

```typescript
// db/schema/shared/enums.ts
export const SESSION_STATUS = [
  'idle',
  'initializing',
  'active',
  'paused',
  'closing',
  'closed',
  'error',
] as const;
export type SessionStatus = (typeof SESSION_STATUS)[number];

// State metadata
interface SessionStateMetadata {
  idle: {
    acceptsConnections: false;
    acceptsEvents: false;
    resourcesAllocated: false;
    canInitialize: true;
  };
  initializing: {
    acceptsConnections: false;
    acceptsEvents: false;
    resourcesAllocated: 'partial';
    canInitialize: false;
  };
  active: {
    acceptsConnections: true;
    acceptsEvents: true;
    resourcesAllocated: true;
    canInitialize: false;
    supportsPresence: true;
  };
  paused: {
    acceptsConnections: false;  // No new connections
    acceptsEvents: 'limited';   // Only RESUME, CLOSE, ERROR
    resourcesAllocated: true;
    preservesState: true;
  };
  closing: {
    acceptsConnections: false;
    acceptsEvents: false;
    resourcesAllocated: 'draining';
    isTerminal: false;
  };
  closed: {
    acceptsConnections: false;
    acceptsEvents: false;
    resourcesAllocated: false;
    isTerminal: true;
  };
  error: {
    acceptsConnections: false;
    acceptsEvents: 'recovery';  // Only recovery events
    resourcesAllocated: 'partial';
    requiresDecision: true;
  };
}
```

---

## Events

| Event | Description | Payload | Source |
|-------|-------------|---------|--------|
| `INITIALIZE` | Begin session setup | `{ projectId, userId, config? }` | SessionService |
| `READY` | Session resources ready | `{ sessionId, streamId }` | Initialization logic |
| `PAUSE` | Temporarily suspend session | `{ reason, preserveState? }` | User / System |
| `RESUME` | Resume suspended session | `{ userId? }` | User action |
| `CLOSE` | Begin graceful shutdown | `{ reason?, force? }` | User / System |
| `ERROR` | Session error occurred | `{ error, recoverable }` | Any component |
| `TIMEOUT` | Timeout event triggered | `{ type: 'idle' | 'connection' | 'cleanup' }` | Timer service |
| `HEARTBEAT` | Keep-alive ping | `{ userId, timestamp }` | Presence service |
| `JOIN` | User joins session | `{ userId, metadata? }` | Presence service |
| `LEAVE` | User leaves session | `{ userId, reason? }` | Presence service |

### Event Type Definitions

```typescript
// lib/state-machines/session-lifecycle/events.ts
import { z } from 'zod';

export type SessionEvent =
  | { type: 'INITIALIZE'; projectId: string; userId: string; config?: SessionConfig }
  | { type: 'READY'; sessionId: string; streamId: string }
  | { type: 'PAUSE'; reason: PauseReason; preserveState?: boolean }
  | { type: 'RESUME'; userId?: string }
  | { type: 'CLOSE'; reason?: string; force?: boolean }
  | { type: 'ERROR'; error: AppError; recoverable: boolean }
  | { type: 'TIMEOUT'; timeoutType: TimeoutType }
  | { type: 'HEARTBEAT'; userId: string; timestamp: number }
  | { type: 'JOIN'; userId: string; metadata?: UserMetadata }
  | { type: 'LEAVE'; userId: string; reason?: LeaveReason };

type PauseReason = 'user_request' | 'idle_timeout' | 'system_maintenance' | 'resource_limit';
type TimeoutType = 'idle' | 'connection' | 'cleanup';
type LeaveReason = 'disconnect' | 'timeout' | 'kicked' | 'session_closed';

interface SessionConfig {
  idleTimeoutMs?: number;      // Default: 1800000 (30 min)
  connectionTimeoutMs?: number; // Default: 30000 (30 sec)
  cleanupTimeoutMs?: number;   // Default: 300000 (5 min)
  maxParticipants?: number;    // Default: 10
  heartbeatIntervalMs?: number; // Default: 30000 (30 sec)
  stalePresenceMs?: number;    // Default: 60000 (60 sec)
}

interface UserMetadata {
  name?: string;
  avatar?: string;
  role?: 'owner' | 'collaborator' | 'viewer';
}

// Zod schemas for validation
export const initializeEventSchema = z.object({
  type: z.literal('INITIALIZE'),
  projectId: z.string().cuid2(),
  userId: z.string().cuid2(),
  config: z.object({
    idleTimeoutMs: z.number().min(60000).max(86400000).optional(),
    connectionTimeoutMs: z.number().min(5000).max(120000).optional(),
    cleanupTimeoutMs: z.number().min(30000).max(600000).optional(),
    maxParticipants: z.number().min(1).max(100).optional(),
    heartbeatIntervalMs: z.number().min(10000).max(120000).optional(),
    stalePresenceMs: z.number().min(30000).max(300000).optional(),
  }).optional(),
});

export const readyEventSchema = z.object({
  type: z.literal('READY'),
  sessionId: z.string().cuid2(),
  streamId: z.string(),
});

export const pauseEventSchema = z.object({
  type: z.literal('PAUSE'),
  reason: z.enum(['user_request', 'idle_timeout', 'system_maintenance', 'resource_limit']),
  preserveState: z.boolean().optional(),
});

export const closeEventSchema = z.object({
  type: z.literal('CLOSE'),
  reason: z.string().max(500).optional(),
  force: z.boolean().optional(),
});

export const errorEventSchema = z.object({
  type: z.literal('ERROR'),
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number(),
    details: z.record(z.unknown()).optional(),
  }),
  recoverable: z.boolean(),
});

export const timeoutEventSchema = z.object({
  type: z.literal('TIMEOUT'),
  timeoutType: z.enum(['idle', 'connection', 'cleanup']),
});

export const heartbeatEventSchema = z.object({
  type: z.literal('HEARTBEAT'),
  userId: z.string().cuid2(),
  timestamp: z.number(),
});

export const joinEventSchema = z.object({
  type: z.literal('JOIN'),
  userId: z.string().cuid2(),
  metadata: z.object({
    name: z.string().optional(),
    avatar: z.string().url().optional(),
    role: z.enum(['owner', 'collaborator', 'viewer']).optional(),
  }).optional(),
});

export const leaveEventSchema = z.object({
  type: z.literal('LEAVE'),
  userId: z.string().cuid2(),
  reason: z.enum(['disconnect', 'timeout', 'kicked', 'session_closed']).optional(),
});
```

---

## Guards

Guards are boolean functions that determine if a transition is allowed.

| Guard | Description | Checks |
|-------|-------------|--------|
| `canInitialize` | Session can be created | Project exists, resources available, no active session |
| `canPause` | Session can be paused | Has active connections, not already paused |
| `canResume` | Session can be resumed | Currently paused, resources still available |
| `canClose` | Session can close gracefully | No pending writes, all participants notified |
| `isRecoverable` | Error allows recovery | `error.recoverable === true` and retry count < max |
| `hasActiveConnections` | Session has connected users | `participants.length > 0` |
| `withinParticipantLimit` | Can accept new participant | `participants.length < maxParticipants` |
| `isHeartbeatValid` | Heartbeat is from valid user | User in participants list |
| `canForceClose` | Force close is allowed | Admin user or system event |

### Guard Implementations

```typescript
// lib/state-machines/session-lifecycle/guards.ts
import type { Session, Project, User } from '@/db/schema';
import type { SessionEvent } from './events';

export interface SessionContext {
  session?: Session;
  project: Project;
  participants: Map<string, ParticipantState>;
  config: SessionConfig;
  retryCount: number;
  maxRetries: number;
  lastError?: AppError;
  pendingWrites: number;
  streamId?: string;
}

interface ParticipantState {
  userId: string;
  joinedAt: Date;
  lastHeartbeat: Date;
  metadata?: UserMetadata;
  connectionStatus: 'connected' | 'reconnecting' | 'stale';
}

export const guards = {
  canInitialize: (ctx: SessionContext, event: Extract<SessionEvent, { type: 'INITIALIZE' }>) => {
    // Check project exists
    if (!ctx.project) return false;

    // Check no active session for this project
    if (ctx.session?.status === 'active' || ctx.session?.status === 'paused') {
      return false;
    }

    // Check resources available (placeholder for resource checks)
    return true;
  },

  canPause: (ctx: SessionContext) => {
    return (
      ctx.session?.status === 'active' &&
      ctx.participants.size > 0
    );
  },

  canResume: (ctx: SessionContext) => {
    return (
      ctx.session?.status === 'paused' &&
      ctx.lastError === undefined
    );
  },

  canClose: (ctx: SessionContext, event: Extract<SessionEvent, { type: 'CLOSE' }>) => {
    // Force close bypasses checks
    if (event.force) return true;

    // Check no pending writes
    if (ctx.pendingWrites > 0) return false;

    return true;
  },

  isRecoverable: (ctx: SessionContext, event: Extract<SessionEvent, { type: 'ERROR' }>) => {
    return (
      event.recoverable === true &&
      ctx.retryCount < ctx.maxRetries
    );
  },

  hasActiveConnections: (ctx: SessionContext) => {
    const now = Date.now();
    const staleThreshold = ctx.config.stalePresenceMs ?? 60000;

    // Count non-stale connections
    let activeCount = 0;
    for (const [, participant] of ctx.participants) {
      if (now - participant.lastHeartbeat.getTime() < staleThreshold) {
        activeCount++;
      }
    }

    return activeCount > 0;
  },

  withinParticipantLimit: (ctx: SessionContext) => {
    const maxParticipants = ctx.config.maxParticipants ?? 10;
    return ctx.participants.size < maxParticipants;
  },

  isHeartbeatValid: (ctx: SessionContext, event: Extract<SessionEvent, { type: 'HEARTBEAT' }>) => {
    return ctx.participants.has(event.userId);
  },

  canForceClose: (ctx: SessionContext, event: Extract<SessionEvent, { type: 'CLOSE' }>) => {
    return event.force === true;
  },

  isIdleTimeout: (ctx: SessionContext, event: Extract<SessionEvent, { type: 'TIMEOUT' }>) => {
    return event.timeoutType === 'idle';
  },

  isConnectionTimeout: (ctx: SessionContext, event: Extract<SessionEvent, { type: 'TIMEOUT' }>) => {
    return event.timeoutType === 'connection';
  },

  isCleanupTimeout: (ctx: SessionContext, event: Extract<SessionEvent, { type: 'TIMEOUT' }>) => {
    return event.timeoutType === 'cleanup';
  },
} as const;

export type Guard = keyof typeof guards;
```

---

## Actions

Actions are side effects executed during transitions.

| Action | Description | Async | Publishes Event |
|--------|-------------|-------|-----------------|
| `createSessionRecord` | Create session in database | Yes | `session:created` |
| `initializeStream` | Set up Durable Stream for session | Yes | None |
| `publishSessionEvent` | Emit event to durable stream | Yes | (varies) |
| `notifyParticipants` | Send notification to all participants | Yes | `session:notification` |
| `cleanupResources` | Release session resources | Yes | `session:cleanup` |
| `persistHistory` | Save session history to database | Yes | None |
| `updateSessionStatus` | Update session status in DB | Yes | `session:status` |
| `addParticipant` | Add user to session | Yes | `presence:join` |
| `removeParticipant` | Remove user from session | Yes | `presence:leave` |
| `updateHeartbeat` | Update user's last heartbeat | No | None |
| `cleanupStalePresence` | Remove stale participants | Yes | `presence:cleanup` |
| `startIdleTimer` | Start idle timeout timer | No | None |
| `cancelIdleTimer` | Cancel idle timeout timer | No | None |
| `incrementRetryCount` | Increment error retry count | No | None |
| `resetRetryCount` | Reset error retry count | No | None |

### Action Implementations

```typescript
// lib/state-machines/session-lifecycle/actions.ts
import type { SessionContext } from './guards';
import type { SessionEvent } from './events';
import { DurableStreamClient } from '@durable-streams/client';
import { publishSessionEvent as publishToStream } from '@/lib/events/session';
import { SessionService } from '@/lib/services/session';
import { PresenceService } from '@/lib/services/presence';

export const actions = {
  createSessionRecord: async (
    ctx: SessionContext,
    event: Extract<SessionEvent, { type: 'INITIALIZE' }>
  ) => {
    const session = await SessionService.create({
      projectId: event.projectId,
      createdBy: event.userId,
      config: event.config,
      status: 'initializing',
    });

    await publishToStream(session.id, {
      type: 'session:created',
      sessionId: session.id,
      projectId: event.projectId,
      createdBy: event.userId,
      timestamp: Date.now(),
    });

    return { ok: true, value: session };
  },

  initializeStream: async (ctx: SessionContext) => {
    if (!ctx.session) {
      return { ok: false, error: SessionErrors.NOT_FOUND };
    }

    const client = new DurableStreamClient({
      streamId: `session:${ctx.session.id}`,
    });

    await client.initialize();

    return { ok: true, value: { streamId: client.streamId } };
  },

  publishSessionEvent: async (ctx: SessionContext, event: SessionEvent) => {
    if (!ctx.session || !ctx.streamId) {
      return { ok: false, error: SessionErrors.NOT_INITIALIZED };
    }

    const sessionEvent = mapToSessionEvent(ctx, event);
    await publishToStream(ctx.session.id, sessionEvent);

    return { ok: true, value: null };
  },

  notifyParticipants: async (
    ctx: SessionContext,
    notification: { type: string; message: string; data?: unknown }
  ) => {
    if (!ctx.session) return { ok: true, value: null };

    const notificationEvent = {
      type: 'session:notification',
      sessionId: ctx.session.id,
      notification,
      recipients: Array.from(ctx.participants.keys()),
      timestamp: Date.now(),
    };

    await publishToStream(ctx.session.id, notificationEvent);

    return { ok: true, value: null };
  },

  cleanupResources: async (ctx: SessionContext) => {
    if (!ctx.session) return { ok: true, value: null };

    // Close stream connection
    if (ctx.streamId) {
      const client = new DurableStreamClient({ streamId: ctx.streamId });
      await client.close();
    }

    // Notify remaining participants
    if (ctx.participants.size > 0) {
      await actions.notifyParticipants(ctx, {
        type: 'session_closing',
        message: 'Session is being closed',
      });
    }

    // Publish cleanup event
    await publishToStream(ctx.session.id, {
      type: 'session:cleanup',
      sessionId: ctx.session.id,
      timestamp: Date.now(),
    });

    return { ok: true, value: null };
  },

  persistHistory: async (ctx: SessionContext) => {
    if (!ctx.session) return { ok: true, value: null };

    await SessionService.persistHistory(ctx.session.id, {
      duration: Date.now() - ctx.session.createdAt.getTime(),
      participantCount: ctx.participants.size,
      eventCount: await SessionService.getEventCount(ctx.session.id),
    });

    return { ok: true, value: null };
  },

  updateSessionStatus: async (ctx: SessionContext, status: Session['status']) => {
    if (!ctx.session) return { ok: false, error: SessionErrors.NOT_FOUND };

    const result = await SessionService.updateStatus(ctx.session.id, status);

    if (result.ok) {
      await publishToStream(ctx.session.id, {
        type: 'session:status',
        sessionId: ctx.session.id,
        status,
        timestamp: Date.now(),
      });
    }

    return result;
  },

  addParticipant: async (
    ctx: SessionContext,
    event: Extract<SessionEvent, { type: 'JOIN' }>
  ) => {
    if (!ctx.session) return { ok: false, error: SessionErrors.NOT_FOUND };

    const participant: ParticipantState = {
      userId: event.userId,
      joinedAt: new Date(),
      lastHeartbeat: new Date(),
      metadata: event.metadata,
      connectionStatus: 'connected',
    };

    await PresenceService.join(ctx.session.id, event.userId, event.metadata);

    await publishToStream(ctx.session.id, {
      type: 'presence:join',
      sessionId: ctx.session.id,
      userId: event.userId,
      metadata: event.metadata,
      timestamp: Date.now(),
    });

    return { ok: true, value: participant };
  },

  removeParticipant: async (
    ctx: SessionContext,
    event: Extract<SessionEvent, { type: 'LEAVE' }>
  ) => {
    if (!ctx.session) return { ok: false, error: SessionErrors.NOT_FOUND };

    await PresenceService.leave(ctx.session.id, event.userId);

    await publishToStream(ctx.session.id, {
      type: 'presence:leave',
      sessionId: ctx.session.id,
      userId: event.userId,
      reason: event.reason,
      timestamp: Date.now(),
    });

    return { ok: true, value: null };
  },

  updateHeartbeat: (
    ctx: SessionContext,
    event: Extract<SessionEvent, { type: 'HEARTBEAT' }>
  ) => {
    const participant = ctx.participants.get(event.userId);
    if (participant) {
      participant.lastHeartbeat = new Date(event.timestamp);
      participant.connectionStatus = 'connected';
    }
    return { ok: true, value: null };
  },

  cleanupStalePresence: async (ctx: SessionContext) => {
    if (!ctx.session) return { ok: true, value: null };

    const now = Date.now();
    const staleThreshold = ctx.config.stalePresenceMs ?? 60000;
    const staleUsers: string[] = [];

    for (const [userId, participant] of ctx.participants) {
      if (now - participant.lastHeartbeat.getTime() > staleThreshold) {
        staleUsers.push(userId);
        participant.connectionStatus = 'stale';
      }
    }

    // Remove stale users
    for (const userId of staleUsers) {
      await actions.removeParticipant(ctx, {
        type: 'LEAVE',
        userId,
        reason: 'timeout',
      });
      ctx.participants.delete(userId);
    }

    if (staleUsers.length > 0) {
      await publishToStream(ctx.session.id, {
        type: 'presence:cleanup',
        sessionId: ctx.session.id,
        removedUsers: staleUsers,
        timestamp: Date.now(),
      });
    }

    return { ok: true, value: { removedCount: staleUsers.length } };
  },

  startIdleTimer: (ctx: SessionContext) => {
    const timeoutMs = ctx.config.idleTimeoutMs ?? 1800000; // 30 min default

    // Timer ID would be stored in context for cancellation
    // Implementation depends on timer service
    return { ok: true, value: { timeoutMs } };
  },

  cancelIdleTimer: (ctx: SessionContext) => {
    // Cancel existing timer if present
    // Implementation depends on timer service
    return { ok: true, value: null };
  },

  incrementRetryCount: (ctx: SessionContext) => {
    return { ...ctx, retryCount: ctx.retryCount + 1 };
  },

  resetRetryCount: (ctx: SessionContext) => {
    return { ...ctx, retryCount: 0 };
  },
} as const;

export type Action = keyof typeof actions;
```

---

## Transition Table

| # | From State | Event | Guard(s) | Action(s) | To State |
|---|------------|-------|----------|-----------|----------|
| 1 | `idle` | `INITIALIZE` | `canInitialize` | `createSessionRecord`, `initializeStream` | `initializing` |
| 2 | `initializing` | `READY` | - | `updateSessionStatus`, `startIdleTimer`, `publishSessionEvent` | `active` |
| 3 | `initializing` | `ERROR` | - | `cleanupResources`, `updateSessionStatus` | `error` |
| 4 | `initializing` | `TIMEOUT` | `isConnectionTimeout` | `cleanupResources`, `updateSessionStatus` | `error` |
| 5 | `active` | `JOIN` | `withinParticipantLimit` | `addParticipant`, `cancelIdleTimer`, `publishSessionEvent` | `active` |
| 6 | `active` | `LEAVE` | - | `removeParticipant`, `publishSessionEvent` | `active` |
| 7 | `active` | `HEARTBEAT` | `isHeartbeatValid` | `updateHeartbeat` | `active` |
| 8 | `active` | `PAUSE` | `canPause` | `notifyParticipants`, `updateSessionStatus`, `publishSessionEvent` | `paused` |
| 9 | `active` | `CLOSE` | `canClose` | `notifyParticipants`, `updateSessionStatus` | `closing` |
| 10 | `active` | `ERROR` | `isRecoverable` | `incrementRetryCount`, `publishSessionEvent` | `active` |
| 11 | `active` | `ERROR` | `!isRecoverable` | `notifyParticipants`, `updateSessionStatus` | `error` |
| 12 | `active` | `TIMEOUT` | `isIdleTimeout` | `updateSessionStatus` | `closing` |
| 13 | `paused` | `RESUME` | `canResume` | `updateSessionStatus`, `startIdleTimer`, `publishSessionEvent` | `active` |
| 14 | `paused` | `CLOSE` | - | `updateSessionStatus` | `closing` |
| 15 | `paused` | `TIMEOUT` | `isIdleTimeout` | `updateSessionStatus` | `closing` |
| 16 | `paused` | `ERROR` | - | `updateSessionStatus` | `error` |
| 17 | `closing` | `TIMEOUT` | `isCleanupTimeout` | `cleanupResources`, `persistHistory`, `updateSessionStatus` | `closed` |
| 18 | `closing` | (auto) | `canClose` | `cleanupResources`, `persistHistory`, `updateSessionStatus` | `closed` |
| 19 | `error` | `RESUME` | `isRecoverable` | `resetRetryCount`, `updateSessionStatus` | `active` |
| 20 | `error` | `CLOSE` | - | `cleanupResources`, `persistHistory`, `updateSessionStatus` | `closed` |
| 21 | `error` | `TIMEOUT` | `isCleanupTimeout` | `cleanupResources`, `updateSessionStatus` | `closed` |

### Transition Validation Matrix

```
              | INITIALIZE | READY | PAUSE | RESUME | CLOSE | ERROR | TIMEOUT | HEARTBEAT | JOIN | LEAVE |
--------------+------------+-------+-------+--------+-------+-------+---------+-----------+------+-------|
idle          |     X      |   -   |   -   |   -    |   -   |   -   |    -    |     -     |  -   |   -   |
initializing  |     -      |   X   |   -   |   -    |   -   |   X   |    X    |     -     |  -   |   -   |
active        |     -      |   -   |   X   |   -    |   X   |   X   |    X    |     X     |  X   |   X   |
paused        |     -      |   -   |   -   |   X    |   X   |   X   |    X    |     -     |  -   |   -   |
closing       |     -      |   -   |   -   |   -    |   -   |   -   |    X    |     -     |  -   |   -   |
closed        |     -      |   -   |   -   |   -    |   -   |   -   |    -    |     -     |  -   |   -   |
error         |     -      |   -   |   -   |   X    |   X   |   -   |    X    |     -     |  -   |   -   |

Legend: X = valid transition, - = invalid/no-op
```

---

## Timeouts

### Timeout Configuration

```typescript
// lib/state-machines/session-lifecycle/timeouts.ts

export const DEFAULT_TIMEOUTS = {
  /** Idle timeout - session closes after no activity (default: 30 minutes) */
  IDLE_TIMEOUT_MS: 30 * 60 * 1000, // 1800000

  /** Connection timeout - max time for initial connection (default: 30 seconds) */
  CONNECTION_TIMEOUT_MS: 30 * 1000, // 30000

  /** Cleanup timeout - max time for graceful shutdown (default: 5 minutes) */
  CLEANUP_TIMEOUT_MS: 5 * 60 * 1000, // 300000

  /** Heartbeat interval - frequency of keep-alive pings (default: 30 seconds) */
  HEARTBEAT_INTERVAL_MS: 30 * 1000, // 30000

  /** Stale presence threshold - when to consider user disconnected (default: 60 seconds) */
  STALE_PRESENCE_MS: 60 * 1000, // 60000

  /** Reconnection window - time allowed for reconnection (default: 2 minutes) */
  RECONNECTION_WINDOW_MS: 2 * 60 * 1000, // 120000
} as const;

export type TimeoutConfig = Partial<typeof DEFAULT_TIMEOUTS>;

// Timer management
export interface SessionTimers {
  idle?: ReturnType<typeof setTimeout>;
  cleanup?: ReturnType<typeof setTimeout>;
  staleCheck?: ReturnType<typeof setInterval>;
}

export function createTimerManager(ctx: SessionContext) {
  const timers: SessionTimers = {};

  return {
    startIdleTimer: (onTimeout: () => void) => {
      if (timers.idle) clearTimeout(timers.idle);
      timers.idle = setTimeout(onTimeout, ctx.config.idleTimeoutMs ?? DEFAULT_TIMEOUTS.IDLE_TIMEOUT_MS);
    },

    resetIdleTimer: (onTimeout: () => void) => {
      if (timers.idle) clearTimeout(timers.idle);
      timers.idle = setTimeout(onTimeout, ctx.config.idleTimeoutMs ?? DEFAULT_TIMEOUTS.IDLE_TIMEOUT_MS);
    },

    cancelIdleTimer: () => {
      if (timers.idle) {
        clearTimeout(timers.idle);
        timers.idle = undefined;
      }
    },

    startCleanupTimer: (onTimeout: () => void) => {
      if (timers.cleanup) clearTimeout(timers.cleanup);
      timers.cleanup = setTimeout(onTimeout, ctx.config.cleanupTimeoutMs ?? DEFAULT_TIMEOUTS.CLEANUP_TIMEOUT_MS);
    },

    startStalePresenceCheck: (onCheck: () => void) => {
      if (timers.staleCheck) clearInterval(timers.staleCheck);
      const interval = ctx.config.heartbeatIntervalMs ?? DEFAULT_TIMEOUTS.HEARTBEAT_INTERVAL_MS;
      timers.staleCheck = setInterval(onCheck, interval);
    },

    cancelAll: () => {
      if (timers.idle) clearTimeout(timers.idle);
      if (timers.cleanup) clearTimeout(timers.cleanup);
      if (timers.staleCheck) clearInterval(timers.staleCheck);
    },
  };
}
```

### Timeout Behavior

| Timeout Type | Default Duration | Trigger State | Result State | Description |
|--------------|------------------|---------------|--------------|-------------|
| Idle | 30 minutes | `active`, `paused` | `closing` | No user activity |
| Connection | 30 seconds | `initializing` | `error` | Failed to establish |
| Cleanup | 5 minutes | `closing` | `closed` | Force complete shutdown |
| Stale Presence | 60 seconds | `active` | (cleanup) | Remove inactive users |

---

## Presence Management

### User Join/Leave Handling

```typescript
// lib/state-machines/session-lifecycle/presence.ts
import type { SessionContext, ParticipantState } from './guards';
import type { SessionEvent } from './events';

export interface PresenceManager {
  join(ctx: SessionContext, event: Extract<SessionEvent, { type: 'JOIN' }>): Promise<ParticipantState>;
  leave(ctx: SessionContext, event: Extract<SessionEvent, { type: 'LEAVE' }>): Promise<void>;
  heartbeat(ctx: SessionContext, event: Extract<SessionEvent, { type: 'HEARTBEAT' }>): void;
  cleanupStale(ctx: SessionContext): Promise<string[]>;
  getActiveCount(ctx: SessionContext): number;
  getParticipants(ctx: SessionContext): ParticipantState[];
}

export const presenceManager: PresenceManager = {
  async join(ctx, event) {
    // Validate participant limit
    if (!guards.withinParticipantLimit(ctx)) {
      throw new Error(SessionErrors.PARTICIPANT_LIMIT_EXCEEDED.message);
    }

    const participant: ParticipantState = {
      userId: event.userId,
      joinedAt: new Date(),
      lastHeartbeat: new Date(),
      metadata: event.metadata,
      connectionStatus: 'connected',
    };

    ctx.participants.set(event.userId, participant);

    // Publish join event
    await actions.addParticipant(ctx, event);

    // Reset idle timer since there's activity
    await actions.cancelIdleTimer(ctx);

    return participant;
  },

  async leave(ctx, event) {
    const participant = ctx.participants.get(event.userId);
    if (!participant) return;

    ctx.participants.delete(event.userId);

    // Publish leave event
    await actions.removeParticipant(ctx, event);

    // If no participants left, start idle timer
    if (ctx.participants.size === 0) {
      await actions.startIdleTimer(ctx);
    }
  },

  heartbeat(ctx, event) {
    const participant = ctx.participants.get(event.userId);
    if (participant) {
      participant.lastHeartbeat = new Date(event.timestamp);
      participant.connectionStatus = 'connected';
    }
  },

  async cleanupStale(ctx) {
    const now = Date.now();
    const staleThreshold = ctx.config.stalePresenceMs ?? 60000;
    const staleUserIds: string[] = [];

    for (const [userId, participant] of ctx.participants) {
      const timeSinceHeartbeat = now - participant.lastHeartbeat.getTime();

      if (timeSinceHeartbeat > staleThreshold) {
        // Mark as stale first
        if (participant.connectionStatus !== 'stale') {
          participant.connectionStatus = 'stale';
        } else {
          // Already stale, remove
          staleUserIds.push(userId);
        }
      } else if (timeSinceHeartbeat > staleThreshold / 2) {
        // Transitioning to reconnecting state
        participant.connectionStatus = 'reconnecting';
      }
    }

    // Remove stale users
    for (const userId of staleUserIds) {
      await this.leave(ctx, { type: 'LEAVE', userId, reason: 'timeout' });
    }

    return staleUserIds;
  },

  getActiveCount(ctx) {
    let count = 0;
    for (const participant of ctx.participants.values()) {
      if (participant.connectionStatus === 'connected') {
        count++;
      }
    }
    return count;
  },

  getParticipants(ctx) {
    return Array.from(ctx.participants.values());
  },
};
```

### Heartbeat Mechanism

```typescript
// lib/state-machines/session-lifecycle/heartbeat.ts

export interface HeartbeatService {
  start(sessionId: string, userId: string, intervalMs?: number): void;
  stop(sessionId: string, userId: string): void;
  onHeartbeatReceived(sessionId: string, userId: string, timestamp: number): void;
}

export function createHeartbeatService(
  sendHeartbeat: (sessionId: string, userId: string) => Promise<void>
): HeartbeatService {
  const intervals = new Map<string, ReturnType<typeof setInterval>>();

  const getKey = (sessionId: string, userId: string) => `${sessionId}:${userId}`;

  return {
    start(sessionId, userId, intervalMs = 30000) {
      const key = getKey(sessionId, userId);

      // Clear existing interval if any
      const existing = intervals.get(key);
      if (existing) clearInterval(existing);

      // Start new interval
      const interval = setInterval(async () => {
        try {
          await sendHeartbeat(sessionId, userId);
        } catch (error) {
          console.error('Heartbeat failed:', error);
          // Optionally handle reconnection
        }
      }, intervalMs);

      intervals.set(key, interval);

      // Send initial heartbeat
      sendHeartbeat(sessionId, userId).catch(console.error);
    },

    stop(sessionId, userId) {
      const key = getKey(sessionId, userId);
      const interval = intervals.get(key);
      if (interval) {
        clearInterval(interval);
        intervals.delete(key);
      }
    },

    onHeartbeatReceived(sessionId, userId, timestamp) {
      // This would update the participant's lastHeartbeat in context
      // Implementation depends on how state is managed
    },
  };
}

// Client-side heartbeat React hook
export function useSessionHeartbeat(sessionId: string | null, userId: string) {
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!sessionId) return;

    const sendHeartbeat = async () => {
      try {
        await fetch(`/api/sessions/${sessionId}/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, timestamp: Date.now() }),
        });
      } catch (error) {
        console.error('Heartbeat failed:', error);
      }
    };

    // Send initial heartbeat
    sendHeartbeat();

    // Start interval
    intervalRef.current = setInterval(sendHeartbeat, 30000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [sessionId, userId]);
}
```

---

## Event Publishing

### Session Events to Durable Streams

```typescript
// lib/events/session.ts
import { DurableStreamClient, DurableStreamState } from '@durable-streams/client';

export type SessionStreamEvent =
  // Lifecycle events
  | { type: 'session:created'; sessionId: string; projectId: string; createdBy: string; timestamp: number }
  | { type: 'session:status'; sessionId: string; status: SessionStatus; timestamp: number }
  | { type: 'session:notification'; sessionId: string; notification: Notification; recipients: string[]; timestamp: number }
  | { type: 'session:cleanup'; sessionId: string; timestamp: number }
  | { type: 'session:closed'; sessionId: string; reason?: string; duration: number; timestamp: number }
  // Presence events
  | { type: 'presence:join'; sessionId: string; userId: string; metadata?: UserMetadata; timestamp: number }
  | { type: 'presence:leave'; sessionId: string; userId: string; reason?: LeaveReason; timestamp: number }
  | { type: 'presence:cleanup'; sessionId: string; removedUsers: string[]; timestamp: number }
  | { type: 'presence:heartbeat'; sessionId: string; userId: string; timestamp: number }
  // Error events
  | { type: 'session:error'; sessionId: string; error: AppError; recoverable: boolean; timestamp: number };

interface Notification {
  type: string;
  message: string;
  data?: unknown;
}

// Stream client factory
export function createSessionStream(sessionId: string): DurableStreamClient<SessionStreamEvent> {
  return new DurableStreamClient<SessionStreamEvent>({
    streamId: `session:${sessionId}`,
    persistence: {
      type: 'pglite',
      table: 'session_events',
    },
  });
}

// Publish event helper
export async function publishSessionEvent(
  sessionId: string,
  event: SessionStreamEvent
): Promise<void> {
  const stream = createSessionStream(sessionId);

  try {
    await stream.publish(event);
  } finally {
    await stream.close();
  }
}

// Subscribe to session events
export function subscribeToSession(
  sessionId: string,
  handlers: Partial<{
    [K in SessionStreamEvent['type']]: (event: Extract<SessionStreamEvent, { type: K }>) => void;
  }>
): () => void {
  const stream = createSessionStream(sessionId);

  const unsubscribe = stream.subscribe((event) => {
    const handler = handlers[event.type as keyof typeof handlers];
    if (handler) {
      (handler as (e: SessionStreamEvent) => void)(event);
    }
  });

  return () => {
    unsubscribe();
    stream.close();
  };
}
```

### Event Schemas

```typescript
// lib/events/session-schemas.ts
import { z } from 'zod';

export const sessionCreatedSchema = z.object({
  type: z.literal('session:created'),
  sessionId: z.string().cuid2(),
  projectId: z.string().cuid2(),
  createdBy: z.string().cuid2(),
  timestamp: z.number(),
});

export const sessionStatusSchema = z.object({
  type: z.literal('session:status'),
  sessionId: z.string().cuid2(),
  status: z.enum(['idle', 'initializing', 'active', 'paused', 'closing', 'closed', 'error']),
  timestamp: z.number(),
});

export const presenceJoinSchema = z.object({
  type: z.literal('presence:join'),
  sessionId: z.string().cuid2(),
  userId: z.string().cuid2(),
  metadata: z.object({
    name: z.string().optional(),
    avatar: z.string().url().optional(),
    role: z.enum(['owner', 'collaborator', 'viewer']).optional(),
  }).optional(),
  timestamp: z.number(),
});

export const presenceLeaveSchema = z.object({
  type: z.literal('presence:leave'),
  sessionId: z.string().cuid2(),
  userId: z.string().cuid2(),
  reason: z.enum(['disconnect', 'timeout', 'kicked', 'session_closed']).optional(),
  timestamp: z.number(),
});

export const sessionErrorSchema = z.object({
  type: z.literal('session:error'),
  sessionId: z.string().cuid2(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number(),
    details: z.record(z.unknown()).optional(),
  }),
  recoverable: z.boolean(),
  timestamp: z.number(),
});

// Union schema for all events
export const sessionStreamEventSchema = z.discriminatedUnion('type', [
  sessionCreatedSchema,
  sessionStatusSchema,
  presenceJoinSchema,
  presenceLeaveSchema,
  sessionErrorSchema,
  // ... other schemas
]);
```

---

## Error Recovery

### Recoverable Errors

| Error Code | Description | Recovery Strategy | Max Retries |
|------------|-------------|-------------------|-------------|
| `SESSION_STREAM_DISCONNECTED` | Stream connection lost | Reconnect with backoff | 5 |
| `SESSION_HEARTBEAT_FAILED` | Heartbeat not received | Mark stale, wait for reconnect | 3 |
| `SESSION_RESOURCE_EXHAUSTED` | Resource limit hit | Wait and retry | 3 |
| `SESSION_PARTICIPANT_TIMEOUT` | Participant not responding | Remove after threshold | N/A |
| `SESSION_SYNC_ERROR` | State sync failed | Re-sync from source | 3 |

### Non-Recoverable Errors

| Error Code | Description | Cleanup Action |
|------------|-------------|----------------|
| `SESSION_PROJECT_DELETED` | Project no longer exists | Close session, notify participants |
| `SESSION_DATABASE_CORRUPTION` | Data integrity failure | Close session, log error |
| `SESSION_FATAL_ERROR` | Unrecoverable system error | Force close, cleanup resources |
| `SESSION_SECURITY_VIOLATION` | Security policy violated | Terminate immediately |

### Error Handling Implementation

```typescript
// lib/state-machines/session-lifecycle/error-recovery.ts
import type { SessionContext } from './guards';
import type { AppError } from '@/lib/errors';

export interface RecoveryStrategy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  onRetry?: (ctx: SessionContext, error: AppError, attempt: number) => Promise<void>;
  onMaxRetriesExceeded?: (ctx: SessionContext, error: AppError) => Promise<void>;
}

const DEFAULT_RECOVERY_STRATEGIES: Record<string, RecoveryStrategy> = {
  SESSION_STREAM_DISCONNECTED: {
    maxRetries: 5,
    backoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 30000,
    onRetry: async (ctx, error, attempt) => {
      console.log(`Attempting stream reconnection (attempt ${attempt})`);
      await actions.initializeStream(ctx);
    },
  },
  SESSION_HEARTBEAT_FAILED: {
    maxRetries: 3,
    backoffMs: 5000,
    backoffMultiplier: 1.5,
    maxBackoffMs: 15000,
  },
  SESSION_RESOURCE_EXHAUSTED: {
    maxRetries: 3,
    backoffMs: 10000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
  },
  SESSION_SYNC_ERROR: {
    maxRetries: 3,
    backoffMs: 2000,
    backoffMultiplier: 2,
    maxBackoffMs: 10000,
  },
};

export async function attemptRecovery(
  ctx: SessionContext,
  error: AppError
): Promise<{ recovered: boolean; shouldClose: boolean }> {
  const strategy = DEFAULT_RECOVERY_STRATEGIES[error.code];

  if (!strategy) {
    // Non-recoverable error
    return { recovered: false, shouldClose: true };
  }

  if (ctx.retryCount >= strategy.maxRetries) {
    // Max retries exceeded
    await strategy.onMaxRetriesExceeded?.(ctx, error);
    return { recovered: false, shouldClose: true };
  }

  // Calculate backoff
  const backoff = Math.min(
    strategy.backoffMs * Math.pow(strategy.backoffMultiplier, ctx.retryCount),
    strategy.maxBackoffMs
  );

  // Wait for backoff period
  await new Promise(resolve => setTimeout(resolve, backoff));

  // Attempt recovery
  try {
    await strategy.onRetry?.(ctx, error, ctx.retryCount + 1);
    return { recovered: true, shouldClose: false };
  } catch (retryError) {
    return { recovered: false, shouldClose: ctx.retryCount + 1 >= strategy.maxRetries };
  }
}

export function isRecoverableError(error: AppError): boolean {
  return error.code in DEFAULT_RECOVERY_STRATEGIES;
}

export function getRecoveryStrategy(errorCode: string): RecoveryStrategy | undefined {
  return DEFAULT_RECOVERY_STRATEGIES[errorCode];
}
```

---

## XState Machine Configuration

```typescript
// lib/state-machines/session-lifecycle/machine.ts
import { createMachine, assign, fromPromise } from 'xstate';
import type { SessionContext } from './guards';
import type { SessionEvent } from './events';
import { guards } from './guards';
import { actions } from './actions';
import { DEFAULT_TIMEOUTS } from './timeouts';

export const sessionLifecycleMachine = createMachine({
  id: 'sessionLifecycle',
  initial: 'idle',
  context: {} as SessionContext,

  states: {
    idle: {
      on: {
        INITIALIZE: {
          target: 'initializing',
          guard: 'canInitialize',
          actions: ['createSessionRecord', 'initializeStream'],
        },
      },
    },

    initializing: {
      after: {
        CONNECTION_TIMEOUT: {
          target: 'error',
          actions: ['captureTimeoutError'],
        },
      },
      on: {
        READY: {
          target: 'active',
          actions: ['updateSessionStatus', 'startIdleTimer', 'publishSessionEvent'],
        },
        ERROR: {
          target: 'error',
          actions: ['cleanupResources', 'updateSessionStatus'],
        },
      },
    },

    active: {
      entry: ['startStalePresenceCheck'],
      exit: ['cancelIdleTimer', 'stopStalePresenceCheck'],
      on: {
        JOIN: {
          target: 'active',
          guard: 'withinParticipantLimit',
          actions: ['addParticipant', 'resetIdleTimer', 'publishSessionEvent'],
        },
        LEAVE: {
          target: 'active',
          actions: ['removeParticipant', 'checkIdleTimer', 'publishSessionEvent'],
        },
        HEARTBEAT: {
          target: 'active',
          guard: 'isHeartbeatValid',
          actions: ['updateHeartbeat', 'resetIdleTimer'],
        },
        PAUSE: {
          target: 'paused',
          guard: 'canPause',
          actions: ['notifyParticipants', 'updateSessionStatus', 'publishSessionEvent'],
        },
        CLOSE: {
          target: 'closing',
          guard: 'canClose',
          actions: ['notifyParticipants', 'updateSessionStatus'],
        },
        ERROR: [
          {
            target: 'active',
            guard: 'isRecoverable',
            actions: ['incrementRetryCount', 'publishSessionEvent', 'attemptRecovery'],
          },
          {
            target: 'error',
            actions: ['notifyParticipants', 'updateSessionStatus'],
          },
        ],
        TIMEOUT: {
          target: 'closing',
          guard: 'isIdleTimeout',
          actions: ['updateSessionStatus'],
        },
      },
    },

    paused: {
      after: {
        IDLE_TIMEOUT: {
          target: 'closing',
          actions: ['updateSessionStatus'],
        },
      },
      on: {
        RESUME: {
          target: 'active',
          guard: 'canResume',
          actions: ['updateSessionStatus', 'startIdleTimer', 'publishSessionEvent'],
        },
        CLOSE: {
          target: 'closing',
          actions: ['updateSessionStatus'],
        },
        ERROR: {
          target: 'error',
          actions: ['updateSessionStatus'],
        },
      },
    },

    closing: {
      entry: ['startCleanupTimer'],
      after: {
        CLEANUP_TIMEOUT: {
          target: 'closed',
          actions: ['forceCleanup', 'persistHistory', 'updateSessionStatus'],
        },
      },
      invoke: {
        id: 'gracefulShutdown',
        src: fromPromise(async ({ input }: { input: SessionContext }) => {
          await actions.cleanupResources(input);
          await actions.persistHistory(input);
          return { success: true };
        }),
        input: ({ context }) => context,
        onDone: {
          target: 'closed',
          actions: ['updateSessionStatus'],
        },
        onError: {
          target: 'closed',
          actions: ['logCleanupError', 'updateSessionStatus'],
        },
      },
    },

    closed: {
      type: 'final',
      entry: ['publishSessionClosed'],
    },

    error: {
      entry: ['captureError'],
      after: {
        CLEANUP_TIMEOUT: {
          target: 'closed',
          actions: ['cleanupResources', 'updateSessionStatus'],
        },
      },
      on: {
        RESUME: {
          target: 'active',
          guard: ({ context }) =>
            guards.isRecoverable(context, { type: 'ERROR', error: context.lastError!, recoverable: true }),
          actions: ['resetRetryCount', 'updateSessionStatus'],
        },
        CLOSE: {
          target: 'closed',
          actions: ['cleanupResources', 'persistHistory', 'updateSessionStatus'],
        },
      },
    },
  },
}, {
  delays: {
    CONNECTION_TIMEOUT: ({ context }) =>
      context.config.connectionTimeoutMs ?? DEFAULT_TIMEOUTS.CONNECTION_TIMEOUT_MS,
    IDLE_TIMEOUT: ({ context }) =>
      context.config.idleTimeoutMs ?? DEFAULT_TIMEOUTS.IDLE_TIMEOUT_MS,
    CLEANUP_TIMEOUT: ({ context }) =>
      context.config.cleanupTimeoutMs ?? DEFAULT_TIMEOUTS.CLEANUP_TIMEOUT_MS,
  },
  guards: {
    canInitialize: ({ context, event }) =>
      guards.canInitialize(context, event as Extract<SessionEvent, { type: 'INITIALIZE' }>),
    canPause: ({ context }) => guards.canPause(context),
    canResume: ({ context }) => guards.canResume(context),
    canClose: ({ context, event }) =>
      guards.canClose(context, event as Extract<SessionEvent, { type: 'CLOSE' }>),
    isRecoverable: ({ context, event }) =>
      guards.isRecoverable(context, event as Extract<SessionEvent, { type: 'ERROR' }>),
    withinParticipantLimit: ({ context }) => guards.withinParticipantLimit(context),
    isHeartbeatValid: ({ context, event }) =>
      guards.isHeartbeatValid(context, event as Extract<SessionEvent, { type: 'HEARTBEAT' }>),
    isIdleTimeout: ({ context, event }) =>
      guards.isIdleTimeout(context, event as Extract<SessionEvent, { type: 'TIMEOUT' }>),
  },
  actions: {
    createSessionRecord: ({ context, event }) =>
      actions.createSessionRecord(context, event as Extract<SessionEvent, { type: 'INITIALIZE' }>),
    initializeStream: ({ context }) => actions.initializeStream(context),
    updateSessionStatus: assign(({ context, event }) => ({
      ...context,
      session: context.session
        ? { ...context.session, status: getTargetStatus(event) }
        : context.session,
    })),
    publishSessionEvent: ({ context, event }) => actions.publishSessionEvent(context, event),
    notifyParticipants: ({ context }, params) =>
      actions.notifyParticipants(context, params as { type: string; message: string }),
    cleanupResources: ({ context }) => actions.cleanupResources(context),
    persistHistory: ({ context }) => actions.persistHistory(context),
    addParticipant: ({ context, event }) =>
      actions.addParticipant(context, event as Extract<SessionEvent, { type: 'JOIN' }>),
    removeParticipant: ({ context, event }) =>
      actions.removeParticipant(context, event as Extract<SessionEvent, { type: 'LEAVE' }>),
    updateHeartbeat: ({ context, event }) =>
      actions.updateHeartbeat(context, event as Extract<SessionEvent, { type: 'HEARTBEAT' }>),
    startIdleTimer: ({ context }) => actions.startIdleTimer(context),
    resetIdleTimer: ({ context }) => {
      actions.cancelIdleTimer(context);
      actions.startIdleTimer(context);
    },
    cancelIdleTimer: ({ context }) => actions.cancelIdleTimer(context),
    incrementRetryCount: assign(({ context }) => actions.incrementRetryCount(context)),
    resetRetryCount: assign(({ context }) => actions.resetRetryCount(context)),
  },
});

function getTargetStatus(event: SessionEvent): SessionStatus {
  // Map events to target status
  const statusMap: Partial<Record<SessionEvent['type'], SessionStatus>> = {
    READY: 'active',
    PAUSE: 'paused',
    RESUME: 'active',
    CLOSE: 'closing',
    ERROR: 'error',
  };
  return statusMap[event.type] ?? 'active';
}

export type SessionLifecycleMachine = typeof sessionLifecycleMachine;
```

---

## Integration with SessionService

```typescript
// lib/services/session.ts
import { createActor, type ActorRefFrom } from 'xstate';
import { sessionLifecycleMachine, type SessionLifecycleMachine } from '@/lib/state-machines/session-lifecycle/machine';
import type { SessionContext } from '@/lib/state-machines/session-lifecycle/guards';
import type { SessionEvent } from '@/lib/state-machines/session-lifecycle/events';
import { db } from '@/db';
import { sessions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';

export class SessionService {
  private static actors = new Map<string, ActorRefFrom<SessionLifecycleMachine>>();

  static async create(params: {
    projectId: string;
    createdBy: string;
    config?: SessionConfig;
  }): Promise<Session> {
    const sessionId = createId();

    // Insert session record
    const [session] = await db.insert(sessions).values({
      id: sessionId,
      projectId: params.projectId,
      createdBy: params.createdBy,
      status: 'initializing',
      config: params.config ?? {},
      createdAt: new Date(),
    }).returning();

    return session;
  }

  static async start(
    projectId: string,
    userId: string,
    config?: SessionConfig
  ): Promise<{ session: Session; actor: ActorRefFrom<SessionLifecycleMachine> }> {
    // Get project
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project) {
      throw SessionErrors.PROJECT_NOT_FOUND;
    }

    // Create initial context
    const context: SessionContext = {
      project,
      participants: new Map(),
      config: config ?? {},
      retryCount: 0,
      maxRetries: 3,
      pendingWrites: 0,
    };

    // Create actor
    const actor = createActor(sessionLifecycleMachine, { context });

    // Start actor
    actor.start();

    // Send INITIALIZE event
    actor.send({ type: 'INITIALIZE', projectId, userId, config });

    // Wait for READY or ERROR
    const snapshot = await new Promise<typeof actor.getSnapshot>((resolve, reject) => {
      const subscription = actor.subscribe((state) => {
        if (state.value === 'active') {
          subscription.unsubscribe();
          resolve(() => state);
        } else if (state.value === 'error') {
          subscription.unsubscribe();
          reject(state.context.lastError);
        }
      });
    });

    const session = snapshot().context.session!;

    // Store actor reference
    this.actors.set(session.id, actor);

    return { session, actor };
  }

  static getActor(sessionId: string): ActorRefFrom<SessionLifecycleMachine> | undefined {
    return this.actors.get(sessionId);
  }

  static async send(sessionId: string, event: SessionEvent): Promise<void> {
    const actor = this.actors.get(sessionId);
    if (!actor) {
      throw SessionErrors.NOT_FOUND;
    }
    actor.send(event);
  }

  static async join(sessionId: string, userId: string, metadata?: UserMetadata): Promise<void> {
    await this.send(sessionId, { type: 'JOIN', userId, metadata });
  }

  static async leave(sessionId: string, userId: string, reason?: LeaveReason): Promise<void> {
    await this.send(sessionId, { type: 'LEAVE', userId, reason });
  }

  static async pause(sessionId: string, reason: PauseReason): Promise<void> {
    await this.send(sessionId, { type: 'PAUSE', reason });
  }

  static async resume(sessionId: string, userId?: string): Promise<void> {
    await this.send(sessionId, { type: 'RESUME', userId });
  }

  static async close(sessionId: string, reason?: string, force?: boolean): Promise<void> {
    await this.send(sessionId, { type: 'CLOSE', reason, force });

    // Wait for closed state
    const actor = this.actors.get(sessionId);
    if (actor) {
      await new Promise<void>((resolve) => {
        const subscription = actor.subscribe((state) => {
          if (state.value === 'closed') {
            subscription.unsubscribe();
            this.actors.delete(sessionId);
            resolve();
          }
        });
      });
    }
  }

  static async updateStatus(sessionId: string, status: SessionStatus): Promise<Result<Session, AppError>> {
    try {
      const [session] = await db
        .update(sessions)
        .set({ status, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId))
        .returning();

      return ok(session);
    } catch (error) {
      return err(SessionErrors.UPDATE_FAILED);
    }
  }

  static async persistHistory(sessionId: string, stats: SessionStats): Promise<void> {
    await db.update(sessions).set({
      duration: stats.duration,
      participantCount: stats.participantCount,
      eventCount: stats.eventCount,
      closedAt: new Date(),
    }).where(eq(sessions.id, sessionId));
  }

  static async getEventCount(sessionId: string): Promise<number> {
    // Query event count from durable stream storage
    const result = await db.execute(
      `SELECT COUNT(*) as count FROM session_events WHERE session_id = $1`,
      [sessionId]
    );
    return Number(result[0]?.count ?? 0);
  }
}
```

---

## React Hooks for Session State

```typescript
// lib/hooks/use-session.ts
import { useEffect, useState, useCallback, useSyncExternalStore } from 'react';
import { type ActorRefFrom } from 'xstate';
import { SessionService } from '@/lib/services/session';
import type { SessionLifecycleMachine } from '@/lib/state-machines/session-lifecycle/machine';
import type { SessionEvent } from '@/lib/state-machines/session-lifecycle/events';
import { useSessionHeartbeat } from '@/lib/state-machines/session-lifecycle/heartbeat';

interface UseSessionOptions {
  projectId: string;
  userId: string;
  autoConnect?: boolean;
}

interface UseSessionReturn {
  session: Session | null;
  status: SessionStatus;
  participants: ParticipantState[];
  isConnected: boolean;
  isLoading: boolean;
  error: AppError | null;
  join: () => Promise<void>;
  leave: () => Promise<void>;
  pause: (reason?: PauseReason) => Promise<void>;
  resume: () => Promise<void>;
  close: (reason?: string) => Promise<void>;
}

export function useSession(options: UseSessionOptions): UseSessionReturn {
  const { projectId, userId, autoConnect = true } = options;

  const [actor, setActor] = useState<ActorRefFrom<SessionLifecycleMachine> | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  // Subscribe to actor state
  const snapshot = useSyncExternalStore(
    useCallback(
      (callback) => {
        if (!actor) return () => {};
        const subscription = actor.subscribe(callback);
        return () => subscription.unsubscribe();
      },
      [actor]
    ),
    useCallback(() => actor?.getSnapshot(), [actor]),
    useCallback(() => null, [])
  );

  // Start heartbeat when connected
  const sessionId = snapshot?.context.session?.id ?? null;
  useSessionHeartbeat(
    snapshot?.value === 'active' ? sessionId : null,
    userId
  );

  // Initialize session
  useEffect(() => {
    if (!autoConnect) return;

    let mounted = true;

    const initSession = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const { actor: newActor } = await SessionService.start(projectId, userId);

        if (mounted) {
          setActor(newActor);
        }
      } catch (err) {
        if (mounted) {
          setError(err as AppError);
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    initSession();

    return () => {
      mounted = false;
      if (actor) {
        actor.send({ type: 'CLOSE', reason: 'component_unmount' });
      }
    };
  }, [projectId, userId, autoConnect]);

  // Action handlers
  const join = useCallback(async () => {
    if (!sessionId) return;
    await SessionService.join(sessionId, userId);
  }, [sessionId, userId]);

  const leave = useCallback(async () => {
    if (!sessionId) return;
    await SessionService.leave(sessionId, userId, 'disconnect');
  }, [sessionId, userId]);

  const pause = useCallback(async (reason: PauseReason = 'user_request') => {
    if (!sessionId) return;
    await SessionService.pause(sessionId, reason);
  }, [sessionId]);

  const resume = useCallback(async () => {
    if (!sessionId) return;
    await SessionService.resume(sessionId, userId);
  }, [sessionId, userId]);

  const close = useCallback(async (reason?: string) => {
    if (!sessionId) return;
    await SessionService.close(sessionId, reason);
  }, [sessionId]);

  return {
    session: snapshot?.context.session ?? null,
    status: (snapshot?.value as SessionStatus) ?? 'idle',
    participants: snapshot?.context.participants
      ? Array.from(snapshot.context.participants.values())
      : [],
    isConnected: snapshot?.value === 'active',
    isLoading,
    error,
    join,
    leave,
    pause,
    resume,
    close,
  };
}

// Hook for presence awareness
export function useSessionPresence(sessionId: string | null) {
  const [participants, setParticipants] = useState<ParticipantState[]>([]);

  useEffect(() => {
    if (!sessionId) return;

    const unsubscribe = subscribeToSession(sessionId, {
      'presence:join': (event) => {
        setParticipants((prev) => [
          ...prev,
          {
            userId: event.userId,
            joinedAt: new Date(event.timestamp),
            lastHeartbeat: new Date(event.timestamp),
            metadata: event.metadata,
            connectionStatus: 'connected',
          },
        ]);
      },
      'presence:leave': (event) => {
        setParticipants((prev) =>
          prev.filter((p) => p.userId !== event.userId)
        );
      },
      'presence:cleanup': (event) => {
        setParticipants((prev) =>
          prev.filter((p) => !event.removedUsers.includes(p.userId))
        );
      },
    });

    return unsubscribe;
  }, [sessionId]);

  return participants;
}

// Hook for session status monitoring
export function useSessionStatus(sessionId: string | null) {
  const [status, setStatus] = useState<SessionStatus>('idle');

  useEffect(() => {
    if (!sessionId) return;

    const unsubscribe = subscribeToSession(sessionId, {
      'session:status': (event) => {
        setStatus(event.status);
      },
    });

    return unsubscribe;
  }, [sessionId]);

  return status;
}
```

---

## Error Integration

| Transition | Possible Errors | Error Code | Recovery |
|------------|-----------------|------------|----------|
| `INITIALIZE` | Project not found | `SESSION_PROJECT_NOT_FOUND` | Select valid project |
| `INITIALIZE` | Active session exists | `SESSION_ALREADY_ACTIVE` | Join existing session |
| `INITIALIZE` | Resource exhausted | `SESSION_RESOURCE_EXHAUSTED` | Retry with backoff |
| `JOIN` | Participant limit | `SESSION_PARTICIPANT_LIMIT` | Wait for slot |
| `JOIN` | Session not active | `SESSION_NOT_ACTIVE` | Wait for active state |
| `HEARTBEAT` | Invalid user | `SESSION_INVALID_PARTICIPANT` | Re-join session |
| `PAUSE` | No connections | `SESSION_NO_CONNECTIONS` | Cannot pause empty session |
| `RESUME` | Not paused | `SESSION_NOT_PAUSED` | Already active |
| `CLOSE` | Pending writes | `SESSION_PENDING_WRITES` | Wait or force close |

---

## Testing

### Unit Tests

```typescript
// tests/state-machines/session-lifecycle.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createActor } from 'xstate';
import { sessionLifecycleMachine } from '@/lib/state-machines/session-lifecycle';
import type { SessionContext } from '@/lib/state-machines/session-lifecycle/guards';

describe('Session Lifecycle State Machine', () => {
  let defaultContext: SessionContext;

  beforeEach(() => {
    defaultContext = {
      project: { id: 'project-1', path: '/test' } as Project,
      participants: new Map(),
      config: {},
      retryCount: 0,
      maxRetries: 3,
      pendingWrites: 0,
    };
  });

  it('transitions from idle to initializing on INITIALIZE', () => {
    const actor = createActor(sessionLifecycleMachine, { context: defaultContext });
    actor.start();

    actor.send({
      type: 'INITIALIZE',
      projectId: 'project-1',
      userId: 'user-1',
    });

    expect(actor.getSnapshot().value).toBe('initializing');
  });

  it('transitions from initializing to active on READY', () => {
    const actor = createActor(sessionLifecycleMachine, {
      context: { ...defaultContext, session: { id: 'session-1', status: 'initializing' } as Session },
    });
    actor.start();

    // Manually set to initializing state
    const state = actor.getSnapshot();
    actor.send({ type: 'READY', sessionId: 'session-1', streamId: 'stream-1' });

    expect(actor.getSnapshot().value).toBe('active');
  });

  it('transitions from active to paused on PAUSE', () => {
    const contextWithSession: SessionContext = {
      ...defaultContext,
      session: { id: 'session-1', status: 'active' } as Session,
      participants: new Map([['user-1', {} as ParticipantState]]),
    };

    const actor = createActor(sessionLifecycleMachine.withContext(contextWithSession));
    // Set initial state to active
    actor.start();

    actor.send({ type: 'PAUSE', reason: 'user_request' });

    expect(actor.getSnapshot().value).toBe('paused');
  });

  it('transitions from paused to active on RESUME', () => {
    const contextWithSession: SessionContext = {
      ...defaultContext,
      session: { id: 'session-1', status: 'paused' } as Session,
    };

    const actor = createActor(sessionLifecycleMachine, { context: contextWithSession });
    actor.start();

    actor.send({ type: 'RESUME', userId: 'user-1' });

    expect(actor.getSnapshot().value).toBe('active');
  });

  it('transitions from active to closing on CLOSE', () => {
    const contextWithSession: SessionContext = {
      ...defaultContext,
      session: { id: 'session-1', status: 'active' } as Session,
    };

    const actor = createActor(sessionLifecycleMachine, { context: contextWithSession });
    actor.start();

    actor.send({ type: 'CLOSE', reason: 'user_request' });

    expect(actor.getSnapshot().value).toBe('closing');
  });

  it('adds participant on JOIN within limit', () => {
    const contextWithSession: SessionContext = {
      ...defaultContext,
      session: { id: 'session-1', status: 'active' } as Session,
      config: { maxParticipants: 10 },
    };

    const actor = createActor(sessionLifecycleMachine, { context: contextWithSession });
    actor.start();

    actor.send({ type: 'JOIN', userId: 'user-2', metadata: { name: 'User 2' } });

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.participants.size).toBe(1);
  });

  it('rejects JOIN when at participant limit', () => {
    const fullParticipants = new Map();
    for (let i = 0; i < 10; i++) {
      fullParticipants.set(`user-${i}`, {} as ParticipantState);
    }

    const contextWithSession: SessionContext = {
      ...defaultContext,
      session: { id: 'session-1', status: 'active' } as Session,
      config: { maxParticipants: 10 },
      participants: fullParticipants,
    };

    const actor = createActor(sessionLifecycleMachine, { context: contextWithSession });
    actor.start();

    actor.send({ type: 'JOIN', userId: 'user-new' });

    // Should still be at 10 participants
    expect(actor.getSnapshot().context.participants.size).toBe(10);
  });

  it('handles recoverable errors without state change', () => {
    const contextWithSession: SessionContext = {
      ...defaultContext,
      session: { id: 'session-1', status: 'active' } as Session,
    };

    const actor = createActor(sessionLifecycleMachine, { context: contextWithSession });
    actor.start();

    actor.send({
      type: 'ERROR',
      error: { code: 'SESSION_SYNC_ERROR', message: 'Sync failed', status: 500 },
      recoverable: true,
    });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe('active');
    expect(snapshot.context.retryCount).toBe(1);
  });

  it('transitions to error on non-recoverable error', () => {
    const contextWithSession: SessionContext = {
      ...defaultContext,
      session: { id: 'session-1', status: 'active' } as Session,
    };

    const actor = createActor(sessionLifecycleMachine, { context: contextWithSession });
    actor.start();

    actor.send({
      type: 'ERROR',
      error: { code: 'SESSION_FATAL_ERROR', message: 'Fatal error', status: 500 },
      recoverable: false,
    });

    expect(actor.getSnapshot().value).toBe('error');
  });

  it('updates heartbeat timestamp on HEARTBEAT', () => {
    const participant: ParticipantState = {
      userId: 'user-1',
      joinedAt: new Date(),
      lastHeartbeat: new Date(Date.now() - 60000),
      connectionStatus: 'connected',
    };

    const contextWithSession: SessionContext = {
      ...defaultContext,
      session: { id: 'session-1', status: 'active' } as Session,
      participants: new Map([['user-1', participant]]),
    };

    const actor = createActor(sessionLifecycleMachine, { context: contextWithSession });
    actor.start();

    const now = Date.now();
    actor.send({ type: 'HEARTBEAT', userId: 'user-1', timestamp: now });

    const updatedParticipant = actor.getSnapshot().context.participants.get('user-1');
    expect(updatedParticipant?.lastHeartbeat.getTime()).toBe(now);
  });
});
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Agent Lifecycle](./agent-lifecycle.md) | Agents operate within sessions |
| [Task Workflow](./task-workflow.md) | Tasks execute in session context |
| [Database Schema](../database/schema.md) | Session table definitions |
| [Error Catalog](../errors/error-catalog.md) | Session error codes |
| [API Endpoints](../api/endpoints.md) | Session REST endpoints |
| [Durable Streams](../integrations/durable-streams.md) | Event publishing format |
| [User Stories](../user-stories.md) | Session requirements |
