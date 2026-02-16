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
  projectId: string;
  containerId: string;
  status: string;
}

interface SandboxProvider {
  list: () => Promise<SandboxInfo[]>;
}

interface HealthDeps {
  db: Database;
  githubService: GitHubTokenService;
  getSandboxProvider?: () => SandboxProvider | null;
}

export function createHealthRoutes({ db, githubService, getSandboxProvider }: HealthDeps) {
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
    } = {
      database: { status: 'error' },
      github: { status: 'not_configured' },
      sandbox: { status: 'not_configured' },
    };

    // Check database connectivity
    try {
      const dbStart = Date.now();
      const result = await db.query.projects.findFirst();
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
      } catch (versionErr) {
        console.debug(
          '[Health] Version query failed:',
          versionErr instanceof Error ? versionErr.message : String(versionErr)
        );
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
        console.debug('[Health] GitHub token error:', tokenResult.error.message);
      }
    } catch (error) {
      checks.github = { status: 'error' };
      console.debug(
        '[Health] GitHub token check failed:',
        error instanceof Error ? error.message : 'Unknown error'
      );
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

  return app;
}
