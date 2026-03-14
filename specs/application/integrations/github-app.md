# GitHub App Integration Specification

## Overview

AgentPane integrates with GitHub via a GitHub App to enable repository access, configuration sync, webhook events, and PR management. This specification defines the complete GitHub integration, from OAuth authorization through webhook handling.

**Wireframe References**:

- [github-app-setup.html](../wireframes/github-app-setup.html) - **Primary**: Global GitHub App setup flow (OAuth, installations, permissions, management)
- [github-project-picker.html](../wireframes/github-project-picker.html) - Project selection with GitHub repos
- [github-multi-project-dashboard.html](../wireframes/github-multi-project-dashboard.html) - Multi-project dashboard view

---

## Architecture

### Integration Components

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           AgentPane Client                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────┐    │
│  │ Project Picker │  │  Config Sync   │  │    PR Management       │    │
│  │  (OAuth Flow)  │  │ (.claude/)  │  │ (Create/Merge PRs)     │    │
│  └────────┬───────┘  └────────┬───────┘  └───────────┬────────────┘    │
└───────────┼───────────────────┼──────────────────────┼─────────────────┘
            │                   │                      │
            ▼                   ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          AgentPane Server                               │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────┐    │
│  │  OAuth Handler │  │ GitHub Service │  │   Webhook Handler      │    │
│  │ /api/github/*  │  │   (Octokit)    │  │  /api/webhooks/github  │    │
│  └────────┬───────┘  └────────┬───────┘  └───────────┬────────────┘    │
│           │                   │                      │                  │
│           └───────────────────┼──────────────────────┘                  │
│                               │                                         │
│                      ┌────────▼────────┐                               │
│                      │   SQLite DB     │                               │
│                      │ (better-sqlite3)│                               │
│                      │ Tokens, Installs│                               │
│                      └─────────────────┘                               │
└─────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          GitHub API                                     │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────┐    │
│  │   OAuth API    │  │   REST API     │  │     Webhooks           │    │
│  │ (User Auth)    │  │ (Repos, PRs)   │  │ (Push, PR, Issues)     │    │
│  └────────────────┘  └────────────────┘  └────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## GitHub App Configuration

### App Settings

```yaml
# GitHub App manifest
name: AgentPane
url: https://agentpane.dev
description: Multi-agent task management for code repositories

# Permissions (Repository)
permissions:
  contents: write        # Read/write repo contents
  pull_requests: write   # Create and manage PRs
  issues: write          # Create and manage issues
  metadata: read         # Basic repo metadata

# Webhook events
webhook_events:
  - push
  - pull_request
  - issues
  - installation
  - installation_repositories

# OAuth settings
callback_url: http://localhost:3000/api/auth/github/callback
setup_url: http://localhost:3000/api/github/setup
```

### Environment Variables

```bash
# .env
GITHUB_APP_ID=123456
GITHUB_APP_NAME=agentpane
GITHUB_CLIENT_ID=Iv1.abc123def456
GITHUB_CLIENT_SECRET=secret_abc123def456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=whsec_abc123def456
```

---

## Authentication and Token Management

### Overview

AgentPane uses two complementary GitHub integration patterns:

1. **GitHub OAuth** (`/api/auth/github`) -- User login/signup via GitHub OAuth for application authentication
2. **Personal Access Tokens (PATs)** -- Encrypted PAT storage for GitHub API access (repos, cloning, PRs)

PATs can be stored at two scopes:
- **Global** -- A single token for all projects (managed via `GitHubTokenService`)
- **Team-scoped** -- Per-team tokens with RBAC enforcement (managed via `/api/teams/:id/github-token`)

Token resolution for a project follows: team token (via `team_projects`) → global token (where `team_id IS NULL`).

### GitHub OAuth Login Flow

OAuth is handled by Hono routes in `src/server/routes/auth.ts`:

```typescript
// src/server/routes/auth.ts
import { Hono } from 'hono';

export function createAuthRoutes({ db }: AuthDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /api/auth/github — Redirect to GitHub OAuth authorization
  app.get('/github', (c) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const state = randomBytes(16).toString('hex');
    const redirectUri = process.env.GITHUB_CALLBACK_URL
      ?? `${c.req.url.replace('/github', '/github/callback')}`;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
    });

    // Set state cookie for CSRF protection
    c.header('Set-Cookie',
      `oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600; Secure`
    );

    return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  });

  // GET /api/auth/github/callback — Handle OAuth callback
  app.get('/github/callback', async (c) => {
    // 1. Verify state parameter (CSRF protection)
    // 2. Exchange code for access token via GitHub API
    // 3. Fetch GitHub user info (id, login, name, email, avatar)
    // 4. Upsert user record in users table
    // 5. Create session (hashed token in DB, raw token in HttpOnly cookie)
    // 6. Redirect to app
  });

  // POST /api/auth/logout — End session
  app.post('/logout', async (c) => {
    // Delete session from DB, clear cookie
  });

  return app;
}
```

### PAT Token Management (Global)

Global token management via `GitHubTokenService` (`src/services/github-token.service.ts`):

```typescript
// src/services/github-token.service.ts
import { Octokit } from 'octokit';

export class GitHubTokenService {
  constructor(private db: Database) {}

  async saveToken(token: string): Promise<Result<TokenInfo, GitHubTokenError>>
  async getTokenInfo(): Promise<Result<TokenInfo | null, GitHubTokenError>>
  async getDecryptedToken(): Promise<string | null>
  async deleteToken(): Promise<Result<void, GitHubTokenError>>
  async revalidateToken(): Promise<Result<boolean, GitHubTokenError>>
  async getOctokit(): Promise<Octokit | null>
  async resolveGitHubTokenForProject(projectId: string): Promise<string | null>

  // Repository operations
  async getRepository(owner: string, repo: string): Promise<Result<GitHubRepo, GitHubTokenError>>
  async listBranches(owner: string, repo: string): Promise<Result<GitHubBranch[], GitHubTokenError>>
  async listUserRepos(): Promise<Result<GitHubRepo[], GitHubTokenError>>
  async listUserOrgs(): Promise<Result<GitHubOrg[], GitHubTokenError>>
  async listReposForOwner(owner: string): Promise<Result<GitHubRepo[], GitHubTokenError>>
  async createRepoFromTemplate(params: CreateTemplateParams): Promise<Result<...>>
}
```

Token encryption uses AES-GCM via `src/lib/crypto/server-encryption.ts`. Tokens are validated against the GitHub API (`GET /user`) before storage.

### PAT Token Management (Team-Scoped)

Team-scoped tokens are managed via Hono routes in `src/server/routes/team-github-token.ts`, mounted at `/api/teams/:id/github-token`. All endpoints enforce RBAC via `RbacService` -- only team admins can manage tokens.

```typescript
// src/server/routes/team-github-token.ts
import { Hono } from 'hono';
import type { RbacService } from '../../services/rbac.service.js';

export function createTeamGitHubTokenRoutes({ db, rbacService }: TeamGitHubTokenDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET / — Get team's token info (metadata only, never the raw token)
  //   Requires: team admin role
  //   Returns: maskedToken, tokenType, scopes, githubLogin, isValid, timestamps

  // PUT / — Set/replace the team's GitHub token
  //   Requires: team admin role
  //   Validates PAT format (ghp_* or github_pat_*) and GitHub API before saving

  // DELETE / — Remove the team's GitHub token
  //   Requires: team admin role

  // POST /validate — Re-validate the team's token against GitHub API
  //   Requires: team admin role
  //   Handles rate-limiting (429) gracefully by preserving previous validation state

  return app;
}
```

### GitHub Client Utilities

```typescript
// src/lib/github/client.ts
import { Octokit } from 'octokit';

// Singleton App-level Octokit (for installation token generation)
export function getAppOctokit(): Octokit

// Get Octokit for a specific installation (creates installation access token)
export async function getInstallationOctokit(installationId: number): Promise<Octokit>

// Create Octokit from a raw PAT
export function createOctokitFromToken(token: string): Octokit

// Extract meaningful error message from Octokit errors
export function formatGitHubError(error: unknown): { message: string; status?: number }
```

### API Routes (Hono)

All GitHub API routes are implemented as Hono route handlers in `src/server/routes/github.ts`, mounted at `/api/github` via `src/server/router.ts`.

```typescript
// src/server/routes/github.ts
import { Hono } from 'hono';
import type { GitHubTokenService } from '../../services/github-token.service.js';

export function createGitHubRoutes({ githubService }: GitHubDeps) {
  const app = new Hono();

  // GET /api/github/orgs — List user's orgs (+ their own account)
  app.get('/orgs', async (_c) => { ... });

  // GET /api/github/repos — List authenticated user's repositories
  app.get('/repos', async (_c) => { ... });

  // GET /api/github/repos/:owner — List repos for a specific owner
  app.get('/repos/:owner', async (c) => { ... });

  // POST /api/github/clone — Clone a repository to local disk
  //   Body: { url: string, destination: string }
  //   Uses Bun.spawn for git clone with PAT-injected URL
  app.post('/clone', async (c) => { ... });

  // POST /api/github/create-from-template — Create repo from template + clone
  //   Body: { templateOwner, templateRepo, name, owner?, description?, isPrivate?, clonePath }
  //   Waits for repo readiness before cloning
  app.post('/create-from-template', async (c) => { ... });

  // GET /api/github/token — Get saved token info (masked)
  app.get('/token', async (_c) => { ... });

  // POST /api/github/token — Save a new GitHub PAT
  app.post('/token', async (c) => { ... });

  // DELETE /api/github/token — Delete saved token
  app.delete('/token', async (_c) => { ... });

  // POST /api/github/revalidate — Re-validate saved token with GitHub API
  app.post('/revalidate', async (_c) => { ... });

  return app;
}
```

---

## Installation Management

Installation records are stored in the `github_installations` SQLite table. The `getAppOctokit()` and `getInstallationOctokit()` utilities in `src/lib/github/client.ts` handle App-level and installation-level Octokit creation.

### Config Existence Check

```typescript
// src/lib/github/config-sync.ts
export async function checkConfigExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  configPath = '.claude'
): Promise<boolean> {
  try {
    await octokit.rest.repos.getContent({
      owner,
      repo,
      path: `${configPath}/config.json`,
    });
    return true;
  } catch {
    return false;
  }
}
```

---

## Repository Access

### Repository Operations

Repository operations are methods on `GitHubTokenService` (`src/services/github-token.service.ts`). Authentication uses the stored PAT, not installation tokens.

```typescript
// src/services/github-token.service.ts (relevant methods)

// Get repository details
async getRepository(owner: string, repo: string): Promise<Result<GitHubRepo, GitHubTokenError>> {
  const result = await this.getOctokitWithId();
  if (!result) return err({ code: 'NOT_FOUND', message: 'No GitHub token configured' });

  const { data } = await result.octokit.rest.repos.get({ owner, repo });
  return ok({
    id: data.id,
    name: data.name,
    full_name: data.full_name,
    private: data.private,
    owner: { login: data.owner.login, avatar_url: data.owner.avatar_url },
    default_branch: data.default_branch,
    description: data.description,
    clone_url: data.clone_url,
    updated_at: data.updated_at ?? '',
    stargazers_count: data.stargazers_count,
    is_template: data.is_template ?? false,
  });
}

// List repos for authenticated user (sorted by updated, max 50)
async listUserRepos(): Promise<Result<GitHubRepo[], GitHubTokenError>>

// List repos for a specific owner (user or org, max 100)
async listReposForOwner(owner: string): Promise<Result<GitHubRepo[], GitHubTokenError>>

// List user's organizations (+ their own account)
async listUserOrgs(): Promise<Result<GitHubOrg[], GitHubTokenError>>

// List branches for a repo
async listBranches(owner: string, repo: string): Promise<Result<GitHubBranch[], GitHubTokenError>>

// Create repo from template
async createRepoFromTemplate(params: {
  templateOwner: string;
  templateRepo: string;
  name: string;
  owner?: string;
  description?: string;
  isPrivate?: boolean;
}): Promise<Result<{ cloneUrl: string; fullName: string }, GitHubTokenError>>
```

### Clone URL with PAT Authentication

Cloning uses PAT token injection rather than installation tokens:

```typescript
// src/server/routes/github.ts — POST /api/github/clone
const token = await githubService.getDecryptedToken();
let cloneUrl = body.url;
if (token && body.url.startsWith('https://github.com/')) {
  cloneUrl = body.url.replace('https://github.com/', `https://${token}@github.com/`);
}
// Token is redacted from any error messages to prevent secret leakage
```

### Error Handling

`GitHubTokenService` automatically invalidates tokens on 401 responses by marking the specific token as `isValid: false` in the database via `handleOctokitError()`. This ensures stale tokens are flagged without affecting other team tokens.

---

## Configuration Sync

### Config File Structure

```text
.claude/
├── config.json          # Main configuration
├── prompts/
│   ├── system.md        # System prompt
│   └── task.md          # Task prompt template
└── tools.json           # Tool whitelist configuration
```

### Config Schema

The config file schema used by the sync service (`src/lib/github/config-sync.ts`):

```typescript
// src/lib/github/config-sync.ts
const configFileSchema = z.object({
  worktreeRoot: z.string().optional(),
  initScript: z.string().optional(),
  envFile: z.string().optional(),
  defaultBranch: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  temperature: z.number().optional(),
});
```

The agent config schema used by the API (`src/lib/api/schemas.ts`) validates agent-level settings:

```typescript
// src/lib/api/schemas.ts
const agentConfigSchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().min(1).max(500).optional(),
  model: z.string().optional(),
  systemPrompt: z.string().max(10000).optional(),
  temperature: z.number().min(0).max(1).optional(),
});
```

### Config Sync Service

The actual config sync implementation is in `src/lib/github/config-sync.ts`. It takes an Octokit instance (from the stored PAT) rather than an installation ID.

```typescript
// src/lib/github/config-sync.ts
import type { Octokit } from 'octokit';
import { z } from 'zod';
import { GitHubErrors } from '../errors/github-errors.js';

export interface SyncConfigOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  configPath?: string;  // defaults to '.claude'
  ref?: string;
}

export interface SyncConfigResult {
  config: ProjectConfig;
  sha: string;
  path: string;
}

const configFileSchema = z.object({
  worktreeRoot: z.string().optional(),
  initScript: z.string().optional(),
  envFile: z.string().optional(),
  defaultBranch: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  temperature: z.number().optional(),
});

// Fetch and validate .claude/config.json from a repository
export async function syncConfigFromGitHub(
  options: SyncConfigOptions
): Promise<Result<SyncConfigResult, ...>> {
  // 1. Fetch file content via Octokit REST API (base64 encoded)
  // 2. Validate JSON structure against configFileSchema (zod)
  // 3. Apply defaults (worktreeRoot: '.worktrees', envFile: '.env', etc.)
  // 4. Return config, sha, and path
  // Handles 404 (CONFIG_NOT_FOUND), 401/403 (AUTH_FAILED), 429 (RATE_LIMITED)
}

// Quick existence check for .claude/config.json
export async function checkConfigExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  configPath = '.claude'
): Promise<boolean>
```

---

## Webhook Handling

### Webhook Handler

Implemented as a Hono route in `src/server/routes/webhooks.ts`, mounted at `/api/webhooks`:

```typescript
// src/server/routes/webhooks.ts
import { Hono } from 'hono';
import { GitHubErrors } from '../../lib/errors/github-errors.js';
import { parseWebhookEvent, verifyWebhookSignature } from '../../lib/github/webhooks.js';
import type { TemplateService } from '../../services/template.service.js';

export function createWebhooksRoutes({ templateService }: WebhooksDeps) {
  const app = new Hono();

  // POST /api/webhooks/github
  app.post('/github', async (c) => {
    const rawBody = await c.req.text();

    // Verify signature if GITHUB_WEBHOOK_SECRET is configured
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
    if (secret) {
      const signature = c.req.header('x-hub-signature-256') ?? null;
      const verifyResult = await verifyWebhookSignature({ payload: rawBody, signature, secret });
      if (!verifyResult.ok) {
        return json({ ok: false, error: GitHubErrors.WEBHOOK_INVALID }, 401);
      }
    }

    // Parse event from headers + body
    const eventResult = parseWebhookEvent(c.req.raw.headers, rawBody);
    if (!eventResult.ok) {
      return json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400);
    }

    const { event, deliveryId, action, payload } = eventResult.value;

    // Currently handles: push events for template sync
    if (event === 'push') {
      const repo = payload.repository;
      if (repo?.owner?.login && repo?.name) {
        const templatesResult = await templateService.findByRepo(repo.owner.login, repo.name);
        if (templatesResult.ok) {
          await Promise.allSettled(
            templatesResult.value.map((template) => templateService.sync(template.id))
          );
        }
      }
    }

    return json({ ok: true, data: { received: true, event, deliveryId, action } });
  });

  return app;
}
```

### Webhook Signature Verification

Uses Web Crypto API (not Node.js `crypto` module) for portability:

```typescript
// src/lib/github/webhooks.ts
export interface VerifyWebhookOptions {
  payload: string;
  signature: string | null;
  secret: string;
}

export async function verifyWebhookSignature(
  options: VerifyWebhookOptions
): Promise<Result<true, typeof GitHubErrors.WEBHOOK_INVALID>> {
  const { payload, signature, secret } = options;

  if (!signature) return err(GitHubErrors.WEBHOOK_INVALID);
  if (!secret) {
    // Skip verification in development mode
    console.warn('[GitHub Webhooks] No webhook secret configured, skipping verification');
    return ok(true);
  }

  const [algorithm, hash] = signature.split('=');
  if (algorithm !== 'sha256' || !hash) return err(GitHubErrors.WEBHOOK_INVALID);

  // Uses crypto.subtle.importKey + crypto.subtle.sign (Web Crypto API)
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const computedHash = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  if (computedHash !== hash) return err(GitHubErrors.WEBHOOK_INVALID);
  return ok(true);
}

// Parse webhook event from headers + body
export function parseWebhookEvent(headers: Headers, body: string): Result<WebhookEvent, Error>

// Supported event types
export type WebhookEventType =
  | 'installation' | 'installation_repositories'
  | 'push' | 'pull_request' | 'issues' | 'ping';
```

### Webhook Event Handling

Currently, webhook handling is focused on **push events for template sync**. The webhook route dispatches to `TemplateService` when a push event is received for a repository that has linked templates.

Future expansion points for additional webhook event handlers:
- `pull_request` -- Could trigger code review agents or update task status on merge
- `installation` / `installation_repositories` -- Could auto-sync installation records
- `issues` -- Could create tasks from labeled issues

---

## Pull Request Management

> **Status: Not yet implemented.** PR management operations (create, merge, get status, comment) are defined in the error catalog (`PR_CREATION_FAILED`) but no PR service exists in the codebase yet.

When implemented, PR operations should use `GitHubTokenService.getOctokit()` (PAT-based) or `getInstallationOctokit()` depending on the authentication context. The error type `GitHubErrors.PR_CREATION_FAILED` is already defined in `src/lib/errors/github-errors.ts`.

---

## Database Tables

Defined in `src/db/schema/sqlite/github.ts`. All tables use `sqliteTable` with `better-sqlite3`.

### GitHub Tokens Table

Stores encrypted GitHub PATs. Supports global tokens (`teamId` is `NULL`) and team-scoped tokens.

```typescript
export const githubTokens = sqliteTable('github_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  encryptedToken: text('encrypted_token').notNull(),       // AES-GCM encrypted, base64-encoded
  tokenType: text('token_type').notNull().default('pat'),  // 'pat' | 'oauth'
  scopes: text('scopes'),                                  // Comma-separated scopes
  githubLogin: text('github_login'),                       // From GitHub API validation
  githubId: text('github_id'),                             // From GitHub API validation
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  isValid: integer('is_valid', { mode: 'boolean' }).default(true),
  lastValidatedAt: text('last_validated_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

### GitHub Installations Table

Tracks GitHub App installations.

```typescript
export const githubInstallations = sqliteTable('github_installations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  installationId: text('installation_id').notNull().unique(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),
  status: text('status').default('active').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

### Repository Configs Table

Links installations to specific repositories with optional JSON config.

```typescript
export const repositoryConfigs = sqliteTable('repository_configs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  installationId: text('installation_id').notNull()
    .references(() => githubInstallations.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>(),
  syncedAt: text('synced_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});
```

**Key differences from PostgreSQL-style schemas:**
- Uses `sqliteTable` (not `pgTable`)
- Uses `text` with `sql\`(datetime('now'))\`` for timestamps (not `timestamp().defaultNow()`)
- Uses `integer('...', { mode: 'boolean' })` for booleans (SQLite stores 0/1)
- Uses `text('...', { mode: 'json' })` for JSON columns (not `jsonb`)
- No enum types -- uses plain `text` columns with string values
- IDs generated via `@paralleldrive/cuid2`

---

## API Endpoints Summary

### Authentication (Hono: `src/server/routes/auth.ts`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/github` | GET | Start GitHub OAuth flow (redirect) |
| `/api/auth/github/callback` | GET | OAuth callback handler (code exchange, user upsert, session creation) |
| `/api/auth/logout` | POST | End session (delete from DB, clear cookie) |

### GitHub Operations (Hono: `src/server/routes/github.ts`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/github/orgs` | GET | List user's organizations |
| `/api/github/repos` | GET | List authenticated user's repositories |
| `/api/github/repos/:owner` | GET | List repos for a specific owner |
| `/api/github/clone` | POST | Clone a repository to local disk |
| `/api/github/create-from-template` | POST | Create repo from template + clone |
| `/api/github/token` | GET | Get saved token info (masked) |
| `/api/github/token` | POST | Save a new GitHub PAT |
| `/api/github/token` | DELETE | Delete saved token |
| `/api/github/revalidate` | POST | Re-validate saved token with GitHub API |

### Team GitHub Token (Hono: `src/server/routes/team-github-token.ts`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/teams/:id/github-token` | GET | Get team's token info (admin only) |
| `/api/teams/:id/github-token` | PUT | Set/replace team's token (admin only) |
| `/api/teams/:id/github-token` | DELETE | Remove team's token (admin only) |
| `/api/teams/:id/github-token/validate` | POST | Re-validate team's token (admin only) |

### Webhooks (Hono: `src/server/routes/webhooks.ts`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/webhooks/github` | POST | GitHub webhook handler (push events for template sync) |

---

## Rate Limiting

### GitHub API Rate Limits

| Resource | Limit | Reset |
|----------|-------|-------|
| REST API (Installation) | 5,000/hour | Hourly |
| REST API (User) | 5,000/hour | Hourly |
| Search API | 30/minute | Per minute |
| GraphQL API | 5,000 points/hour | Hourly |

### Rate Limit Handling

Implemented in `src/lib/github/rate-limit.ts`:

```typescript
// src/lib/github/rate-limit.ts

export interface RateLimitStatus {
  core: RateLimitInfo;
  search: RateLimitInfo;
  graphql: RateLimitInfo;
}

// Get full rate limit status across all resource types
export async function getRateLimitStatus(octokit: Octokit): Promise<Result<RateLimitStatus, Error>>

// Check if rate limit is critically low (< 10 remaining)
export function checkRateLimit(status: RateLimitStatus): Result<void, ...>

// Retry wrapper with automatic rate limit backoff (up to 60s wait, 3 retries)
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; onRateLimited?: (resetAt: Date) => void }
): Promise<T>
```

The team-github-token routes also handle rate limiting gracefully during validation: if a 429 is returned, the previous validation state is preserved rather than marking the token as invalid.

---

## Error Codes

Defined in `src/lib/errors/github-errors.ts`:

| Error Code | HTTP | Description |
|------------|------|-------------|
| `GITHUB_AUTH_FAILED` | 401 | GitHub authentication failed |
| `GITHUB_INSTALLATION_NOT_FOUND` | 404 | GitHub App installation not found |
| `GITHUB_REPO_NOT_FOUND` | 404 | Repository not found |
| `GITHUB_CONFIG_NOT_FOUND` | 404 | Configuration file not found at path |
| `GITHUB_CONFIG_INVALID` | 400 | Invalid configuration format |
| `GITHUB_WEBHOOK_INVALID` | 401 | Invalid webhook signature |
| `GITHUB_RATE_LIMITED` | 429 | GitHub API rate limit exceeded |
| `GITHUB_PR_CREATION_FAILED` | 500 | Failed to create pull request |

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `src/server/routes/auth.ts` | GitHub OAuth login/callback/logout (Hono) |
| `src/server/routes/github.ts` | GitHub API routes: orgs, repos, tokens, clone (Hono) |
| `src/server/routes/team-github-token.ts` | Team-scoped PAT management with RBAC (Hono) |
| `src/server/routes/webhooks.ts` | Webhook handler for push events (Hono) |
| `src/services/github-token.service.ts` | Global PAT management and GitHub API operations |
| `src/services/rbac.service.ts` | Role-based access control for team operations |
| `src/lib/github/client.ts` | Octokit factory utilities |
| `src/lib/github/webhooks.ts` | Webhook signature verification (Web Crypto API) |
| `src/lib/github/config-sync.ts` | Repository config sync from GitHub |
| `src/lib/github/rate-limit.ts` | Rate limit checking and retry logic |
| `src/lib/errors/github-errors.ts` | GitHub-specific error types |
| `src/lib/crypto/server-encryption.ts` | AES-GCM token encryption/decryption |
| `src/db/schema/sqlite/github.ts` | SQLite schema (githubTokens, githubInstallations, repositoryConfigs) |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../database/schema.md) | GitHub tables definition |
| [Error Catalog](../errors/error-catalog.md) | GitHub error codes |
| [User Stories](../user-stories.md) | Config sync requirements |
| [Git Worktrees](./git-worktrees.md) | Branch/PR integration |
| [Test Cases](../testing/test-cases.md) | GitHub integration tests |
