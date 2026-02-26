# TanStack Start Routing Specification

## Overview

Complete routing configuration for AgentPane using TanStack Start file-based routing. Defines client-side routes with loaders, server API routes, layout nesting, and navigation guards for the multi-agent task management system.

## Technology Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| TanStack Start | 1.150.0 | Full-stack React framework with file-based routing |
| TanStack Router | 1.150.0 | Type-safe client routing with loaders |
| Bun | 1.3.10 | Server runtime |

---

## Interface Definition

```typescript
// lib/types/routing.ts
import type { FileRoute, FileRoutesByPath } from '@tanstack/react-router';

/**
 * Route metadata for navigation and breadcrumbs
 */
export interface RouteMeta {
  title: string;
  description?: string;
  breadcrumb?: string;
  requiresAuth?: boolean;
  layout?: 'default' | 'full-screen' | 'sidebar';
}

/**
 * Loader context available to all route loaders
 */
export interface LoaderContext {
  request: Request;
  params: Record<string, string>;
  context: {
    db: typeof db;
    session?: UserSession;
  };
}

/**
 * Navigation guard result
 */
export interface GuardResult {
  allowed: boolean;
  redirect?: string;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Route params for dynamic segments
 */
export interface RouteParams {
  projectId?: string;
  taskId?: string;
  agentId?: string;
  sessionId?: string;
}

/**
 * Pending navigation state for optimistic UI
 */
export interface PendingNavigation {
  from: string;
  to: string;
  params: RouteParams;
}
```

---

## Route Map

### Client Routes (Pages)

| Path | Component | Description |
|------|-----------|-------------|
| `/` | `Dashboard` | Dashboard / multi-project overview |
| `/projects` | `ProjectList` | All projects list with search |
| `/projects/$projectId` | `ProjectDetail` | Project detail with Kanban board |
| `/projects/$projectId/tasks/$taskId` | `TaskDetail` | Task detail modal/panel |
| `/agents` | `AgentList` | All agents across projects |
| `/agents/$agentId` | `AgentDetail` | Agent detail and configuration |
| `/sessions/$sessionId` | `SessionView` | Real-time session view (shareable) |

### Server Routes (API)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/projects` | `listProjects` | List all projects |
| POST | `/api/projects` | `createProject` | Create new project |
| GET | `/api/projects/$id` | `getProject` | Get project by ID |
| PATCH | `/api/projects/$id` | `updateProject` | Update project |
| DELETE | `/api/projects/$id` | `deleteProject` | Delete project |
| GET | `/api/tasks` | `listTasks` | List tasks (with filters) |
| POST | `/api/tasks` | `createTask` | Create new task |
| GET | `/api/tasks/$id` | `getTask` | Get task by ID |
| PATCH | `/api/tasks/$id` | `updateTask` | Update task |
| DELETE | `/api/tasks/$id` | `deleteTask` | Delete task |
| POST | `/api/tasks/$id/move` | `moveTask` | Move task between columns |
| POST | `/api/tasks/$id/approve` | `approveTask` | Approve task changes |
| POST | `/api/tasks/$id/reject` | `rejectTask` | Reject with feedback |
| GET | `/api/agents` | `listAgents` | List agents |
| POST | `/api/agents` | `createAgent` | Create new agent |
| GET | `/api/agents/$id` | `getAgent` | Get agent by ID |
| PATCH | `/api/agents/$id` | `updateAgent` | Update agent config |
| DELETE | `/api/agents/$id` | `deleteAgent` | Delete agent |
| POST | `/api/agents/$id/start` | `startAgent` | Start agent on task |
| POST | `/api/agents/$id/stop` | `stopAgent` | Stop running agent |
| GET | `/api/agents/$id/status` | `getAgentStatus` | Get execution status |
| POST | `/api/sessions` | `createSession` | Create new session |
| GET | `/api/sessions/$id` | `getSession` | Get session by ID |
| GET | `/api/sessions/$id/stream` | `streamSession` | SSE event stream |
| GET | `/api/sessions/$id/history` | `getHistory` | Get historical events |
| POST | `/api/sessions/$id/close` | `closeSession` | Close session |
| GET | `/api/sessions/$id/presence` | `getPresence` | Get active users |
| POST | `/api/sessions/$id/presence` | `updatePresence` | Update user presence |
| GET | `/api/streams` | `durableStreams` | Durable Streams endpoint |
| POST | `/api/webhooks/github` | `githubWebhook` | GitHub webhook receiver |

---

## Route Details

### Client Route Loaders

#### Dashboard (`/`)

```typescript
// app/routes/index.tsx
import { createFileRoute } from '@tanstack/react-router';
import { projectService } from '@/lib/services/project-service';
import { taskService } from '@/lib/services/task-service';
import { agentService } from '@/lib/services/agent-service';

export const Route = createFileRoute('/')({
  meta: () => [{ title: 'Dashboard | AgentPane' }],

  loader: async ({ context }) => {
    // Parallel fetch for dashboard data
    const [projects, recentTasks, runningAgents] = await Promise.all([
      projectService.list({ limit: 10 }),
      taskService.listRecent({ limit: 5 }),
      agentService.listRunning(),
    ]);

    return {
      projects: projects.ok ? projects.value.items : [],
      recentTasks: recentTasks.ok ? recentTasks.value : [],
      runningAgents: runningAgents.ok ? runningAgents.value : [],
      stats: {
        totalProjects: projects.ok ? projects.value.totalCount : 0,
        activeAgents: runningAgents.ok ? runningAgents.value.length : 0,
      },
    };
  },

  component: Dashboard,
});
```

#### Project List (`/projects`)

```typescript
// app/routes/projects/index.tsx
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { projectService } from '@/lib/services/project-service';

const projectSearchSchema = z.object({
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().optional().default(20),
});

export const Route = createFileRoute('/projects/')({
  meta: () => [{ title: 'Projects | AgentPane' }],

  validateSearch: projectSearchSchema,

  loaderDeps: ({ search }) => ({
    search: search.search,
    cursor: search.cursor,
    limit: search.limit,
  }),

  loader: async ({ deps }) => {
    const result = await projectService.list(deps);

    if (!result.ok) {
      throw new Error(result.error.message);
    }

    return result.value;
  },

  component: ProjectList,
});
```

#### Project Detail (`/projects/$projectId`)

```typescript
// app/routes/projects/$projectId.tsx
import { createFileRoute, notFound } from '@tanstack/react-router';
import { projectService } from '@/lib/services/project-service';
import { taskService } from '@/lib/services/task-service';
import { agentService } from '@/lib/services/agent-service';

export const Route = createFileRoute('/projects/$projectId')({
  meta: ({ loaderData }) => [
    { title: `${loaderData?.project.name ?? 'Project'} | AgentPane` },
  ],

  loader: async ({ params }) => {
    const projectId = params.projectId;

    // Parallel fetch project data
    const [projectResult, tasksResult, agentsResult] = await Promise.all([
      projectService.getById(projectId),
      taskService.list({ projectId }),
      agentService.list(projectId),
    ]);

    if (!projectResult.ok) {
      throw notFound();
    }

    return {
      project: projectResult.value,
      tasks: tasksResult.ok ? tasksResult.value : { items: [], counts: {} },
      agents: agentsResult.ok ? agentsResult.value : [],
    };
  },

  // Stale-while-revalidate for real-time updates
  staleTime: 5000,
  gcTime: 30000,

  component: ProjectDetail,
});
```

#### Task Detail (`/projects/$projectId/tasks/$taskId`)

```typescript
// app/routes/projects/$projectId/tasks/$taskId.tsx
import { createFileRoute, notFound } from '@tanstack/react-router';
import { taskService } from '@/lib/services/task-service';

export const Route = createFileRoute('/projects/$projectId/tasks/$taskId')({
  meta: ({ loaderData }) => [
    { title: `${loaderData?.task.title ?? 'Task'} | AgentPane` },
  ],

  loader: async ({ params }) => {
    const result = await taskService.getById(params.taskId);

    if (!result.ok) {
      throw notFound();
    }

    // Verify task belongs to project
    if (result.value.projectId !== params.projectId) {
      throw notFound();
    }

    return {
      task: result.value,
      agent: result.value.agent,
      worktree: result.value.worktree,
      session: result.value.session,
    };
  },

  component: TaskDetail,
});
```

#### Agent List (`/agents`)

```typescript
// app/routes/agents/index.tsx
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { agentService } from '@/lib/services/agent-service';

const agentSearchSchema = z.object({
  projectId: z.string().optional(),
  status: z.enum(['idle', 'starting', 'running', 'paused', 'error', 'completed']).optional(),
  type: z.enum(['task', 'conversational', 'background']).optional(),
});

export const Route = createFileRoute('/agents/')({
  meta: () => [{ title: 'Agents | AgentPane' }],

  validateSearch: agentSearchSchema,

  loaderDeps: ({ search }) => search,

  loader: async ({ deps }) => {
    const result = await agentService.listAll(deps);

    return {
      agents: result.ok ? result.value : [],
      filters: deps,
    };
  },

  component: AgentList,
});
```

#### Agent Detail (`/agents/$agentId`)

```typescript
// app/routes/agents/$agentId.tsx
import { createFileRoute, notFound } from '@tanstack/react-router';
import { agentService } from '@/lib/services/agent-service';

export const Route = createFileRoute('/agents/$agentId')({
  meta: ({ loaderData }) => [
    { title: `${loaderData?.agent.name ?? 'Agent'} | AgentPane` },
  ],

  loader: async ({ params }) => {
    const result = await agentService.getById(params.agentId);

    if (!result.ok) {
      throw notFound();
    }

    return {
      agent: result.value,
      currentTask: result.value.currentTask,
      currentSession: result.value.currentSession,
      recentRuns: await agentService.getRecentRuns(params.agentId, 10),
    };
  },

  component: AgentDetail,
});
```

#### Session View (`/sessions/$sessionId`)

```typescript
// app/routes/sessions/$sessionId.tsx
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { sessionService } from '@/lib/services/session-service';

export const Route = createFileRoute('/sessions/$sessionId')({
  meta: ({ loaderData }) => [
    { title: `Session: ${loaderData?.session.title ?? 'Untitled'} | AgentPane` },
  ],

  // Sessions are deep-linkable and shareable
  beforeLoad: async ({ params, context }) => {
    // Validate session exists before loading
    const exists = await sessionService.exists(params.sessionId);
    if (!exists) {
      throw notFound();
    }
  },

  loader: async ({ params }) => {
    const result = await sessionService.getById(params.sessionId);

    if (!result.ok) {
      throw notFound();
    }

    return {
      session: result.value,
      task: result.value.task,
      agent: result.value.agent,
      project: result.value.project,
      // Initial events for hydration (last 100)
      initialEvents: await sessionService.getRecentEvents(params.sessionId, 100),
    };
  },

  component: SessionView,
});
```

---

## Layout Structure

### File Structure

```
app/
├── routes/
│   ├── __root.tsx              # Root layout (TooltipProvider, theme)
│   ├── index.tsx               # / - Dashboard
│   ├── projects/
│   │   ├── route.tsx           # /projects layout (sidebar)
│   │   ├── index.tsx           # /projects - Project list
│   │   └── $projectId/
│   │       ├── route.tsx       # /projects/$projectId layout
│   │       ├── index.tsx       # /projects/$projectId - Kanban board
│   │       └── tasks/
│   │           └── $taskId.tsx # /projects/$projectId/tasks/$taskId
│   ├── agents/
│   │   ├── route.tsx           # /agents layout
│   │   ├── index.tsx           # /agents - Agent list
│   │   └── $agentId.tsx        # /agents/$agentId - Agent detail
│   ├── sessions/
│   │   └── $sessionId.tsx      # /sessions/$sessionId (full-screen)
│   └── api/
│       ├── projects/
│       │   ├── index.ts        # GET/POST /api/projects
│       │   └── $id/
│       │       └── index.ts    # GET/PATCH/DELETE /api/projects/$id
│       ├── tasks/
│       │   ├── index.ts        # GET/POST /api/tasks
│       │   └── $id/
│       │       ├── index.ts    # GET/PATCH/DELETE /api/tasks/$id
│       │       ├── move.ts     # POST /api/tasks/$id/move
│       │       ├── approve.ts  # POST /api/tasks/$id/approve
│       │       └── reject.ts   # POST /api/tasks/$id/reject
│       ├── agents/
│       │   ├── index.ts        # GET/POST /api/agents
│       │   └── $id/
│       │       ├── index.ts    # GET/PATCH/DELETE /api/agents/$id
│       │       ├── start.ts    # POST /api/agents/$id/start
│       │       ├── stop.ts     # POST /api/agents/$id/stop
│       │       └── status.ts   # GET /api/agents/$id/status
│       ├── sessions/
│       │   ├── index.ts        # POST /api/sessions
│       │   └── $id/
│       │       ├── index.ts    # GET /api/sessions/$id
│       │       ├── stream.ts   # GET /api/sessions/$id/stream (SSE)
│       │       ├── history.ts  # GET /api/sessions/$id/history
│       │       ├── close.ts    # POST /api/sessions/$id/close
│       │       └── presence.ts # GET/POST /api/sessions/$id/presence
│       ├── streams.ts          # GET /api/streams (Durable Streams)
│       └── webhooks/
│           └── github.ts       # POST /api/webhooks/github
```

### Root Layout (`__root.tsx`)

```typescript
// app/routes/__root.tsx
import {
  Outlet,
  ScrollRestoration,
  createRootRouteWithContext,
} from '@tanstack/react-router';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { ThemeProvider } from '@/components/theme-provider';
import { AppShell } from '@/components/app-shell';
import { NotFoundPage } from '@/components/not-found';
import type { RouterContext } from '@/lib/router-context';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorBoundary,
});

function RootComponent() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="agentpane-theme">
      <TooltipProvider delayDuration={300}>
        <AppShell>
          <Outlet />
        </AppShell>
        <ScrollRestoration />
      </TooltipProvider>
    </ThemeProvider>
  );
}

function ErrorBoundary({ error }: { error: Error }) {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-destructive">Error</h1>
        <p className="text-muted-foreground">{error.message}</p>
      </div>
    </div>
  );
}
```

### Projects Layout (`/projects/route.tsx`)

```typescript
// app/routes/projects/route.tsx
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { ProjectSidebar } from '@/components/project-sidebar';

export const Route = createFileRoute('/projects')({
  component: ProjectsLayout,
});

function ProjectsLayout() {
  return (
    <div className="flex h-full">
      <ProjectSidebar className="w-64 shrink-0 border-r" />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
```

### Session Layout (Full-Screen)

```typescript
// Sessions use full-screen layout without sidebar
// app/routes/sessions/$sessionId.tsx
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionView,
  // Override layout in component
});

function SessionView() {
  const { session, initialEvents } = Route.useLoaderData();

  return (
    <div className="fixed inset-0 z-50 bg-background">
      {/* Full-screen session UI */}
      <SessionHeader session={session} />
      <SessionContent events={initialEvents} sessionId={session.id} />
    </div>
  );
}
```

---

## Navigation Guards

### Authentication Guard

```typescript
// lib/guards/auth-guard.ts
import { redirect } from '@tanstack/react-router';
import type { GuardResult } from '@/lib/types/routing';

export async function requireAuth(context: LoaderContext): Promise<GuardResult> {
  const session = context.context.session;

  if (!session) {
    return {
      allowed: false,
      redirect: '/login',
    };
  }

  return { allowed: true };
}

// Usage in route
export const Route = createFileRoute('/projects/$projectId')({
  beforeLoad: async ({ context }) => {
    const guard = await requireAuth(context);
    if (!guard.allowed && guard.redirect) {
      throw redirect({ to: guard.redirect });
    }
  },
  // ...
});
```

### Project Access Guard

```typescript
// lib/guards/project-guard.ts
import { notFound } from '@tanstack/react-router';
import { projectService } from '@/lib/services/project-service';

export async function requireProjectAccess(
  projectId: string,
  userId?: string
): Promise<GuardResult> {
  const result = await projectService.getById(projectId);

  if (!result.ok) {
    return {
      allowed: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found',
      },
    };
  }

  // Add access control logic here if needed
  return { allowed: true };
}
```

### Session Access Guard

```typescript
// lib/guards/session-guard.ts
import { sessionService } from '@/lib/services/session-service';

export async function requireSessionAccess(sessionId: string): Promise<GuardResult> {
  const result = await sessionService.getById(sessionId);

  if (!result.ok) {
    return {
      allowed: false,
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found or expired',
      },
    };
  }

  if (!result.value.isActive) {
    return {
      allowed: false,
      error: {
        code: 'SESSION_CLOSED',
        message: 'Session has been closed',
      },
    };
  }

  return { allowed: true };
}
```

---

## Implementation Outline

### Router Configuration

```typescript
// app/router.tsx
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { db } from '@/db/client';

export interface RouterContext {
  db: typeof db;
  session?: UserSession;
}

export const router = createRouter({
  routeTree,
  context: {
    db,
    session: undefined,
  },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  // Error handling
  defaultErrorComponent: ({ error }) => <ErrorPage error={error} />,
  defaultNotFoundComponent: () => <NotFoundPage />,
  // Scroll behavior
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
```

### Server Route Pattern

```typescript
// app/routes/api/tasks/$id/move.ts
import { createServerFileRoute } from '@tanstack/react-start/server';
import { taskService } from '@/lib/services/task-service';
import { handleApiError } from '@/lib/api/error-handler';
import { moveTaskSchema } from '@/db/schema/validation';

export const ServerRoute = createServerFileRoute().methods({
  POST: async ({ request, params }) => {
    const body = await request.json();

    // Validate request body
    const parsed = moveTaskSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: parsed.error.flatten(),
          },
        },
        { status: 400 }
      );
    }

    // Execute service method
    const result = await taskService.moveColumn(params.id, parsed.data);

    if (!result.ok) {
      return handleApiError(result.error);
    }

    return Response.json({ ok: true, data: result.value });
  },
});
```

### SSE Stream Route

```typescript
// app/routes/api/sessions/$id/stream.ts
import { createServerFileRoute } from '@tanstack/react-start/server';
import { sessionService } from '@/lib/services/session-service';

export const ServerRoute = createServerFileRoute().methods({
  GET: async ({ params, request }) => {
    // Verify session exists
    const session = await sessionService.getById(params.id);
    if (!session.ok) {
      return Response.json(
        { ok: false, error: session.error },
        { status: 404 }
      );
    }

    // Get user ID from headers or generate anonymous ID
    const userId = request.headers.get('X-User-ID') ?? `anon_${Date.now()}`;

    // Join session for presence tracking
    await sessionService.join(params.id, userId);

    // Create SSE stream
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        // Subscribe to session events via Durable Streams
        const subscription = sessionService.subscribe(params.id);

        for await (const event of subscription) {
          const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        }
      },
      cancel() {
        // Leave session on disconnect
        sessionService.leave(params.id, userId);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  },
});
```

### Deep Link Support

```typescript
// lib/deep-links.ts
import { router } from '@/app/router';

/**
 * Generate shareable session URL
 */
export function getSessionUrl(sessionId: string): string {
  return `${window.location.origin}/sessions/${sessionId}`;
}

/**
 * Generate project task URL
 */
export function getTaskUrl(projectId: string, taskId: string): string {
  return `${window.location.origin}/projects/${projectId}/tasks/${taskId}`;
}

/**
 * Navigate to session from anywhere
 */
export function navigateToSession(sessionId: string) {
  router.navigate({
    to: '/sessions/$sessionId',
    params: { sessionId },
  });
}

/**
 * Open task in project context
 */
export function openTask(projectId: string, taskId: string) {
  router.navigate({
    to: '/projects/$projectId/tasks/$taskId',
    params: { projectId, taskId },
  });
}
```

### Navigation Hooks

```typescript
// lib/hooks/use-navigation.ts
import { useRouter, useMatches } from '@tanstack/react-router';

export function useNavigation() {
  const router = useRouter();
  const matches = useMatches();

  const currentPath = matches[matches.length - 1]?.pathname ?? '/';

  const navigateToProject = (projectId: string) => {
    router.navigate({
      to: '/projects/$projectId',
      params: { projectId },
    });
  };

  const navigateToTask = (projectId: string, taskId: string) => {
    router.navigate({
      to: '/projects/$projectId/tasks/$taskId',
      params: { projectId, taskId },
    });
  };

  const navigateToAgent = (agentId: string) => {
    router.navigate({
      to: '/agents/$agentId',
      params: { agentId },
    });
  };

  const navigateToSession = (sessionId: string) => {
    router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId },
    });
  };

  const goBack = () => {
    router.history.back();
  };

  return {
    currentPath,
    navigateToProject,
    navigateToTask,
    navigateToAgent,
    navigateToSession,
    goBack,
  };
}
```

### Breadcrumb Generation

```typescript
// lib/hooks/use-breadcrumbs.ts
import { useMatches } from '@tanstack/react-router';

interface Breadcrumb {
  label: string;
  href: string;
}

export function useBreadcrumbs(): Breadcrumb[] {
  const matches = useMatches();

  return matches
    .filter((match) => match.staticData?.breadcrumb)
    .map((match) => ({
      label: match.staticData.breadcrumb as string,
      href: match.pathname,
    }));
}

// Usage in routes
export const Route = createFileRoute('/projects/$projectId')({
  staticData: {
    breadcrumb: 'Project',
  },
  // ...
});
```

---

## Route Transitions

### Loading States

```typescript
// components/route-loading.tsx
import { useRouterState } from '@tanstack/react-router';
import { Skeleton } from '@/components/ui/skeleton';

export function RouteLoadingIndicator() {
  const isLoading = useRouterState({
    select: (s) => s.status === 'pending',
  });

  if (!isLoading) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-50">
      <div className="h-1 bg-primary animate-pulse" />
    </div>
  );
}
```

### Pending UI

```typescript
// components/pending-component.tsx
export function PendingComponent() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

// Usage
export const Route = createFileRoute('/projects/$projectId')({
  pendingComponent: PendingComponent,
  // ...
});
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [API Endpoints](/specs/api/endpoints.md) | Server route implementations |
| [Project Service](/specs/services/project-service.md) | Project route loaders |
| [Task Service](/specs/services/task-service.md) | Task route loaders and mutations |
| [Agent Service](/specs/services/agent-service.md) | Agent route loaders and actions |
| [Session Service](/specs/services/session-service.md) | Session SSE streaming |
| [Database Schema](/specs/database/schema.md) | Data types for loaders |
| [Error Catalog](/specs/errors/error-catalog.md) | Route error handling |
| [User Stories](/specs/user-stories.md) | Navigation requirements |
| [Component Patterns](/specs/implementation/component-patterns.md) | UI components for routes |
