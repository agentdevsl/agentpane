# Phase 3: API Layer

**Duration:** Weeks 5-6
**Endpoints:** 29
**Dependencies:** Phase 2 (Services Layer)

---

## Overview

Phase 3 implements the REST API layer using TanStack Start's file-based routing. All endpoints return consistent Result-style responses and integrate with the services layer.

---

## 3.1 API Route Structure

```
routes/api/
├── _layout.ts                    # Middleware (error handling, logging)
├── projects/
│   ├── index.ts                  # GET (list), POST (create)
│   └── $projectId/
│       ├── index.ts              # GET, PATCH, DELETE
│       └── sync.ts               # POST (sync from GitHub)
├── tasks/
│   ├── index.ts                  # GET, POST
│   └── $taskId/
│       ├── index.ts              # GET, PATCH, DELETE
│       ├── move.ts               # POST
│       ├── approve.ts            # POST
│       └── reject.ts             # POST
├── agents/
│   ├── index.ts                  # GET, POST
│   └── $agentId/
│       ├── index.ts              # GET, PATCH, DELETE
│       ├── start.ts              # POST
│       ├── stop.ts               # POST
│       └── status.ts             # GET
├── sessions/
│   ├── index.ts                  # GET, POST
│   └── $sessionId/
│       ├── index.ts              # GET
│       ├── stream.ts             # GET (SSE)
│       ├── history.ts            # GET
│       ├── close.ts              # POST
│       └── presence.ts           # GET, POST
└── webhooks/
    └── github.ts                 # POST
```

---

## 3.2 API Response Format

### Success Response

```typescript
interface ApiSuccessResponse<T> {
  ok: true;
  data: T;
}
```

### Error Response

```typescript
interface ApiErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    status: number;
    details?: Record<string, unknown>;
  };
}
```

### Response Wrapper (`lib/api/response.ts`)

```typescript
import type { Result } from '@/lib/utils/result';
import type { AppError } from '@/lib/errors/base';

export function apiResponse<T>(result: Result<T, AppError>): Response {
  if (result.ok) {
    return Response.json({ ok: true, data: result.value });
  }

  return Response.json(
    {
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        status: result.error.status,
        details: result.error.details,
      },
    },
    { status: result.error.status }
  );
}

export function apiSuccess<T>(data: T): Response {
  return Response.json({ ok: true, data });
}

export function apiError(error: AppError): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
        details: error.details,
      },
    },
    { status: error.status }
  );
}
```

---

## 3.3 API Middleware

### Layout Middleware (`routes/api/_layout.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { AppError } from '@/lib/errors/base';

export const APIRoute = createAPIFileRoute('/api')({
  onRequest: async ({ request, next }) => {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    // Add request ID header
    const response = await next();
    response.headers.set('X-Request-Id', requestId);

    // Log request
    console.log({
      requestId,
      method: request.method,
      url: request.url,
      status: response.status,
      duration: Date.now() - startTime,
    });

    return response;
  },

  onError: async ({ error }) => {
    console.error('API Error:', error);

    if (error instanceof AppError) {
      return Response.json(
        {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            status: error.status,
            details: error.details,
          },
        },
        { status: error.status }
      );
    }

    return Response.json(
      {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
          status: 500,
        },
      },
      { status: 500 }
    );
  },
});
```

---

## 3.4 Pagination

### Cursor-Based Pagination Types (`lib/api/pagination.ts`)

```typescript
export interface PaginationParams {
  cursor?: string;
  limit?: number;
  direction?: 'forward' | 'backward';
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export function parsePaginationParams(searchParams: URLSearchParams): PaginationParams {
  const limit = Math.min(
    parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10),
    MAX_LIMIT
  );
  const cursor = searchParams.get('cursor') ?? undefined;
  const direction = (searchParams.get('direction') as 'forward' | 'backward') ?? 'forward';

  return { cursor, limit, direction };
}

export function encodeCursor(id: string, timestamp: Date): string {
  return Buffer.from(`${id}:${timestamp.toISOString()}`).toString('base64url');
}

export function decodeCursor(cursor: string): { id: string; timestamp: Date } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
    const [id, timestamp] = decoded.split(':');
    return { id, timestamp: new Date(timestamp) };
  } catch {
    return null;
  }
}
```

---

## 3.5 Input Validation

### Zod Schemas (`lib/api/schemas.ts`)

```typescript
import { z } from 'zod';
import { isCuid } from '@paralleldrive/cuid2';

// Custom validators
export const cuidSchema = z.string().refine(isCuid, { message: 'Invalid ID format' });

export const taskColumnSchema = z.enum(['backlog', 'in_progress', 'waiting_approval', 'verified']);
export const agentStatusSchema = z.enum(['idle', 'starting', 'running', 'paused', 'error', 'completed']);
export const agentTypeSchema = z.enum(['task', 'conversational', 'background']);

// Project schemas
export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  path: z.string().min(1),
  description: z.string().max(500).optional(),
  maxConcurrentAgents: z.number().int().min(1).max(10).optional(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

// Task schemas
export const createTaskSchema = z.object({
  projectId: cuidSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(10000).optional(),
  labels: z.array(z.string()).max(10).optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(10000).optional(),
  labels: z.array(z.string()).max(10).optional(),
});

export const moveTaskSchema = z.object({
  column: taskColumnSchema,
  position: z.number().int().min(0).optional(),
});

export const approveTaskSchema = z.object({
  commitMessage: z.string().min(1).max(500).optional(),
  mergeStrategy: z.enum(['merge', 'squash', 'rebase']).optional(),
});

export const rejectTaskSchema = z.object({
  reason: z.string().min(1).max(1000),
  feedback: z.string().max(5000).optional(),
});

// Agent schemas
export const createAgentSchema = z.object({
  projectId: cuidSchema,
  name: z.string().min(1).max(100),
  type: agentTypeSchema.optional(),
  config: z.object({
    allowedTools: z.array(z.string()).optional(),
    maxTurns: z.number().int().min(1).max(500).optional(),
    model: z.string().optional(),
    systemPrompt: z.string().max(10000).optional(),
    temperature: z.number().min(0).max(1).optional(),
  }).optional(),
});

export const updateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  config: z.object({
    allowedTools: z.array(z.string()).optional(),
    maxTurns: z.number().int().min(1).max(500).optional(),
    model: z.string().optional(),
    systemPrompt: z.string().max(10000).optional(),
    temperature: z.number().min(0).max(1).optional(),
  }).optional(),
});

export const startAgentSchema = z.object({
  taskId: cuidSchema,
});

// Session schemas
export const createSessionSchema = z.object({
  projectId: cuidSchema,
  taskId: cuidSchema.optional(),
  agentId: cuidSchema.optional(),
  title: z.string().max(200).optional(),
});

export const presenceUpdateSchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1).max(100),
  cursor: z.object({
    line: z.number().int().min(0),
    column: z.number().int().min(0),
  }).optional(),
});
```

### Validation Helper (`lib/api/validate.ts`)

```typescript
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/utils/result';
import { ValidationErrors } from '@/lib/errors/validation-errors';

export function validate<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): Result<T, ValidationError> {
  const result = schema.safeParse(data);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    return err(ValidationErrors.VALIDATION_ERROR(issues));
  }

  return ok(result.data);
}

export async function parseBody<T>(
  request: Request,
  schema: z.ZodSchema<T>
): Promise<Result<T, ValidationError>> {
  try {
    const body = await request.json();
    return validate(schema, body);
  } catch {
    return err(ValidationErrors.VALIDATION_ERROR([{ path: 'body', message: 'Invalid JSON' }]));
  }
}
```

---

## 3.6 Project Endpoints

### List/Create Projects (`routes/api/projects/index.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getProjectService } from '@/services/project.service';
import { apiResponse, apiSuccess } from '@/lib/api/response';
import { parsePaginationParams } from '@/lib/api/pagination';
import { parseBody } from '@/lib/api/validate';
import { createProjectSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/projects')({
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const pagination = parsePaginationParams(url.searchParams);

    const projectService = getProjectService();
    const result = await projectService.list(pagination);

    return apiResponse(result);
  },

  POST: async ({ request }) => {
    const validation = await parseBody(request, createProjectSchema);
    if (!validation.ok) return apiResponse(validation);

    const projectService = getProjectService();
    const result = await projectService.create(validation.value);

    return apiResponse(result);
  },
});
```

### Get/Update/Delete Project (`routes/api/projects/$projectId/index.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getProjectService } from '@/services/project.service';
import { apiResponse } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validate';
import { updateProjectSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/projects/$projectId')({
  GET: async ({ params }) => {
    const projectService = getProjectService();
    const result = await projectService.getById(params.projectId);
    return apiResponse(result);
  },

  PATCH: async ({ request, params }) => {
    const validation = await parseBody(request, updateProjectSchema);
    if (!validation.ok) return apiResponse(validation);

    const projectService = getProjectService();
    const result = await projectService.update(params.projectId, validation.value);
    return apiResponse(result);
  },

  DELETE: async ({ params }) => {
    const projectService = getProjectService();
    const result = await projectService.delete(params.projectId);
    return apiResponse(result);
  },
});
```

### Sync from GitHub (`routes/api/projects/$projectId/sync.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getProjectService } from '@/services/project.service';
import { apiResponse } from '@/lib/api/response';

export const APIRoute = createAPIFileRoute('/api/projects/$projectId/sync')({
  POST: async ({ params }) => {
    const projectService = getProjectService();
    const result = await projectService.syncFromGitHub(params.projectId);
    return apiResponse(result);
  },
});
```

---

## 3.7 Task Endpoints

### List/Create Tasks (`routes/api/tasks/index.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getTaskService } from '@/services/task.service';
import { apiResponse } from '@/lib/api/response';
import { parsePaginationParams } from '@/lib/api/pagination';
import { parseBody } from '@/lib/api/validate';
import { createTaskSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/tasks')({
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const pagination = parsePaginationParams(url.searchParams);
    const projectId = url.searchParams.get('projectId');
    const column = url.searchParams.get('column');

    if (!projectId) {
      return apiResponse(err(ValidationErrors.MISSING_REQUIRED_FIELD('projectId')));
    }

    const taskService = getTaskService();
    const result = await taskService.list(projectId, {
      ...pagination,
      column: column as TaskColumn | undefined,
    });

    return apiResponse(result);
  },

  POST: async ({ request }) => {
    const validation = await parseBody(request, createTaskSchema);
    if (!validation.ok) return apiResponse(validation);

    const taskService = getTaskService();
    const result = await taskService.create(validation.value);
    return apiResponse(result);
  },
});
```

### Get/Update/Delete Task (`routes/api/tasks/$taskId/index.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getTaskService } from '@/services/task.service';
import { apiResponse } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validate';
import { updateTaskSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/tasks/$taskId')({
  GET: async ({ params }) => {
    const taskService = getTaskService();
    const result = await taskService.getById(params.taskId);
    return apiResponse(result);
  },

  PATCH: async ({ request, params }) => {
    const validation = await parseBody(request, updateTaskSchema);
    if (!validation.ok) return apiResponse(validation);

    const taskService = getTaskService();
    const result = await taskService.update(params.taskId, validation.value);
    return apiResponse(result);
  },

  DELETE: async ({ params }) => {
    const taskService = getTaskService();
    const result = await taskService.delete(params.taskId);
    return apiResponse(result);
  },
});
```

### Move Task (`routes/api/tasks/$taskId/move.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getTaskService } from '@/services/task.service';
import { apiResponse } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validate';
import { moveTaskSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/tasks/$taskId/move')({
  POST: async ({ request, params }) => {
    const validation = await parseBody(request, moveTaskSchema);
    if (!validation.ok) return apiResponse(validation);

    const taskService = getTaskService();
    const result = await taskService.moveColumn(
      params.taskId,
      validation.value.column,
      validation.value.position
    );
    return apiResponse(result);
  },
});
```

### Approve Task (`routes/api/tasks/$taskId/approve.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getTaskService } from '@/services/task.service';
import { apiResponse } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validate';
import { approveTaskSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/tasks/$taskId/approve')({
  POST: async ({ request, params }) => {
    const validation = await parseBody(request, approveTaskSchema);
    if (!validation.ok) return apiResponse(validation);

    const taskService = getTaskService();
    const result = await taskService.approve(params.taskId, validation.value);
    return apiResponse(result);
  },
});
```

### Reject Task (`routes/api/tasks/$taskId/reject.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getTaskService } from '@/services/task.service';
import { apiResponse } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validate';
import { rejectTaskSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/tasks/$taskId/reject')({
  POST: async ({ request, params }) => {
    const validation = await parseBody(request, rejectTaskSchema);
    if (!validation.ok) return apiResponse(validation);

    const taskService = getTaskService();
    const result = await taskService.reject(params.taskId, validation.value);
    return apiResponse(result);
  },
});
```

---

## 3.8 Agent Endpoints

### List/Create Agents (`routes/api/agents/index.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getAgentService } from '@/services/agent.service';
import { apiResponse, apiSuccess } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validate';
import { createAgentSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/agents')({
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId');
    const status = url.searchParams.get('status');

    if (!projectId) {
      return apiResponse(err(ValidationErrors.MISSING_REQUIRED_FIELD('projectId')));
    }

    const agentService = getAgentService();
    const result = await agentService.list(projectId, {
      status: status as AgentStatus | undefined,
    });

    return apiSuccess(result.value);
  },

  POST: async ({ request }) => {
    const validation = await parseBody(request, createAgentSchema);
    if (!validation.ok) return apiResponse(validation);

    const agentService = getAgentService();
    const result = await agentService.create(validation.value);
    return apiResponse(result);
  },
});
```

### Get/Update/Delete Agent (`routes/api/agents/$agentId/index.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getAgentService } from '@/services/agent.service';
import { apiResponse } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validate';
import { updateAgentSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/agents/$agentId')({
  GET: async ({ params }) => {
    const agentService = getAgentService();
    const result = await agentService.getById(params.agentId);
    return apiResponse(result);
  },

  PATCH: async ({ request, params }) => {
    const validation = await parseBody(request, updateAgentSchema);
    if (!validation.ok) return apiResponse(validation);

    const agentService = getAgentService();
    const result = await agentService.update(params.agentId, validation.value);
    return apiResponse(result);
  },

  DELETE: async ({ params }) => {
    const agentService = getAgentService();
    const result = await agentService.delete(params.agentId);
    return apiResponse(result);
  },
});
```

### Start Agent (`routes/api/agents/$agentId/start.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getAgentService } from '@/services/agent.service';
import { apiResponse } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validate';
import { startAgentSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/agents/$agentId/start')({
  POST: async ({ request, params }) => {
    const validation = await parseBody(request, startAgentSchema);
    if (!validation.ok) return apiResponse(validation);

    const agentService = getAgentService();
    const result = await agentService.start(params.agentId, validation.value.taskId);
    return apiResponse(result);
  },
});
```

### Stop Agent (`routes/api/agents/$agentId/stop.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getAgentService } from '@/services/agent.service';
import { apiResponse } from '@/lib/api/response';

export const APIRoute = createAPIFileRoute('/api/agents/$agentId/stop')({
  POST: async ({ params }) => {
    const agentService = getAgentService();
    const result = await agentService.stop(params.agentId);
    return apiResponse(result);
  },
});
```

### Agent Status (`routes/api/agents/$agentId/status.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getAgentService } from '@/services/agent.service';
import { apiResponse, apiSuccess } from '@/lib/api/response';

export const APIRoute = createAPIFileRoute('/api/agents/$agentId/status')({
  GET: async ({ params }) => {
    const agentService = getAgentService();
    const agent = await agentService.getById(params.agentId);
    if (!agent.ok) return apiResponse(agent);

    const runningCount = await agentService.getRunningCount(agent.value.projectId);
    const queuedTasks = await agentService.getQueuedTasks(agent.value.projectId);

    return apiSuccess({
      status: agent.value.status,
      currentTaskId: agent.value.currentTaskId,
      currentSessionId: agent.value.currentSessionId,
      currentTurn: agent.value.currentTurn,
      runningAgentsInProject: runningCount.value,
      queuedTasks: queuedTasks.value,
    });
  },
});
```

---

## 3.9 Session Endpoints

### List/Create Sessions (`routes/api/sessions/index.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getSessionService } from '@/services/session.service';
import { apiResponse } from '@/lib/api/response';
import { parsePaginationParams } from '@/lib/api/pagination';
import { parseBody } from '@/lib/api/validate';
import { createSessionSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/sessions')({
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const pagination = parsePaginationParams(url.searchParams);
    const projectId = url.searchParams.get('projectId');
    const status = url.searchParams.get('status');

    const sessionService = getSessionService();
    const result = await sessionService.list({
      ...pagination,
      projectId: projectId ?? undefined,
      status: status as SessionStatus | undefined,
    });

    return apiResponse(result);
  },

  POST: async ({ request }) => {
    const validation = await parseBody(request, createSessionSchema);
    if (!validation.ok) return apiResponse(validation);

    const sessionService = getSessionService();
    const result = await sessionService.create(validation.value);
    return apiResponse(result);
  },
});
```

### Get Session (`routes/api/sessions/$sessionId/index.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getSessionService } from '@/services/session.service';
import { apiResponse } from '@/lib/api/response';

export const APIRoute = createAPIFileRoute('/api/sessions/$sessionId')({
  GET: async ({ params }) => {
    const sessionService = getSessionService();
    const result = await sessionService.getById(params.sessionId);
    return apiResponse(result);
  },
});
```

### Session Stream (SSE) (`routes/api/sessions/$sessionId/stream.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getSessionService } from '@/services/session.service';
import { apiError } from '@/lib/api/response';

export const APIRoute = createAPIFileRoute('/api/sessions/$sessionId/stream')({
  GET: async ({ params, request }) => {
    const sessionService = getSessionService();
    const session = await sessionService.getById(params.sessionId);

    if (!session.ok) {
      return apiError(session.error);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        // Send initial connection event
        send({ type: 'connected', sessionId: params.sessionId });

        try {
          for await (const event of sessionService.subscribe(params.sessionId)) {
            send(event);
          }
        } catch (error) {
          send({ type: 'error', message: 'Stream error' });
        } finally {
          controller.close();
        }
      },
      cancel() {
        // Cleanup subscription
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  },
});
```

### Session History (`routes/api/sessions/$sessionId/history.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getSessionService } from '@/services/session.service';
import { apiResponse } from '@/lib/api/response';

export const APIRoute = createAPIFileRoute('/api/sessions/$sessionId/history')({
  GET: async ({ request, params }) => {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const after = url.searchParams.get('after') ?? undefined;

    const sessionService = getSessionService();
    const result = await sessionService.getHistory(params.sessionId, { limit, after });
    return apiResponse(result);
  },
});
```

### Close Session (`routes/api/sessions/$sessionId/close.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getSessionService } from '@/services/session.service';
import { apiResponse } from '@/lib/api/response';

export const APIRoute = createAPIFileRoute('/api/sessions/$sessionId/close')({
  POST: async ({ params }) => {
    const sessionService = getSessionService();
    const result = await sessionService.close(params.sessionId);
    return apiResponse(result);
  },
});
```

### Presence (`routes/api/sessions/$sessionId/presence.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getSessionService } from '@/services/session.service';
import { apiResponse, apiSuccess } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validate';
import { presenceUpdateSchema } from '@/lib/api/schemas';

export const APIRoute = createAPIFileRoute('/api/sessions/$sessionId/presence')({
  GET: async ({ params }) => {
    const sessionService = getSessionService();
    const result = await sessionService.getActiveUsers(params.sessionId);
    return apiResponse(result);
  },

  POST: async ({ request, params }) => {
    const validation = await parseBody(request, presenceUpdateSchema);
    if (!validation.ok) return apiResponse(validation);

    const sessionService = getSessionService();
    const result = await sessionService.updatePresence(
      params.sessionId,
      validation.value.userId,
      validation.value
    );
    return apiResponse(result);
  },
});
```

---

## 3.10 GitHub Webhook

### Webhook Handler (`routes/api/webhooks/github.ts`)

```typescript
import { createAPIFileRoute } from '@tanstack/react-start/api';
import { getProjectService } from '@/services/project.service';
import { apiSuccess, apiError } from '@/lib/api/response';
import { GitHubErrors } from '@/lib/errors/github-errors';
import crypto from 'crypto';

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

function verifySignature(payload: string, signature: string | null): boolean {
  if (!signature || !GITHUB_WEBHOOK_SECRET) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex')}`;

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export const APIRoute = createAPIFileRoute('/api/webhooks/github')({
  POST: async ({ request }) => {
    const payload = await request.text();
    const signature = request.headers.get('X-Hub-Signature-256');

    if (!verifySignature(payload, signature)) {
      return apiError(GitHubErrors.WEBHOOK_INVALID());
    }

    const event = request.headers.get('X-GitHub-Event');
    const body = JSON.parse(payload);

    switch (event) {
      case 'push': {
        // Config file changed - sync project settings
        if (body.commits?.some((c: any) => c.modified?.includes('.claude/settings.json'))) {
          const projectService = getProjectService();
          const project = await projectService.findByGitHub(
            body.repository.owner.login,
            body.repository.name
          );
          if (project.ok && project.value) {
            await projectService.syncFromGitHub(project.value.id);
          }
        }
        break;
      }

      case 'installation': {
        // Handle installation events
        console.log('GitHub App installation event:', body.action);
        break;
      }

      case 'installation_repositories': {
        // Handle repository access changes
        console.log('GitHub App repository access changed:', body.action);
        break;
      }
    }

    return apiSuccess({ received: true });
  },
});
```

---

## 3.11 Rate Limiting

### Rate Limiter (`lib/api/rate-limiter.ts`)

```typescript
interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const rateLimitConfigs: Record<string, RateLimitConfig> = {
  read: { windowMs: 60000, maxRequests: 1000 },
  write: { windowMs: 60000, maxRequests: 100 },
  agent: { windowMs: 60000, maxRequests: 20 },
  session: { windowMs: 60000, maxRequests: 10 },
};

const requestCounts = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(
  key: string,
  type: 'read' | 'write' | 'agent' | 'session'
): { allowed: boolean; remaining: number; resetAt: number } {
  const config = rateLimitConfigs[type];
  const now = Date.now();
  const record = requestCounts.get(key);

  if (!record || now > record.resetAt) {
    requestCounts.set(key, { count: 1, resetAt: now + config.windowMs });
    return { allowed: true, remaining: config.maxRequests - 1, resetAt: now + config.windowMs };
  }

  if (record.count >= config.maxRequests) {
    return { allowed: false, remaining: 0, resetAt: record.resetAt };
  }

  record.count++;
  return { allowed: true, remaining: config.maxRequests - record.count, resetAt: record.resetAt };
}
```

### Rate Limit Middleware

```typescript
// In routes/api/_layout.ts
export const APIRoute = createAPIFileRoute('/api')({
  onRequest: async ({ request, next }) => {
    const ip = request.headers.get('X-Forwarded-For') ?? 'unknown';
    const method = request.method;
    const path = new URL(request.url).pathname;

    // Determine rate limit type
    let type: 'read' | 'write' | 'agent' | 'session' = 'read';
    if (method !== 'GET') type = 'write';
    if (path.includes('/agents/') && (path.endsWith('/start') || path.endsWith('/stop'))) type = 'agent';
    if (path.includes('/sessions/') && path.endsWith('/stream')) type = 'session';

    const rateLimit = checkRateLimit(`${ip}:${type}`, type);

    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests',
            status: 429,
          },
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(rateLimit.resetAt),
          },
        }
      );
    }

    const response = await next();
    response.headers.set('X-RateLimit-Remaining', String(rateLimit.remaining));
    response.headers.set('X-RateLimit-Reset', String(rateLimit.resetAt));

    return response;
  },
});
```

---

## 3.12 Endpoint Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List projects (paginated) |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Get project by ID |
| PATCH | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project |
| POST | `/api/projects/:id/sync` | Sync from GitHub |
| GET | `/api/tasks` | List tasks (filtered, paginated) |
| POST | `/api/tasks` | Create task |
| GET | `/api/tasks/:id` | Get task by ID |
| PATCH | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |
| POST | `/api/tasks/:id/move` | Move task to column |
| POST | `/api/tasks/:id/approve` | Approve task |
| POST | `/api/tasks/:id/reject` | Reject task |
| GET | `/api/agents` | List agents (filtered) |
| POST | `/api/agents` | Create agent |
| GET | `/api/agents/:id` | Get agent by ID |
| PATCH | `/api/agents/:id` | Update agent |
| DELETE | `/api/agents/:id` | Delete agent |
| POST | `/api/agents/:id/start` | Start agent on task |
| POST | `/api/agents/:id/stop` | Stop running agent |
| GET | `/api/agents/:id/status` | Get agent status |
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions` | Create session |
| GET | `/api/sessions/:id` | Get session by ID |
| GET | `/api/sessions/:id/stream` | SSE event stream |
| GET | `/api/sessions/:id/history` | Get session history |
| POST | `/api/sessions/:id/close` | Close session |
| GET/POST | `/api/sessions/:id/presence` | Presence management |
| POST | `/api/webhooks/github` | GitHub webhook handler |

---

## 3.13 Tests

### API Test Categories

| Category | Test Count |
|----------|------------|
| Project endpoints | 8 |
| Task endpoints | 12 |
| Agent endpoints | 10 |
| Session endpoints | 8 |
| Pagination | 4 |
| Validation | 6 |
| Rate limiting | 4 |
| Error handling | 5 |

### Example Test (`tests/api/tasks.test.ts`)

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestProject, createTestTask } from '../factories';
import { setupTestDatabase, clearTestDatabase } from '../setup';

describe('Task API', () => {
  beforeEach(async () => {
    await clearTestDatabase();
  });

  describe('POST /api/tasks', () => {
    it('creates task in backlog', async () => {
      const project = await createTestProject();

      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          title: 'Test Task',
          description: 'Test description',
        }),
      });

      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.data.title).toBe('Test Task');
      expect(data.data.column).toBe('backlog');
    });

    it('validates required fields', async () => {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/tasks/:id/move', () => {
    it('moves task to in_progress', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);

      const response = await fetch(`/api/tasks/${task.id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column: 'in_progress' }),
      });

      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.data.column).toBe('in_progress');
    });

    it('rejects invalid transition', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id);

      const response = await fetch(`/api/tasks/${task.id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column: 'verified' }),
      });

      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('TASK_INVALID_TRANSITION');
    });
  });
});
```

---

## Spec References

- API Endpoints: `/specs/application/api/endpoints.md`
- Pagination: `/specs/application/api/pagination.md`
- Error Catalog: `/specs/application/errors/error-catalog.md`
- Services: `/specs/application/services/*.md`
