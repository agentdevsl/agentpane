/**
 * Server Bootstrap (CB-001)
 *
 * Phase-based server initialization pipeline.
 * Orchestrates all bootstrap phases in correct order.
 */

import { createLogger } from '../../lib/logging/logger.js';
import { resolveApiKey } from './phases/api-key-resolution.js';
import { initializeDatabase } from './phases/database.js';
import { runRecovery } from './phases/recovery.js';
import { createAppRouter } from './phases/router.js';
import { startSchedulers } from './phases/schedulers.js';
import { createServiceContainer } from './phases/services.js';
import { initSandboxProvider } from './sandbox/sandbox-init.js';
import { parseServerConfig } from './server-config.js';
import { GracefulShutdown } from './shutdown.js';
import type { SandboxState } from './types.js';

declare const Bun: {
  serve: (options: {
    port: number;
    fetch: (req: Request) => Response | Promise<Response>;
    idleTimeout?: number;
  }) => void;
};

const log = createLogger('Bootstrap');

/**
 * Run the complete server bootstrap pipeline.
 *
 * Phases:
 * 1. Parse and validate configuration
 * 2. Initialize database (SQLite/PostgreSQL)
 * 3. Run recovery (reset stale agents, orphaned tasks, worktrees)
 * 4. Construct services
 * 5. Resolve Anthropic API key
 * 6. Create Hono router
 * 7. Start Bun.serve()
 * 8. Start schedulers
 * 9. Initialize sandbox provider (background, non-blocking)
 * 10. Register graceful shutdown handlers
 */
export async function run(): Promise<void> {
  // Phase 1: Configuration
  const config = parseServerConfig();

  // Phase 2: Database
  const database = await initializeDatabase(config);

  // Phase 3: Recovery
  const recovery = await runRecovery(database.db);
  if (recovery.errors.length > 0) {
    log.warn(`Recovery completed with ${recovery.errors.length} error(s)`, {
      data: { errors: recovery.errors.map((e) => e.message) },
    });
  }

  // Phase 4: Services
  const services = createServiceContainer(database.db, config);

  // Phase 4.5: Memory service initialization (always available — backed by local SQLite)
  await services.memoryService.initialize();

  // Phase 5: API Key Resolution
  await resolveApiKey(services.apiKeyService);

  // Phase 6: Sandbox state (mutable, shared across runtime)
  const sandboxState: SandboxState = {
    provider: null,
    containerAgentService: null,
    k8sProvider: null,
    nomadProvider: null,
    controller: null,
    k8sHealInterval: null,
    nomadHealInterval: null,
    retryTimer: null,
    retryCount: 0,
    initializing: false,
  };

  const isDev = process.env.NODE_ENV === 'development';

  const getSandboxProvider = () => {
    // In dev mode, trigger lazy re-init if provider is null and no retry/init is pending
    if (!sandboxState.provider && isDev && !sandboxState.retryTimer && !sandboxState.initializing) {
      sandboxState.initializing = true;
      // Trigger async retry - will be picked up on next call
      initSandboxProvider(database.db, services, sandboxState, config.sandboxInitTimeoutMs)
        .finally(() => {
          sandboxState.initializing = false;
        })
        .catch((err) => {
          log.warn('Lazy sandbox re-init failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
    return sandboxState.provider;
  };

  const getK8sProvider = () => sandboxState.k8sProvider;
  const getNomadProvider = () => sandboxState.nomadProvider;

  // Phase 7: Router
  const app = createAppRouter(
    database.db,
    services,
    getSandboxProvider,
    getK8sProvider,
    getNomadProvider
  );

  // Phase 8: Start server
  Bun.serve({
    port: config.port,
    fetch: app.fetch,
    idleTimeout: 0, // Disable idle timeout for long-lived SSE connections
  });
  log.info(`Server running on http://localhost:${config.port}`);

  // Phase 9: Graceful Shutdown
  const shutdown = new GracefulShutdown();

  // Register cleanups in dependency order (LIFO: last registered runs first)
  // Database closes last, server stops first
  shutdown.register('database', async () => {
    if (database.pgClient) {
      try {
        await database.pgClient.end();
        log.info('Database closed');
      } catch (dbErr) {
        log.warn('Failed to close database', { error: dbErr });
      }
    } else if (database.sqlite) {
      try {
        database.sqlite.close();
        log.info('Database closed');
      } catch (dbErr) {
        log.warn('Failed to close database', { error: dbErr });
      }
    }
  });

  shutdown.register('sessionService', () => {
    services.sessionService.destroy();
  });

  shutdown.register('cliMonitorService', () => {
    services.cliMonitorService.destroy();
  });

  shutdown.register('taskCreationService', () => {
    services.taskCreationService.destroy();
  });

  shutdown.register('sandboxController', () => {
    sandboxState.controller?.stop();
  });

  shutdown.register('sandboxRetryTimer', () => {
    if (sandboxState.retryTimer) {
      clearTimeout(sandboxState.retryTimer);
      sandboxState.retryTimer = null;
    }
  });

  shutdown.register('k8sHealInterval', () => {
    if (sandboxState.k8sHealInterval) {
      clearInterval(sandboxState.k8sHealInterval);
      sandboxState.k8sHealInterval = null;
    }
  });

  shutdown.register('nomadHealInterval', () => {
    if (sandboxState.nomadHealInterval) {
      clearInterval(sandboxState.nomadHealInterval);
      sandboxState.nomadHealInterval = null;
    }
  });

  shutdown.register('containerAgentService', async () => {
    if (sandboxState.containerAgentService) {
      const running = sandboxState.containerAgentService.getRunningAgents();
      const stopPromises = running.map((agent) =>
        sandboxState.containerAgentService?.stopAgent(agent.taskId).catch((stopErr) => {
          log.warn('Failed to stop agent during shutdown', {
            data: { taskId: agent.taskId, error: String(stopErr) },
          });
        })
      );
      await Promise.allSettled(stopPromises);
      sandboxState.containerAgentService.dispose();
    }
  });

  shutdown.installSignalHandlers();

  // Phase 10: Schedulers (registers own cleanups)
  await startSchedulers(database.db, services, shutdown);

  // Phase 11: Sandbox provider (background, non-blocking)
  initSandboxProvider(database.db, services, sandboxState, config.sandboxInitTimeoutMs).catch(
    (err) => {
      log.error('Sandbox provider initialization failed:', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  );
}
