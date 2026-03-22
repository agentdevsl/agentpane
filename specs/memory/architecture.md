# Memory Service Architecture Specification

## Overview

The Memory Service integrates [Honcho](https://github.com/plastic-labs/honcho) as a persistent memory layer for AgentPane agents. Honcho is an open-source memory library (FastAPI server + TypeScript SDK) that provides semantic memory storage, automatic conclusion derivation, and multi-level reasoning queries. It runs as a Docker sidecar alongside AgentPane.

**Design Principle**: Memory is purely additive. If Honcho is unavailable, AgentPane operates exactly as it does today -- no memory context is injected, no messages are captured, no sessions are finalized. Every memory operation is wrapped in graceful degradation.

### What Memory Enables

| Capability | Before | After |
|---|---|---|
| Codebase knowledge | Agent rediscovers patterns each task | Recalls architecture decisions, file conventions, test patterns |
| User preferences | No awareness | Remembers coding style, review preferences, naming conventions |
| Task continuity | Each task starts from scratch | References prior work, avoids re-implementing solved problems |
| Skill optimization | N/A | Platform-wide learning: common tool sequences, error recovery patterns |

---

## System Architecture

```mermaid
graph TB
    subgraph AgentPane["AgentPane Server (port 3001)"]
        AES[AgentExecutionService]
        SH[StreamHandler]
        MS[MemoryService Facade]
        MC[MemoryClientService]
        MQ[MemoryQueryService]
        MCA[MemoryCaptureService]
        MA[MemoryAdminService]
        MR[Memory Routes]
    end

    subgraph Honcho["Honcho Sidecar"]
        HA[Honcho API :8000]
        PG[(PostgreSQL + pgvector :5433)]
        RD[(Redis :6380)]
        DRV[Deriver Worker]
    end

    AES -->|1. getContext| MS
    MS --> MQ
    MQ -->|query conclusions + docs| MC
    MC -->|HTTP via SDK| HA

    SH -->|2. onMessage callback| MS
    MS --> MCA
    MCA -->|create message| MC

    AES -->|3. finalizeSession| MS
    MS --> MCA

    MR -->|admin CRUD| MS
    MS --> MA
    MA -->|manage docs/conclusions| MC

    HA --> PG
    HA --> RD
    DRV -->|auto-derive conclusions| PG
```

### Integration Points

There are exactly **three touchpoints** between AgentPane and the memory system:

1. **Context Injection** -- Before agent execution starts, query Honcho for relevant memory and append to the task prompt (`AgentExecutionService.start()`, line 254)
2. **Message Capture** -- During execution, each assistant turn is captured to Honcho via the `onMessage` callback in the stream handler
3. **Session Finalization** -- After execution completes, close the Honcho session to trigger the deriver (conclusion auto-generation)

---

## Data Model Mapping

### Dual-Workspace Model

Memory is organized into two workspace scopes:

```
Honcho
  Workspace "platform"                  <- global, cross-cutting
    Peer "user:{userId}"
      Session (skill observations)
      Collection "skills"
        Documents (tool patterns, error recovery)
      Conclusions (derived platform knowledge)

  Workspace "codespace:{codespaceId}"   <- per-codespace isolation
    Peer "user:{userId}"
      Sessions (mapped 1:1 from AgentPane sessions)
      Messages (captured from stream handler turns)
      Collection "codebase"
        Documents (architecture notes, conventions)
      Conclusions (derived codebase knowledge)
    Peer "agent:{agentId}"
      Sessions (agent execution sessions)
      Messages
```

### Entity Mapping Table

| AgentPane Entity | Honcho Entity | Naming Convention | Notes |
|---|---|---|---|
| Platform (global) | Workspace | `"platform"` | Cross-cutting: user prefs, skill optimization, tool patterns |
| Codespace | Workspace | `"codespace:{codespaceId}"` | Per-codespace isolation for codebase-specific memory |
| User | Peer | `"user:{userId}"` | Created per workspace on first interaction |
| Agent | Peer | `"agent:{agentId}"` | Created per workspace on first execution |
| AgentPane Session | Honcho Session | 1:1 mapping via metadata | `metadata.agentpaneSessionId` stores the AgentPane session ID |
| Session Event (turn) | Message | Role-mapped | `assistant` and `user` messages captured from stream handler |
| Codebase knowledge | Document (Collection) | Collection `"codebase"` | RAG corpus per codespace |
| Skill patterns | Document (Collection) | Collection `"skills"` | Platform-wide tool/pattern corpus |
| Derived facts | Conclusion | Auto-generated | Honcho deriver produces these from session messages |

### Session Metadata Schema

Each Honcho session stores metadata linking back to AgentPane:

```typescript
interface HonchoSessionMetadata {
  agentpaneSessionId: string;   // AgentPane session ID
  agentId: string;              // AgentPane agent ID
  taskId: string;               // AgentPane task ID
  codespaceId: string;          // For cross-referencing
  phase: 'planning' | 'execution';
  model: string;                // Model used for this session
  startedAt: string;            // ISO timestamp
}
```

---

## Service Design

### File Structure

```
src/services/memory/
  index.ts                        # Barrel exports
  memory.service.ts               # Facade (composes sub-services)
  memory-client.service.ts        # Honcho SDK wrapper + connection management
  memory-capture.service.ts       # Stream handler hooks for message capture
  memory-query.service.ts         # Context retrieval and prompt assembly
  memory-admin.service.ts         # CRUD for manual memory management (UI)
  types.ts                        # Shared types and interfaces

src/lib/errors/
  memory-errors.ts                # Error definitions
```

### Facade: MemoryService

The facade composes all sub-services and is the single entry point used by `AgentExecutionService` and the memory API routes.

```typescript
// src/services/memory/memory.service.ts

import type { AppError } from '../../lib/errors/base.js';
import type { Result } from '../../lib/utils/result.js';

export class MemoryService {
  private client: MemoryClientService;
  private query: MemoryQueryService;
  private capture: MemoryCaptureService;
  private admin: MemoryAdminService;

  constructor(
    settingsService: SettingsService,
    db: Database
  );

  // --- Lifecycle (used by AgentExecutionService) ---

  /** Query Honcho for relevant memory context to inject into agent prompt. */
  async getContext(params: {
    codespaceId: string;
    agentId: string;
    taskTitle: string;
    taskDescription: string | null;
  }): Promise<Result<MemoryContext, MemoryError>>;

  /** Create a Honcho session for tracking this agent execution. */
  async startSession(params: {
    codespaceId: string;
    agentId: string;
    taskId: string;
    sessionId: string;
    phase: 'planning' | 'execution';
    model: string;
  }): Promise<Result<HonchoSessionRef, MemoryError>>;

  /** Capture a single message (turn) from the stream handler. */
  async captureMessage(params: {
    honchoSessionRef: HonchoSessionRef;
    role: 'user' | 'assistant';
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<Result<void, MemoryError>>;

  /** Finalize a Honcho session (triggers deriver). */
  async finalizeSession(
    honchoSessionRef: HonchoSessionRef
  ): Promise<Result<void, MemoryError>>;

  // --- Admin (used by API routes) ---

  async getConclusions(codespaceId: string): Promise<Result<Conclusion[], MemoryError>>;
  async createConclusion(codespaceId: string, content: string): Promise<Result<Conclusion, MemoryError>>;
  async deleteConclusion(conclusionId: string): Promise<Result<void, MemoryError>>;
  async getDocuments(codespaceId: string): Promise<Result<Document[], MemoryError>>;
  async createDocument(codespaceId: string, content: string, metadata?: Record<string, unknown>): Promise<Result<Document, MemoryError>>;
  async deleteDocument(documentId: string): Promise<Result<void, MemoryError>>;
  async getSessions(codespaceId: string): Promise<Result<HonchoSession[], MemoryError>>;
  async search(codespaceId: string, query: string): Promise<Result<SearchResult[], MemoryError>>;

  // --- Health ---

  async healthCheck(): Promise<Result<HealthStatus, MemoryError>>;
  isAvailable(): boolean;
}
```

### MemoryClientService

Wraps the `@honcho-ai/sdk` and manages connection state, workspace/peer lifecycle, and retry logic.

```typescript
// src/services/memory/memory-client.service.ts

export interface HonchoSessionRef {
  workspaceId: string;
  peerId: string;
  sessionId: string;
}

export class MemoryClientService {
  private sdk: HonchoClient | null = null;
  private available = false;

  constructor(settingsService: SettingsService);

  /** Initialize SDK connection. Non-fatal on failure. */
  async initialize(): Promise<Result<void, MemoryError>>;

  /** Health check ping to Honcho /health endpoint. */
  async ping(): Promise<Result<{ status: string; version: string }, MemoryError>>;

  /** Ensure a workspace exists, creating if necessary. Returns workspace ID. */
  async ensureWorkspace(name: string): Promise<Result<string, MemoryError>>;

  /** Ensure a peer exists within a workspace. Returns peer ID. */
  async ensurePeer(workspaceId: string, name: string): Promise<Result<string, MemoryError>>;

  /** Create a new session for a peer. */
  async createSession(
    workspaceId: string,
    peerId: string,
    metadata: Record<string, unknown>
  ): Promise<Result<HonchoSessionRef, MemoryError>>;

  /** Close/finalize a session (triggers deriver). */
  async closeSession(ref: HonchoSessionRef): Promise<Result<void, MemoryError>>;

  /** Add a message to a session. */
  async addMessage(
    ref: HonchoSessionRef,
    role: 'user' | 'assistant',
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<Result<void, MemoryError>>;

  /** Query conclusions for a peer in a workspace. */
  async getConclusions(
    workspaceId: string,
    peerId: string
  ): Promise<Result<Conclusion[], MemoryError>>;

  /** Semantic search across documents in a collection. */
  async searchDocuments(
    workspaceId: string,
    peerId: string,
    collection: string,
    query: string,
    topK?: number
  ): Promise<Result<Document[], MemoryError>>;

  /** Create a document in a collection. */
  async createDocument(
    workspaceId: string,
    peerId: string,
    collection: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<Result<Document, MemoryError>>;

  /** Delete a document. */
  async deleteDocument(
    workspaceId: string,
    peerId: string,
    collection: string,
    documentId: string
  ): Promise<Result<void, MemoryError>>;

  /** Check if the client is connected and ready. */
  isAvailable(): boolean;
}
```

### MemoryQueryService

Handles context retrieval and prompt assembly with token budgeting.

```typescript
// src/services/memory/memory-query.service.ts

export interface MemoryContext {
  /** Assembled text block to append to agent prompt. */
  text: string;
  /** Approximate token count of the assembled context. */
  tokenCount: number;
  /** Breakdown of what was included. */
  sources: {
    conclusions: number;      // Count of conclusions included
    documents: number;        // Count of documents included
    platformConclusions: number;  // Count from platform workspace
  };
}

export class MemoryQueryService {
  constructor(
    private client: MemoryClientService,
    private settingsService: SettingsService
  );

  /**
   * Retrieve and assemble memory context for agent injection.
   *
   * Retrieval priority (fills token budget in order):
   * 1. Codespace conclusions (highest signal - derived facts about this codebase)
   * 2. Semantic document search (RAG over codebase knowledge base)
   * 3. Platform conclusions (cross-cutting skill optimization)
   *
   * Token budget: configurable via `memory.contextMaxTokens` (default: 2000)
   */
  async assembleContext(params: {
    codespaceId: string;
    agentId: string;
    taskTitle: string;
    taskDescription: string | null;
    maxTokens?: number;
  }): Promise<Result<MemoryContext, MemoryError>>;
}
```

### MemoryCaptureService

Handles message capture during agent execution and session finalization.

```typescript
// src/services/memory/memory-capture.service.ts

export class MemoryCaptureService {
  constructor(private client: MemoryClientService);

  /**
   * Create a Honcho session mapped to an AgentPane session.
   * Ensures workspace and peer exist before creating the session.
   */
  async startSession(params: {
    codespaceId: string;
    agentId: string;
    taskId: string;
    sessionId: string;
    phase: 'planning' | 'execution';
    model: string;
  }): Promise<Result<HonchoSessionRef, MemoryError>>;

  /**
   * Capture a message from the stream handler.
   * Fire-and-forget semantics -- failures are logged but never block execution.
   */
  async captureMessage(params: {
    honchoSessionRef: HonchoSessionRef;
    role: 'user' | 'assistant';
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<Result<void, MemoryError>>;

  /**
   * Finalize session by closing it in Honcho.
   * This triggers the deriver to auto-generate conclusions.
   */
  async finalizeSession(
    ref: HonchoSessionRef
  ): Promise<Result<void, MemoryError>>;
}
```

### MemoryAdminService

CRUD operations exposed through API routes for manual memory management.

```typescript
// src/services/memory/memory-admin.service.ts

export class MemoryAdminService {
  constructor(private client: MemoryClientService);

  async getConclusions(codespaceId: string): Promise<Result<Conclusion[], MemoryError>>;
  async createConclusion(codespaceId: string, content: string): Promise<Result<Conclusion, MemoryError>>;
  async deleteConclusion(conclusionId: string): Promise<Result<void, MemoryError>>;
  async getDocuments(codespaceId: string): Promise<Result<Document[], MemoryError>>;
  async createDocument(
    codespaceId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<Result<Document, MemoryError>>;
  async deleteDocument(documentId: string): Promise<Result<void, MemoryError>>;
  async getSessions(codespaceId: string): Promise<Result<HonchoSession[], MemoryError>>;
  async search(codespaceId: string, query: string): Promise<Result<SearchResult[], MemoryError>>;
}
```

---

## Error Definitions

```typescript
// src/lib/errors/memory-errors.ts

import { createError } from './base.js';

export const MemoryErrors = {
  UNAVAILABLE: createError(
    'MEMORY_UNAVAILABLE',
    'Memory service is not available',
    503
  ),
  CONNECTION_FAILED: (url: string) =>
    createError(
      'MEMORY_CONNECTION_FAILED',
      `Failed to connect to Honcho at ${url}`,
      503,
      { url }
    ),
  WORKSPACE_ERROR: (workspace: string) =>
    createError(
      'MEMORY_WORKSPACE_ERROR',
      `Failed to manage workspace: ${workspace}`,
      500,
      { workspace }
    ),
  SESSION_ERROR: (detail: string) =>
    createError(
      'MEMORY_SESSION_ERROR',
      `Memory session error: ${detail}`,
      500,
      { detail }
    ),
  QUERY_ERROR: (detail: string) =>
    createError(
      'MEMORY_QUERY_ERROR',
      `Memory query failed: ${detail}`,
      500,
      { detail }
    ),
  CAPTURE_ERROR: (detail: string) =>
    createError(
      'MEMORY_CAPTURE_ERROR',
      `Memory capture failed: ${detail}`,
      500,
      { detail }
    ),
} as const;

export type MemoryError =
  | typeof MemoryErrors.UNAVAILABLE
  | ReturnType<typeof MemoryErrors.CONNECTION_FAILED>
  | ReturnType<typeof MemoryErrors.WORKSPACE_ERROR>
  | ReturnType<typeof MemoryErrors.SESSION_ERROR>
  | ReturnType<typeof MemoryErrors.QUERY_ERROR>
  | ReturnType<typeof MemoryErrors.CAPTURE_ERROR>;
```

---

## Memory Lifecycle

### Phase 1: Context Injection (Agent Start)

Occurs in `AgentExecutionService.start()` at line 254, after the task prompt is built and before `executeAgentAsync()` is called.

```typescript
// In agent-execution.service.ts, around line 254:

// Build task prompt
const taskPrompt = `Work on the following task:\n\nTitle: ${task.title}\n\nDescription: ${task.description ?? 'No description provided'}\n\nThe task is in the worktree at: ${worktree.value.path}`;

// === MEMORY CONTEXT INJECTION (new) ===
let fullPrompt = taskPrompt;
if (this.memoryService?.isAvailable()) {
  const memoryResult = await this.memoryService.getContext({
    codespaceId: agent.codespaceId,
    agentId: agent.id,
    taskTitle: task.title,
    taskDescription: task.description,
  });
  if (memoryResult.ok && memoryResult.value.text) {
    fullPrompt = `${taskPrompt}\n\n---\n\n## Relevant Context from Previous Work\n\n${memoryResult.value.text}`;
    log.info('Injected memory context', {
      data: {
        agentId,
        tokenCount: memoryResult.value.tokenCount,
        sources: memoryResult.value.sources,
      },
    });
  } else if (!memoryResult.ok) {
    log.warn('Memory context retrieval failed, proceeding without', {
      data: { agentId, error: memoryResult.error.message },
    });
  }
}
// === END MEMORY CONTEXT INJECTION ===

// Start agent execution asynchronously
this.executeAgentAsync(agentId, session.value.id, fullPrompt, ...);
```

**Token Budget**: Configurable via `memory.contextMaxTokens` setting (default: 2000 tokens). Context is assembled with this priority:

| Priority | Source | Typical Tokens | Content |
|---|---|---|---|
| 1 | Codespace conclusions | ~800 | Derived facts about this codebase (architecture, conventions, patterns) |
| 2 | Semantic document search | ~800 | RAG results from codebase knowledge collection, queried by task title/description |
| 3 | Platform conclusions | ~400 | Cross-cutting skill optimizations (tool patterns, error recovery) |

If the token budget is exhausted at any level, lower-priority sources are skipped.

### Phase 2: Message Capture (During Execution)

The stream handler calls `onMessage` after each assistant turn. This is a **fire-and-forget** operation -- capture failures never block or interrupt agent execution.

**Integration in `StreamHandlerOptions`**:

```typescript
// In src/lib/agents/stream-handler.ts

export interface StreamHandlerOptions {
  agentId: string;
  sessionId: string;
  prompt: string;
  allowedTools: string[];
  maxTurns: number;
  model: string;
  cwd: string;
  signal?: AbortSignal;
  sessionService: {
    publish: (sessionId: string, event: SessionEvent) => Promise<unknown>;
  };
  // === NEW ===
  onMessage?: (params: {
    role: 'user' | 'assistant';
    content: string;
    turn: number;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}
```

**Callback wiring in `AgentExecutionService`**:

```typescript
// In executeAgentAsync(), when calling runAgentPlanning/runAgentExecution:

const honchoSession = this.memoryService?.isAvailable()
  ? await this.memoryService.startSession({
      codespaceId: agent.codespaceId,
      agentId,
      taskId,
      sessionId,
      phase: 'planning',
      model: resolvedModel,
    })
  : null;

const result = await runAgentPlanning({
  agentId,
  sessionId,
  prompt: fullPrompt,
  // ... existing options ...
  sessionService: this.sessionService,
  onMessage: honchoSession?.ok
    ? async ({ role, content, turn, metadata }) => {
        await this.memoryService?.captureMessage({
          honchoSessionRef: honchoSession.value,
          role,
          content,
          metadata: { ...metadata, turn },
        });
      }
    : undefined,
});
```

**Stream handler invocation** (in both `runAgentPlanning` and `runAgentExecution`):

```typescript
// After each assistant message is processed:
if (msg.type === 'assistant') {
  turn++;
  // ... existing turn processing ...

  // Fire-and-forget memory capture
  if (options.onMessage && textContent) {
    options.onMessage({
      role: 'assistant',
      content: textContent,
      turn,
      metadata: { model, phase: 'planning' },
    }).catch((captureErr) => {
      log.warn('Memory capture failed', { error: captureErr });
    });
  }
}
```

### Phase 3: Session Finalization (Post-Execution)

After `executeAgentAsync()` completes (regardless of outcome), finalize the Honcho session. This closes the session and triggers the Honcho deriver to auto-generate conclusions from the conversation.

```typescript
// At the end of executeAgentAsync(), after updating agent/task status:

if (honchoSession?.ok) {
  this.memoryService?.finalizeSession(honchoSession.value).catch((finalizeErr) => {
    log.warn('Memory session finalization failed', {
      error: finalizeErr,
      data: { agentId, sessionId },
    });
  });
}
```

---

## Configuration

### Settings Keys

Stored in AgentPane's settings table, configurable via the Settings UI.

| Key | Type | Default | Description |
|---|---|---|---|
| `memory.enabled` | `boolean` | `false` | Master switch for the memory system |
| `memory.honcho.url` | `string` | `"http://localhost:8000"` | Honcho API base URL |
| `memory.honcho.apiKey` | `string` | `""` | Honcho API key (if auth enabled) |
| `memory.contextMaxTokens` | `number` | `2000` | Max tokens for injected memory context |
| `memory.captureEnabled` | `boolean` | `true` | Whether to capture messages during execution |
| `memory.captureMinTurnLength` | `number` | `50` | Minimum character length to capture a turn |

### Environment Variables

Used during bootstrap for initial configuration. Settings keys override these at runtime.

| Variable | Default | Description |
|---|---|---|
| `HONCHO_URL` | `http://localhost:8000` | Honcho API URL (used if setting not yet configured) |
| `HONCHO_API_KEY` | `""` | Honcho API key |
| `MEMORY_ENABLED` | `false` | Enable memory on startup |

---

## Docker Deployment

### Docker Compose Extension

Create `docker/docker-compose.memory.yml` as an extension to the base compose file. Ports are offset to avoid conflicts with AgentPane's own PostgreSQL (5432) and Redis (6379) if present.

```yaml
# docker/docker-compose.memory.yml
# Usage: docker compose -f docker-compose.yml -f docker/docker-compose.memory.yml up

services:
  honcho:
    image: ghcr.io/plastic-labs/honcho:latest
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgresql://honcho:honcho@honcho-postgres:5432/honcho
      REDIS_URL: redis://honcho-redis:6379/0
      HONCHO_API_KEY: ${HONCHO_API_KEY:-}
    depends_on:
      honcho-postgres:
        condition: service_healthy
      honcho-redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  honcho-postgres:
    image: pgvector/pgvector:pg16
    ports:
      - "5433:5432"
    environment:
      POSTGRES_USER: honcho
      POSTGRES_PASSWORD: honcho
      POSTGRES_DB: honcho
    volumes:
      - honcho_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U honcho"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  honcho-redis:
    image: redis:7-alpine
    ports:
      - "6380:6379"
    volumes:
      - honcho_redis:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

volumes:
  honcho_pgdata:
  honcho_redis:
```

### Port Allocation

| Service | Internal Port | External Port | Notes |
|---|---|---|---|
| Honcho API | 8000 | 8000 | HTTP REST API |
| Honcho PostgreSQL | 5432 | **5433** | Offset to avoid AgentPane DB conflicts |
| Honcho Redis | 6379 | **6380** | Offset to avoid AgentPane Redis conflicts |

---

## Bootstrap Integration

### Service Container Registration

`MemoryService` is instantiated in `service-container.ts` after `settingsService` (it depends on settings for configuration) and before `agentService` (which needs it for context injection).

```typescript
// In src/server/bootstrap/service-container.ts

import { MemoryService } from '../../services/memory/index.js';

// ... inside createServiceContainer():

// After settingsService (step 1), before agentService (step 6):
const memoryService = new MemoryService(settingsService, db);

// 6. Agent service (updated to accept memoryService)
const agentService = new AgentService(db, worktreeService, taskService, sessionService, memoryService);

return {
  // ... existing services ...
  memoryService,
};
```

### ServiceContainer Type Update

```typescript
// In src/server/bootstrap/types.ts

import type { MemoryService } from '../../services/memory/index.js';

export interface ServiceContainer {
  // ... existing services ...
  memoryService: MemoryService | null;
}
```

The `| null` type allows the container to work even if memory service construction fails.

### Initialization Sequence

```mermaid
sequenceDiagram
    participant Boot as Bootstrap
    participant MS as MemoryService
    participant MC as MemoryClientService
    participant H as Honcho API
    participant SS as SettingsService

    Boot->>SS: Read memory.* settings
    Boot->>MS: new MemoryService(settingsService, db)
    MS->>MC: new MemoryClientService(settingsService)

    alt memory.enabled = true
        MC->>H: GET /health
        alt Honcho reachable
            H-->>MC: 200 OK { status: "healthy" }
            MC->>H: Ensure "platform" workspace
            H-->>MC: Workspace ID
            MC-->>MS: available = true
            MS-->>Boot: Ready (with memory)
        else Honcho unreachable
            H-->>MC: Connection refused / timeout
            MC-->>MS: available = false
            MS-->>Boot: Ready (without memory)
            Note over Boot: Log warning, continue normally
        end
    else memory.enabled = false
        MC-->>MS: available = false
        MS-->>Boot: Ready (memory disabled)
    end
```

### Health Check Integration

The memory health check is non-fatal and included in the existing health endpoint:

```typescript
// In health route handler:
const memoryHealth = services.memoryService
  ? await services.memoryService.healthCheck()
  : null;

return {
  status: 'healthy',
  services: {
    // ... existing health checks ...
    memory: memoryHealth?.ok
      ? { status: 'healthy', version: memoryHealth.value.version }
      : { status: memoryHealth ? 'unhealthy' : 'disabled' },
  },
};
```

---

## Graceful Degradation

Every memory operation is designed to fail silently. The system must never block, crash, or degrade agent execution due to memory failures.

### Failure Modes

| Failure | Impact | Behavior |
|---|---|---|
| Honcho not running | No memory features | `isAvailable()` returns `false`, all operations short-circuit |
| Honcho crashes mid-execution | Capture stops, context injection fails next time | Ongoing agent execution continues unaffected |
| Network timeout on context query | No memory injected | Agent starts with standard prompt, warning logged |
| Message capture fails | Turn not recorded | Fire-and-forget, warning logged, execution continues |
| Session finalization fails | Deriver won't run for this session | Warning logged, no impact on agent or task state |
| Invalid API key | All operations fail | `isAvailable()` returns `false` after first failure |
| Workspace/peer creation fails | Session can't be created | Falls back to no-memory mode for this execution |
| Token budget exceeded | Partial context | Highest-priority items included up to budget |

### Implementation Pattern

All public methods on `MemoryService` follow this pattern:

```typescript
async getContext(params: GetContextParams): Promise<Result<MemoryContext, MemoryError>> {
  if (!this.client.isAvailable()) {
    return ok({ text: '', tokenCount: 0, sources: { conclusions: 0, documents: 0, platformConclusions: 0 } });
  }

  try {
    return await this.query.assembleContext(params);
  } catch (error) {
    log.warn('Memory context retrieval failed', { error });
    return ok({ text: '', tokenCount: 0, sources: { conclusions: 0, documents: 0, platformConclusions: 0 } });
  }
}
```

Note: `getContext` returns `ok()` with empty context on failure, not `err()`. This ensures callers never need to handle memory errors -- they simply get no context.

---

## API Endpoints

All routes are prefixed with `/api/memory` and registered in `src/server/routes/memory.ts`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/memory/health` | Memory service health check |
| `GET` | `/api/memory/codespaces/:id/conclusions` | List conclusions for a codespace |
| `POST` | `/api/memory/codespaces/:id/conclusions` | Create a manual conclusion |
| `DELETE` | `/api/memory/conclusions/:id` | Delete a conclusion |
| `GET` | `/api/memory/codespaces/:id/documents` | List documents for a codespace |
| `POST` | `/api/memory/codespaces/:id/documents` | Create a document |
| `DELETE` | `/api/memory/documents/:id` | Delete a document |
| `GET` | `/api/memory/codespaces/:id/sessions` | List Honcho sessions for a codespace |
| `POST` | `/api/memory/codespaces/:id/search` | Semantic search across memory |

### Request/Response Schemas

```typescript
// POST /api/memory/codespaces/:id/conclusions
const CreateConclusionSchema = z.object({
  content: z.string().min(1).max(5000),
});
// Response: { ok: true, data: { id: string, content: string, createdAt: string } }

// POST /api/memory/codespaces/:id/documents
const CreateDocumentSchema = z.object({
  content: z.string().min(1).max(10000),
  metadata: z.record(z.unknown()).optional(),
});
// Response: { ok: true, data: { id: string, content: string, metadata: Record<string, unknown>, createdAt: string } }

// POST /api/memory/codespaces/:id/search
const SearchSchema = z.object({
  query: z.string().min(1).max(1000),
  topK: z.number().int().min(1).max(50).default(10),
});
// Response: { ok: true, data: Array<{ id: string, content: string, score: number, source: 'conclusion' | 'document' }> }
```

---

## Shared Types

```typescript
// src/services/memory/types.ts

export interface HonchoSessionRef {
  workspaceId: string;
  peerId: string;
  sessionId: string;
}

export interface MemoryContext {
  text: string;
  tokenCount: number;
  sources: {
    conclusions: number;
    documents: number;
    platformConclusions: number;
  };
}

export interface Conclusion {
  id: string;
  content: string;
  createdAt: string;
  workspace: string;
}

export interface Document {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  collection: string;
  createdAt: string;
}

export interface HonchoSession {
  id: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  isActive: boolean;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  source: 'conclusion' | 'document';
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'disabled';
  version?: string;
  url?: string;
}
```

---

## Package Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@honcho-ai/sdk` | `^0.1.x` | TypeScript SDK for Honcho API |

Add to `package.json`:

```json
{
  "dependencies": {
    "@honcho-ai/sdk": "^0.1.0"
  }
}
```

No database migrations required -- all memory storage is in Honcho's PostgreSQL, not AgentPane's SQLite/PostgreSQL.

---

## Implementation Phases

### Phase 1: Foundation

1. Create `src/lib/errors/memory-errors.ts` with error definitions
2. Create `src/services/memory/types.ts` with shared types
3. Create `src/services/memory/memory-client.service.ts` -- Honcho SDK wrapper with connection management, workspace/peer ensure methods
4. Create `src/services/memory/memory.service.ts` -- Facade shell that delegates to sub-services
5. Create `src/services/memory/index.ts` -- Barrel exports
6. Add `@honcho-ai/sdk` to `package.json`
7. Create `docker/docker-compose.memory.yml`

### Phase 2: Bootstrap Integration

8. Update `src/server/bootstrap/types.ts` -- Add `memoryService: MemoryService | null` to `ServiceContainer`
9. Update `src/server/bootstrap/service-container.ts` -- Instantiate `MemoryService` after `settingsService`
10. Add `memory.*` keys to `ALLOWED_SETTINGS_KEYS` in `src/server/routes/settings.ts`
11. Add memory health to health endpoint in `src/server/routes/health.ts`

### Phase 3: Context Injection

12. Create `src/services/memory/memory-query.service.ts` -- Context retrieval with token budgeting and priority assembly
13. Modify `src/services/agent/agent-execution.service.ts` -- Accept `memoryService` dependency, inject memory context at line 254

### Phase 4: Message Capture

14. Create `src/services/memory/memory-capture.service.ts` -- Session lifecycle and message capture
15. Add `onMessage` callback to `StreamHandlerOptions` in `src/lib/agents/stream-handler.ts`
16. Wire `onMessage` in both `runAgentPlanning` and `runAgentExecution`
17. Wire capture callback and session finalization in `AgentExecutionService.executeAgentAsync()` and `executeAgentExecution()`

### Phase 5: Admin API

18. Create `src/services/memory/memory-admin.service.ts` -- CRUD operations
19. Create `src/server/routes/memory.ts` -- API route handlers
20. Register memory routes in `src/server/router.ts`

### Phase 6: Testing

21. Unit tests for `MemoryClientService` (mock Honcho SDK)
22. Unit tests for `MemoryQueryService` (token budgeting, priority assembly)
23. Unit tests for `MemoryCaptureService` (fire-and-forget behavior)
24. Integration test: full lifecycle (context injection -> capture -> finalization)
25. Graceful degradation tests (Honcho unavailable, timeout, error scenarios)

---

## Key Files

| File | Purpose |
|------|---------|
| `src/services/memory/memory.service.ts` | Facade composing all memory sub-services |
| `src/services/memory/memory-client.service.ts` | Honcho SDK wrapper + connection management |
| `src/services/memory/memory-query.service.ts` | Context retrieval and token-budgeted assembly |
| `src/services/memory/memory-capture.service.ts` | Stream handler hooks for message capture |
| `src/services/memory/memory-admin.service.ts` | CRUD for manual memory management |
| `src/services/memory/types.ts` | Shared types and interfaces |
| `src/lib/errors/memory-errors.ts` | Error definitions |
| `src/server/routes/memory.ts` | API route handlers |
| `docker/docker-compose.memory.yml` | Docker sidecar deployment |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Agent Service](../application/services/agent-service.md) | Context injection point in `AgentExecutionService.start()` |
| [Error Catalog](../application/errors/error-catalog.md) | `MEMORY_*` error codes |
| [Session Service](../application/services/session-service.md) | Session ID mapping to Honcho sessions |
| [Database Schema](../application/database/schema.md) | No schema changes -- all storage in Honcho |
| [API Endpoints](../application/api/endpoints.md) | `/api/memory/*` routes |
| [Operations / Deployment](../application/operations/deployment.md) | Docker compose extension |
