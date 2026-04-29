# API Endpoints Specification

## Overview

Complete REST API specification for AgentPane. The API is built on **Hono** (`hono` v4.x), a lightweight web framework. Each domain area is implemented as a Hono sub-application in a dedicated route file under `src/server/routes/`, then mounted onto the main router via `app.route()` in `src/server/router.ts`.

All endpoints are prefixed with `/api/` and return JSON with a consistent `ok/error` response structure.

**Route files:** 40+ files producing 240+ endpoints across the documented domain groups.

> **arch29-W3-D (F12-06)** — the project→codespace rename has been completed at the API surface. The previous `/api/projects/*`, `/api/project-folders/*`, `/api/project-members/*`, and `/api/team-projects/*` paths have been renamed to `/api/codespaces/*`, `/api/codespace-folders/*`, `/api/codespaces/:id/members`, and `/api/teams/:id/project-folders` respectively. For one release the server emits a 308 Permanent Redirect from `/api/project-folders/*` → `/api/codespace-folders/*` so existing API clients continue to work; the redirect will be removed in the next release. All other old paths have been replaced (no redirect was added because there was no production API consumer using them when the rename landed).

---

## Architecture

### Router Structure

```
src/server/
├── router.ts            # Main Hono app — mounts all sub-routes, middleware
├── shared.ts            # Shared helpers: json(), isValidId(), parsePagination()
├── validation.ts        # Shared Zod schemas and parseBody/parseJsonBody helpers
└── routes/
    ├── agents.ts
    ├── api-keys.ts
    ├── auth.ts
    ├── cli-monitor.ts
    ├── codespace-folders.ts   # arch29-W3-D: renamed from project-folders.ts
    ├── codespace-members.ts   # arch29-W3-D: renamed from project-members.ts
    ├── codespaces.ts          # was projects.ts
    ├── events.ts
    ├── filesystem.ts
    ├── git.ts
    ├── github.ts
    ├── github-app.ts
    ├── github-app-webhooks.ts
    ├── health.ts
    ├── invitation-accept.ts
    ├── marketplaces.ts
    ├── me.ts
    ├── memory.ts
    ├── metrics.ts
    ├── admin-metrics.ts
    ├── rbac-tokens.ts
    ├── sandbox.ts             # legacy factories
    ├── sandbox-configs.ts
    ├── sandbox-k8s.ts
    ├── sandbox-nomad.ts
    ├── sandbox-status.ts
    ├── sessions.ts
    ├── settings.ts
    ├── tags.ts                # 3 exported factories: tags, codespace-tags, task-tags
    ├── task-creation.ts
    ├── tasks.ts
    ├── team-github-token.ts
    ├── team-invitations.ts
    ├── team-members.ts
    ├── team-project-folders.ts  # was team-projects.ts
    ├── teams.ts
    ├── templates.ts
    ├── terraform.ts
    ├── webhooks.ts
    ├── workflow-designer.ts
    └── workflows.ts
```

### Route Factory Pattern

Each route file exports a factory function that receives service dependencies and returns a Hono sub-app:

```typescript
import { Hono } from 'hono';
import { json } from '../shared.js';

interface CodespacesDeps {
  db: Database;
}

export function createCodespacesRoutes({ db }: CodespacesDeps) {
  const app = new Hono();

  app.get('/', async (c) => {
    // ...
    return json({ ok: true, data: { items } });
  });

  return app;
}
```

The main router mounts it:

```typescript
app.route('/api/codespaces', createCodespacesRoutes({ db }));
```

### Response Format

**Success:**

```typescript
{ ok: true, data: T }
```

**Error:**

```typescript
{
  ok: false,
  error: {
    code: string,       // Machine-readable error code
    message: string     // Human-readable message
  }
}
```

### Authentication & Authorization

All `/api/*` routes pass through a middleware chain defined in `router.ts`:

1. **Rate limiter** -- 200 req/min per IP, 100 req/min per API token
2. **`createAuthMiddleware`** -- validates session cookie or `Authorization: Bearer <token>` header; populates `auth` context variable
3. **`enrichAuthContext`** -- loads full user record and token scope metadata
4. **`requireTagAccess`** -- filters API token requests by tag scope
5. **`requireRole` guards** -- per-route-group RBAC minimum role checks (see table below)

**Exception:** `/api/auth/*` and `/api/health/*` are exempt from auth middleware. Health probes `/api/healthz` and `/api/readyz` are inline handlers exempt from auth.

**RBAC Role Guards by Route Group:**

| Route Prefix | Minimum Role |
|---|---|
| `/api/settings` | `admin` |
| `/api/keys` | `admin` |
| `/api/filesystem` | `admin` |
| `/api/sandbox-configs` | `admin` |
| `/api/sandbox/k8s` | `admin` |
| `/api/sandbox/nomad` | `admin` |
| `/api/webhooks` | `admin` |
| `/api/tasks/create-with-ai` | `agent_operator` |
| `/api/git` | `agent_operator` |
| `/api/codespaces`, `/api/codespace-folders`, `/api/tasks`, `/api/agents`, `/api/sessions` | `viewer` |
| `/api/github`, `/api/workflows`, `/api/templates`, `/api/workflow-designer` | `viewer` |
| `/api/marketplaces`, `/api/terraform`, `/api/cli-monitor`, `/api/events` | `viewer` |
| `/api/sandbox/status` | `viewer` |

Some route handlers perform additional fine-grained role checks (e.g., `requireTeamRole`, `requireCodespaceRole`) internally.

### Validation Pattern

Routes use either inline Zod validation or the shared `parseBody` / `parseJsonBody` helpers from `src/server/validation.ts`:

```typescript
// Inline pattern
const parsed = createCodespaceSchema.safeParse(body);
if (!parsed.success) {
  return json({ ok: false, error: { code: 'VALIDATION_ERROR', message: '...' } }, 400);
}

// Shared helper pattern
const parsed = await parseJsonBody(c, updateProfileSchema);
if (!parsed.ok) return parsed.response;
```

---

## Health & Probes

**File:** `health.ts` | **Mount:** `/api/health`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Full health check (database, GitHub, sandbox, K8s) |
| `GET` | `/api/health/liveness` | Liveness probe -- confirms process is running |
| `GET` | `/api/health/readiness` | Readiness probe -- confirms DB is reachable |

**Inline routes in `router.ts`:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/healthz` | Lightweight liveness probe (alias) |
| `GET` | `/api/readyz` | Lightweight readiness probe (alias) |

---

## Authentication

**File:** `auth.ts` | **Mount:** `/api/auth`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/auth/github` | Redirect to GitHub OAuth authorization |
| `GET` | `/api/auth/github/callback` | Handle OAuth callback, create/update user, set session cookie |
| `POST` | `/api/auth/logout` | End session, clear cookie, delete session from DB |

---

## Current User Profile

**File:** `me.ts` | **Mount:** `/api/me`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/me` | Get current user profile with team memberships |
| `PATCH` | `/api/me` | Update current user profile (name, email) |

---

## Codespaces

**File:** `codespaces.ts` | **Mount:** `/api/codespaces`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/codespaces` | List all codespaces (ordered by `updatedAt` desc) |
| `POST` | `/api/codespaces` | Create a new codespace (validates unique path) |
| `GET` | `/api/codespaces/summaries` | List codespaces with task counts, running agents, status |
| `GET` | `/api/codespaces/:id` | Get codespace by ID |
| `PATCH` | `/api/codespaces/:id` | Update codespace (name, description, config, maxConcurrentAgents) |
| `DELETE` | `/api/codespaces/:id` | Delete codespace (optionally delete files with `?deleteFiles=true`) |

**Validation (`src/server/validation.ts`):**

```typescript
export const createCodespaceSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  path: z.string().min(1, 'Path is required').max(2048),
  description: z.string().max(2000).optional(),
  projectFolderId: idSchema,
});

export const updateCodespaceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  maxConcurrentAgents: z.number().int().positive().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  projectFolderId: idSchema.optional(),
  githubOwner: z.string().min(1).max(200).optional(),
  githubRepo: z.string().min(1).max(200).optional(),
});
```

---

## Codespace Folders

**File:** `codespace-folders.ts` | **Mount:** `/api/codespace-folders`

> arch29-W3-D: previously mounted at `/api/project-folders`. Old path emits 308 redirect.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/codespace-folders` | List all codespace folders (optional `teamId` filter) |
| `POST` | `/api/codespace-folders` | Create a new folder (auto-generates slug if not provided) |
| `GET` | `/api/codespace-folders/:id` | Get folder by ID |
| `PATCH` | `/api/codespace-folders/:id` | Update folder (name, slug, description, icon, color) |
| `DELETE` | `/api/codespace-folders/:id` | Delete folder (refuses if it contains codespaces) |
| `GET` | `/api/codespace-folders/:id/codespaces` | List codespaces in this folder |
| `GET` | `/api/codespace-folders/:id/summary` | Get folder summary (counts, running agents, etc.) |

> The DB table and service are still named `projectFolders` / `ProjectFolderService` because the entity is a "folder of codespaces" — distinct from a single codespace. The rename is scoped to the public API path and route file.

---

## Codespace Members

**File:** `codespace-members.ts` | **Mount:** `/api/codespaces/:id/members`

> arch29-W3-D: route file renamed from `project-members.ts`. The mount path was already `/api/codespaces/:id/members`. Internal symbols renamed (`createCodespaceMembersRoutes`, `addCodespaceMemberSchema`, `updateCodespaceMemberSchema`).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/codespaces/:id/members` | List codespace members with effective roles |
| `POST` | `/api/codespaces/:id/members` | Add codespace member override (requires `admin` role) |
| `PATCH` | `/api/codespaces/:id/members/:uid` | Update member role (requires `admin` role) |
| `DELETE` | `/api/codespaces/:id/members/:uid` | Remove codespace member override (requires `admin` role) |

Each list item includes `codespaceRole` and (deprecated) `projectRole` mirror plus `effectiveRole` resolved from RBAC.

---

## Tasks

**File:** `tasks.ts` | **Mount:** `/api/tasks`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tasks` | List tasks for a codespace (requires `codespaceId` query param) |
| `POST` | `/api/tasks` | Create a new task |
| `GET` | `/api/tasks/:id` | Get task by ID |
| `PUT` | `/api/tasks/:id` | Update a task (title, description, labels, priority) |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| `GET` | `/api/tasks/:id/diff` | Get diff for a task |
| `PATCH` | `/api/tasks/:id/move` | Move task to a different column (Kanban drag-drop) |
| `POST` | `/api/tasks/:id/approve-plan` | Approve a pending plan and start execution |
| `POST` | `/api/tasks/:id/reject-plan` | Reject a pending plan (optional `reason` in body) |
| `POST` | `/api/tasks/:id/stop-agent` | Stop a running container agent for a task |

**Key behavior:** When `PATCH /api/tasks/:id/move` moves a task to `in_progress`, it can optionally auto-start an agent (controlled by `startAgent` field in body, defaults to `true`). The response includes `{ task, agentError? }`.

**Validation (shared schemas from `validation.ts`):**

```typescript
const moveTaskSchema = z.object({
  column: z.enum(['backlog', 'queued', 'in_progress', 'waiting_approval', 'verified']),
  position: z.number().int().min(0),
  startAgent: z.boolean().optional(),
});
```

---

## Task Tags

**File:** `tags.ts` (exported as `createTaskTagRoutes`) | **Mount:** `/api/tasks/:id/tags`

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/tasks/:id/tags` | Assign a tag to a task |
| `DELETE` | `/api/tasks/:id/tags/:tagId` | Remove a tag from a task |

---

## Task Creation with AI

**File:** `task-creation.ts` | **Mount:** `/api/tasks/create-with-ai`

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/tasks/create-with-ai/start` | Start an AI-assisted task creation conversation |
| `POST` | `/api/tasks/create-with-ai/message` | Send a message in the conversation |
| `POST` | `/api/tasks/create-with-ai/accept` | Accept the AI-suggested task (creates the task) |
| `POST` | `/api/tasks/create-with-ai/cancel` | Cancel the conversation |
| `POST` | `/api/tasks/create-with-ai/answer` | Answer clarifying questions from the AI |
| `POST` | `/api/tasks/create-with-ai/skip` | Skip clarifying questions |
| `GET` | `/api/tasks/create-with-ai/stream` | SSE endpoint for real-time task creation updates |

The SSE stream emits events: `connected`, `task-creation:token`, `task-creation:message`, `task-creation:questions`, `task-creation:suggestion`, `task-creation:completed`, `task-creation:cancelled`, `task-creation:error`.

---

## Agents

**File:** `agents.ts` | **Mount:** `/api/agents`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agents` | List agents for a codespace (requires `codespaceId` query param) |
| `POST` | `/api/agents` | Create a new agent |
| `GET` | `/api/agents/:id` | Get agent by ID |
| `PATCH` | `/api/agents/:id` | Update agent configuration |
| `DELETE` | `/api/agents/:id` | Delete an agent |
| `POST` | `/api/agents/:id/start` | Start an agent (optionally with `taskId` in body) |
| `GET` | `/api/agents/:id/status` | Get agent execution status |
| `POST` | `/api/agents/:id/stop` | Stop a running agent |
| `POST` | `/api/agents/:id/pause` | Pause a running agent |
| `POST` | `/api/agents/:id/resume` | Resume a paused agent (optional `feedback` in body) |

---

## Sessions

**File:** `sessions.ts` | **Mount:** `/api/sessions`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions` | List sessions (optional `codespaceId`, `status`, `agentId`, `search`, `dateFrom`, `dateTo` filters) |
| `POST` | `/api/sessions` | Create a new session |
| `GET` | `/api/sessions/:id` | Get session by ID |
| `DELETE` | `/api/sessions/:id` | Delete a session |
| `GET` | `/api/sessions/:id/events` | Get session events (paginated with `limit`/`offset`) |
| `GET` | `/api/sessions/:id/summary` | Get session summary (duration, turns, tokens, files modified) |
| `POST` | `/api/sessions/:id/export` | Export session in JSON, Markdown, or CSV format |

Note: The SSE streaming endpoint has been removed. Clients subscribe to Caddy durable streams at `/v1/stream/sessions/:id` directly.

---

## Worktrees

**File:** `worktrees.ts` | **Mount:** `/api/worktrees`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/worktrees` | List worktrees for a codespace (requires `codespaceId` query param) |
| `POST` | `/api/worktrees` | Create a new worktree |
| `POST` | `/api/worktrees/prune` | Prune stale worktrees for a codespace |
| `GET` | `/api/worktrees/:id` | Get worktree status |
| `DELETE` | `/api/worktrees/:id` | Remove a worktree (`?force=true` to force) |
| `GET` | `/api/worktrees/:id/diff` | Get diff for a worktree |
| `POST` | `/api/worktrees/:id/commit` | Commit changes in a worktree |
| `POST` | `/api/worktrees/:id/merge` | Merge worktree branch (optional `deleteAfterMerge` and `targetBranch` in body) |

---

## Git

**File:** `git.ts` | **Mount:** `/api/git`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/git/status` | Get git status for a codespace (requires `codespaceId` query param) |
| `GET` | `/api/git/branches` | List local branches for a project |
| `GET` | `/api/git/commits` | List commits (optional `branch` and `limit` query params) |
| `GET` | `/api/git/remote-branches` | List remote branches (fetches from remote first) |

---

## GitHub Integration

**File:** `github.ts` | **Mount:** `/api/github`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/github/orgs` | List authenticated user's GitHub organizations |
| `GET` | `/api/github/repos` | List authenticated user's repositories |
| `GET` | `/api/github/repos/:owner` | List repositories for a specific owner/org |
| `POST` | `/api/github/clone` | Clone a GitHub repository to local filesystem |
| `POST` | `/api/github/create-from-template` | Create repo from GitHub template and clone it |
| `GET` | `/api/github/token` | Get GitHub token info (masked) |
| `POST` | `/api/github/token` | Save a GitHub personal access token |
| `DELETE` | `/api/github/token` | Delete the stored GitHub token |
| `POST` | `/api/github/revalidate` | Revalidate the stored GitHub token |

---

## Teams

**File:** `teams.ts` | **Mount:** `/api/teams`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/teams` | List user's teams (with cursor pagination, search, member/project counts) |
| `POST` | `/api/teams` | Create a new team (creator becomes owner) |
| `GET` | `/api/teams/:id` | Get team details (with member/project counts and caller's role) |
| `PATCH` | `/api/teams/:id` | Update team (name, slug, description; requires `admin` role) |
| `DELETE` | `/api/teams/:id` | Delete team and all associated data (requires `owner` role) |
| `POST` | `/api/teams/:id/transfer-ownership` | Transfer team ownership to another member (requires `owner` role) |

---

## Team Members

**File:** `team-members.ts` | **Mount:** `/api/teams/:id/members`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/teams/:id/members` | List team members (with cursor pagination and role filter) |
| `POST` | `/api/teams/:id/members` | Add a member to the team (requires `admin` role) |
| `PATCH` | `/api/teams/:id/members/:uid` | Update member role (requires `admin`; only `owner` can assign `admin`) |
| `DELETE` | `/api/teams/:id/members/:uid` | Remove member from team (prevents removing last owner) |

---

## Team Project Folders

**File:** `team-project-folders.ts` | **Mount:** `/api/teams/:id/project-folders`

> arch29-W3-D: previously named "team-projects". Now scopes folders (each folder contains many codespaces) onto a team.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/teams/:id/project-folders` | Assign a folder to the team (requires `admin` role) |
| `DELETE` | `/api/teams/:id/project-folders/:folderId` | Remove a folder from the team (requires `admin` role) |

---

## Team Invitations

**File:** `team-invitations.ts` | **Mount:** `/api/teams/:id/invitations`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/teams/:id/invitations` | List pending invitations (requires `admin` role) |
| `POST` | `/api/teams/:id/invitations` | Create an invitation (requires `admin`; only `owner` can invite with `admin` role) |
| `POST` | `/api/teams/:id/invitations/:iid/decline` | Decline an invitation (invitee only, verified by GitHub email) |
| `DELETE` | `/api/teams/:id/invitations/:iid` | Revoke an invitation (requires `admin` role) |

---

## Invitation Accept

**File:** `invitation-accept.ts` | **Mount:** `/api/invitations`

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/invitations/:token/accept` | Accept a team invitation using the raw token |

Validates token hash, checks email match against GitHub OAuth email, and adds user to team in a transaction.

---

## Team GitHub Token

**File:** `team-github-token.ts` | **Mount:** `/api/teams/:id/github-token`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/teams/:id/github-token` | Get team's GitHub token info (masked, never raw; requires `admin`) |
| `PUT` | `/api/teams/:id/github-token` | Set/replace team's GitHub token (validates with GitHub API first; requires `admin`) |
| `DELETE` | `/api/teams/:id/github-token` | Delete team's GitHub token (requires `admin`) |
| `POST` | `/api/teams/:id/github-token/validate` | Validate token against GitHub API (requires `admin`) |

---

## Tags

**File:** `tags.ts` (exported as `createTagsRoutes`) | **Mount:** `/api/tags`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tags` | List tags for a team (requires `teamId` query param) |
| `POST` | `/api/tags` | Create a tag (requires `agent_operator` role in team) |
| `DELETE` | `/api/tags/:id` | Delete a tag (requires `admin` role in team) |

---

## Codespace Tags

**File:** `tags.ts` (exported as `createProjectTagRoutes`) | **Mount:** `/api/codespaces/:id/tags`

> arch29-W3-D: mounted at `/api/codespaces/:id/tags`. The exported factory name `createProjectTagRoutes` is a legacy holdover and not user-visible.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/codespaces/:id/tags` | Assign a tag to a codespace (requires `agent_operator` on codespace) |
| `DELETE` | `/api/codespaces/:id/tags/:tagId` | Remove a tag from a codespace |

---

## API Tokens (RBAC)

**File:** `rbac-tokens.ts` | **Mount:** `/api/tokens`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tokens` | List user's API tokens (cursor pagination, optional `teamId`, `status`, `allTeam` filters) |
| `POST` | `/api/tokens` | Create an API token (validates team membership, role ceiling, scope tags) |
| `GET` | `/api/tokens/:id` | Get token details (enriched with team name and scope tag details) |
| `DELETE` | `/api/tokens/:id` | Revoke a token (soft delete, sets status to `revoked`) |

Tokens are generated with `ap_` prefix and stored as SHA-256 hashes. The raw token is returned only once on creation. Max 25 active tokens per user.

---

## API Keys (Service Keys)

**File:** `api-keys.ts` | **Mount:** `/api/keys`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/keys/:service` | Get key info for a service (e.g., `anthropic`) |
| `POST` | `/api/keys/:service` | Save an API key for a service |
| `DELETE` | `/api/keys/:service` | Delete an API key for a service |

---

## Settings

**File:** `settings.ts` | **Mount:** `/api/settings`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/settings` | Get settings (optional `keys` query param for filtering) |
| `PUT` | `/api/settings` | Update settings (upserts allowed keys only) |

**Allowed settings keys:** `sandbox.defaults`, `sandbox.mode`, `sandbox.provider`, `sandbox.kubernetes`, `sandbox.nomad`, `sandbox.agentcore`, `anthropic.apiKey`, `anthropic.model`, `github.token`, `github.appId`, `theme`, `general.agentModel`.

Sensitive fields (`sandbox.nomad.token`, `sandbox.agentcore.secretAccessKey`) are encrypted on write and redacted on read.

---

## Templates

**File:** `templates.ts` | **Mount:** `/api/templates`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/templates` | List templates (optional `scope`, `codespaceId`, `limit` filters) |
| `POST` | `/api/templates` | Create a template (requires `name`, `scope`, `githubUrl`) |
| `GET` | `/api/templates/:id` | Get template by ID |
| `PATCH` | `/api/templates/:id` | Update a template |
| `DELETE` | `/api/templates/:id` | Delete a template |
| `POST` | `/api/templates/:id/sync` | Sync template from GitHub |

---

## Marketplaces

**File:** `marketplaces.ts` | **Mount:** `/api/marketplaces`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/marketplaces` | List marketplaces (optional `limit`, `includeDisabled` filters) |
| `POST` | `/api/marketplaces` | Create a marketplace |
| `POST` | `/api/marketplaces/seed` | Seed the default marketplace |
| `GET` | `/api/marketplaces/plugins` | List all plugins across marketplaces (optional `search`, `category`, `marketplaceId`) |
| `GET` | `/api/marketplaces/categories` | List plugin categories |
| `GET` | `/api/marketplaces/:id` | Get marketplace by ID (includes cached plugins) |
| `DELETE` | `/api/marketplaces/:id` | Delete a marketplace |
| `POST` | `/api/marketplaces/:id/sync` | Sync marketplace plugins from GitHub |

---

## Workflows

**File:** `workflows.ts` | **Mount:** `/api/workflows`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workflows` | List workflows (offset pagination, optional `status`, `search` filters) |
| `POST` | `/api/workflows` | Create a workflow |
| `GET` | `/api/workflows/:id` | Get workflow by ID |
| `PATCH` | `/api/workflows/:id` | Update a workflow |
| `DELETE` | `/api/workflows/:id` | Delete a workflow |

---

## Workflow Designer

**File:** `workflow-designer.ts` | **Mount:** `/api/workflow-designer`

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/workflow-designer/analyze` | Analyze a template and generate a workflow graph using AI (Claude Agent SDK) |

Accepts either a `templateId` to fetch from DB, or inline `skills`/`commands`/`agents` arrays. Returns a complete `Workflow` object with AI-positioned nodes and edges (laid out via ELK).

---

## Terraform

**File:** `terraform.ts` | **Mount:** `/api/terraform` (conditional -- only if services are available)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/terraform/registries` | List all Terraform registries |
| `POST` | `/api/terraform/registries` | Create a registry |
| `GET` | `/api/terraform/registries/:id` | Get registry detail |
| `PATCH` | `/api/terraform/registries/:id` | Update registry settings |
| `DELETE` | `/api/terraform/registries/:id` | Delete a registry |
| `POST` | `/api/terraform/registries/:id/sync` | Trigger manual registry sync |
| `GET` | `/api/terraform/modules` | List all modules (optional `search`, `provider`, `registryId`, `limit`) |
| `GET` | `/api/terraform/modules/:id` | Get module detail |
| `POST` | `/api/terraform/validate` | Validate generated HCL code |
| `POST` | `/api/terraform/compose` | Start a compose job (returns 202 with sessionId) |

Note: The SSE streaming endpoint has been removed. Clients subscribe to Caddy durable streams at `/v1/stream/terraform/{sessionId}` directly.

---

## CLI Monitor

**File:** `cli-monitor.ts` | **Mount:** `/api/cli-monitor` (conditional -- only if service is available)

### Daemon-to-Server (push from CLI daemon):

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/cli-monitor/register` | Daemon announces itself |
| `POST` | `/api/cli-monitor/heartbeat` | Daemon keepalive |
| `POST` | `/api/cli-monitor/ingest` | Daemon pushes session updates (up to 500 sessions, 5MB limit) |
| `POST` | `/api/cli-monitor/deregister` | Daemon shutting down |

### Frontend-to-Server (queried by UI):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cli-monitor/status` | Check if daemon is connected |
| `GET` | `/api/cli-monitor/sessions` | List live sessions (optional `limit`/`offset` pagination) |
| `GET` | `/api/cli-monitor/history` | Query historical sessions from DB (optional `projectHash`, `since`, `limit`) |
| `GET` | `/api/cli-monitor/stream` | SSE endpoint for live session updates (max 50 concurrent connections) |
| `GET` | `/api/cli-monitor/topology` | Get topology graph for a root session (requires `rootSessionId` query param) |

The SSE stream sends an initial `cli-monitor:snapshot` event, then relays live events from the daemon. Keep-alive pings every 15s.

---

## Events (Plugin System)

**File:** `events.ts` | **Mount:** `/api/events` (conditional -- only if services are available)

### Event Sources:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events/sources` | List event sources (optional `teamId`, `type`, `status` filters) |
| `GET` | `/api/events/sources/:id` | Get event source by ID |
| `POST` | `/api/events/sources` | Create an event source (webhook, cron, or manual) |
| `PATCH` | `/api/events/sources/:id` | Update an event source |
| `DELETE` | `/api/events/sources/:id` | Delete an event source |
| `POST` | `/api/events/sources/:id/rotate-secret` | Rotate webhook secret |
| `POST` | `/api/events/sources/:id/trigger` | Manually trigger an event source |
| `POST` | `/api/events/sources/:id/pause` | Pause an event source |
| `POST` | `/api/events/sources/:id/resume` | Resume a paused event source |
| `GET` | `/api/events/sources/:id/budget` | Get budget/usage info for an event source |
| `GET` | `/api/events/sources/:id/executions` | List cron schedule executions |

### Event Subscriptions:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events/subscriptions` | List subscriptions (optional `sourceId`, `codespaceId` filters) |
| `GET` | `/api/events/subscriptions/:id` | Get subscription by ID |
| `POST` | `/api/events/subscriptions` | Create a subscription |
| `PATCH` | `/api/events/subscriptions/:id` | Update a subscription |
| `DELETE` | `/api/events/subscriptions/:id` | Delete a subscription |

### Event Log:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events/log` | Query event log (optional `sourceId`, `status`, `since`/`until`, cursor pagination) |
| `GET` | `/api/events/log/:id` | Get event log entry by ID |

### Streaming:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events/stream` | SSE endpoint for real-time event notifications (max 50 connections) |

---

## Sandbox Configs

**File:** `sandbox.ts` (exported as `createSandboxRoutes`) | **Mount:** `/api/sandbox-configs`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sandbox-configs` | List sandbox configurations (paginated) |
| `POST` | `/api/sandbox-configs` | Create a sandbox configuration |
| `GET` | `/api/sandbox-configs/:id` | Get sandbox config by ID |
| `PATCH` | `/api/sandbox-configs/:id` | Update a sandbox configuration |
| `DELETE` | `/api/sandbox-configs/:id` | Delete a sandbox configuration |

---

## Sandbox Status

**File:** `sandbox-status.ts` | **Mount:** `/api/sandbox/status`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sandbox/status/:codespaceId` | Get sandbox mode, container status, and provider health (Docker, K8s, Nomad) |
| `POST` | `/api/sandbox/status/:codespaceId/restart` | Restart the sandbox container |

Includes self-healing: auto-creates the default sandbox when Docker/K8s is available but no container exists.

---

## Sandbox K8s

**File:** `sandbox.ts` (exported as `createK8sRoutes`) | **Mount:** `/api/sandbox/k8s`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sandbox/k8s/status` | Get Kubernetes cluster health and CRD status |
| `GET` | `/api/sandbox/k8s/contexts` | List available kube contexts |
| `GET` | `/api/sandbox/k8s/namespaces` | List Kubernetes namespaces |
| `GET` | `/api/sandbox/k8s/controller` | Get AgentPane controller installation status |
| `POST` | `/api/sandbox/k8s/minikube/start` | Start minikube for local development |
| `POST` | `/api/sandbox/k8s/install-crds` | Install AgentPane CRDs in the cluster |

---

## Sandbox Nomad

**File:** `sandbox.ts` (exported as `createNomadRoutes`) | **Mount:** `/api/sandbox/nomad`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sandbox/nomad/status` | Get Nomad cluster health |
| `GET` | `/api/sandbox/nomad/namespaces` | List Nomad namespaces |
| `GET` | `/api/sandbox/nomad/datacenters` | List Nomad datacenters |
| `POST` | `/api/sandbox/nomad/validate` | Validate Nomad connection settings |

---

## Filesystem

**File:** `filesystem.ts` | **Mount:** `/api/filesystem`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/filesystem/discover-repos` | Discover git repositories in common directories (`~/git`, `~/projects`, etc.) |

Returns up to 20 most recently modified repositories. Includes warnings for inaccessible directories.

---

## Webhooks

**File:** `webhooks.ts` | **Mount:** `/api/webhooks`

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/webhooks/github` | GitHub webhook handler (verifies `x-hub-signature-256`, handles `push` events to auto-sync templates) |

---

## Cross-References

| Spec | Relationship |
|---|---|
| [Database Schema](../database/schema.md) | Data types and table definitions |
| [Error Catalog](../errors/error-catalog.md) | Error codes and messages |
| [Authentication](../security/authentication.md) | OAuth and session management |
| [Pagination](./pagination.md) | Cursor-based pagination patterns |
| [User Stories](../user-stories.md) | Feature requirements |
