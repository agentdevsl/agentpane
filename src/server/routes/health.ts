/**
 * Health check routes
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { GitHubTokenService } from '../../services/github-token.service.js';
import type { Database, PostgresDatabase, SqliteDatabase } from '../../types/database.js';
import { json } from '../shared.js';

const DB_MODE = process.env.DB_MODE ?? 'sqlite';

interface SandboxInfo {
  id: string;
  codespaceId: string;
  containerId: string;
  status: string;
}

interface SandboxProvider {
  list: () => Promise<SandboxInfo[]>;
}

/** Minimal interface for reading K8s provider health in the health endpoint. */
interface K8sProviderHealth {
  healthCheck(): Promise<{
    healthy: boolean;
    message?: string;
    details?: Record<string, unknown>;
  }>;
}

interface HealthDeps {
  db: Database;
  githubService: GitHubTokenService;
  getSandboxProvider?: () => SandboxProvider | null;
  getK8sProvider?: () => K8sProviderHealth | null;
  /** CB-011: URL of the durable streams server for reachability checks. */
  streamsUrl?: string;
}

export function createHealthRoutes({
  db,
  githubService,
  getSandboxProvider,
  getK8sProvider,
  streamsUrl,
}: HealthDeps) {
  const app = new Hono();

  app.get('/', async (_c) => {
    const startTime = Date.now();
    const checks: {
      database: {
        status: 'ok' | 'error';
        latencyMs?: number;
        mode?: string;
        version?: string;
        error?: string;
      };
      github: { status: 'ok' | 'error' | 'not_configured'; login?: string | null };
      sandbox: {
        status: 'ok' | 'error' | 'not_configured';
        containerId?: string;
        containerCount?: number;
        error?: string;
      };
      kubernetes?: {
        status: 'ok' | 'error' | 'not_configured';
        crdRegistered?: boolean;
        namespaceExists?: boolean;
        controllerInstalled?: boolean;
        clusterVersion?: string | null;
        error?: string;
      };
      // CB-011: Extended health checks
      streams: { status: 'ok' | 'error' | 'not_configured'; error?: string };
      apiKey: { status: 'ok' | 'not_configured' };
      sandboxInit: { status: 'ok' | 'pending' | 'not_configured' };
    } = {
      database: { status: 'error' },
      github: { status: 'not_configured' },
      sandbox: { status: 'not_configured' },
      streams: { status: 'not_configured' },
      apiKey: { status: 'not_configured' },
      sandboxInit: { status: 'not_configured' },
    };

    // Check database connectivity
    try {
      const dbStart = Date.now();
      const result = await db.query.codespaces.findFirst();
      void result;

      // Query database version
      let version: string | undefined;
      try {
        if (DB_MODE === 'postgres') {
          const rows = await (db as unknown as PostgresDatabase).execute(
            sql`SELECT version() as v`
          );
          const raw = rows?.[0]?.v ?? (rows as unknown as { rows: { v: string }[] })?.rows?.[0]?.v;
          if (typeof raw === 'string') {
            // Extract "PostgreSQL X.Y" prefix from the full version string
            const match = raw.match(/^PostgreSQL\s+[\d.]+/);
            version = match ? match[0] : raw.split(',')[0];
          }
        } else {
          const rows = (db as SqliteDatabase).all<{ v: string }>(sql`SELECT sqlite_version() as v`);
          const raw = rows?.[0]?.v;
          if (typeof raw === 'string') {
            version = `SQLite ${raw}`;
          }
        }
      } catch (_versionErr) {
        // Version detection is best-effort — non-fatal
      }

      checks.database = {
        status: 'ok',
        latencyMs: Date.now() - dbStart,
        mode: DB_MODE,
        version,
      };
    } catch (error) {
      checks.database = {
        status: 'error',
        mode: DB_MODE,
        error: error instanceof Error ? error.message : 'Database query failed',
      };
    }

    // Check GitHub token status
    try {
      const tokenResult = await githubService.getTokenInfo();
      if (tokenResult.ok && tokenResult.value) {
        checks.github = {
          status: tokenResult.value.isValid ? 'ok' : 'error',
          login: tokenResult.value.githubLogin,
        };
      } else if (!tokenResult.ok) {
        checks.github = { status: 'error' };
      }
    } catch (_error) {
      checks.github = { status: 'error' };
    }

    // Check sandbox availability (uses getter for deferred initialization)
    const sandboxProvider = getSandboxProvider?.();
    if (sandboxProvider) {
      try {
        const sandboxes = await sandboxProvider.list();
        const runningSandboxes = sandboxes.filter((s) => s.status === 'running');

        const firstRunning = runningSandboxes[0];
        const firstSandbox = sandboxes[0];

        if (firstRunning) {
          checks.sandbox = {
            status: 'ok',
            containerId: firstRunning.containerId,
            containerCount: runningSandboxes.length,
          };
        } else if (firstSandbox) {
          checks.sandbox = {
            status: 'error',
            containerId: firstSandbox.containerId,
            containerCount: sandboxes.length,
            error: `No running containers (${sandboxes.length} total, status: ${firstSandbox.status})`,
          };
        } else {
          checks.sandbox = {
            status: 'ok', // No sandboxes is OK - they're created on demand
            containerCount: 0,
          };
        }
      } catch (error) {
        checks.sandbox = {
          status: 'error',
          error: error instanceof Error ? error.message : 'Sandbox check failed',
        };
      }
    }

    // Check Kubernetes provider health (when configured)
    const k8sProvider = getK8sProvider?.();
    if (k8sProvider) {
      try {
        const health = await k8sProvider.healthCheck();
        const details = health.details ?? {};
        const crdRegistered = details.crdRegistered === true;
        const namespaceExists = details.namespaceExists === true;
        const controllerInstalled =
          typeof details.controller === 'object' &&
          details.controller !== null &&
          (details.controller as { installed?: boolean }).installed === true;
        const clusterVersion =
          typeof details.clusterVersion === 'string' ? details.clusterVersion : null;

        checks.kubernetes = {
          status: health.healthy ? 'ok' : 'error',
          crdRegistered,
          namespaceExists,
          controllerInstalled,
          clusterVersion,
        };
      } catch (error) {
        checks.kubernetes = {
          status: 'error',
          error: error instanceof Error ? error.message : 'K8s health check failed',
        };
      }
    }

    // CB-011: Extended health checks — streams reachability
    if (streamsUrl) {
      try {
        const resp = await fetch(streamsUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(3000),
        });
        // Any response (even 404) means the server is reachable
        checks.streams = { status: resp.ok || resp.status === 404 ? 'ok' : 'error' };
      } catch (streamErr) {
        checks.streams = {
          status: 'error',
          error: streamErr instanceof Error ? streamErr.message : 'Streams server unreachable',
        };
      }
    }

    // CB-011: Extended health check — API key presence
    checks.apiKey = {
      status:
        process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_OAUTH_TOKEN ? 'ok' : 'not_configured',
    };

    // CB-011: Extended health check — sandbox provider initialization status
    const currentSandboxProvider = getSandboxProvider?.();
    checks.sandboxInit = {
      status: currentSandboxProvider ? 'ok' : 'pending',
    };

    const allOk = checks.database.status === 'ok';

    return json({
      ok: allOk,
      data: {
        status: allOk ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        checks,
        responseTimeMs: Date.now() - startTime,
      },
    });
  });

  // Liveness probe — confirms the process is running
  app.get('/liveness', (_c) => {
    return json({ ok: true, status: 'alive' });
  });

  // Readiness probe — confirms the service can handle requests (DB is reachable)
  app.get('/readiness', async (_c) => {
    try {
      const dbStart = Date.now();
      await db.query.codespaces.findFirst();
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

  return app;
}
