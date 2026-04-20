/**
 * Schedulers Bootstrap Phase
 *
 * Starts template sync, Terraform sync, and task schedulers.
 * Registers cleanup functions directly with the shutdown handler.
 *
 * F12-04: new-style timer owners (implementing `BackgroundJob`) go through
 * the shared {@link BackgroundJobRegistry}. The registry itself is stopped
 * via a single LIFO entry on the shutdown handler, guaranteeing that a
 * failure in one job's `stop()` does not strand timers in another.
 */

import { type BackgroundJob, BackgroundJobRegistry } from '../../../lib/background/job.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { EventCleanupService } from '../../../services/event-cleanup.service.js';
import { startDreamScheduler } from '../../../services/memory/dream-scheduler.service.js';
import { startSyncScheduler } from '../../../services/template-sync-scheduler.js';
import { startTerraformSyncScheduler } from '../../../services/terraform-sync-scheduler.js';
import type { Database } from '../../../types/database.js';
import type { GracefulShutdown } from '../shutdown.js';
import type { BootstrapPhaseResult, ServiceContainer } from '../types.js';

const log = createLogger('Schedulers');

/**
 * Start all schedulers and register their cleanup with the shutdown handler.
 *
 * Returns a {@link BootstrapPhaseResult} so the orchestrator can decide
 * whether a scheduler failure should terminate the server (F01-05). The
 * task scheduler is critical in production (cron jobs for retries, etc.)
 * so it is marked fatal there; in development it logs and continues so
 * UI work isn't blocked by a flaky scheduler dependency.
 */
export async function startSchedulers(
  db: Database,
  services: ServiceContainer,
  shutdown: GracefulShutdown,
  registry: BackgroundJobRegistry = new BackgroundJobRegistry()
): Promise<BootstrapPhaseResult> {
  // Template sync scheduler (legacy — returns its own stop fn)
  const stopTemplateSync = startSyncScheduler(db, services.templateService);
  shutdown.register('templateSyncScheduler', stopTemplateSync);
  log.info('Template sync scheduler started');

  // Terraform sync scheduler (legacy — returns its own stop fn)
  const stopTerraformSync = startTerraformSyncScheduler(db, services.terraformRegistryService);
  shutdown.register('terraformSyncScheduler', stopTerraformSync);
  log.info('Terraform sync scheduler started');

  // F12-04: BackgroundJob-shaped services register with the shared registry
  // so they share a single drain path. Any individual stop() failure is
  // logged by the registry and does not prevent siblings from stopping.
  const eventCleanup = new EventCleanupService(db, services.settingsService);
  registry.register(eventCleanup satisfies BackgroundJob);

  // Dream scheduler (legacy — returns its own stop fn)
  if (services.dreamService) {
    const stopDreamScheduler = startDreamScheduler(services.dreamService, services.settingsService);
    shutdown.register('dreamScheduler', stopDreamScheduler);
    log.info('Dream scheduler started');
  }

  // Task scheduler: we still start() it explicitly so an initialisation
  // failure (schedule recovery throws) can be reported as a phase result.
  // After a successful start we register it with the registry for shutdown
  // so every BackgroundJob-shaped service flows through the same drain path.
  try {
    await services.schedulerService.start();
    registry.register(services.schedulerService satisfies BackgroundJob);
    log.info('Task scheduler started');
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to start scheduler', { error });
    // Non-fatal in non-production: the server is still useful for UI/API work
    // even if background scheduling is degraded. Operators see the log.
    const fatal = process.env.NODE_ENV === 'production';
    return { ok: false, fatal, error };
  }

  // Start remaining BackgroundJob-shaped services (scheduler was started above).
  // `startAll()` catches per-job errors so a single failure does not abort the loop.
  await registry.startAll();

  // Single LIFO-ordered drain: the registry handles per-job errors internally.
  shutdown.register('backgroundJobRegistry', () => registry.stopAll());
  log.info(`Background job registry started with ${registry.size()} job(s)`);

  return { ok: true };
}
