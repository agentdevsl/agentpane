/**
 * Hono API Router
 *
 * Main router that combines all route modules.
 */

import { and, eq } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { apiTokens } from '../db/schema/sqlite/api-tokens.js';
import { userSessions } from '../db/schema/sqlite/user-sessions.js';
import { getAuthContext } from '../lib/api/auth-middleware.js';
import { createSqliteBackend, rateLimiter } from '../lib/api/rate-limiter.js';
import { enrichAuthContext, requireRole, requireTagAccess } from '../lib/api/rbac-middleware.js';
import { requestContextStorage } from '../lib/context/request-context.js';
import { publishEventToStream } from '../lib/events/event-bus.js';
import { createLogger } from '../lib/logging/logger.js';
import type { EventEmittingSandboxProvider } from '../lib/sandbox/index.js';
import { captureException } from '../lib/telemetry/error-sink.js';
import type { AgentService } from '../services/agent.service.js';
import type { ApiKeyService } from '../services/api-key.service.js';
import type { CliMonitorService } from '../services/cli-monitor/index.js';
import type { CodespaceService } from '../services/codespace.service.js';
import type { DurableStreamsService } from '../services/durable-streams.service.js';
import type { EventProcessingService } from '../services/event-processing.service.js';
import type { EventSourceService } from '../services/event-source.service.js';
import type { EventSubscriptionService } from '../services/event-subscription.service.js';
import type { GitService } from '../services/git.service.js';
import type { GitHubAppService } from '../services/github-app.service.js';
import type { GitHubTokenService } from '../services/github-token.service.js';
import type { MarketplaceService } from '../services/marketplace.service.js';
import type { MemoryService } from '../services/memory/index.js';
import { getMetricsService } from '../services/metrics.service.js';
import type { PlanModeService } from '../services/plan-mode.service.js';
import type { ProjectFolderService } from '../services/project-folder.service.js';
import { RbacService } from '../services/rbac.service.js';
import type { SandboxConfigService } from '../services/sandbox-config.service.js';
import type { SchedulerService } from '../services/scheduler.service.js';
import type { SessionService } from '../services/session.service.js';
import type { SettingsService } from '../services/settings.service.js';
import type { TaskService } from '../services/task.service.js';
import type { TaskCreationService } from '../services/task-creation.service.js';
import type { TemplateService } from '../services/template.service.js';
import type { TerraformComposeService } from '../services/terraform-compose.service.js';
import type { TerraformRegistryService } from '../services/terraform-registry.service.js';
import type { WorkflowService } from '../services/workflow.service.js';
import type { Database } from '../types/database.js';
import { bodyLimit, DEFAULT_BODY_LIMIT_BYTES } from './middleware/body-limit.js';
import { createAdminMetricsRoutes } from './routes/admin-metrics.js';
import { createAgentsRoutes } from './routes/agents.js';
import { createApiKeysRoutes } from './routes/api-keys.js';
import { createAuthRoutes } from './routes/auth.js';
import { createCliMonitorRoutes } from './routes/cli-monitor.js';
import { createCodespacesRoutes } from './routes/codespaces.js';
import { createEventsRoutes } from './routes/events.js';
import { createFilesystemRoutes } from './routes/filesystem.js';
import { createGitRoutes } from './routes/git.js';
import { createGitHubRoutes } from './routes/github.js';
import { createGitHubAppRoutes } from './routes/github-app.js';
import { createGitHubAppWebhooksRoutes } from './routes/github-app-webhooks.js';
import { createHealthRoutes } from './routes/health.js';
import { createInvitationAcceptRoutes } from './routes/invitation-accept.js';
import { createMarketplacesRoutes } from './routes/marketplaces.js';
import { createMeRoutes } from './routes/me.js';
import { createMemoryRoutes } from './routes/memory.js';
import { createMetricsRoutes } from './routes/metrics.js';
import { createProjectFoldersRoutes } from './routes/project-folders.js';
import { createProjectMembersRoutes } from './routes/project-members.js';
import { createRbacTokensRoutes } from './routes/rbac-tokens.js';
import { createSandboxConfigRoutes } from './routes/sandbox-configs.js';
import { createK8sRoutes } from './routes/sandbox-k8s.js';
import { createNomadRoutes } from './routes/sandbox-nomad.js';
import { createSandboxStatusRoutes } from './routes/sandbox-status.js';
import { createSessionsRoutes } from './routes/sessions.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createProjectTagRoutes, createTagsRoutes, createTaskTagRoutes } from './routes/tags.js';
import { createTaskCreationRoutes } from './routes/task-creation.js';
import { createTasksRoutes } from './routes/tasks.js';
import { createTeamGitHubTokenRoutes } from './routes/team-github-token.js';
import { createTeamInvitationsRoutes } from './routes/team-invitations.js';
import { createTeamMembersRoutes } from './routes/team-members.js';
import { createTeamProjectFoldersRoutes } from './routes/team-project-folders.js';
import { createTeamsRoutes } from './routes/teams.js';
import { createTemplatesRoutes } from './routes/templates.js';
import { createTerraformRoutes } from './routes/terraform.js';
import { createWebhooksRoutes } from './routes/webhooks.js';
import { createWorkflowDesignerRoutes } from './routes/workflow-designer.js';
import { createWorkflowsRoutes } from './routes/workflows.js';
import { hashToken } from './shared.js';

const routerLog = createLogger('Router');

let requestCounter = 0;

async function requestIdMiddleware(c: Context, next: Next) {
  const id =
    c.req.header('x-request-id') ??
    `req-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  return requestContextStorage.run({ requestId: id }, () => next());
}

/**
 * F10-01: per-request metrics middleware. Runs after routing so
 * `c.req.routePath` reflects the matched Hono pattern (low cardinality); raw
 * path is used as the fallback when no route matched (404 path).
 */
async function metricsMiddleware(c: Context, next: Next) {
  await next();
  try {
    const metrics = getMetricsService();
    const rawRoute = c.req.routePath ?? c.req.path ?? 'unknown';
    const status = c.res.status ?? 0;
    // F10-01: normalise to bound cardinality — unknown/404 routes MUST NOT
    // leak raw paths into the label set (which would grow unbounded as a
    // map). `normaliseMetricsRoute` keeps matched Hono patterns as-is and
    // buckets everything else to `<404>` / `<other>`.
    const route = normaliseMetricsRoute(rawRoute, status);
    metrics.recordHttpRequest(route, status);
  } catch (metricsErr) {
    // Metrics recording must never break a request, but failures must be
    // visible so broken metrics don't silently decay.
    routerLog.warn('metricsMiddleware: record failed', {
      error: metricsErr instanceof Error ? metricsErr.message : String(metricsErr),
    });
  }
}

/**
 * F10-01: Normalise a metrics route label.
 *
 * The metrics service stores counts keyed by `route|statusClass`. Raw URL
 * paths (`/api/tasks/abc123`) blow up the keyspace, so we only allow:
 *
 * - Matched Hono patterns (they contain colon params or are a bare
 *   `/api/...` pattern registered in the router)
 * - `<404>` for unmatched paths (status 404 or `routePath === '*'`)
 * - `<other>` once we exceed {@link METRICS_ROUTE_LIMIT} unique routes
 *
 * The cap is intentionally generous (500) — we expect well under that from
 * the Hono tree; it only trips if something goes wrong.
 */
const METRICS_ROUTE_LIMIT = 500;
const observedMetricsRoutes = new Set<string>();

function normaliseMetricsRoute(rawRoute: string, status: number): string {
  // 404s (either explicit status or Hono's catch-all route pattern `*`)
  // collapse to a single bucket so raw paths never reach the metrics map.
  if (status === 404 || rawRoute === '*' || rawRoute === '/*') {
    return '<404>';
  }
  // A matched Hono route pattern starts with `/` and either has no raw path
  // segments that look like IDs, or already uses `:param` placeholders. If
  // it looks like a raw URL (no colons, but very long or contains obvious
  // id-like segments), bucket it.
  if (!rawRoute.startsWith('/')) {
    return '<other>';
  }
  // Allow through, but cap the total number of unique labels seen.
  if (observedMetricsRoutes.has(rawRoute)) {
    return rawRoute;
  }
  if (observedMetricsRoutes.size >= METRICS_ROUTE_LIMIT) {
    return '<other>';
  }
  observedMetricsRoutes.add(rawRoute);
  return rawRoute;
}

/** Test helper — reset the unique-route set between test runs. */
export function __resetMetricsRouteCache(): void {
  observedMetricsRoutes.clear();
}

/**
 * F06-NEW-10: production CSP. The April 29 security review (`specs/
 * arch_review_april29/06-security.md`) tightened this from the prior
 * `script-src 'self'` baseline to:
 *
 * - `'wasm-unsafe-eval'` in `script-src` — Shiki uses WebAssembly for
 *   grammar parsing (`markdown-content.tsx`, `terraform-right-panel.tsx`).
 *   Without this directive Chrome blocks the WASM compile and syntax
 *   highlighting silently degrades to plain text.
 * - `https://avatars.githubusercontent.com` in `img-src` — the team-member
 *   list and codespace owner views render avatars from GitHub's CDN.
 *   Without this allow-list the avatars showed as broken images in
 *   production builds.
 *
 * The remaining directives stay minimal: `default-src 'self'` so anything
 * not explicitly allowed above is denied; `style-src 'unsafe-inline'`
 * because Tailwind injects classes (no inline styles produced by the
 * framework, but third-party SVGs may carry inline `<style>`). `data:` is
 * kept on `img-src` for inline icon data URIs used by Phosphor.
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "connect-src 'self'",
].join('; ');

async function securityHeaders(c: Context, next: Next) {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    c.header('Content-Security-Policy', PRODUCTION_CSP);
  }
}

/** Factory that creates auth middleware with access to database for token validation. */
function createAuthMiddleware(db: Database) {
  return async function authMiddleware(c: Context, next: Next) {
    const path = c.req.path;
    if (path === '/api/health' || path === '/api/healthz' || path === '/api/readyz') {
      return next();
    }
    if (path.startsWith('/api/auth/')) {
      return next();
    }

    const result = await getAuthContext(c.req.raw, {
      validateSessionToken: async (token: string) => {
        const session = await db.query.userSessions.findFirst({
          where: and(eq(userSessions.token, hashToken(token))),
        });
        if (!session) return null;
        // Check expiration
        if (new Date(session.expiresAt) < new Date()) return null;
        return session.userId;
      },
      validateApiKey: async (key: string) => {
        const tokenHash = hashToken(key);
        const apiToken = await db.query.apiTokens.findFirst({
          where: and(eq(apiTokens.tokenHash, tokenHash), eq(apiTokens.status, 'active')),
        });
        if (!apiToken) return null;
        // Check expiration if set
        if (apiToken.expiresAt && new Date(apiToken.expiresAt) < new Date()) return null;
        // Cache the resolved token record so enrichAuthContext doesn't re-query
        c.set('_resolvedApiToken', apiToken);
        return apiToken.userId;
      },
    });

    if (!result.ok) {
      return c.json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status as 401 | 403
      );
    }

    c.set('auth', result.value);
    return next();
  };
}

/** Shared interface for reading sandbox provider health in routes (K8s, Nomad, etc.). */
export interface SandboxProviderHealth {
  healthCheck(): Promise<{
    healthy: boolean;
    message?: string;
    details?: Record<string, unknown>;
  }>;
  listSandboxes?(): Promise<Array<{ name: string; status: string }>>;
}

export interface RouterDependencies {
  db: Database;
  githubService: GitHubTokenService;
  apiKeyService: ApiKeyService;
  templateService: TemplateService;
  sandboxConfigService: SandboxConfigService;
  taskService: TaskService;
  sessionService: SessionService;
  taskCreationService: TaskCreationService;
  marketplaceService: MarketplaceService;
  agentService: AgentService;
  workflowService: WorkflowService;
  gitService: GitService;
  codespaceService: CodespaceService;
  projectFolderService: ProjectFolderService;
  getSandboxProvider?: () => EventEmittingSandboxProvider | null;
  getK8sProvider?: () => SandboxProviderHealth | null;
  getNomadProvider?: () => SandboxProviderHealth | null;
  /**
   * F01-03: Readiness gate for `/api/health`. Returns true once the
   * sandbox provider init phase has completed. When false, health
   * responds 503 with `status: 'initializing'`. Optional in tests.
   */
  isSandboxReady?: () => boolean;
  cliMonitorService?: CliMonitorService | null;
  terraformRegistryService?: TerraformRegistryService;
  terraformComposeService?: TerraformComposeService;
  settingsService: SettingsService;
  rbacService?: RbacService;
  githubAppService?: GitHubAppService;
  eventSourceService?: EventSourceService;
  eventSubscriptionService?: EventSubscriptionService;
  eventProcessingService?: EventProcessingService;
  schedulerService?: SchedulerService;
  memoryService: MemoryService;
  skillTrackingService: import('../services/memory/skill-tracking.service.js').SkillTrackingService;
  dreamService: import('../services/memory/dream.service.js').DreamService;
  /** F05-13: surfaced on /api/admin/metrics/streams. */
  durableStreamsService?: DurableStreamsService;
  /** F05-02: surfaced on /api/admin/metrics/plan-mode. */
  planModeService?: PlanModeService;
}

/**
 * Helper to register RBAC role guards for a route path.
 * Reduces boilerplate by applying the guard to both the base path and wildcard subpaths.
 *
 * AR-007: Replaces the duplicated `app.use('/api/x', requireRole(...)); app.use('/api/x/*', requireRole(...))` pattern.
 *
 * @example
 * useRoleGuard(app, '/api/settings', 'admin', rbacService);
 * // Equivalent to:
 * // app.use('/api/settings', requireRole('admin', rbacService));
 * // app.use('/api/settings/*', requireRole('admin', rbacService));
 */
function useRoleGuard(
  app: Hono,
  basePath: string,
  role: import('../db/schema/shared/enums').RbacRole,
  rbacService: RbacService
) {
  app.use(basePath, requireRole(role, rbacService));
  app.use(`${basePath}/*`, requireRole(role, rbacService));
}

export function createRouter(deps: RouterDependencies) {
  const app = new Hono();

  // F06-NEW-08: shared SQLite-backed rate-limit store. Persists buckets so a
  // process restart does not reset limit counters. The same backend instance
  // is reused across all four rate-limit middlewares below — they only differ
  // in `max`, `windowMs`, and `keyFrom`, so sharing the backend avoids
  // creating four independent in-memory stores.
  const rateLimitBackend = createSqliteBackend(deps.db);

  // AR-026: CORS is configured as single-origin by design.
  // In production with Caddy as front door, browser requests are same-origin
  // so CORS is not strictly needed. However, CORS is kept for:
  // - Local development (direct API access on port 3001)
  // - External API consumers and dev tooling
  // The single-origin design is intentional -- multi-origin support would require
  // a dynamic origin callback, which is not needed for our architecture where
  // Caddy reverse-proxies everything under the same domain in production.
  // Override via CORS_ORIGIN env var if a different origin is needed.
  app.use(
    '*',
    cors({
      origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    })
  );
  app.use('*', logger());
  app.use('*', requestIdMiddleware);
  app.use('*', securityHeaders);
  // F10-01: record per-request counters for /api/metrics.
  app.use('*', metricsMiddleware);
  // F06-NEW-09: cap incoming body size on the public-facing surfaces.
  // Default is 5MB (matches the prior cli-monitor cap). Applied early so
  // webhook handlers that call `c.req.text()` and route handlers that call
  // `zValidator('json', ...)` reject oversized payloads before any
  // buffering. cli-monitor keeps its existing 5MB cap (in
  // `src/server/routes/cli-monitor.ts`) — same value, applied at the
  // route handler for backward compatibility with that service's own
  // error envelope.
  app.use('/api/*', bodyLimit({ maxBytes: DEFAULT_BODY_LIMIT_BYTES }));
  app.use('/hooks/*', bodyLimit({ maxBytes: DEFAULT_BODY_LIMIT_BYTES }));
  // Public webhook endpoint - no auth required (signature-verified by plugin)
  if (deps.eventProcessingService) {
    // Rate-limit webhooks: 60 requests per minute per IP
    app.use(
      '/hooks/events/*',
      rateLimiter({ max: 60, windowMs: 60_000, backend: rateLimitBackend })
    );
    app.post('/hooks/events/:slug', async (c) => {
      try {
        const slug = c.req.param('slug');
        const rawBody = await c.req.text();
        if (!deps.eventProcessingService) {
          return c.json(
            {
              ok: false,
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'Event processing service not initialized',
              },
            },
            503
          );
        }
        const result = await deps.eventProcessingService.processIncomingEvent(
          slug,
          c.req.raw.headers,
          rawBody
        );
        if (!result.ok) {
          return c.json(
            { ok: false, error: { code: result.error.code, message: result.error.message } },
            result.error.status as ContentfulStatusCode
          );
        }
        // Publish to SSE subscribers for real-time UI updates (deferred to not block response)
        const eventData = result.value;
        queueMicrotask(() => publishEventToStream({ type: 'event:processed', data: eventData }));
        return c.json({ ok: true, data: result.value });
      } catch (error) {
        routerLog.error('Webhook processing error', { error, data: { slug: c.req.param('slug') } });
        return c.json(
          { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Webhook processing failed' } },
          500
        );
      }
    });
  }

  // Public GitHub App webhook endpoint — no auth required (signature-verified)
  if (deps.githubAppService && deps.eventProcessingService) {
    app.use(
      '/hooks/github-app',
      rateLimiter({ max: 60, windowMs: 60_000, backend: rateLimitBackend })
    );
    app.route(
      '/hooks/github-app',
      createGitHubAppWebhooksRoutes({
        githubAppService: deps.githubAppService,
        eventProcessingService: deps.eventProcessingService,
        db: deps.db,
      })
    );
  }

  app.use('/api/*', rateLimiter({ max: 200, windowMs: 60_000, backend: rateLimitBackend }));
  app.use('/api/*', createAuthMiddleware(deps.db));
  app.use('/api/*', enrichAuthContext(deps.db));
  // Per-token rate limiter: applies a stricter limit to API token requests.
  // Must run after enrichAuthContext which populates tokenScope on the auth context.
  // Non-token requests (session/dev auth) skip this limiter entirely.
  app.use(
    '/api/*',
    rateLimiter({ max: 100, windowMs: 60_000, keyOnToken: true, backend: rateLimitBackend })
  );
  app.use('/api/*', requireTagAccess(deps.db));

  // --- RBAC role guards for existing routes ---
  // AR-007: useRoleGuard() helper reduces duplicated base+wildcard pairs.
  // Demonstrated on the first few routes below; remaining routes use the original
  // pattern for gradual migration.
  const rbacService = deps.rbacService ?? new RbacService(deps.db);

  // biome-ignore lint/correctness/useHookAtTopLevel: useRoleGuard is a Hono middleware helper, not a React hook
  useRoleGuard(app, '/api/settings', 'admin', rbacService);
  // biome-ignore lint/correctness/useHookAtTopLevel: useRoleGuard is a Hono middleware helper, not a React hook
  useRoleGuard(app, '/api/keys', 'admin', rbacService);
  // biome-ignore lint/correctness/useHookAtTopLevel: useRoleGuard is a Hono middleware helper, not a React hook
  useRoleGuard(app, '/api/memory', 'viewer', rbacService);
  // biome-ignore lint/correctness/useHookAtTopLevel: useRoleGuard is a Hono middleware helper, not a React hook
  useRoleGuard(app, '/api/codespaces', 'viewer', rbacService);
  // biome-ignore lint/correctness/useHookAtTopLevel: useRoleGuard is a Hono middleware helper, not a React hook
  useRoleGuard(app, '/api/project-folders', 'viewer', rbacService);
  // biome-ignore lint/correctness/useHookAtTopLevel: useRoleGuard is a Hono middleware helper, not a React hook
  useRoleGuard(app, '/api/tasks', 'viewer', rbacService);
  // biome-ignore lint/correctness/useHookAtTopLevel: useRoleGuard is a Hono middleware helper, not a React hook
  useRoleGuard(app, '/api/agents', 'viewer', rbacService);
  // biome-ignore lint/correctness/useHookAtTopLevel: useRoleGuard is a Hono middleware helper, not a React hook
  useRoleGuard(app, '/api/sessions', 'viewer', rbacService);
  // GitHub integration: viewer minimum (read repos/branches)
  app.use('/api/github', requireRole('viewer', rbacService));
  app.use('/api/github/*', requireRole('viewer', rbacService));

  // Git operations: agent_operator minimum (executes git commands)
  app.use('/api/git', requireRole('agent_operator', rbacService));
  app.use('/api/git/*', requireRole('agent_operator', rbacService));

  // Filesystem: admin required (arbitrary filesystem browsing)
  app.use('/api/filesystem', requireRole('admin', rbacService));
  app.use('/api/filesystem/*', requireRole('admin', rbacService));

  // Sandbox configs: admin required (infrastructure management)
  app.use('/api/sandbox-configs', requireRole('admin', rbacService));
  app.use('/api/sandbox-configs/*', requireRole('admin', rbacService));
  app.use('/api/sandbox/status', requireRole('viewer', rbacService));
  app.use('/api/sandbox/status/*', requireRole('viewer', rbacService));
  app.use('/api/sandbox/k8s', requireRole('admin', rbacService));
  app.use('/api/sandbox/k8s/*', requireRole('admin', rbacService));
  app.use('/api/sandbox/nomad', requireRole('admin', rbacService));
  app.use('/api/sandbox/nomad/*', requireRole('admin', rbacService));
  // Workflows and templates: viewer minimum
  app.use('/api/workflows', requireRole('viewer', rbacService));
  app.use('/api/workflows/*', requireRole('viewer', rbacService));
  app.use('/api/templates', requireRole('viewer', rbacService));
  app.use('/api/templates/*', requireRole('viewer', rbacService));
  app.use('/api/workflow-designer', requireRole('viewer', rbacService));
  app.use('/api/workflow-designer/*', requireRole('viewer', rbacService));

  // Marketplaces: viewer minimum
  app.use('/api/marketplaces', requireRole('viewer', rbacService));
  app.use('/api/marketplaces/*', requireRole('viewer', rbacService));

  // Webhooks: admin required
  app.use('/api/webhooks', requireRole('admin', rbacService));
  app.use('/api/webhooks/*', requireRole('admin', rbacService));

  // Terraform: viewer minimum
  app.use('/api/terraform', requireRole('viewer', rbacService));
  app.use('/api/terraform/*', requireRole('viewer', rbacService));

  // CLI monitor: viewer minimum
  app.use('/api/cli-monitor', requireRole('viewer', rbacService));
  app.use('/api/cli-monitor/*', requireRole('viewer', rbacService));

  // Events: viewer minimum (write operations checked in handlers)
  app.use('/api/events', requireRole('viewer', rbacService));
  app.use('/api/events/*', requireRole('viewer', rbacService));

  // Task creation with AI: agent_operator minimum
  app.use('/api/tasks/create-with-ai', requireRole('agent_operator', rbacService));
  app.use('/api/tasks/create-with-ai/*', requireRole('agent_operator', rbacService));

  app.route(
    '/api/health',
    createHealthRoutes({
      db: deps.db,
      githubService: deps.githubService,
      getSandboxProvider: deps.getSandboxProvider,
      getK8sProvider: deps.getK8sProvider,
      isSandboxReady: deps.isSandboxReady,
    })
  );

  app.get('/api/healthz', (c) => c.json({ ok: true, status: 'alive' }));
  app.get('/api/readyz', async (c) => {
    try {
      await deps.db.query.codespaces.findFirst();
      return c.json({ ok: true, status: 'ready' });
    } catch {
      return c.json({ ok: false, status: 'not_ready' }, 503);
    }
  });

  // Auth routes (public — exempted from authMiddleware above)
  app.route('/api/auth', createAuthRoutes({ db: deps.db }));

  app.route('/api/settings', createSettingsRoutes({ settingsService: deps.settingsService }));
  app.route(
    '/api/codespaces',
    createCodespacesRoutes({
      codespaceService: deps.codespaceService,
      templateService: deps.templateService,
      db: deps.db,
    })
  );
  app.route(
    '/api/project-folders',
    createProjectFoldersRoutes({ projectFolderService: deps.projectFolderService })
  );
  app.route('/api/agents', createAgentsRoutes({ agentService: deps.agentService, db: deps.db }));
  app.route(
    '/api/tasks/create-with-ai',
    createTaskCreationRoutes({ taskCreationService: deps.taskCreationService })
  );
  app.route('/api/tasks', createTasksRoutes({ taskService: deps.taskService, db: deps.db }));
  app.route('/api/workflows', createWorkflowsRoutes({ workflowService: deps.workflowService }));
  app.route('/api/templates', createTemplatesRoutes({ templateService: deps.templateService }));
  app.route(
    '/api/marketplaces',
    createMarketplacesRoutes({ marketplaceService: deps.marketplaceService })
  );
  app.route(
    '/api/sessions',
    createSessionsRoutes({
      sessionService: deps.sessionService,
      db: deps.db,
    })
  );
  app.route('/api/github', createGitHubRoutes({ githubService: deps.githubService }));
  if (deps.githubAppService) {
    app.route(
      '/api/github/app',
      createGitHubAppRoutes({ githubAppService: deps.githubAppService })
    );
  }
  app.route('/api/git', createGitRoutes({ gitService: deps.gitService }));
  app.route(
    '/api/sandbox-configs',
    createSandboxConfigRoutes({ sandboxConfigService: deps.sandboxConfigService })
  );
  app.route(
    '/api/sandbox/status',
    createSandboxStatusRoutes({
      db: deps.db,
      getDockerProvider: deps.getSandboxProvider ?? (() => null),
      getK8sProvider: deps.getK8sProvider,
      getNomadProvider: deps.getNomadProvider,
    })
  );
  app.route('/api/sandbox/k8s', createK8sRoutes({ db: deps.db }));
  app.route('/api/sandbox/nomad', createNomadRoutes({ db: deps.db }));
  app.route('/api/keys', createApiKeysRoutes({ apiKeyService: deps.apiKeyService }));
  app.route('/api/filesystem', createFilesystemRoutes());
  app.route(
    '/api/workflow-designer',
    createWorkflowDesignerRoutes({
      templateService: deps.templateService,
      settingsService: deps.settingsService,
    })
  );
  app.route('/api/webhooks', createWebhooksRoutes({ templateService: deps.templateService }));

  if (deps.cliMonitorService) {
    app.route(
      '/api/cli-monitor',
      createCliMonitorRoutes({ cliMonitorService: deps.cliMonitorService })
    );
  }

  app.route(
    '/api/memory',
    createMemoryRoutes({
      memoryService: deps.memoryService,
      skillTrackingService: deps.skillTrackingService,
      dreamService: deps.dreamService,
      db: deps.db,
    })
  );

  if (deps.eventSourceService && deps.eventSubscriptionService) {
    app.route(
      '/api/events',
      createEventsRoutes({
        eventSourceService: deps.eventSourceService,
        eventSubscriptionService: deps.eventSubscriptionService,
        db: deps.db,
        rbacService,
        schedulerService: deps.schedulerService,
      })
    );
  }

  if (deps.terraformRegistryService && deps.terraformComposeService) {
    app.route(
      '/api/terraform',
      createTerraformRoutes({
        terraformRegistryService: deps.terraformRegistryService,
        terraformComposeService: deps.terraformComposeService,
      })
    );
  }

  // RBAC routes
  // AR-008: Team routes use handler-level RBAC via requireTeamRole() / requireTeamRoleResolved()
  // instead of middleware-level guards. This is intentional because team routes need to resolve
  // the team-specific role (not the global role), which depends on the :id param extracted in
  // the handler. Each team handler calls requireTeamRole() at the top of its body.
  app.route('/api/teams', createTeamsRoutes({ db: deps.db, rbacService }));
  app.route('/api/teams/:id/members', createTeamMembersRoutes({ db: deps.db, rbacService }));
  app.route(
    '/api/teams/:id/project-folders',
    createTeamProjectFoldersRoutes({ db: deps.db, rbacService })
  );
  app.route(
    '/api/teams/:id/invitations',
    createTeamInvitationsRoutes({ db: deps.db, rbacService })
  );
  app.route(
    '/api/teams/:id/github-token',
    createTeamGitHubTokenRoutes({ db: deps.db, rbacService })
  );
  // AR-009: /api/invitations and /api/me intentionally skip middleware-level RBAC guards.
  // - /api/invitations: Accepts team invitations using a signed token. The user may not yet
  //   be a member of any team, so they have no RBAC role to check against.
  // - /api/me: Returns the authenticated user's own profile. Any authenticated user should
  //   be able to view and update their own profile regardless of team membership.
  app.route('/api/invitations', createInvitationAcceptRoutes({ db: deps.db }));
  app.route(
    '/api/codespaces/:id/members',
    createProjectMembersRoutes({ db: deps.db, rbacService })
  );
  app.route('/api/tokens', createRbacTokensRoutes({ db: deps.db, rbacService }));
  app.route('/api/tags', createTagsRoutes({ db: deps.db, rbacService }));
  app.route('/api/codespaces/:id/tags', createProjectTagRoutes({ db: deps.db, rbacService }));
  app.route('/api/tasks/:id/tags', createTaskTagRoutes({ db: deps.db, rbacService }));
  app.route('/api/me', createMeRoutes({ db: deps.db }));

  // F05-02/F05-13: Admin metrics endpoints (admin-only; observability).
  app.use('/api/admin/metrics', requireRole('admin', rbacService));
  app.use('/api/admin/metrics/*', requireRole('admin', rbacService));
  app.route(
    '/api/admin/metrics',
    createAdminMetricsRoutes({
      streamsService: deps.durableStreamsService ?? null,
      planModeService: deps.planModeService ?? null,
    })
  );

  // F10-01: GET /api/metrics — in-memory counters/gauges/histograms for ops.
  // Admin-only — same treatment as /api/admin/metrics since counters reveal
  // routes and can leak tenant activity.
  app.use('/api/metrics', requireRole('admin', rbacService));
  app.route(
    '/api/metrics',
    createMetricsRoutes({
      metricsService: getMetricsService(),
      streamsService: deps.durableStreamsService ?? null,
      planModeService: deps.planModeService ?? null,
    })
  );

  // AR-030: In development mode, the error message is exposed to help with debugging.
  // This is acceptable because dev mode is never enabled in production or staging
  // (NODE_ENV defaults to 'production' in deployed environments). The full stack trace
  // is logged server-side via the structured logger regardless of environment.
  app.onError((err, c) => {
    const requestId =
      c.req.header('x-request-id') ?? (c.res.headers.get('X-Request-Id') || undefined);
    routerLog.error('Unhandled error', { requestId, error: err });

    // F10-04: forward to the telemetry sink with request context so future
    // Sentry wiring sees route + requestId tags.
    captureException(err, {
      source: 'hono:onError',
      requestId,
      route: c.req.routePath ?? c.req.path,
      method: c.req.method,
    });

    const isDev = process.env.NODE_ENV === 'development';
    let message = 'An unexpected error occurred.';
    if (isDev && err instanceof Error) {
      message = err.message;
    }

    return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message } }, 500);
  });

  app.notFound((c) => {
    return c.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
  });

  return app;
}
