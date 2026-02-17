# Application Bootstrap Specification

## Overview

Complete specification for the AgentPane application bootstrap process. This document covers the client/server architecture with SQLite database on the server, REST API for data access, and client-side initialization for React components, Durable Streams connection, and GitHub token validation.

---

## Architecture Overview

AgentPane uses a **client/server architecture** where:
- **Server**: Runs SQLite database with Drizzle ORM, handles all data persistence via REST API endpoints
- **Client**: React SPA that fetches data via API, manages UI state, and connects to real-time streams

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Browser Client                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │  React Router   │  │   API Client    │  │  Durable Streams Client     │  │
│  │  (TanStack)     │  │  (fetch-based)  │  │  (Real-time events)         │  │
│  └────────┬────────┘  └────────┬────────┘  └──────────────┬──────────────┘  │
└───────────┼───────────────────┼───────────────────────────┼─────────────────┘
            │                   │                           │
            │ ───────────────── │ ───────────────────────── │ ─────────────────
            │     HTTP/REST     │                           │  SSE (real-time)
            │ ───────────────── │ ───────────────────────── │ ─────────────────
            │                   │                           │
┌───────────┼───────────────────┼───────────────────────────┼─────────────────┐
│           ▼                   ▼                           ▼                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │  TanStack Start │  │  API Endpoints  │  │  Durable Streams Server     │  │
│  │  (SSR/Routing)  │  │  (/api/*)       │  │  (/api/streams)             │  │
│  └────────┬────────┘  └────────┬────────┘  └──────────────┬──────────────┘  │
│           │                    │                          │                 │
│           └────────────────────┼──────────────────────────┘                 │
│                                ▼                                            │
│                       ┌─────────────────┐                                   │
│                       │   Drizzle ORM   │                                   │
│                       │   (better-sqlite3)                                  │
│                       └────────┬────────┘                                   │
│                                ▼                                            │
│                       ┌─────────────────┐                                   │
│                       │  SQLite Database│                                   │
│                       │  (server-only)  │                                   │
│                       └─────────────────┘                                   │
│                              Server                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| Bun | 1.3.6 | JavaScript runtime |
| TanStack Start | 1.150.0 | Full-stack React framework |
| better-sqlite3 | 11.x | SQLite database (server-only) |
| Drizzle ORM | 0.45.1 | Type-safe SQL query builder |
| Durable Streams | 0.1.5 | Real-time event streaming |

---

## Interface Definition

```typescript
// lib/bootstrap/types.ts
import type { Result } from '@/lib/utils/result';

/**
 * Result type pattern for error handling
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Bootstrap phase identifiers (client-side only)
 *
 * Note: Database initialization happens on the server automatically.
 * The client bootstrap only handles UI-related initialization.
 */
export type BootstrapPhase =
  | 'client'      // Initialize client-side services
  | 'collections' // Mark collections as ready (data via API)
  | 'streams'     // Connect to Durable Streams
  | 'github';     // Validate GitHub token

/**
 * Bootstrap status for each phase
 */
export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Individual phase result
 */
export interface PhaseResult<T = unknown> {
  phase: BootstrapPhase;
  status: PhaseStatus;
  duration: number;
  data?: T;
  error?: BootstrapError;
}

/**
 * Complete bootstrap result
 */
export interface BootstrapResult {
  success: boolean;
  duration: number;
  phases: PhaseResult[];
  isFirstRun: boolean;
}

/**
 * Bootstrap error categories (client-side errors only)
 *
 * Note: Database errors are handled server-side and returned via API responses.
 */
export type BootstrapErrorCode =
  | 'CLIENT_INIT_FAILED'
  | 'API_UNAVAILABLE'
  | 'COLLECTION_INIT_FAILED'
  | 'STREAMS_CONNECTION_FAILED'
  | 'GITHUB_TOKEN_INVALID'
  | 'GITHUB_TOKEN_EXPIRED'
  | 'RECOVERY_FAILED';

/**
 * Bootstrap error structure
 */
export interface BootstrapError {
  code: BootstrapErrorCode;
  message: string;
  phase: BootstrapPhase;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

/**
 * Bootstrap configuration options (client-side)
 */
export interface BootstrapConfig {
  /** API base URL */
  apiBaseUrl: string;
  /** Skip GitHub validation if token not present */
  skipGitHubIfMissing: boolean;
  /** Maximum retries for recoverable errors */
  maxRetries: number;
  /** Retry delay in milliseconds */
  retryDelayMs: number;
  /** Timeout for each phase in milliseconds */
  phaseTimeoutMs: number;
  /** Enable verbose logging */
  debug: boolean;
}

/**
 * Default bootstrap configuration
 */
export const DEFAULT_BOOTSTRAP_CONFIG: BootstrapConfig = {
  apiBaseUrl: '/api',
  skipGitHubIfMissing: true,
  maxRetries: 3,
  retryDelayMs: 1000,
  phaseTimeoutMs: 30000,
  debug: false,
};

/**
 * Bootstrap service interface
 */
export interface IBootstrapService {
  /** Initialize the application */
  initialize(config?: Partial<BootstrapConfig>): Promise<Result<BootstrapResult, BootstrapError>>;

  /** Get current bootstrap status */
  getStatus(): BootstrapStatus;

  /** Retry a failed phase */
  retryPhase(phase: BootstrapPhase): Promise<Result<PhaseResult, BootstrapError>>;

  /** Reset and reinitialize */
  reset(): Promise<Result<BootstrapResult, BootstrapError>>;

  /** Check if database is available */
  checkDatabaseAvailability(): Promise<Result<boolean, BootstrapError>>;
}

/**
 * Current bootstrap status
 */
export interface BootstrapStatus {
  isInitialized: boolean;
  isInitializing: boolean;
  currentPhase: BootstrapPhase | null;
  completedPhases: BootstrapPhase[];
  failedPhase: BootstrapPhase | null;
  error: BootstrapError | null;
}
```

---

## Initialization Sequence

The bootstrap process is split between server and client:
- **Server**: Database initialization happens automatically on server startup
- **Client**: UI initialization handles API connectivity and real-time streams

### Server-Side Initialization (Automatic)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Server Bootstrap (Automatic)                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  SQLite Database Initialization                                  │
│  ├─ Create/open database file (data/agentpane.db)               │
│  ├─ Run Drizzle migrations (drizzle-kit push)                   │
│  └─ Database ready for API requests                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  API Server Ready                                                │
│  ├─ REST endpoints available (/api/*)                           │
│  ├─ Durable Streams endpoint ready (/api/streams)               │
│  └─ Accepting client connections                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Client-Side Bootstrap

```
┌─────────────────────────────────────────────────────────────────┐
│                    Client Bootstrap                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: Client Initialization                                  │
│  ├─ Verify API connectivity (health check)                       │
│  ├─ Initialize API client                                        │
│  └─ Set up error handlers                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 2: Collections Ready                                      │
│  ├─ Mark agents collection as ready (data via API)               │
│  ├─ Mark tasks collection as ready (data via API)                │
│  ├─ Mark projects collection as ready (data via API)             │
│  └─ Mark sessions collection as ready (data via API)             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 3: Durable Streams Connection                             │
│  ├─ Initialize Durable Streams client                            │
│  ├─ Establish SSE connection to /api/streams                     │
│  └─ Verify heartbeat                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 4: GitHub Token Validation (Optional)                     │
│  ├─ Check for stored token in localStorage                       │
│  ├─ Validate token with GitHub API                               │
│  └─ Skip if not configured (skipGitHubIfMissing)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Bootstrap Complete                                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Server-Side: Database Initialization

The server handles all database operations. SQLite (better-sqlite3) runs on the server and is accessed via Drizzle ORM.

```typescript
// db/index.ts (server-only)
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

/**
 * SQLite database connection (server-only)
 * This file should never be imported in client-side code
 */
const sqlite = new Database('data/agentpane.db');
sqlite.pragma('journal_mode = WAL'); // Better concurrent access

export const db = drizzle(sqlite, { schema });
export type DbClient = typeof db;
```

### Database Migrations

Migrations are run via Drizzle Kit on server startup or during deployment:

```bash
# Push schema changes to database
bun drizzle-kit push

# Generate migration files (if using migration files)
bun drizzle-kit generate
```

---

## Client-Side: API Client

The browser client accesses data through REST API endpoints, not direct database access.

```typescript
// lib/api/client.ts
interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * Generic fetch wrapper for API calls
 */
async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    const json = await response.json();
    return json as ApiResponse<T>;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'FETCH_ERROR',
        message: error instanceof Error ? error.message : 'Network request failed',
      },
    };
  }
}

/**
 * Typed API client for all endpoints
 */
export const apiClient = {
  projects: {
    list: (params?: { limit?: number }) =>
      apiFetch<ProjectListResponse>(`/api/projects${params?.limit ? `?limit=${params.limit}` : ''}`),
    get: (id: string) =>
      apiFetch<Project>(`/api/projects/${id}`),
    create: (data: CreateProjectInput) =>
      apiFetch<Project>('/api/projects', { method: 'POST', body: JSON.stringify(data) }),
  },
  tasks: {
    list: (projectId: string) =>
      apiFetch<TaskListResponse>(`/api/projects/${projectId}/tasks`),
    get: (projectId: string, taskId: string) =>
      apiFetch<Task>(`/api/projects/${projectId}/tasks/${taskId}`),
  },
  agents: {
    list: () => apiFetch<AgentListResponse>('/api/agents'),
    getRunningCount: () => apiFetch<{ count: number }>('/api/agents/running-count'),
  },
  sessions: {
    list: () => apiFetch<SessionListResponse>('/api/sessions'),
    get: (id: string) => apiFetch<Session>(`/api/sessions/${id}`),
  },
  worktrees: {
    list: () => apiFetch<WorktreeListResponse>('/api/worktrees'),
  },
};
```

---

## Phase 2: Collections Ready (Client Mode)

In client mode, collections don't store data locally - they just mark readiness for API-based data fetching.

```typescript
// lib/bootstrap/phases/collections.ts
import { ok } from '@/lib/utils/result';
import type { BootstrapContext } from '../types';

/**
 * Initialize collections for client mode.
 * In client mode, data is fetched from API endpoints, so this just sets up
 * an empty collections structure for compatibility.
 */
export const initializeCollections = async (_ctx: BootstrapContext) => {
  console.log('[Bootstrap] Collections initialized (client mode - data via API)');

  // In client mode, collections are managed via API fetch
  // This phase just marks collections as ready
  return ok({
    projects: { ready: true },
    tasks: { ready: true },
    agents: { ready: true },
    sessions: { ready: true },
  });
};
```

### Data Fetching Pattern

Instead of local collections, React components fetch data using the API client:

```typescript
// Example: Project list component
function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchProjects = async () => {
      const result = await apiClient.projects.list({ limit: 24 });
      if (result.ok && result.data) {
        setProjects(result.data.items);
      }
      setIsLoading(false);
    };
    fetchProjects();
  }, []);

  if (isLoading) return <LoadingSkeleton />;
  return <ProjectGrid projects={projects} />;
}
```

---

## Phase 3: Durable Streams Connection

Establish SSE (Server-Sent Events) connection to Durable Streams for real-time event streaming.

```typescript
// lib/bootstrap/phases/streams.ts
import { DurableStreamsClient } from '@durable-streams/client';
import { ok, err, type Result } from '@/lib/utils/result';
import type { PhaseResult, BootstrapError, BootstrapConfig } from '../types';
import { sessionSchema } from '@/lib/sessions/schema';

/**
 * Durable Streams client instance
 */
let streamsClient: DurableStreamsClient | null = null;

/**
 * Initialize Durable Streams client
 *
 * Durable Streams uses Server-Sent Events (SSE) for real-time updates,
 * providing efficient one-way streaming from server to client.
 */
export async function initializeStreams(
  config: BootstrapConfig
): Promise<Result<PhaseResult<{ client: DurableStreamsClient }>, BootstrapError>> {
  const startTime = Date.now();

  try {
    if (config.debug) {
      console.log('[Bootstrap] Initializing Durable Streams client (SSE)...');
    }

    // Initialize client with SSE connection
    streamsClient = new DurableStreamsClient({
      url: '/api/streams',
      schema: sessionSchema,
      reconnect: {
        enabled: true,
        initialDelay: 1000,
        maxDelay: 30000,
        backoffMultiplier: 2,
      },
    });

    // Wait for initial connection with timeout
    const connectionPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, config.phaseTimeoutMs);

      streamsClient!.on('connected', () => {
        clearTimeout(timeout);
        resolve();
      });

      streamsClient!.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      // Initiate SSE connection
      streamsClient!.connect();
    });

    await connectionPromise;

    const duration = Date.now() - startTime;

    if (config.debug) {
      console.log(`[Bootstrap] Durable Streams connected in ${duration}ms`);
    }

    return ok({
      phase: 'streams',
      status: 'completed',
      duration,
      data: { client: streamsClient },
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return err({
      code: 'STREAMS_CONNECTION_FAILED',
      message: `Failed to connect to Durable Streams: ${errorMessage}`,
      phase: 'streams',
      recoverable: true,
      details: {
        error: errorMessage,
        hint: 'Check network connectivity and server status',
      },
    });
  }
}

/**
 * Get the Durable Streams client
 */
export function getStreamsClient(): DurableStreamsClient | null {
  return streamsClient;
}
```

---

## Phase 4: GitHub Token Validation

Validate GitHub token if configured (optional phase).

```typescript
// lib/bootstrap/phases/github.ts
import { ok, err, type Result } from '@/lib/utils/result';
import type { PhaseResult, BootstrapError, BootstrapConfig } from '../types';

interface GitHubTokenInfo {
  isValid: boolean;
  scopes: string[];
  expiresAt: Date | null;
  username: string;
}

/**
 * Validate GitHub token
 */
export async function validateGitHubToken(
  config: BootstrapConfig
): Promise<Result<PhaseResult<GitHubTokenInfo | null>, BootstrapError>> {
  const startTime = Date.now();

  try {
    // Get token from environment or storage
    const token = typeof window !== 'undefined'
      ? localStorage.getItem('github_token')
      : process.env.GITHUB_TOKEN;

    // Skip if no token and configured to skip
    if (!token && config.skipGitHubIfMissing) {
      const duration = Date.now() - startTime;

      if (config.debug) {
        console.log('[Bootstrap] GitHub token not found, skipping validation');
      }

      return ok({
        phase: 'github',
        status: 'skipped',
        duration,
        data: null,
      });
    }

    // No token and not configured to skip
    if (!token) {
      return err({
        code: 'GITHUB_TOKEN_INVALID',
        message: 'GitHub token not configured',
        phase: 'github',
        recoverable: true,
        details: {
          hint: 'Set up GitHub integration in project settings',
        },
      });
    }

    if (config.debug) {
      console.log('[Bootstrap] Validating GitHub token...');
    }

    // Validate token with GitHub API
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return err({
          code: 'GITHUB_TOKEN_INVALID',
          message: 'GitHub token is invalid or revoked',
          phase: 'github',
          recoverable: true,
          details: {
            status: response.status,
            hint: 'Please re-authenticate with GitHub',
          },
        });
      }

      if (response.status === 403) {
        const rateLimitReset = response.headers.get('X-RateLimit-Reset');

        return err({
          code: 'GITHUB_TOKEN_EXPIRED',
          message: 'GitHub API rate limit exceeded',
          phase: 'github',
          recoverable: true,
          details: {
            status: response.status,
            resetAt: rateLimitReset ? new Date(parseInt(rateLimitReset) * 1000).toISOString() : null,
          },
        });
      }

      throw new Error(`GitHub API error: ${response.status}`);
    }

    const userData = await response.json();

    // Parse scopes from response headers
    const scopesHeader = response.headers.get('X-OAuth-Scopes');
    const scopes = scopesHeader ? scopesHeader.split(', ') : [];

    // Check for required scopes
    const requiredScopes = ['repo', 'read:org'];
    const missingScopes = requiredScopes.filter(s => !scopes.includes(s));

    if (missingScopes.length > 0) {
      if (config.debug) {
        console.warn('[Bootstrap] GitHub token missing scopes:', missingScopes);
      }
    }

    const duration = Date.now() - startTime;

    if (config.debug) {
      console.log(`[Bootstrap] GitHub token validated in ${duration}ms for user: ${userData.login}`);
    }

    return ok({
      phase: 'github',
      status: 'completed',
      duration,
      data: {
        isValid: true,
        scopes,
        expiresAt: null, // GitHub tokens don't have built-in expiry
        username: userData.login,
      },
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return err({
      code: 'GITHUB_TOKEN_INVALID',
      message: `GitHub token validation failed: ${errorMessage}`,
      phase: 'github',
      recoverable: true,
      details: { error: errorMessage },
    });
  }
}
```

---

## Server-Side: Data Seeding

Data seeding now happens on the server, not the client. This is handled during server startup or via API endpoints.

```typescript
// db/seed.ts (server-only)
import { createId } from '@paralleldrive/cuid2';
import { db } from './index';
import { projects, agents } from './schema';

/**
 * Seed default data on first run (server-side)
 */
export async function seedDefaultData() {
  // Check if any projects exist
  const existingProjects = await db.select().from(projects).limit(1);

  if (existingProjects.length > 0) {
    console.log('[Seed] Existing projects found, skipping seeding');
    return;
  }

  console.log('[Seed] First run detected, seeding default data...');

  // Create default project
  const projectId = createId();

  await db.insert(projects).values({
    id: projectId,
    name: 'My First Project',
    path: process.cwd(),
    description: 'Welcome to AgentPane! This is your first project.',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
      maxTurns: 50,
      model: 'claude-sonnet-4-6',
    },
    maxConcurrentAgents: 3,
  });

  // Create default agent
  const agentId = createId();

  await db.insert(agents).values({
    id: agentId,
    projectId,
    name: 'Default Agent',
    type: 'task',
    status: 'idle',
    config: {
      allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
      maxTurns: 50,
      model: 'claude-sonnet-4-6',
    },
  });

  console.log('[Seed] Default data seeded successfully');
}
```

---

## Error Handling

### Error Recovery Strategies (Client-Side)

```typescript
// lib/bootstrap/recovery.ts
import type { BootstrapError, BootstrapPhase, BootstrapConfig } from './types';
import { initializeCollections } from './phases/collections';
import { initializeStreams } from './phases/streams';
import { validateGitHubToken } from './phases/github';

/**
 * Recovery strategies for each error type (client-side only)
 */
export const recoveryStrategies: Record<
  BootstrapError['code'],
  (config: BootstrapConfig, attempt: number) => Promise<boolean>
> = {
  // Client init failed - retry with backoff
  CLIENT_INIT_FAILED: async (config, attempt) => {
    const delay = config.retryDelayMs * Math.pow(2, attempt);
    await sleep(delay);
    return attempt < config.maxRetries;
  },

  // API unavailable - retry with backoff
  API_UNAVAILABLE: async (config, attempt) => {
    const delay = config.retryDelayMs * Math.pow(2, attempt);
    await sleep(delay);
    return attempt < config.maxRetries;
  },

  // Collection init failed - retry
  COLLECTION_INIT_FAILED: async (config, attempt) => {
    await sleep(config.retryDelayMs);
    return attempt < config.maxRetries;
  },

  // Streams connection failed - retry with backoff
  STREAMS_CONNECTION_FAILED: async (config, attempt) => {
    const delay = config.retryDelayMs * Math.pow(2, attempt);
    await sleep(delay);
    return attempt < config.maxRetries;
  },

  // GitHub token invalid - skip (handled by UI)
  GITHUB_TOKEN_INVALID: async () => true,

  // GitHub token expired - skip (handled by UI)
  GITHUB_TOKEN_EXPIRED: async () => true,

  // Recovery failed - cannot recover
  RECOVERY_FAILED: async () => false,
};

/**
 * Phase retry functions (client-side only)
 */
export const phaseRetryFunctions: Record<
  BootstrapPhase,
  (config: BootstrapConfig) => Promise<unknown>
> = {
  client: initializeClient,
  collections: initializeCollections,
  streams: initializeStreams,
  github: validateGitHubToken,
};

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt to recover from a bootstrap error
 */
export async function attemptRecovery(
  error: BootstrapError,
  config: BootstrapConfig,
  attempt: number
): Promise<{ canRetry: boolean; shouldSkip: boolean }> {
  if (!error.recoverable) {
    return { canRetry: false, shouldSkip: false };
  }

  const strategy = recoveryStrategies[error.code];

  if (!strategy) {
    return { canRetry: false, shouldSkip: false };
  }

  const canRetry = await strategy(config, attempt);

  // Special handling for GitHub errors - skip rather than fail
  const shouldSkip = error.code === 'GITHUB_TOKEN_INVALID' ||
                     error.code === 'GITHUB_TOKEN_EXPIRED';

  return { canRetry, shouldSkip };
}
```

### Bootstrap Error Types (Client-Side)

```typescript
// lib/errors/bootstrap-errors.ts
import { createError, type AppError } from './base';

export const BootstrapErrors = {
  CLIENT_INIT_FAILED: (error: string) => createError(
    'CLIENT_INIT_FAILED',
    `Failed to initialize client: ${error}`,
    500,
    { error }
  ),

  API_UNAVAILABLE: (error: string) => createError(
    'API_UNAVAILABLE',
    `API server is unavailable: ${error}`,
    502,
    { error, hint: 'Check server status and network connectivity' }
  ),

  COLLECTION_INIT_FAILED: (collection: string) => createError(
    'COLLECTION_INIT_FAILED',
    `Failed to initialize collection: ${collection}`,
    500,
    { collection }
  ),

  STREAMS_CONNECTION_FAILED: (error: string) => createError(
    'STREAMS_CONNECTION_FAILED',
    `Failed to connect to real-time streams: ${error}`,
    502,
    { error }
  ),

  GITHUB_TOKEN_INVALID: createError(
    'GITHUB_TOKEN_INVALID',
    'GitHub token is invalid or has been revoked',
    401
  ),

  GITHUB_TOKEN_EXPIRED: (resetAt: string) => createError(
    'GITHUB_TOKEN_EXPIRED',
    'GitHub API rate limit exceeded',
    429,
    { resetAt }
  ),

  RECOVERY_FAILED: (phase: string, attempts: number) => createError(
    'RECOVERY_FAILED',
    `Bootstrap recovery failed for phase "${phase}" after ${attempts} attempts`,
    500,
    { phase, attempts }
  ),
} as const;

export type BootstrapError =
  | ReturnType<typeof BootstrapErrors.CLIENT_INIT_FAILED>
  | ReturnType<typeof BootstrapErrors.API_UNAVAILABLE>
  | ReturnType<typeof BootstrapErrors.COLLECTION_INIT_FAILED>
  | ReturnType<typeof BootstrapErrors.STREAMS_CONNECTION_FAILED>
  | typeof BootstrapErrors.GITHUB_TOKEN_INVALID
  | ReturnType<typeof BootstrapErrors.GITHUB_TOKEN_EXPIRED>
  | ReturnType<typeof BootstrapErrors.RECOVERY_FAILED>;
```

---

## Implementation Outline

### Bootstrap Service (Client-Side)

```typescript
// lib/bootstrap/service.ts
import { ok, err, type Result } from '@/lib/utils/result';
import {
  type IBootstrapService,
  type BootstrapConfig,
  type BootstrapResult,
  type BootstrapStatus,
  type BootstrapPhase,
  type PhaseResult,
  type BootstrapError,
  DEFAULT_BOOTSTRAP_CONFIG,
} from './types';
import { initializeClient } from './phases/client';
import { initializeCollections } from './phases/collections';
import { initializeStreams } from './phases/streams';
import { validateGitHubToken } from './phases/github';
import { attemptRecovery, phaseRetryFunctions } from './recovery';

/**
 * Bootstrap service implementation
 */
class BootstrapService implements IBootstrapService {
  private status: BootstrapStatus = {
    isInitialized: false,
    isInitializing: false,
    currentPhase: null,
    completedPhases: [],
    failedPhase: null,
    error: null,
  };

  private config: BootstrapConfig = DEFAULT_BOOTSTRAP_CONFIG;
  private phaseResults: PhaseResult[] = [];

  /**
   * Initialize the application
   */
  async initialize(
    configOverrides?: Partial<BootstrapConfig>
  ): Promise<Result<BootstrapResult, BootstrapError>> {
    // Prevent concurrent initialization
    if (this.status.isInitializing) {
      return err({
        code: 'RECOVERY_FAILED',
        message: 'Bootstrap already in progress',
        phase: 'client',
        recoverable: false,
      });
    }

    // Apply config overrides
    this.config = { ...DEFAULT_BOOTSTRAP_CONFIG, ...configOverrides };

    this.status.isInitializing = true;
    this.status.error = null;
    this.phaseResults = [];

    const startTime = Date.now();

    // Execute phases in sequence (client-side only)
    const phases: Array<{
      name: BootstrapPhase;
      execute: (config: BootstrapConfig) => Promise<Result<PhaseResult, BootstrapError>>;
    }> = [
      { name: 'client', execute: initializeClient },
      { name: 'collections', execute: initializeCollections },
      { name: 'streams', execute: initializeStreams },
      { name: 'github', execute: validateGitHubToken },
    ];

    for (const phase of phases) {
      this.status.currentPhase = phase.name;
      let attempt = 0;
      let result: Result<PhaseResult, BootstrapError>;

      do {
        result = await phase.execute(this.config);

        if (!result.ok) {
          const recovery = await attemptRecovery(result.error, this.config, attempt);

          if (recovery.shouldSkip) {
            // Convert error to skipped phase
            this.phaseResults.push({
              phase: phase.name,
              status: 'skipped',
              duration: 0,
              error: result.error,
            });
            this.status.completedPhases.push(phase.name);
            break;
          }

          if (!recovery.canRetry) {
            this.status.failedPhase = phase.name;
            this.status.error = result.error;
            this.status.isInitializing = false;
            return result;
          }

          attempt++;
        }
      } while (!result.ok && attempt <= this.config.maxRetries);

      if (result.ok) {
        this.phaseResults.push(result.value);
        this.status.completedPhases.push(phase.name);
      }
    }

    // Bootstrap complete
    this.status.isInitialized = true;
    this.status.isInitializing = false;
    this.status.currentPhase = null;

    const totalDuration = Date.now() - startTime;

    if (this.config.debug) {
      console.log(`[Bootstrap] Complete in ${totalDuration}ms`);
    }

    return ok({
      success: true,
      duration: totalDuration,
      phases: this.phaseResults,
      isFirstRun: false, // First run is now determined server-side
    });
  }

  /**
   * Get current bootstrap status
   */
  getStatus(): BootstrapStatus {
    return { ...this.status };
  }

  /**
   * Retry a failed phase
   */
  async retryPhase(phase: BootstrapPhase): Promise<Result<PhaseResult, BootstrapError>> {
    const retryFn = phaseRetryFunctions[phase];

    if (!retryFn) {
      return err({
        code: 'RECOVERY_FAILED',
        message: `Unknown phase: ${phase}`,
        phase,
        recoverable: false,
      });
    }

    this.status.currentPhase = phase;
    const result = await retryFn(this.config);

    if (result.ok) {
      this.status.failedPhase = null;
      this.status.error = null;
      this.status.completedPhases.push(phase);
    }

    this.status.currentPhase = null;
    return result as Result<PhaseResult, BootstrapError>;
  }

  /**
   * Reset and reinitialize (client-side only)
   */
  async reset(): Promise<Result<BootstrapResult, BootstrapError>> {
    // Clear stored data (client-side only, database is server-managed)
    if (typeof window !== 'undefined') {
      // Clear local storage tokens
      localStorage.removeItem('github_token');
    }

    // Reset status
    this.status = {
      isInitialized: false,
      isInitializing: false,
      currentPhase: null,
      completedPhases: [],
      failedPhase: null,
      error: null,
    };

    // Reinitialize
    return this.initialize(this.config);
  }

  /**
   * Check if API server is available
   */
  async checkApiAvailability(): Promise<Result<boolean, BootstrapError>> {
    try {
      const response = await fetch('/api/health');
      return ok(response.ok);
    } catch {
      return ok(false);
    }
  }
}

// Export singleton instance
export const bootstrap = new BootstrapService();
```

### React Integration

```typescript
// lib/bootstrap/hooks.ts
import { useEffect, useState, useCallback } from 'react';
import { bootstrap } from './service';
import type { BootstrapStatus, BootstrapResult, BootstrapConfig } from './types';

/**
 * Hook for bootstrap status
 */
export function useBootstrap(config?: Partial<BootstrapConfig>) {
  const [status, setStatus] = useState<BootstrapStatus>(bootstrap.getStatus());
  const [result, setResult] = useState<BootstrapResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // Already initialized
    if (status.isInitialized) {
      return;
    }

    // Initialize
    bootstrap.initialize(config).then((res) => {
      if (res.ok) {
        setResult(res.value);
      } else {
        setError(new Error(res.error.message));
      }
      setStatus(bootstrap.getStatus());
    });
  }, [config]);

  const retry = useCallback(async () => {
    if (status.failedPhase) {
      const res = await bootstrap.retryPhase(status.failedPhase);
      setStatus(bootstrap.getStatus());
      return res;
    }
    return null;
  }, [status.failedPhase]);

  const reset = useCallback(async () => {
    const res = await bootstrap.reset();
    if (res.ok) {
      setResult(res.value);
      setError(null);
    } else {
      setError(new Error(res.error.message));
    }
    setStatus(bootstrap.getStatus());
    return res;
  }, []);

  return {
    status,
    result,
    error,
    isReady: status.isInitialized,
    isLoading: status.isInitializing,
    retry,
    reset,
  };
}
```

### Bootstrap Provider

```typescript
// app/providers/bootstrap-provider.tsx
import { createContext, useContext, type ReactNode } from 'react';
import { useBootstrap } from '@/lib/bootstrap/hooks';
import type { BootstrapStatus, BootstrapResult } from '@/lib/bootstrap/types';

interface BootstrapContextValue {
  status: BootstrapStatus;
  result: BootstrapResult | null;
  error: Error | null;
  isReady: boolean;
  isLoading: boolean;
  retry: () => Promise<unknown>;
  reset: () => Promise<unknown>;
}

const BootstrapContext = createContext<BootstrapContextValue | null>(null);

export function BootstrapProvider({ children }: { children: ReactNode }) {
  const bootstrap = useBootstrap();

  // Show loading state during initialization
  if (bootstrap.isLoading) {
    return <BootstrapLoading phase={bootstrap.status.currentPhase} />;
  }

  // Show error state if bootstrap failed
  if (bootstrap.error && !bootstrap.isReady) {
    return (
      <BootstrapError
        error={bootstrap.error}
        phase={bootstrap.status.failedPhase}
        onRetry={bootstrap.retry}
        onReset={bootstrap.reset}
      />
    );
  }

  return (
    <BootstrapContext.Provider value={bootstrap}>
      {children}
    </BootstrapContext.Provider>
  );
}

export function useBootstrapContext() {
  const context = useContext(BootstrapContext);

  if (!context) {
    throw new Error('useBootstrapContext must be used within BootstrapProvider');
  }

  return context;
}

// Loading component
function BootstrapLoading({ phase }: { phase: string | null }) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full mx-auto" />
        <p className="mt-4 text-sm text-gray-500">
          {phase ? `Initializing ${phase}...` : 'Starting...'}
        </p>
      </div>
    </div>
  );
}

// Error component
function BootstrapError({
  error,
  phase,
  onRetry,
  onReset,
}: {
  error: Error;
  phase: string | null;
  onRetry: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="max-w-md p-6 bg-red-50 border border-red-200 rounded-lg">
        <h2 className="text-lg font-semibold text-red-700">
          Initialization Failed
        </h2>
        <p className="mt-2 text-sm text-red-600">
          {error.message}
        </p>
        {phase && (
          <p className="mt-1 text-xs text-red-500">
            Failed during: {phase}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            onClick={onRetry}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Retry
          </button>
          <button
            onClick={onReset}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../database/schema.md) | Defines tables validated in schema phase |
| [Agent Service](../services/agent-service.md) | Depends on bootstrap completion |
| [Task Service](../services/task-service.md) | Depends on bootstrap completion |
| [Project Service](../services/project-service.md) | Depends on bootstrap completion |
| [Session Service](../services/session-service.md) | Depends on bootstrap completion |
| [Durable Sessions](../integrations/durable-sessions.md) | Streams phase initializes connection |
| [GitHub App](../integrations/github-app.md) | GitHub phase validates token |
| [Error Catalog](../errors/error-catalog.md) | Bootstrap error definitions |
