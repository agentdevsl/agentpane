/**
 * Server Bootstrap (CB-001)
 *
 * Phase-based server initialization pipeline.
 * Orchestrates all bootstrap phases in correct order.
 */

import { createLogger } from '../../lib/logging/logger.js';
import { resolveApiKey } from './phases/api-key-resolution.js';
import { tryInitializeDatabase } from './phases/database.js';
import { runRecovery } from './phases/recovery.js';
import { createAppRouter } from './phases/router.js';
import { startSchedulers } from './phases/schedulers.js';
import { createServiceContainer } from './phases/services.js';
import { initSandboxProvider } from './sandbox/sandbox-init.js';
import { parseServerConfig } from './server-config.js';
import { GracefulShutdown } from './shutdown.js';
import type { BootstrapPhaseResult, SandboxState } from './types.js';

declare const Bun: {
  serve: (options: {
    port: number;
    fetch: (req: Request) => Response | Promise<Response>;
    idleTimeout?: number;
  }) => void;
};

const log = createLogger('Bootstrap');

/**
 * Apply a {@link BootstrapPhaseResult}: fatal failures exit the process,
 * non-fatal failures are logged and the bootstrap continues (F01-05).
 */
function applyPhaseResult(phase: string, result: BootstrapPhaseResult): void {
  if (result.ok) return;
  if (result.fatal) {
    log.error(`Bootstrap phase '${phase}' failed (fatal)`, { error: result.error });
    process.exit(1);
  }
  log.warn(`Bootstrap phase '${phase}' failed (non-fatal, continuing)`, {
    error: result.error,
  });
}

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

  // Phase 2: Database (F01-05: fatal if fails; exit via applyPhaseResult)
  const { result: dbResult, database } = await tryInitializeDatabase(config);
  applyPhaseResult('database', dbResult);
  if (!database) {
    // Should be unreachable: applyPhaseResult exits on fatal failure. Guard for
    // the type narrower and for any future non-fatal DB policy.
    throw new Error('Bootstrap: database initialization returned no database');
  }

  // Phase 3: Recovery
  const recovery = await runRecovery(database.db);
  if (recovery.errors.length > 0) {
    log.warn(`Recovery completed with ${recovery.errors.length} error(s)`, {
      data: { errors: recovery.errors.map((e) => e.message) },
    });
  }

  // Phase 4: Services
  const services = createServiceContainer(database.db, config);

  // Start orphaned agent sweep (safety net for agents that crash without cleanup)
  services.agentService.startOrphanSweep();

  // Phase 4.5: Memory service initialization (always available — backed by local SQLite)
  await services.memoryService.initialize();

  // Phase 5: API Key Resolution (F01-05)
  applyPhaseResult('api-key-resolution', await resolveApiKey(services.apiKeyService));

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
    reconciled: false,
  };

  const isDev = process.env.NODE_ENV === 'development';

  const getSandboxProvider = () => {
    // In dev mode, trigger lazy re-init if provider is null and no retry/init is pending
    if (!sandboxState.provider && isDev && !sandboxState.retryTimer && !sandboxState.initializing) {
      sandboxState.initializing = true;
      // Trigger async retry - will be picked up on next call
      initSandboxProvider(
        database.db,
        services,
        sandboxState,
        config.sandboxInitTimeoutMs,
        config.dbMode
      )
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

  // F01-03: readiness gate for `/api/health`. The sandbox provider init
  // runs in the background (Phase 11) and sandbox reconciliation follows
  // it; health is "initializing" until both complete.
  const isSandboxReady = () => sandboxState.provider !== null && sandboxState.reconciled;

  // Phase 7: Router
  const app = createAppRouter(
    database.db,
    services,
    getSandboxProvider,
    getK8sProvider,
    getNomadProvider,
    isSandboxReady
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

  shutdown.register('agentOrphanSweep', () => {
    services.agentService.stopOrphanSweep();
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

  // Phase 10: Schedulers (registers own cleanups; F01-05 applies)
  applyPhaseResult('schedulers', await startSchedulers(database.db, services, shutdown));

  // Phase 11: Sandbox provider (background, non-blocking).
  // initSandboxProvider handles both the initial attempt and retry scheduling,
  // and — on any successful init (initial or retry) — runs the F01-01
  // reconciliation phase inline before flipping `sandboxState.reconciled`.
  // The outer `.then()` is kept purely as a safety net: if the provider is
  // still null after the promise resolves (e.g., all retries exhausted and
  // the retry chain gave up), leave `reconciled` as-is so the readiness
  // gate correctly reports "not ready". Only flip it here if the provider
  // actually came up AND reconciliation was skipped for some reason.
  initSandboxProvider(
    database.db,
    services,
    sandboxState,
    config.sandboxInitTimeoutMs,
    config.dbMode
  )
    .then(() => {
      if (sandboxState.provider !== null && !sandboxState.reconciled) {
        // Defensive: initSandboxProvider should already have set this on
        // success. If it didn't, the provider is up but reconciliation
        // didn't run — mark ready so /health unblocks (best-effort).
        log.warn(
          'Sandbox provider initialized but reconciliation flag still false — flipping to ready'
        );
        sandboxState.reconciled = true;
      }
    })
    .catch((err) => {
      log.error('Sandbox provider initialization failed:', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
