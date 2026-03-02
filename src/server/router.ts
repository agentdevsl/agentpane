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
import { apiTokens } from '../db/schema/sqlite/api-tokens.js';
import { userSessions } from '../db/schema/sqlite/user-sessions.js';
import { getAuthContext } from '../lib/api/auth-middleware.js';
import { rateLimiter } from '../lib/api/rate-limiter.js';
import { enrichAuthContext, requireRole, requireTagAccess } from '../lib/api/rbac-middleware.js';
import { createLogger } from '../lib/logging/logger.js';
import type { EventEmittingSandboxProvider } from '../lib/sandbox/index.js';
import type { AgentService } from '../services/agent.service.js';
import type { ApiKeyService } from '../services/api-key.service.js';
import type { CliMonitorService } from '../services/cli-monitor/index.js';
import type { EventProcessingService } from '../services/event-processing.service.js';
import type { EventSourceService } from '../services/event-source.service.js';
import type { EventSubscriptionService } from '../services/event-subscription.service.js';
import type { GitHubTokenService } from '../services/github-token.service.js';
import type { MarketplaceService } from '../services/marketplace.service.js';
import { RbacService } from '../services/rbac.service.js';
import type { SandboxConfigService } from '../services/sandbox-config.service.js';
import type { SessionService } from '../services/session.service.js';
import type { SettingsService } from '../services/settings.service.js';
import type { TaskService } from '../services/task.service.js';
import type { TaskCreationService } from '../services/task-creation.service.js';
import type { TemplateService } from '../services/template.service.js';
import type { TerraformComposeService } from '../services/terraform-compose.service.js';
import type { TerraformRegistryService } from '../services/terraform-registry.service.js';
import type { CommandRunner, WorktreeService } from '../services/worktree.service.js';
import type { Database } from '../types/database.js';
import { createAgentsRoutes } from './routes/agents.js';
import { createApiKeysRoutes } from './routes/api-keys.js';
import { createAuthRoutes } from './routes/auth.js';
import { createCliMonitorRoutes } from './routes/cli-monitor.js';
import { createEventsRoutes, publishEventToStream } from './routes/events.js';
import { createFilesystemRoutes } from './routes/filesystem.js';
import { createGitRoutes } from './routes/git.js';
import { createGitHubRoutes } from './routes/github.js';
import { createHealthRoutes } from './routes/health.js';
import { createInvitationAcceptRoutes } from './routes/invitation-accept.js';
import { createMarketplacesRoutes } from './routes/marketplaces.js';
import { createMeRoutes } from './routes/me.js';
import { createProjectMembersRoutes } from './routes/project-members.js';
import { createProjectsRoutes } from './routes/projects.js';
import { createRbacTokensRoutes } from './routes/rbac-tokens.js';
import { createK8sRoutes, createNomadRoutes, createSandboxRoutes } from './routes/sandbox.js';
import { createSandboxStatusRoutes } from './routes/sandbox-status.js';
import { createSessionsRoutes } from './routes/sessions.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createProjectTagRoutes, createTagsRoutes, createTaskTagRoutes } from './routes/tags.js';
import { createTaskCreationRoutes } from './routes/task-creation.js';
import { createTasksRoutes } from './routes/tasks.js';
import { createTeamGitHubTokenRoutes } from './routes/team-github-token.js';
import { createTeamInvitationsRoutes } from './routes/team-invitations.js';
import { createTeamMembersRoutes } from './routes/team-members.js';
import { createTeamProjectsRoutes } from './routes/team-projects.js';
import { createTeamsRoutes } from './routes/teams.js';
import { createTemplatesRoutes } from './routes/templates.js';
import { createTerraformRoutes } from './routes/terraform.js';
import { createWebhooksRoutes } from './routes/webhooks.js';
import { createWorkflowDesignerRoutes } from './routes/workflow-designer.js';
import { createWorkflowsRoutes } from './routes/workflows.js';
import { createWorktreesRoutes } from './routes/worktrees.js';
import { hashToken } from './shared.js';

const routerLog = createLogger('Router');

let requestCounter = 0;

async function requestIdMiddleware(c: Context, next: Next) {
  const id =
    c.req.header('x-request-id') ??
    `req-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  return next();
}

async function securityHeaders(c: Context, next: Next) {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
    );
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
  listSandboxes?(): Promise<Array<{ name: string; phase: string }>>;
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
  worktreeService: WorktreeService;
  marketplaceService: MarketplaceService;
  agentService: AgentService;
  commandRunner: CommandRunner;
  getSandboxProvider?: () => EventEmittingSandboxProvider | null;
  getK8sProvider?: () => SandboxProviderHealth | null;
  getNomadProvider?: () => SandboxProviderHealth | null;
  cliMonitorService?: CliMonitorService | null;
  terraformRegistryService?: TerraformRegistryService;
  terraformComposeService?: TerraformComposeService;
  settingsService?: SettingsService;
  rbacService?: RbacService;
  eventSourceService?: EventSourceService;
  eventSubscriptionService?: EventSubscriptionService;
  eventProcessingService?: EventProcessingService;
}

export function createRouter(deps: RouterDependencies) {
  const app = new Hono();

  // In production with Caddy as front door, browser requests are same-origin
  // so CORS is not strictly needed. However, CORS is kept for:
  // - Local development (direct API access on port 3001)
  // - External API consumers and dev tooling
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
  // Public webhook endpoint - no auth required (signature-verified by plugin)
  if (deps.eventProcessingService) {
    // Rate-limit webhooks: 60 requests per minute per IP
    app.use('/hooks/events/*', rateLimiter({ max: 60, windowMs: 60_000 }));
    app.post('/hooks/events/:slug', async (c) => {
      try {
        const slug = c.req.param('slug');
        const rawBody = await c.req.text();
        const result = await deps.eventProcessingService!.processIncomingEvent(
          slug,
          c.req.raw.headers,
          rawBody
        );
        if (!result.ok) {
          return c.json(
            { ok: false, error: { code: result.error.code, message: result.error.message } },
            result.error.status as any
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

  app.use('/api/*', rateLimiter({ max: 200, windowMs: 60_000 }));
  app.use('/api/*', createAuthMiddleware(deps.db));
  app.use('/api/*', enrichAuthContext(deps.db));
  // Per-token rate limiter: applies a stricter limit to API token requests.
  // Must run after enrichAuthContext which populates tokenScope on the auth context.
  // Non-token requests (session/dev auth) skip this limiter entirely.
  app.use('/api/*', rateLimiter({ max: 100, windowMs: 60_000, keyOnToken: true }));
  app.use('/api/*', requireTagAccess(deps.db));

  // --- RBAC role guards for existing routes ---
  const rbacService = deps.rbacService ?? new RbacService(deps.db);

  // Settings: admin required
  app.use('/api/settings', requireRole('admin', rbacService));
  app.use('/api/settings/*', requireRole('admin', rbacService));

  // API keys: admin required
  app.use('/api/keys', requireRole('admin', rbacService));
  app.use('/api/keys/*', requireRole('admin', rbacService));

  // Projects: viewer minimum (write operations checked in handlers)
  app.use('/api/projects', requireRole('viewer', rbacService));
  app.use('/api/projects/*', requireRole('viewer', rbacService));

  // Tasks: viewer minimum (write operations checked in handlers)
  app.use('/api/tasks', requireRole('viewer', rbacService));
  app.use('/api/tasks/*', requireRole('viewer', rbacService));

  // Agents: viewer minimum (action endpoints checked in handlers)
  app.use('/api/agents', requireRole('viewer', rbacService));
  app.use('/api/agents/*', requireRole('viewer', rbacService));

  // Sessions: viewer minimum
  app.use('/api/sessions', requireRole('viewer', rbacService));
  app.use('/api/sessions/*', requireRole('viewer', rbacService));

  // Worktrees: viewer minimum
  app.use('/api/worktrees', requireRole('viewer', rbacService));
  app.use('/api/worktrees/*', requireRole('viewer', rbacService));

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
    })
  );

  app.get('/api/healthz', (c) => c.json({ ok: true, status: 'alive' }));
  app.get('/api/readyz', async (c) => {
    try {
      await deps.db.query.projects.findFirst();
      return c.json({ ok: true, status: 'ready' });
    } catch {
      return c.json({ ok: false, status: 'not_ready' }, 503);
    }
  });

  // Auth routes (public — exempted from authMiddleware above)
  app.route('/api/auth', createAuthRoutes({ db: deps.db }));

  app.route('/api/settings', createSettingsRoutes({ db: deps.db }));
  app.route('/api/projects', createProjectsRoutes({ db: deps.db }));
  app.route('/api/agents', createAgentsRoutes({ agentService: deps.agentService }));
  app.route(
    '/api/tasks/create-with-ai',
    createTaskCreationRoutes({ taskCreationService: deps.taskCreationService })
  );
  app.route('/api/tasks', createTasksRoutes({ taskService: deps.taskService }));
  app.route('/api/workflows', createWorkflowsRoutes({ db: deps.db }));
  app.route('/api/templates', createTemplatesRoutes({ templateService: deps.templateService }));
  app.route(
    '/api/marketplaces',
    createMarketplacesRoutes({ marketplaceService: deps.marketplaceService })
  );
  app.route(
    '/api/sessions',
    createSessionsRoutes({
      sessionService: deps.sessionService,
    })
  );
  app.route('/api/worktrees', createWorktreesRoutes({ worktreeService: deps.worktreeService }));
  app.route('/api/github', createGitHubRoutes({ githubService: deps.githubService }));
  app.route('/api/git', createGitRoutes({ db: deps.db, commandRunner: deps.commandRunner }));
  app.route(
    '/api/sandbox-configs',
    createSandboxRoutes({ sandboxConfigService: deps.sandboxConfigService })
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

  if (deps.eventSourceService && deps.eventSubscriptionService) {
    app.route(
      '/api/events',
      createEventsRoutes({
        eventSourceService: deps.eventSourceService,
        eventSubscriptionService: deps.eventSubscriptionService,
        db: deps.db,
        rbacService,
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
  app.route('/api/teams', createTeamsRoutes({ db: deps.db, rbacService }));
  app.route('/api/teams/:id/members', createTeamMembersRoutes({ db: deps.db, rbacService }));
  app.route('/api/teams/:id/projects', createTeamProjectsRoutes({ db: deps.db, rbacService }));
  app.route(
    '/api/teams/:id/invitations',
    createTeamInvitationsRoutes({ db: deps.db, rbacService })
  );
  app.route(
    '/api/teams/:id/github-token',
    createTeamGitHubTokenRoutes({ db: deps.db, rbacService })
  );
  app.route('/api/invitations', createInvitationAcceptRoutes({ db: deps.db }));
  app.route('/api/projects/:id/members', createProjectMembersRoutes({ db: deps.db, rbacService }));
  app.route('/api/tokens', createRbacTokensRoutes({ db: deps.db, rbacService }));
  app.route('/api/tags', createTagsRoutes({ db: deps.db, rbacService }));
  app.route('/api/projects/:id/tags', createProjectTagRoutes({ db: deps.db, rbacService }));
  app.route('/api/tasks/:id/tags', createTaskTagRoutes({ db: deps.db, rbacService }));
  app.route('/api/me', createMeRoutes({ db: deps.db }));

  app.onError((err, c) => {
    const requestId =
      c.req.header('x-request-id') ?? (c.res.headers.get('X-Request-Id') || undefined);
    routerLog.error('Unhandled error', { requestId, error: err });

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
