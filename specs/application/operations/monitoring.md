# Monitoring and Observability Specification

## Overview

Comprehensive monitoring, logging, metrics collection, health checks, alerting, and distributed tracing specification for AgentPane. This specification enables deep visibility into agent execution, system health, and operational metrics across the local-first architecture.

### Implementation Status

| Area | Status | Notes |
|------|--------|-------|
| Structured Logging | **Implemented** | `src/lib/logging/logger.ts` -- `createLogger(context)` with level filtering and JSON/human-readable output |
| Health Checks | **Implemented** | `src/server/routes/health.ts` -- Hono routes at `/api/health`, `/api/health/liveness`, `/api/health/readiness` |
| Request ID Middleware | **Implemented** | `src/server/router.ts` -- `requestIdMiddleware` sets `X-Request-Id` header |
| HTTP Request Logging | **Implemented** | Hono built-in `logger()` middleware in `src/server/router.ts` |
| Metrics Collection | Planned | No `lib/observability/metrics*` files exist yet |
| Distributed Tracing | Planned | No `lib/observability/tracing*` files exist yet |
| Alerting | Planned | No `lib/observability/alerts*` files exist yet |
| Sensitive Data Masking | Planned | No `lib/logging/masking.ts` exists yet |
| Dashboards | Planned | Specification only; no Grafana/Prometheus integration |

---

## Technology Context

| Component | Technology | Role in Observability |
|-----------|------------|----------------------|
| Runtime | Bun 1.3.10 | Process metrics, native tracing hooks |
| Framework | Hono (API) + TanStack Start (SSR) | Request/response instrumentation |
| Database | SQLite (better-sqlite3 / bun:sqlite) or PostgreSQL (dual-mode via `DB_MODE`) | Query metrics, connection health |
| Streaming | Durable Streams | Event throughput, latency metrics |
| Agents | Claude Agent SDK | Turn metrics, tool execution tracing |

---

## Logging Strategy

### Log Levels

| Level | When to Use | Retention |
|-------|-------------|-----------|
| `debug` | Development diagnostics, detailed execution traces | 24 hours |
| `info` | Normal operations, state transitions, user actions | 7 days |
| `warn` | Recoverable issues, deprecations, threshold warnings | 30 days |
| `error` | Failures requiring attention, unrecoverable errors | 90 days |

### Structured Logging Format

> **Current implementation note:** The actual logger at `src/lib/logging/logger.ts` uses a simpler interface than what is specified below. It uses `createLogger(context: string)` which returns an object with `debug/info/warn/error` methods. In production it outputs JSON; in development it outputs human-readable format. The spec below describes the target schema for the structured log entries.

All logs use JSON format for machine parsing and structured querying:

```typescript
// src/lib/logging/logger.ts
import { z } from 'zod';

export const logEntrySchema = z.object({
  // Timestamp in ISO 8601 format
  timestamp: z.string().datetime(),

  // Log level
  level: z.enum(['debug', 'info', 'warn', 'error']),

  // Human-readable message
  message: z.string(),

  // Service identifier
  service: z.literal('agentpane'),

  // Component that generated the log
  component: z.enum([
    'api',
    'agent',
    'worktree',
    'session',
    'database',
    'stream',
    'github',
    'scheduler',
  ]),

  // Correlation IDs for distributed tracing
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),

  // Request context
  requestId: z.string().optional(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),

  // Entity context
  projectId: z.string().optional(),
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  worktreeId: z.string().optional(),

  // Error context (when level === 'error')
  error: z.object({
    code: z.string(),
    message: z.string(),
    stack: z.string().optional(),
    details: z.record(z.unknown()).optional(),
  }).optional(),

  // Performance metrics
  duration: z.number().optional(),  // milliseconds

  // Arbitrary structured data
  data: z.record(z.unknown()).optional(),
});

export type LogEntry = z.infer<typeof logEntrySchema>;
```

### Logger Implementation (Target)

> **Current implementation:** The actual logger (`src/lib/logging/logger.ts`) is a simpler module that uses `createLogger(context: string)` returning `{ debug, info, warn, error }` methods. Each method accepts `(message, opts?)` where opts can include `requestId`, `data`, and `error`. It delegates to `console.log/warn/error/debug` with JSON output in production and human-readable output in development. The class-based `Logger` with component enums, trace IDs, and child loggers shown below is the target design.

```typescript
// src/lib/logging/logger.ts (implementation)
import { createId } from '@paralleldrive/cuid2';
import type { LogEntry } from './logger';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  component: LogEntry['component'];
  traceId?: string;
  spanId?: string;
  requestId?: string;
  userId?: string;
  sessionId?: string;
  projectId?: string;
  agentId?: string;
  taskId?: string;
  worktreeId?: string;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LOG_LEVEL = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

class Logger {
  private context: LogContext;

  constructor(context: LogContext) {
    this.context = context;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[MIN_LOG_LEVEL];
  }

  private write(level: LogLevel, message: string, data?: Record<string, unknown>) {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: 'agentpane',
      component: this.context.component,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      requestId: this.context.requestId,
      userId: this.context.userId,
      sessionId: this.context.sessionId,
      projectId: this.context.projectId,
      agentId: this.context.agentId,
      taskId: this.context.taskId,
      worktreeId: this.context.worktreeId,
      data,
    };

    // Remove undefined values for cleaner JSON
    const cleanEntry = JSON.parse(JSON.stringify(entry));

    // Write to stdout for log aggregation
    console.log(JSON.stringify(cleanEntry));
  }

  debug(message: string, data?: Record<string, unknown>) {
    this.write('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>) {
    this.write('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>) {
    this.write('warn', message, data);
  }

  error(message: string, error?: Error | unknown, data?: Record<string, unknown>) {
    const errorContext = error instanceof Error
      ? {
          code: (error as any).code ?? 'UNKNOWN_ERROR',
          message: error.message,
          stack: error.stack,
        }
      : typeof error === 'object' && error !== null
        ? error as Record<string, unknown>
        : undefined;

    this.write('error', message, {
      ...data,
      error: errorContext,
    });
  }

  // Create child logger with additional context
  child(additionalContext: Partial<LogContext>): Logger {
    return new Logger({
      ...this.context,
      ...additionalContext,
    });
  }

  // Create span for timing operations
  startSpan(name: string): Span {
    const spanId = createId();
    return new Span(this.child({ spanId }), name);
  }
}

class Span {
  private logger: Logger;
  private name: string;
  private startTime: number;
  private attributes: Record<string, unknown> = {};

  constructor(logger: Logger, name: string) {
    this.logger = logger;
    this.name = name;
    this.startTime = performance.now();
    this.logger.debug(`Span started: ${name}`);
  }

  setAttribute(key: string, value: unknown) {
    this.attributes[key] = value;
  }

  end(status: 'ok' | 'error' = 'ok') {
    const duration = performance.now() - this.startTime;
    this.logger.info(`Span ended: ${this.name}`, {
      duration,
      status,
      ...this.attributes,
    });
  }
}

export function createLogger(context: LogContext): Logger {
  return new Logger(context);
}

// Pre-configured loggers for each component
export const loggers = {
  api: (requestId?: string) => createLogger({ component: 'api', requestId }),
  agent: (agentId: string) => createLogger({ component: 'agent', agentId }),
  worktree: (worktreeId?: string) => createLogger({ component: 'worktree', worktreeId }),
  session: (sessionId?: string) => createLogger({ component: 'session', sessionId }),
  database: () => createLogger({ component: 'database' }),
  stream: (sessionId?: string) => createLogger({ component: 'stream', sessionId }),
  github: () => createLogger({ component: 'github' }),
  scheduler: () => createLogger({ component: 'scheduler' }),
};
```

### What to Log at Each Level

#### Debug Level

```typescript
// Agent execution details
logger.debug('Tool input prepared', { tool: 'Read', input: { path: '/src/index.ts' } });
logger.debug('Query plan generated', { sql: 'SELECT...', params: [] });
logger.debug('WebSocket frame received', { type: 'text', size: 1024 });
logger.debug('Cache lookup', { key: 'session:abc123', hit: true });
```

#### Info Level

```typescript
// State transitions
logger.info('Agent started', { agentId, taskId, sessionId });
logger.info('Task moved to column', { taskId, from: 'backlog', to: 'in_progress' });
logger.info('Session created', { sessionId, projectId, url: '/sessions/abc123' });
logger.info('Worktree created', { worktreeId, branch: 'agent/feature-x', path });

// User actions
logger.info('User approved task', { taskId, userId, diffStats: { added: 50, removed: 10 } });
logger.info('User joined session', { sessionId, userId });

// API requests
logger.info('Request completed', { method: 'POST', path: '/api/agents/start', status: 200, duration: 150 });
```

#### Warn Level

```typescript
// Threshold warnings
logger.warn('Agent approaching turn limit', { agentId, current: 40, max: 50 });
logger.warn('Concurrency limit reached', { projectId, current: 3, max: 3, queued: 2 });
logger.warn('Rate limit threshold exceeded', { endpoint: '/api/tasks', remaining: 5, limit: 100 });

// Recoverable issues
logger.warn('Retry scheduled', { operation: 'github_api', attempt: 2, maxAttempts: 3 });
logger.warn('Stale presence detected', { sessionId, userId, lastSeen: timestamp });
logger.warn('Deprecated API called', { endpoint: '/api/v1/agents', suggestedEndpoint: '/api/v2/agents' });
```

#### Error Level

```typescript
// Failures
logger.error('Agent execution failed', agentError, { agentId, taskId, turnCount: 15 });
logger.error('Worktree creation failed', worktreeError, { projectId, branch });
logger.error('Database query failed', dbError, { query: 'SELECT...', table: 'tasks' });
logger.error('GitHub API error', githubError, { endpoint: '/repos/owner/repo', status: 403 });
logger.error('Stream connection lost', connectionError, { sessionId, reconnectAttempt: 3 });
```

### Sensitive Data Masking

```typescript
// src/lib/logging/masking.ts (planned)

const SENSITIVE_PATTERNS = [
  /ANTHROPIC_API_KEY/i,
  /GITHUB_TOKEN/i,
  /GITHUB_PRIVATE_KEY/i,
  /password/i,
  /secret/i,
  /credential/i,
  /api[_-]?key/i,
  /auth[_-]?token/i,
];

const SENSITIVE_FIELDS = new Set([
  'password',
  'apiKey',
  'api_key',
  'token',
  'secret',
  'privateKey',
  'private_key',
  'authorization',
  'cookie',
]);

export function maskSensitiveData(data: unknown, depth = 0): unknown {
  if (depth > 10) return data; // Prevent infinite recursion

  if (typeof data === 'string') {
    // Mask environment variable patterns
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(data)) {
        return '[REDACTED]';
      }
    }
    // Mask values that look like tokens/keys
    if (data.length > 20 && /^[A-Za-z0-9_-]+$/.test(data)) {
      return `${data.slice(0, 4)}...[REDACTED]`;
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => maskSensitiveData(item, depth + 1));
  }

  if (typeof data === 'object' && data !== null) {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
        masked[key] = '[REDACTED]';
      } else {
        masked[key] = maskSensitiveData(value, depth + 1);
      }
    }
    return masked;
  }

  return data;
}

// Wrap logger to auto-mask sensitive data
export function createMaskedLogger(baseLogger: Logger): Logger {
  return new Proxy(baseLogger, {
    get(target, prop) {
      if (['debug', 'info', 'warn', 'error'].includes(prop as string)) {
        return (message: string, ...args: unknown[]) => {
          const maskedArgs = args.map(arg => maskSensitiveData(arg));
          return (target as any)[prop](message, ...maskedArgs);
        };
      }
      return (target as any)[prop];
    },
  });
}
```

### Log Rotation and Retention

```typescript
// src/lib/logging/log-config.ts (planned)

export const LOG_CONFIG = {
  // File-based logging (when not using centralized logging)
  file: {
    enabled: process.env.LOG_TO_FILE === 'true',
    path: process.env.LOG_PATH ?? './logs',
    maxFileSize: '100MB',
    maxFiles: 10,
    compress: true,
  },

  // Retention policies by level
  retention: {
    debug: '24h',
    info: '7d',
    warn: '30d',
    error: '90d',
  },

  // Sampling for high-volume logs
  sampling: {
    debug: 0.1,   // 10% of debug logs
    info: 1.0,    // 100% of info logs
    warn: 1.0,    // 100% of warning logs
    error: 1.0,   // 100% of error logs
  },
};
```

---

## Metrics Collection

### TypeScript Interfaces

```typescript
// src/lib/observability/metrics.ts (planned)
import { z } from 'zod';

export const metricTypeSchema = z.enum(['counter', 'gauge', 'histogram', 'summary']);
export type MetricType = z.infer<typeof metricTypeSchema>;

export interface MetricDefinition {
  name: string;
  type: MetricType;
  help: string;
  labels?: string[];
  buckets?: number[];  // For histograms
}

export interface MetricValue {
  name: string;
  labels: Record<string, string>;
  value: number;
  timestamp: number;
}

// Metric registry interface
export interface MetricsRegistry {
  // Counter operations
  counter(name: string, labels?: Record<string, string>): Counter;

  // Gauge operations
  gauge(name: string, labels?: Record<string, string>): Gauge;

  // Histogram operations
  histogram(name: string, labels?: Record<string, string>): Histogram;

  // Get all metrics
  collect(): MetricValue[];

  // Prometheus format export
  toPrometheus(): string;
}

export interface Counter {
  inc(value?: number): void;
}

export interface Gauge {
  set(value: number): void;
  inc(value?: number): void;
  dec(value?: number): void;
}

export interface Histogram {
  observe(value: number): void;
  startTimer(): () => void;
}
```

### Key Performance Indicators (KPIs)

| KPI | Metric | Target | Alert Threshold |
|-----|--------|--------|-----------------|
| Task Completion Rate | `agentpane_tasks_completed_total` / `agentpane_tasks_started_total` | > 85% | < 70% |
| Agent Success Rate | `agentpane_agent_runs_total{status="completed"}` / total | > 90% | < 75% |
| Average Task Duration | `agentpane_task_duration_seconds` p50 | < 5 min | > 15 min |
| Approval Time | `agentpane_approval_wait_seconds` p50 | < 30 min | > 2 hours |
| Turn Efficiency | Turns per task completion | < 25 | > 40 |

### Business Metrics

```typescript
// src/lib/observability/metrics-definitions.ts (planned)

export const BUSINESS_METRICS: MetricDefinition[] = [
  // Agent metrics
  {
    name: 'agentpane_agents_total',
    type: 'gauge',
    help: 'Total number of agents by project and status',
    labels: ['project_id', 'status'],
  },
  {
    name: 'agentpane_agents_running',
    type: 'gauge',
    help: 'Number of currently running agents by project',
    labels: ['project_id'],
  },
  {
    name: 'agentpane_agent_runs_total',
    type: 'counter',
    help: 'Total agent runs by project and status',
    labels: ['project_id', 'agent_id', 'status'],
  },
  {
    name: 'agentpane_agent_turns_total',
    type: 'counter',
    help: 'Total turns across all agents',
    labels: ['project_id', 'agent_id'],
  },

  // Task metrics
  {
    name: 'agentpane_tasks_total',
    type: 'gauge',
    help: 'Total tasks by project and column',
    labels: ['project_id', 'column'],
  },
  {
    name: 'agentpane_tasks_created_total',
    type: 'counter',
    help: 'Tasks created over time',
    labels: ['project_id'],
  },
  {
    name: 'agentpane_tasks_completed_total',
    type: 'counter',
    help: 'Tasks moved to verified column',
    labels: ['project_id'],
  },
  {
    name: 'agentpane_task_duration_seconds',
    type: 'histogram',
    help: 'Duration from task creation to completion',
    labels: ['project_id'],
    buckets: [60, 300, 600, 1800, 3600, 7200, 14400],  // 1m, 5m, 10m, 30m, 1h, 2h, 4h
  },
  {
    name: 'agentpane_task_rejections_total',
    type: 'counter',
    help: 'Number of task rejections (approval failures)',
    labels: ['project_id', 'task_id'],
  },

  // Queue metrics
  {
    name: 'agentpane_queue_depth',
    type: 'gauge',
    help: 'Number of tasks waiting in queue',
    labels: ['project_id'],
  },
  {
    name: 'agentpane_queue_wait_seconds',
    type: 'histogram',
    help: 'Time tasks spend in queue before execution',
    labels: ['project_id'],
    buckets: [30, 60, 120, 300, 600, 1800],
  },

  // Approval metrics
  {
    name: 'agentpane_approvals_total',
    type: 'counter',
    help: 'Total approvals by outcome',
    labels: ['project_id', 'outcome'],  // approved, rejected
  },
  {
    name: 'agentpane_approval_wait_seconds',
    type: 'histogram',
    help: 'Time waiting for approval',
    labels: ['project_id'],
    buckets: [60, 300, 900, 1800, 3600, 7200, 14400],
  },

  // Session metrics
  {
    name: 'agentpane_sessions_active',
    type: 'gauge',
    help: 'Number of active sessions',
    labels: ['project_id'],
  },
  {
    name: 'agentpane_session_participants',
    type: 'gauge',
    help: 'Number of participants in active sessions',
    labels: ['session_id'],
  },
  {
    name: 'agentpane_session_events_total',
    type: 'counter',
    help: 'Total events published to sessions',
    labels: ['session_id', 'event_type'],
  },
];
```

### Technical Metrics

```typescript
// src/lib/observability/metrics-definitions.ts (planned, continued)

export const TECHNICAL_METRICS: MetricDefinition[] = [
  // HTTP metrics
  {
    name: 'agentpane_http_requests_total',
    type: 'counter',
    help: 'Total HTTP requests',
    labels: ['method', 'path', 'status'],
  },
  {
    name: 'agentpane_http_request_duration_seconds',
    type: 'histogram',
    help: 'HTTP request duration',
    labels: ['method', 'path'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
  {
    name: 'agentpane_http_request_size_bytes',
    type: 'histogram',
    help: 'HTTP request body size',
    labels: ['method', 'path'],
    buckets: [100, 1000, 10000, 100000, 1000000],
  },
  {
    name: 'agentpane_http_response_size_bytes',
    type: 'histogram',
    help: 'HTTP response body size',
    labels: ['method', 'path'],
    buckets: [100, 1000, 10000, 100000, 1000000],
  },

  // Database metrics
  {
    name: 'agentpane_db_queries_total',
    type: 'counter',
    help: 'Total database queries',
    labels: ['operation', 'table'],
  },
  {
    name: 'agentpane_db_query_duration_seconds',
    type: 'histogram',
    help: 'Database query duration',
    labels: ['operation', 'table'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  },
  {
    name: 'agentpane_db_connections_active',
    type: 'gauge',
    help: 'Active database connections',
    labels: [],
  },
  {
    name: 'agentpane_db_size_bytes',
    type: 'gauge',
    help: 'Database size in bytes',
    labels: ['database'],
  },

  // Tool execution metrics
  {
    name: 'agentpane_tool_calls_total',
    type: 'counter',
    help: 'Total tool calls by tool name and status',
    labels: ['tool', 'status'],  // status: success, error, denied
  },
  {
    name: 'agentpane_tool_duration_seconds',
    type: 'histogram',
    help: 'Tool execution duration',
    labels: ['tool'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  },

  // Stream metrics
  {
    name: 'agentpane_stream_connections_active',
    type: 'gauge',
    help: 'Active stream connections (SSE/WebSocket)',
    labels: ['type'],  // sse, websocket
  },
  {
    name: 'agentpane_stream_events_total',
    type: 'counter',
    help: 'Total events sent through streams',
    labels: ['event_type'],
  },
  {
    name: 'agentpane_stream_latency_seconds',
    type: 'histogram',
    help: 'Event publish to delivery latency',
    labels: [],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  },

  // Worktree metrics
  {
    name: 'agentpane_worktrees_active',
    type: 'gauge',
    help: 'Number of active worktrees',
    labels: ['project_id'],
  },
  {
    name: 'agentpane_worktree_creation_duration_seconds',
    type: 'histogram',
    help: 'Worktree creation duration',
    labels: ['project_id'],
    buckets: [1, 5, 10, 30, 60, 120, 300],
  },
  {
    name: 'agentpane_worktree_disk_usage_bytes',
    type: 'gauge',
    help: 'Disk usage per worktree',
    labels: ['worktree_id'],
  },

  // GitHub metrics
  {
    name: 'agentpane_github_api_calls_total',
    type: 'counter',
    help: 'Total GitHub API calls',
    labels: ['endpoint', 'status'],
  },
  {
    name: 'agentpane_github_api_duration_seconds',
    type: 'histogram',
    help: 'GitHub API call duration',
    labels: ['endpoint'],
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
  {
    name: 'agentpane_github_rate_limit_remaining',
    type: 'gauge',
    help: 'GitHub API rate limit remaining',
    labels: [],
  },

  // Claude API metrics
  {
    name: 'agentpane_claude_api_calls_total',
    type: 'counter',
    help: 'Total Claude API calls',
    labels: ['model', 'status'],
  },
  {
    name: 'agentpane_claude_tokens_total',
    type: 'counter',
    help: 'Total tokens consumed',
    labels: ['model', 'direction'],  // input, output
  },
  {
    name: 'agentpane_claude_api_duration_seconds',
    type: 'histogram',
    help: 'Claude API call duration',
    labels: ['model'],
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
  },

  // Process metrics
  {
    name: 'agentpane_process_memory_bytes',
    type: 'gauge',
    help: 'Process memory usage',
    labels: ['type'],  // heap_used, heap_total, rss, external
  },
  {
    name: 'agentpane_process_cpu_seconds_total',
    type: 'counter',
    help: 'CPU time consumed',
    labels: ['mode'],  // user, system
  },
  {
    name: 'agentpane_process_open_fds',
    type: 'gauge',
    help: 'Number of open file descriptors',
    labels: [],
  },
];
```

### Metric Naming Conventions

| Prefix | Use Case | Example |
|--------|----------|---------|
| `agentpane_` | All metrics | `agentpane_tasks_total` |
| `_total` | Counter suffix | `agentpane_http_requests_total` |
| `_seconds` | Duration metrics | `agentpane_task_duration_seconds` |
| `_bytes` | Size metrics | `agentpane_db_size_bytes` |
| `_ratio` | Calculated ratios | `agentpane_success_ratio` |

### Cardinality Considerations

```typescript
// src/lib/observability/metrics-cardinality.ts (planned)

// High cardinality labels to AVOID
const HIGH_CARDINALITY_LABELS = [
  'task_id',      // Use only for specific debugging
  'worktree_id',  // Temporary entities
  'request_id',   // Use traces instead
  'user_id',      // May have many unique values
  'session_id',   // Only use for active session metrics
];

// Safe labels with bounded cardinality
const SAFE_LABELS = [
  'project_id',   // Bounded by number of projects
  'agent_id',     // Bounded, typically < 10 per project
  'status',       // Enum values
  'method',       // HTTP methods (GET, POST, etc.)
  'tool',         // Bounded set of tools
  'column',       // 4 Kanban columns
  'event_type',   // Bounded event types
];

// Estimated cardinality budget
export const CARDINALITY_LIMITS = {
  maxUniqueTimeSeries: 10000,
  maxLabelsPerMetric: 5,
  maxUniqueValuesPerLabel: 100,
};
```

### Metrics Registry Implementation

```typescript
// src/lib/observability/metrics-registry.ts (planned)

interface StoredMetric {
  definition: MetricDefinition;
  values: Map<string, { value: number; timestamp: number }>;
  buckets?: Map<string, number[]>;  // For histograms
}

export class MetricsRegistry implements MetricsRegistry {
  private metrics = new Map<string, StoredMetric>();

  private getKey(labels: Record<string, string>): string {
    return Object.entries(labels).sort().map(([k, v]) => `${k}="${v}"`).join(',');
  }

  counter(name: string, labels: Record<string, string> = {}): Counter {
    if (!this.metrics.has(name)) {
      throw new Error(`Metric ${name} not registered`);
    }

    const metric = this.metrics.get(name)!;
    const key = this.getKey(labels);

    return {
      inc: (value = 1) => {
        const current = metric.values.get(key)?.value ?? 0;
        metric.values.set(key, { value: current + value, timestamp: Date.now() });
      },
    };
  }

  gauge(name: string, labels: Record<string, string> = {}): Gauge {
    if (!this.metrics.has(name)) {
      throw new Error(`Metric ${name} not registered`);
    }

    const metric = this.metrics.get(name)!;
    const key = this.getKey(labels);

    return {
      set: (value: number) => {
        metric.values.set(key, { value, timestamp: Date.now() });
      },
      inc: (value = 1) => {
        const current = metric.values.get(key)?.value ?? 0;
        metric.values.set(key, { value: current + value, timestamp: Date.now() });
      },
      dec: (value = 1) => {
        const current = metric.values.get(key)?.value ?? 0;
        metric.values.set(key, { value: current - value, timestamp: Date.now() });
      },
    };
  }

  histogram(name: string, labels: Record<string, string> = {}): Histogram {
    if (!this.metrics.has(name)) {
      throw new Error(`Metric ${name} not registered`);
    }

    const metric = this.metrics.get(name)!;
    const key = this.getKey(labels);
    const buckets = metric.definition.buckets ?? [0.01, 0.05, 0.1, 0.5, 1, 5, 10];

    if (!metric.buckets) {
      metric.buckets = new Map();
    }
    if (!metric.buckets.has(key)) {
      metric.buckets.set(key, buckets.map(() => 0));
    }

    return {
      observe: (value: number) => {
        const bucketCounts = metric.buckets!.get(key)!;
        for (let i = 0; i < buckets.length; i++) {
          if (value <= buckets[i]) {
            bucketCounts[i]++;
          }
        }
        // Also track sum and count
        const current = metric.values.get(key) ?? { value: 0, timestamp: 0 };
        metric.values.set(key, {
          value: current.value + value,
          timestamp: Date.now(),
        });
      },
      startTimer: () => {
        const start = performance.now();
        return () => {
          const duration = (performance.now() - start) / 1000;
          this.histogram(name, labels).observe(duration);
        };
      },
    };
  }

  toPrometheus(): string {
    const lines: string[] = [];

    for (const [name, metric] of this.metrics) {
      lines.push(`# HELP ${name} ${metric.definition.help}`);
      lines.push(`# TYPE ${name} ${metric.definition.type}`);

      for (const [key, { value }] of metric.values) {
        const labelStr = key ? `{${key}}` : '';
        lines.push(`${name}${labelStr} ${value}`);
      }

      // Histogram buckets
      if (metric.definition.type === 'histogram' && metric.buckets) {
        const buckets = metric.definition.buckets ?? [];
        for (const [key, counts] of metric.buckets) {
          const baseLabels = key ? `${key},` : '';
          for (let i = 0; i < buckets.length; i++) {
            lines.push(`${name}_bucket{${baseLabels}le="${buckets[i]}"} ${counts[i]}`);
          }
          lines.push(`${name}_bucket{${baseLabels}le="+Inf"} ${counts.reduce((a, b) => a + b, 0)}`);
        }
      }
    }

    return lines.join('\n');
  }

  // Register metrics at startup
  register(definition: MetricDefinition) {
    this.metrics.set(definition.name, {
      definition,
      values: new Map(),
    });
  }
}

// Singleton registry
export const registry = new MetricsRegistry();

// Register all metrics at module load
[...BUSINESS_METRICS, ...TECHNICAL_METRICS].forEach(m => registry.register(m));
```

---

## Health Checks

### Health Check Types

| Check Type | Purpose | Failure Impact |
|------------|---------|----------------|
| **Liveness** | Is the process alive? | Container restart |
| **Readiness** | Can the service handle requests? | Remove from load balancer |
| **Startup** | Is the service initialized? | Wait before liveness checks |

### Health Check Interfaces

```typescript
// src/lib/observability/health.ts (planned)
import { z } from 'zod';

export const healthStatusSchema = z.enum(['healthy', 'degraded', 'unhealthy']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const componentHealthSchema = z.object({
  name: z.string(),
  status: healthStatusSchema,
  message: z.string().optional(),
  latency: z.number().optional(),  // milliseconds
  lastCheck: z.string().datetime(),
  details: z.record(z.unknown()).optional(),
});

export type ComponentHealth = z.infer<typeof componentHealthSchema>;

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  version: z.string(),
  uptime: z.number(),  // seconds
  timestamp: z.string().datetime(),
  components: z.array(componentHealthSchema).optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

// Health check function signature
export type HealthCheck = () => Promise<ComponentHealth>;
```

### Liveness Probe: /api/health/liveness

Returns immediately if the process is running. No dependency checks.

The health routes are implemented as Hono routes in `src/server/routes/health.ts` and mounted at `/api/health` via the main router (`src/server/router.ts`).

```typescript
// src/server/routes/health.ts (actual implementation)
// Liveness: GET /api/health/liveness
app.get('/liveness', (_c) => {
  return json({ ok: true, status: 'alive' });
});
```

There is also a legacy alias at `GET /api/healthz` that returns the same response.

### Readiness Probe: /api/health/readiness

Checks database connectivity before accepting traffic.

```typescript
// src/server/routes/health.ts (actual implementation)
// Readiness: GET /api/health/readiness
app.get('/readiness', async (_c) => {
  try {
    const dbStart = Date.now();
    await db.query.projects.findFirst();
    return json({
      ok: true,
      status: 'ready',
      dbLatencyMs: Date.now() - dbStart,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        status: 'not_ready',
        error: error instanceof Error ? error.message : 'Database unreachable',
      },
      503
    );
  }
});
```

There is also a legacy alias at `GET /api/readyz` that returns a simplified response.

### Component Health Checks

The comprehensive health check endpoint is `GET /api/health` (Hono route). It checks multiple subsystems in a single request.

```typescript
// src/server/routes/health.ts (actual implementation)
// GET /api/health — comprehensive health check
//
// The health route checks: database, GitHub token, sandbox provider, and
// optionally Kubernetes provider health.

// Database health check (supports both SQLite and PostgreSQL via DB_MODE)
// Queries projects table and database version
try {
  const dbStart = Date.now();
  const result = await db.query.projects.findFirst();
  // For SQLite: SELECT sqlite_version()
  // For Postgres: SELECT version()
  checks.database = {
    status: 'ok',
    latencyMs: Date.now() - dbStart,
    mode: DB_MODE,   // 'sqlite' or 'postgres'
    version,         // e.g. "SQLite 3.45.0" or "PostgreSQL 16.2"
  };
} catch (error) {
  checks.database = {
    status: 'error',
    mode: DB_MODE,
    error: error instanceof Error ? error.message : 'Database query failed',
  };
}

// Durable Streams health check
async function checkDurableStreams(): Promise<ComponentHealth> {
  const start = performance.now();
  const name = 'durable_streams';

  try {
    // Check if stream server is accepting connections
    const response = await Promise.race([
      fetch('http://localhost:3001/health', { method: 'HEAD' }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
      ),
    ]);

    if (!response.ok) {
      throw new Error(`Stream server returned ${response.status}`);
    }

    return {
      name,
      status: 'healthy',
      latency: performance.now() - start,
      lastCheck: new Date().toISOString(),
    };
  } catch (error) {
    return {
      name,
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
      latency: performance.now() - start,
      lastCheck: new Date().toISOString(),
    };
  }
}

// GitHub API health check
async function checkGitHub(): Promise<ComponentHealth> {
  const start = performance.now();
  const name = 'github';

  // Skip if no GitHub integration configured
  if (!process.env.GITHUB_APP_ID) {
    return {
      name,
      status: 'healthy',
      message: 'GitHub integration not configured',
      latency: 0,
      lastCheck: new Date().toISOString(),
    };
  }

  try {
    const response = await Promise.race([
      fetch('https://api.github.com/rate_limit', {
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
      ),
    ]);

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`);
    }

    const data = await response.json() as { rate: { remaining: number; limit: number } };
    const remainingPercent = (data.rate.remaining / data.rate.limit) * 100;

    return {
      name,
      status: remainingPercent > 10 ? 'healthy' : 'degraded',
      message: remainingPercent <= 10 ? 'Rate limit low' : undefined,
      latency: performance.now() - start,
      lastCheck: new Date().toISOString(),
      details: {
        rateLimit: {
          remaining: data.rate.remaining,
          limit: data.rate.limit,
          percentRemaining: remainingPercent.toFixed(1),
        },
      },
    };
  } catch (error) {
    return {
      name,
      status: 'degraded',  // GitHub is optional, so degraded not unhealthy
      message: error instanceof Error ? error.message : 'Unknown error',
      latency: performance.now() - start,
      lastCheck: new Date().toISOString(),
    };
  }
}

// File system health check (for worktrees)
async function checkFileSystem(): Promise<ComponentHealth> {
  const start = performance.now();
  const name = 'filesystem';

  try {
    const testPath = '/tmp/agentpane-health-check';
    await Bun.write(testPath, 'health');
    const content = await Bun.file(testPath).text();
    await Bun.$`rm ${testPath}`;

    if (content !== 'health') {
      throw new Error('File content mismatch');
    }

    return {
      name,
      status: 'healthy',
      latency: performance.now() - start,
      lastCheck: new Date().toISOString(),
    };
  } catch (error) {
    return {
      name,
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
      latency: performance.now() - start,
      lastCheck: new Date().toISOString(),
    };
  }
}

// All checks run within a single Hono handler (GET /api/health)
// Checks: database, GitHub token, sandbox provider, Kubernetes (optional)
// The actual implementation runs checks sequentially within one handler:

  // Determine overall status
  let overallStatus: HealthStatus = 'healthy';
  for (const check of checks) {
    if (check.status === 'unhealthy') {
      overallStatus = 'unhealthy';
      break;
    }
    if (check.status === 'degraded') {
      overallStatus = 'degraded';
    }
  }

  return {
    status: overallStatus,
    version: process.env.APP_VERSION ?? '0.0.0',
    uptime: Math.floor((Date.now() - global.startTime) / 1000),
    timestamp: new Date().toISOString(),
    components: checks,
  };
}
```

### Health Check Response Format

The actual `GET /api/health` response format:

```json
{
  "ok": true,
  "data": {
    "status": "healthy",
    "timestamp": "2026-01-17T10:30:00.000Z",
    "uptime": 86400,
    "checks": {
      "database": {
        "status": "ok",
        "latencyMs": 2,
        "mode": "sqlite",
        "version": "SQLite 3.45.0"
      },
      "github": {
        "status": "ok",
        "login": "octocat"
      },
      "sandbox": {
        "status": "ok",
        "containerCount": 1,
        "containerId": "abc123"
      },
      "kubernetes": {
        "status": "ok",
        "crdRegistered": true,
        "namespaceExists": true,
        "controllerInstalled": true,
        "clusterVersion": "v1.28.0"
      }
    },
    "responseTimeMs": 15
  }
}
```

Note: The `kubernetes` field only appears when a K8s provider is configured. The `sandbox` field shows `"not_configured"` when no sandbox provider is available.

---

## Alerting

### Alert Severity Levels

| Level | Response Time | Examples |
|-------|---------------|----------|
| **Critical (P1)** | Immediate (< 5 min) | Service down, data loss risk, security breach |
| **Warning (P2)** | Within 1 hour | Degraded performance, approaching limits |
| **Info (P3)** | Next business day | Trend changes, capacity planning |

### Alert Definitions

```typescript
// src/lib/observability/alerts.ts (planned)
import { z } from 'zod';

export const alertSeveritySchema = z.enum(['critical', 'warning', 'info']);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

export const alertDefinitionSchema = z.object({
  name: z.string(),
  severity: alertSeveritySchema,
  description: z.string(),
  condition: z.string(),  // PromQL or custom expression
  for: z.string(),        // Duration condition must be true
  labels: z.record(z.string()),
  annotations: z.object({
    summary: z.string(),
    description: z.string(),
    runbook: z.string().url().optional(),
  }),
});

export type AlertDefinition = z.infer<typeof alertDefinitionSchema>;

// Alert definitions
export const ALERTS: AlertDefinition[] = [
  // Critical alerts
  {
    name: 'AgentPaneDown',
    severity: 'critical',
    description: 'AgentPane service is not responding',
    condition: 'up{service="agentpane"} == 0',
    for: '1m',
    labels: { team: 'platform' },
    annotations: {
      summary: 'AgentPane is down',
      description: 'AgentPane has been unresponsive for more than 1 minute',
      runbook: 'https://runbooks.agentpane.dev/agentpane-down',
    },
  },
  {
    name: 'DatabaseUnhealthy',
    severity: 'critical',
    description: 'Database is not responding (SQLite or PostgreSQL depending on DB_MODE)',
    condition: 'agentpane_health_check_status{component="database"} == 0',
    for: '30s',
    labels: { team: 'platform' },
    annotations: {
      summary: 'Database health check failing',
      description: 'Database has been unhealthy for 30 seconds',
      runbook: 'https://runbooks.agentpane.dev/db-unhealthy',
    },
  },
  {
    name: 'HighErrorRate',
    severity: 'critical',
    description: 'Error rate exceeds 5%',
    condition: `
      sum(rate(agentpane_http_requests_total{status=~"5.."}[5m]))
      / sum(rate(agentpane_http_requests_total[5m])) > 0.05
    `,
    for: '5m',
    labels: { team: 'platform' },
    annotations: {
      summary: 'High error rate detected',
      description: 'Error rate has been above 5% for 5 minutes',
      runbook: 'https://runbooks.agentpane.dev/high-error-rate',
    },
  },
  {
    name: 'AgentExecutionStuck',
    severity: 'critical',
    description: 'Agent has been running without progress',
    condition: `
      agentpane_agent_last_activity_timestamp > 0
      AND (time() - agentpane_agent_last_activity_timestamp) > 600
    `,
    for: '5m',
    labels: { team: 'agents' },
    annotations: {
      summary: 'Agent execution appears stuck',
      description: 'Agent {{ $labels.agent_id }} has no activity for 10+ minutes',
      runbook: 'https://runbooks.agentpane.dev/stuck-agent',
    },
  },

  // Warning alerts
  {
    name: 'HighLatency',
    severity: 'warning',
    description: 'API latency is elevated',
    condition: `
      histogram_quantile(0.95, rate(agentpane_http_request_duration_seconds_bucket[5m])) > 2
    `,
    for: '10m',
    labels: { team: 'platform' },
    annotations: {
      summary: 'High API latency',
      description: 'P95 latency has been above 2 seconds for 10 minutes',
    },
  },
  {
    name: 'ConcurrencyLimitReached',
    severity: 'warning',
    description: 'Project at max concurrent agents',
    condition: `
      agentpane_agents_running >= agentpane_project_max_concurrent_agents
    `,
    for: '15m',
    labels: { team: 'agents' },
    annotations: {
      summary: 'Concurrency limit reached',
      description: 'Project {{ $labels.project_id }} at max agents for 15+ minutes',
    },
  },
  {
    name: 'QueueBacklog',
    severity: 'warning',
    description: 'Task queue growing',
    condition: `
      agentpane_queue_depth > 10
      AND increase(agentpane_queue_depth[30m]) > 5
    `,
    for: '30m',
    labels: { team: 'agents' },
    annotations: {
      summary: 'Growing task queue',
      description: 'Queue has more than 10 tasks and growing',
    },
  },
  {
    name: 'GitHubRateLimitLow',
    severity: 'warning',
    description: 'GitHub API rate limit running low',
    condition: 'agentpane_github_rate_limit_remaining < 500',
    for: '5m',
    labels: { team: 'integrations' },
    annotations: {
      summary: 'GitHub rate limit low',
      description: 'Less than 500 GitHub API calls remaining',
    },
  },
  {
    name: 'HighRejectionRate',
    severity: 'warning',
    description: 'Task rejection rate is high',
    condition: `
      sum(rate(agentpane_approvals_total{outcome="rejected"}[1h]))
      / sum(rate(agentpane_approvals_total[1h])) > 0.3
    `,
    for: '1h',
    labels: { team: 'agents' },
    annotations: {
      summary: 'High task rejection rate',
      description: 'More than 30% of tasks rejected in the last hour',
    },
  },
  {
    name: 'AgentApproachingTurnLimit',
    severity: 'warning',
    description: 'Agent nearing turn limit',
    condition: `
      agentpane_agent_current_turn / agentpane_agent_max_turns > 0.8
    `,
    for: '0m',
    labels: { team: 'agents' },
    annotations: {
      summary: 'Agent approaching turn limit',
      description: 'Agent {{ $labels.agent_id }} at 80%+ of turn limit',
    },
  },

  // Info alerts
  {
    name: 'NewProjectCreated',
    severity: 'info',
    description: 'A new project was created',
    condition: 'increase(agentpane_projects_total[5m]) > 0',
    for: '0m',
    labels: { team: 'platform' },
    annotations: {
      summary: 'New project created',
      description: 'A new project was created',
    },
  },
  {
    name: 'DailyTasksCompleted',
    severity: 'info',
    description: 'Daily completed tasks summary',
    condition: 'hour() == 0',  // Trigger at midnight
    for: '0m',
    labels: { team: 'metrics' },
    annotations: {
      summary: 'Daily tasks report',
      description: '{{ $value }} tasks completed today',
    },
  },
];
```

### Alert Routing and Escalation

```typescript
// src/lib/observability/alert-routing.ts (planned)

export interface AlertRoute {
  match: {
    severity?: AlertSeverity | AlertSeverity[];
    labels?: Record<string, string>;
  };
  receiver: string;
  groupBy?: string[];
  groupWait?: string;
  groupInterval?: string;
  repeatInterval?: string;
}

export interface AlertReceiver {
  name: string;
  webhookConfigs?: {
    url: string;
    sendResolved: boolean;
  }[];
  slackConfigs?: {
    channel: string;
    sendResolved: boolean;
  }[];
  emailConfigs?: {
    to: string[];
    sendResolved: boolean;
  }[];
}

export const ALERT_RECEIVERS: AlertReceiver[] = [
  {
    name: 'critical-pager',
    webhookConfigs: [
      {
        url: process.env.PAGERDUTY_WEBHOOK_URL ?? '',
        sendResolved: true,
      },
    ],
    slackConfigs: [
      {
        channel: '#agentpane-alerts-critical',
        sendResolved: true,
      },
    ],
  },
  {
    name: 'warning-slack',
    slackConfigs: [
      {
        channel: '#agentpane-alerts',
        sendResolved: true,
      },
    ],
  },
  {
    name: 'info-metrics',
    webhookConfigs: [
      {
        url: process.env.METRICS_WEBHOOK_URL ?? '',
        sendResolved: false,
      },
    ],
  },
];

export const ALERT_ROUTES: AlertRoute[] = [
  {
    match: { severity: 'critical' },
    receiver: 'critical-pager',
    groupBy: ['alertname', 'service'],
    groupWait: '30s',
    groupInterval: '5m',
    repeatInterval: '4h',
  },
  {
    match: { severity: 'warning' },
    receiver: 'warning-slack',
    groupBy: ['alertname'],
    groupWait: '1m',
    groupInterval: '10m',
    repeatInterval: '12h',
  },
  {
    match: { severity: 'info' },
    receiver: 'info-metrics',
    groupBy: ['alertname'],
    groupWait: '5m',
    groupInterval: '30m',
    repeatInterval: '24h',
  },
];
```

### On-Call Considerations

```typescript
// src/lib/observability/oncall.ts (planned)

export interface OnCallSchedule {
  team: string;
  primaryContact: string;
  secondaryContact: string;
  escalationTimeMinutes: number;
}

export const ONCALL_CONFIG = {
  // Escalation chain
  escalation: {
    initial: 5,        // Minutes before first escalation
    secondary: 15,     // Minutes before escalating to secondary
    management: 30,    // Minutes before escalating to management
  },

  // Quiet hours (reduce noise)
  quietHours: {
    enabled: true,
    start: '22:00',
    end: '08:00',
    timezone: 'America/Los_Angeles',
    // Only critical alerts during quiet hours
    allowedSeverities: ['critical'] as AlertSeverity[],
  },

  // Alert batching
  batching: {
    enabled: true,
    windowSeconds: 60,
    maxAlerts: 10,
  },
};
```

---

## Distributed Tracing

### Trace Context Propagation

```typescript
// src/lib/observability/tracing.ts (planned)
import { createId } from '@paralleldrive/cuid2';

// W3C Trace Context format
export interface TraceContext {
  traceId: string;      // 32 hex characters
  spanId: string;       // 16 hex characters
  parentSpanId?: string;
  traceFlags: number;   // 0 = not sampled, 1 = sampled
  traceState?: string;  // Optional vendor-specific state
}

// Parse traceparent header
export function parseTraceParent(header: string | null): TraceContext | null {
  if (!header) return null;

  // Format: 00-{traceId}-{spanId}-{flags}
  const match = header.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/);
  if (!match) return null;

  return {
    traceId: match[1],
    spanId: match[2],
    traceFlags: parseInt(match[3], 16),
  };
}

// Generate traceparent header
export function formatTraceParent(ctx: TraceContext): string {
  const flags = ctx.traceFlags.toString(16).padStart(2, '0');
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

// Create new trace context
export function createTraceContext(parentContext?: TraceContext): TraceContext {
  const traceId = parentContext?.traceId ?? createId().padEnd(32, '0').slice(0, 32);
  const spanId = createId().slice(0, 16);

  return {
    traceId,
    spanId,
    parentSpanId: parentContext?.spanId,
    traceFlags: 1,  // Always sample in development
  };
}

// Trace context storage (async local storage for Bun)
const traceStorage = new Map<string, TraceContext>();

export function setCurrentTrace(requestId: string, ctx: TraceContext) {
  traceStorage.set(requestId, ctx);
}

export function getCurrentTrace(requestId: string): TraceContext | undefined {
  return traceStorage.get(requestId);
}

export function clearTrace(requestId: string) {
  traceStorage.delete(requestId);
}
```

### Span Naming Conventions

| Operation Type | Span Name Pattern | Example |
|---------------|-------------------|---------|
| HTTP Request | `http.{method} {route}` | `http.POST /api/tasks` |
| Database Query | `db.{operation} {table}` | `db.select tasks` |
| Tool Execution | `tool.{name}` | `tool.Read` |
| Agent Turn | `agent.turn.{number}` | `agent.turn.15` |
| External API | `external.{service}.{operation}` | `external.github.createPR` |
| Stream Event | `stream.{event_type}` | `stream.chunk` |

### Span Implementation

```typescript
// src/lib/observability/spans.ts (planned)
import { createId } from '@paralleldrive/cuid2';
import type { TraceContext } from './tracing';
import { loggers } from './logger.impl';

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: SpanAttributes;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'client' | 'server' | 'producer' | 'consumer' | 'internal';
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'ok' | 'error' | 'unset';
  attributes: SpanAttributes;
  events: SpanEvent[];
}

export class SpanBuilder {
  private span: Span;
  private logger = loggers.api();

  constructor(name: string, traceContext: TraceContext, kind: Span['kind'] = 'internal') {
    this.span = {
      traceId: traceContext.traceId,
      spanId: createId().slice(0, 16),
      parentSpanId: traceContext.spanId,
      name,
      kind,
      startTime: performance.now(),
      status: 'unset',
      attributes: {},
      events: [],
    };

    this.logger = this.logger.child({
      traceId: this.span.traceId,
      spanId: this.span.spanId,
    });
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.span.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: SpanAttributes): this {
    Object.assign(this.span.attributes, attrs);
    return this;
  }

  addEvent(name: string, attributes?: SpanAttributes): this {
    this.span.events.push({
      name,
      timestamp: performance.now(),
      attributes,
    });
    return this;
  }

  setStatus(status: 'ok' | 'error', message?: string): this {
    this.span.status = status;
    if (message) {
      this.span.attributes['status.message'] = message;
    }
    return this;
  }

  end(): Span {
    this.span.endTime = performance.now();
    this.span.duration = this.span.endTime - this.span.startTime;

    // Log span completion
    this.logger.info(`Span completed: ${this.span.name}`, {
      duration: this.span.duration,
      status: this.span.status,
      attributes: this.span.attributes,
    });

    return this.span;
  }

  getContext(): TraceContext {
    return {
      traceId: this.span.traceId,
      spanId: this.span.spanId,
      parentSpanId: this.span.parentSpanId,
      traceFlags: 1,
    };
  }
}
```

### Request Tracing Middleware

```typescript
// src/lib/observability/tracing-middleware.ts (planned)
import { createTraceContext, parseTraceParent, formatTraceParent, setCurrentTrace, clearTrace } from './tracing';
import { SpanBuilder } from './spans';
import { registry } from './metrics-registry';
import { createId } from '@paralleldrive/cuid2';

export function createTracingMiddleware() {
  return async (request: Request, next: () => Promise<Response>): Promise<Response> => {
    const requestId = createId();
    const url = new URL(request.url);

    // Extract or create trace context
    const parentContext = parseTraceParent(request.headers.get('traceparent'));
    const traceContext = createTraceContext(parentContext ?? undefined);

    // Store trace context
    setCurrentTrace(requestId, traceContext);

    // Create request span
    const span = new SpanBuilder(`http.${request.method} ${url.pathname}`, traceContext, 'server');
    span.setAttributes({
      'http.method': request.method,
      'http.url': request.url,
      'http.route': url.pathname,
      'http.user_agent': request.headers.get('user-agent') ?? 'unknown',
    });

    // Metrics timer
    const stopTimer = registry.histogram('agentpane_http_request_duration_seconds', {
      method: request.method,
      path: url.pathname,
    }).startTimer();

    try {
      const response = await next();

      span.setAttributes({
        'http.status_code': response.status,
      });
      span.setStatus(response.ok ? 'ok' : 'error');

      // Record metrics
      registry.counter('agentpane_http_requests_total', {
        method: request.method,
        path: url.pathname,
        status: String(response.status),
      }).inc();

      // Add trace headers to response
      const headers = new Headers(response.headers);
      headers.set('traceparent', formatTraceParent(traceContext));
      headers.set('x-request-id', requestId);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      span.setStatus('error', error instanceof Error ? error.message : 'Unknown error');
      span.addEvent('exception', {
        'exception.type': error instanceof Error ? error.constructor.name : 'Error',
        'exception.message': error instanceof Error ? error.message : String(error),
      });

      registry.counter('agentpane_http_requests_total', {
        method: request.method,
        path: url.pathname,
        status: '500',
      }).inc();

      throw error;
    } finally {
      stopTimer();
      span.end();
      clearTrace(requestId);
    }
  };
}
```

### Cross-Service Context Propagation

```typescript
// src/lib/observability/context-propagation.ts (planned)
import { formatTraceParent, type TraceContext } from './tracing';

// Propagate context to outgoing HTTP requests
export function injectTraceContext(
  headers: Headers | Record<string, string>,
  context: TraceContext
): void {
  const traceparent = formatTraceParent(context);

  if (headers instanceof Headers) {
    headers.set('traceparent', traceparent);
  } else {
    headers['traceparent'] = traceparent;
  }
}

// Propagate context to Durable Streams events
export function injectStreamContext<T extends Record<string, unknown>>(
  event: T,
  context: TraceContext
): T & { _trace: TraceContext } {
  return {
    ...event,
    _trace: context,
  };
}

// Extract context from Durable Streams events
export function extractStreamContext<T extends { _trace?: TraceContext }>(
  event: T
): TraceContext | undefined {
  return event._trace;
}

// Propagate context to Claude Agent SDK
export function createAgentContextHeaders(context: TraceContext): Record<string, string> {
  return {
    'traceparent': formatTraceParent(context),
    'x-agentpane-trace-id': context.traceId,
    'x-agentpane-span-id': context.spanId,
  };
}
```

---

## Dashboard Specifications

### Overview Dashboard

**Purpose:** High-level system health and key metrics at a glance.

| Panel | Visualization | Metric |
|-------|---------------|--------|
| Service Health | Status indicator | Health check status |
| Active Agents | Single stat | `agentpane_agents_running` |
| Tasks by Column | Stacked bar | `agentpane_tasks_total` by column |
| Request Rate | Time series | `rate(agentpane_http_requests_total[5m])` |
| Error Rate | Time series | Error requests / total requests |
| P95 Latency | Time series | `histogram_quantile(0.95, ...)` |

```typescript
// Dashboard configuration
export const OVERVIEW_DASHBOARD = {
  title: 'AgentPane Overview',
  refresh: '30s',
  rows: [
    {
      title: 'Service Health',
      panels: [
        {
          title: 'Health Status',
          type: 'stat',
          query: 'agentpane_health_check_status{component="all"}',
          thresholds: [
            { value: 0, color: 'red' },
            { value: 1, color: 'green' },
          ],
        },
        {
          title: 'Uptime',
          type: 'stat',
          query: 'agentpane_process_uptime_seconds',
          format: 'duration',
        },
        {
          title: 'Active Agents',
          type: 'stat',
          query: 'sum(agentpane_agents_running)',
        },
        {
          title: 'Active Sessions',
          type: 'stat',
          query: 'sum(agentpane_sessions_active)',
        },
      ],
    },
    {
      title: 'Task Pipeline',
      panels: [
        {
          title: 'Tasks by Column',
          type: 'bar',
          query: 'sum by (column) (agentpane_tasks_total)',
          legend: ['Backlog', 'In Progress', 'Waiting Approval', 'Verified'],
        },
        {
          title: 'Task Completion Rate',
          type: 'timeseries',
          query: 'rate(agentpane_tasks_completed_total[1h])',
        },
      ],
    },
    {
      title: 'Performance',
      panels: [
        {
          title: 'Request Rate',
          type: 'timeseries',
          query: 'sum(rate(agentpane_http_requests_total[5m]))',
        },
        {
          title: 'Error Rate',
          type: 'timeseries',
          query: `
            sum(rate(agentpane_http_requests_total{status=~"5.."}[5m]))
            / sum(rate(agentpane_http_requests_total[5m]))
          `,
          unit: 'percentunit',
        },
        {
          title: 'P95 Latency',
          type: 'timeseries',
          query: `
            histogram_quantile(0.95,
              rate(agentpane_http_request_duration_seconds_bucket[5m])
            )
          `,
          unit: 's',
        },
      ],
    },
  ],
};
```

### Agent Performance Dashboard

**Purpose:** Detailed agent execution metrics and troubleshooting.

| Panel | Visualization | Metric |
|-------|---------------|--------|
| Agent Status | Table | All agents with status, current task |
| Turns per Task | Histogram | `agentpane_agent_turns_total` distribution |
| Tool Usage | Pie chart | `agentpane_tool_calls_total` by tool |
| Tool Latency | Heatmap | `agentpane_tool_duration_seconds` |
| Turn Timeline | Time series | Turns over time per agent |
| Error Rate | Time series | Failed agent runs |

```typescript
export const AGENT_DASHBOARD = {
  title: 'Agent Performance',
  refresh: '10s',
  variables: [
    {
      name: 'project_id',
      type: 'query',
      query: 'label_values(agentpane_agents_total, project_id)',
    },
    {
      name: 'agent_id',
      type: 'query',
      query: 'label_values(agentpane_agents_total{project_id="$project_id"}, agent_id)',
    },
  ],
  rows: [
    {
      title: 'Agent Status',
      panels: [
        {
          title: 'Active Agents',
          type: 'table',
          query: `
            agentpane_agents_total{project_id="$project_id"}
            * on(agent_id) group_left(status) agentpane_agent_status
          `,
          columns: ['agent_id', 'status', 'current_task', 'turn_count'],
        },
        {
          title: 'Running Agents',
          type: 'stat',
          query: 'sum(agentpane_agents_running{project_id="$project_id"})',
        },
      ],
    },
    {
      title: 'Execution Metrics',
      panels: [
        {
          title: 'Turns per Task',
          type: 'histogram',
          query: 'agentpane_agent_turns_per_task{project_id="$project_id"}',
          buckets: [5, 10, 15, 20, 25, 30, 40, 50],
        },
        {
          title: 'Task Duration',
          type: 'histogram',
          query: 'agentpane_task_duration_seconds{project_id="$project_id"}',
        },
      ],
    },
    {
      title: 'Tool Execution',
      panels: [
        {
          title: 'Tool Usage Distribution',
          type: 'pie',
          query: 'sum by (tool) (agentpane_tool_calls_total{agent_id="$agent_id"})',
        },
        {
          title: 'Tool Latency Heatmap',
          type: 'heatmap',
          query: 'agentpane_tool_duration_seconds_bucket{agent_id="$agent_id"}',
        },
        {
          title: 'Tool Errors',
          type: 'timeseries',
          query: 'rate(agentpane_tool_calls_total{agent_id="$agent_id", status="error"}[5m])',
        },
      ],
    },
  ],
};
```

### Infrastructure Dashboard

**Purpose:** System resources and infrastructure health.

| Panel | Visualization | Metric |
|-------|---------------|--------|
| Memory Usage | Gauge | `agentpane_process_memory_bytes` |
| CPU Usage | Time series | `agentpane_process_cpu_seconds_total` |
| Database Size | Single stat | `agentpane_db_size_bytes` |
| Query Performance | Heatmap | `agentpane_db_query_duration_seconds` |
| Stream Connections | Time series | `agentpane_stream_connections_active` |
| GitHub Rate Limit | Gauge | `agentpane_github_rate_limit_remaining` |

```typescript
export const INFRASTRUCTURE_DASHBOARD = {
  title: 'Infrastructure',
  refresh: '30s',
  rows: [
    {
      title: 'Process Metrics',
      panels: [
        {
          title: 'Memory Usage',
          type: 'gauge',
          query: 'agentpane_process_memory_bytes{type="heap_used"}',
          max: 'agentpane_process_memory_bytes{type="heap_total"}',
          unit: 'bytes',
        },
        {
          title: 'CPU Usage',
          type: 'timeseries',
          query: 'rate(agentpane_process_cpu_seconds_total[1m])',
          unit: 'percentunit',
        },
        {
          title: 'Open File Descriptors',
          type: 'stat',
          query: 'agentpane_process_open_fds',
        },
      ],
    },
    {
      title: 'Database',
      panels: [
        {
          title: 'Database Size',
          type: 'stat',
          query: 'agentpane_db_size_bytes',
          unit: 'bytes',
        },
        {
          title: 'Query Latency',
          type: 'heatmap',
          query: 'agentpane_db_query_duration_seconds_bucket',
        },
        {
          title: 'Queries per Second',
          type: 'timeseries',
          query: 'sum(rate(agentpane_db_queries_total[1m]))',
        },
      ],
    },
    {
      title: 'Streams & Connections',
      panels: [
        {
          title: 'Active Connections',
          type: 'timeseries',
          query: 'agentpane_stream_connections_active',
        },
        {
          title: 'Events Published',
          type: 'timeseries',
          query: 'sum(rate(agentpane_stream_events_total[5m]))',
        },
        {
          title: 'Stream Latency',
          type: 'timeseries',
          query: `
            histogram_quantile(0.99,
              rate(agentpane_stream_latency_seconds_bucket[5m])
            )
          `,
          unit: 'ms',
        },
      ],
    },
    {
      title: 'External Services',
      panels: [
        {
          title: 'GitHub Rate Limit',
          type: 'gauge',
          query: 'agentpane_github_rate_limit_remaining',
          max: 5000,
          thresholds: [
            { value: 500, color: 'red' },
            { value: 1000, color: 'yellow' },
            { value: 5000, color: 'green' },
          ],
        },
        {
          title: 'Claude API Tokens',
          type: 'timeseries',
          query: 'sum by (direction) (rate(agentpane_claude_tokens_total[1h]))',
        },
      ],
    },
  ],
};
```

---

## Prometheus Metrics Endpoint (Planned)

A `/api/metrics` endpoint is not yet implemented. When added, it should be a Hono route (consistent with all other API routes) rather than a TanStack Start file route:

```typescript
// src/server/routes/metrics.ts (planned)
import { Hono } from 'hono';
import { registry } from '../../lib/observability/metrics-registry.js';

export function createMetricsRoutes() {
  const app = new Hono();

  app.get('/', (_c) => {
    const metrics = registry.toPrometheus();

    return new Response(metrics, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      },
    });
  });

  return app;
}
```

---

## Integration with Error Catalog

All monitored errors reference the error codes defined in [Error Catalog](/specs/errors/error-catalog.md):

| Error Code | Metric Label | Alert |
|------------|--------------|-------|
| `AGENT_EXECUTION_ERROR` | `error_code="AGENT_EXECUTION_ERROR"` | AgentExecutionFailed |
| `CONCURRENCY_LIMIT_EXCEEDED` | `error_code="CONCURRENCY_LIMIT_EXCEEDED"` | ConcurrencyLimitReached |
| `GITHUB_RATE_LIMITED` | `error_code="GITHUB_RATE_LIMITED"` | GitHubRateLimitLow |
| `SESSION_CONNECTION_FAILED` | `error_code="SESSION_CONNECTION_FAILED"` | StreamConnectionFailed |
| `WORKTREE_CREATION_FAILED` | `error_code="WORKTREE_CREATION_FAILED"` | WorktreeCreationFailed |

```typescript
// Example: Logging an error with correlation to error catalog
logger.error('Agent execution failed', new Error('Timeout'), {
  errorCode: 'AGENT_EXECUTION_ERROR',  // From error catalog
  agentId,
  taskId,
  turnCount,
});

// Metrics increment with error code
registry.counter('agentpane_errors_total', {
  error_code: 'AGENT_EXECUTION_ERROR',
  component: 'agent',
}).inc();
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Error Catalog](/specs/application/errors/error-catalog.md) | Error codes for logging and metrics |
| [API Endpoints](/specs/application/api/endpoints.md) | HTTP metrics instrumentation points |
| [Agent Service](/specs/application/services/agent-service.md) | Agent execution metrics |
| [Session Service](/specs/application/services/session-service.md) | Stream and presence metrics |
| [Database Schema](/specs/application/database/schema.md) | Database query metrics |
| [Durable Sessions](/specs/application/integrations/durable-sessions.md) | Stream event metrics |

### Implemented Files

| File | Purpose |
|------|---------|
| `src/lib/logging/logger.ts` | Structured logger with level filtering, JSON/human-readable output |
| `src/server/routes/health.ts` | Health check routes (liveness, readiness, comprehensive) |
| `src/server/router.ts` | Request ID middleware, Hono logger middleware, error handling |
| `src/db/client.ts` | Database client with dual-mode SQLite/PostgreSQL support |
