# SessionService Specification

## Overview

The SessionService manages collaborative agent sessions with real-time event streaming, presence tracking, and URL-addressable session access. It is implemented as a **facade pattern** composing three focused services:

- **SessionCrudService** (`src/services/session/session-crud.service.ts`) - CRUD operations
- **SessionPresenceService** (`src/services/session/session-presence.service.ts`) - User presence management
- **SessionStreamService** (`src/services/session/session-stream.service.ts`) - Event streaming and persistence

The facade (`src/services/session.service.ts`) re-exports all methods and types for backward compatibility.

**Related Wireframes:**

- [Agent Session Presence](/specs/wireframes/agent-session-presence.html) - Real-time presence indicators, share URLs
- [Session History](/specs/wireframes/session-history.html) - Session replay, timeline, audit trail
- [GitHub Terminal Split](/specs/wireframes/github-terminal-split.html) - Agent stream, file preview

---

## Session Status Lifecycle

Sessions use a 7-state lifecycle:

```
idle -> initializing -> active -> paused -> active -> closing -> closed
                              \-> error
```

| Status | Description |
|--------|-------------|
| `idle` | Default initial state |
| `initializing` | Session being set up (stream creation) |
| `active` | Session is live and accepting events |
| `paused` | Session temporarily paused |
| `closing` | Session is being closed |
| `closed` | Session is closed (preserved for replay) |
| `error` | Session encountered an error |

---

## Constructor

```typescript
constructor(db: Database, streams: DurableStreamsServer, config: { baseUrl: string })
```

The facade instantiates sub-services with shared dependencies:
- `SessionStreamService` receives `db` and `streams`
- `SessionCrudService` receives `db`, `streams`, `config`, and shared `presenceStore`
- `SessionPresenceService` receives `db`, `presenceStore`, and a getter for `SessionStreamService`

---

## Session Schema

```typescript
sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  taskId: text('task_id').references(() => tasks.id),
  agentId: text('agent_id').references(() => agents.id),
  status: text('status').$type<SessionStatus>().default('idle').notNull(),
  title: text('title'),
  url: text('url').notNull(),
  sandboxProvider: text('sandbox_provider'),
  sandboxContainerId: text('sandbox_container_id'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  closedAt: text('closed_at'),
});
```

Key fields:
- `sandboxProvider` - Tracks which sandbox provider created this session (e.g., `docker`, `kubernetes`, `agentcore`)
- `sandboxContainerId` - The container ID associated with this session

---

## CRUD Operations (SessionCrudService)

### create

Creates a new session, initializes a Durable Stream, and transitions to `active`.

```typescript
async create(input: CreateSessionInput): Promise<Result<SessionWithPresence, SessionError>>
```

**Input:**
```typescript
type CreateSessionInput = {
  projectId: string;
  taskId?: string;
  agentId?: string;
  title?: string;
};
```

**Flow:**
1. Validate project exists
2. Insert session with status `initializing`
3. Create Durable Stream for the session
4. Update status to `active`
5. Return session with empty presence array

### getById

```typescript
async getById(id: string): Promise<Result<SessionWithPresence, SessionError>>
```

Returns session with current presence data from the in-memory store.

### list

```typescript
async list(options?: ListSessionsOptions): Promise<Result<SessionWithPresence[], SessionError>>
```

**Options:**
```typescript
type ListSessionsOptions = {
  limit?: number;       // default: 50
  offset?: number;      // default: 0
  orderBy?: 'createdAt' | 'updatedAt';  // default: 'updatedAt'
  orderDirection?: 'asc' | 'desc';      // default: 'desc'
};
```

### listSessionsWithFilters

Enhanced listing with status, date, agent, and search filters.

```typescript
async listSessionsWithFilters(
  projectId: string,
  options?: ListSessionsWithFiltersOptions
): Promise<Result<{ sessions: SessionWithPresence[]; total: number }, SessionError>>
```

**Filter Options:**
```typescript
type ListSessionsWithFiltersOptions = {
  status?: SessionStatus[];
  agentId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;      // Title search (LIKE)
  limit?: number;       // default: 20
  offset?: number;      // default: 0
};
```

### close

Closes a session by setting status to `closed` and `closedAt` timestamp.

```typescript
async close(id: string): Promise<Result<SessionWithPresence, SessionError>>
```

### delete

Deletes a session and cascades to `sessionEvents` and `sessionSummaries`.

```typescript
async delete(id: string): Promise<Result<{ deleted: boolean }, SessionError>>
```

### URL Helpers

```typescript
generateUrl(sessionId: string): string
parseUrl(url: string): Result<string, SessionError>
```

---

## Presence Operations (SessionPresenceService)

### join

Adds a user to the session's active participants.

```typescript
async join(sessionId: string, userId: string): Promise<Result<SessionWithPresence, SessionError>>
```

Publishes a `presence:joined` event. Rejects if session is `closed`.

### leave

Removes a user from active participants.

```typescript
async leave(sessionId: string, userId: string): Promise<Result<SessionWithPresence, SessionError>>
```

Publishes a `presence:left` event.

### updatePresence

Updates a user's cursor position or active file.

```typescript
async updatePresence(
  sessionId: string,
  userId: string,
  presenceUpdate: PresenceUpdate
): Promise<Result<void, SessionError>>
```

**PresenceUpdate:**
```typescript
type PresenceUpdate = {
  cursor?: { x: number; y: number };
  activeFile?: string;
};
```

Publishes a `presence:cursor` event.

### getActiveUsers

```typescript
async getActiveUsers(sessionId: string): Promise<Result<ActiveUser[], SessionError>>
```

**ActiveUser:**
```typescript
type ActiveUser = {
  userId: string;
  lastSeen: number;
  cursor?: { x: number; y: number };
  activeFile?: string;
};
```

Presence is stored in-memory via a shared `Map<string, Map<string, ActiveUser>>`.

---

## Streaming Operations (SessionStreamService)

### publish

Publishes an event to both the real-time Durable Stream and persists to the `sessionEvents` table (non-blocking).

```typescript
async publish(
  sessionId: string,
  event: SessionEvent
): Promise<Result<{ offset: number }, SessionError>>
```

### subscribe

Yields historical events and (in the future) live events. Currently only history replay is functional; live SSE is handled by Caddy durable streams directly.

```typescript
async *subscribe(sessionId: string, options?: SubscribeOptions): AsyncIterable<SessionEvent>
```

### persistEvent

Persists an event to the `sessionEvents` table with automatic offset calculation and retry logic for concurrent inserts.

```typescript
async persistEvent(
  sessionId: string,
  event: SessionEvent,
  retryCount?: number
): Promise<Result<{ id: string; offset: number }, SessionError>>
```

### getEventsBySession

Retrieves persisted events with pagination.

```typescript
async getEventsBySession(
  sessionId: string,
  options?: GetEventsBySessionOptions
): Promise<Result<SessionEvent[], SessionError>>
```

### getSessionSummary / updateSessionSummary

Read and write session aggregation data from the `sessionSummaries` table.

```typescript
async getSessionSummary(sessionId: string): Promise<Result<SessionSummary | null, SessionError>>
async updateSessionSummary(
  sessionId: string,
  updates: Partial<NewSessionSummary>
): Promise<Result<SessionSummary, SessionError>>
```

### Channel Mapping

Events are categorized into channels based on their type prefix:

| Event Type Pattern | Channel |
|-------------------|---------|
| `chunk` | `chunks` |
| `tool:*` | `toolCalls` |
| `terminal:*` | `terminal` |
| `presence:*` | `presence` |
| `approval:*` | `approval` |
| `agent:*` | `agent` |
| `state:update` | `state` |
| other | `other` |

---

## Session Event Types

```typescript
type SessionEventType =
  // Core streaming
  | 'chunk'
  | 'tool:start' | 'tool:result'
  // Presence
  | 'presence:joined' | 'presence:left' | 'presence:cursor'
  // Terminal
  | 'terminal:input' | 'terminal:output'
  // Approval workflow
  | 'approval:requested' | 'approval:approved' | 'approval:rejected'
  // Agent lifecycle
  | 'state:update'
  | 'agent:started' | 'agent:planning' | 'agent:plan_ready'
  | 'agent:turn' | 'agent:turn_limit'
  | 'agent:completed' | 'agent:error'
  | 'agent:warning' | 'agent:metrics'
  | 'agent:tool_progress' | 'agent:compacted'
  // Container agent events
  | 'container-agent:started' | 'container-agent:token'
  | 'container-agent:turn' | 'container-agent:tool:start'
  | 'container-agent:tool:result' | 'container-agent:message'
  | 'container-agent:complete' | 'container-agent:error'
  | 'container-agent:cancelled' | 'container-agent:plan_ready'
  // Topology (swarm) events
  | 'topology:agent_spawned' | 'topology:agent_status'
  | 'topology:agent_progress' | 'topology:agent_completed'
  | 'topology:agent_failed' | 'topology:decision' | 'topology:snapshot';

type SessionEvent = {
  id: string;
  type: SessionEventType;
  timestamp: number;
  data: unknown;
};
```

---

## SessionWithPresence

```typescript
type SessionWithPresence = {
  id: string;
  projectId: string;
  taskId?: string | null;
  agentId?: string | null;
  title?: string | null;
  url: string;
  status: string;
  presence: ActiveUser[];
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  sandboxProvider?: string | null;
  sandboxContainerId?: string | null;
};
```

---

## Database Tables

### sessionEvents

Persisted events for historical replay:

| Column | Type | Description |
|--------|------|-------------|
| `id` | text (PK) | Event ID |
| `sessionId` | text (FK) | Session reference |
| `offset` | integer | Monotonic sequence number |
| `type` | text | Event type |
| `channel` | text | Derived channel name |
| `data` | JSON | Event payload |
| `timestamp` | integer | Event timestamp |

### sessionSummaries

Aggregated session statistics:

| Column | Type | Description |
|--------|------|-------------|
| `sessionId` | text (PK/FK) | Session reference |
| Various metrics | | Updated as events are persisted |

---

## Durable Streams Integration

### Architecture

- **Backend**: Events published via `DurableStreamsServer` (LMDB-backed)
- **Frontend**: Clients subscribe via Caddy SSE endpoints
- **Persistence**: Events also persisted to SQLite `sessionEvents` table for replay
- **Reconnection**: Clients use EventSource with automatic reconnection

### SSE Endpoint

`GET /api/sessions/:id/stream` - SSE streaming endpoint served by Caddy

---

## Error Conditions

| Method | Error Code | Condition |
|--------|------------|-----------|
| `create` | `PROJECT_NOT_FOUND` | Referenced project doesn't exist |
| `getById` | `SESSION_NOT_FOUND` | Session ID doesn't exist |
| `close` | `SESSION_NOT_FOUND` | Session ID doesn't exist |
| `join` | `SESSION_NOT_FOUND` | Session ID doesn't exist |
| `join` | `SESSION_CLOSED` | Cannot join closed session |
| `publish` | `SESSION_SYNC_FAILED` | Stream publish or persist error |
| `parseUrl` | `INVALID_URL` | URL doesn't contain valid session ID |

---

## Key Files

| File | Purpose |
|------|---------|
| `src/services/session.service.ts` | Facade composing all three sub-services |
| `src/services/session/session-crud.service.ts` | CRUD operations |
| `src/services/session/session-presence.service.ts` | Presence management |
| `src/services/session/session-stream.service.ts` | Streaming and persistence |
| `src/services/session/types.ts` | Shared type definitions |
| `src/services/session/index.ts` | Barrel file |
| `src/services/durable-streams.service.ts` | DurableStreamsServer type |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../database/schema.md) | `sessions`, `sessionEvents`, `sessionSummaries` tables |
| [Error Catalog](../errors/error-catalog.md) | `SESSION_*` error codes |
| [API Endpoints](../api/endpoints.md) | REST endpoints for sessions |
| [AgentService](./agent-service.md) | Creates sessions during agent start |
| [ContainerAgentService](./container-agent-service.md) | Creates sessions for container agents |
