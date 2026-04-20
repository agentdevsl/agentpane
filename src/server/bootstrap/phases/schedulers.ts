/**
 * Schedulers Bootstrap Phase
 *
 * Starts template sync, Terraform sync, and task schedulers.
 * Registers cleanup functions directly with the shutdown handler.
 */

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
  shutdown: GracefulShutdown
): Promise<BootstrapPhaseResult> {
  // Template sync scheduler
  const stopTemplateSync = startSyncScheduler(db, services.templateService);
  shutdown.register('templateSyncScheduler', stopTemplateSync);
  log.info('Template sync scheduler started');

  // Terraform sync scheduler
  const stopTerraformSync = startTerraformSyncScheduler(db, services.terraformRegistryService);
  shutdown.register('terraformSyncScheduler', stopTerraformSync);
  log.info('Terraform sync scheduler started');

  // Event cleanup scheduler
  const eventCleanup = new EventCleanupService(db, services.settingsService);
  const stopEventCleanup = eventCleanup.start();
  shutdown.register('eventCleanupScheduler', stopEventCleanup);
  log.info('Event cleanup scheduler started');

  // Dream scheduler (skill improvement via Claude analysis)
  if (services.dreamService) {
    const stopDreamScheduler = startDreamScheduler(services.dreamService, services.settingsService);
    shutdown.register('dreamScheduler', stopDreamScheduler);
    log.info('Dream scheduler started');
  }

  // Task scheduler
  try {
    await services.schedulerService.start();
    shutdown.register('taskScheduler', () => services.schedulerService.stop());
    log.info('Task scheduler started');
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to start scheduler', { error });
    // Non-fatal in non-production: the server is still useful for UI/API work
    // even if background scheduling is degraded. Operators see the log.
    const fatal = process.env.NODE_ENV === 'production';
    return { ok: false, fatal, error };
  }

  return { ok: true };
}
