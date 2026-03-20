/**
 * Schedulers Bootstrap Phase
 *
 * Starts template sync, Terraform sync, and task schedulers.
 * Returns cleanup functions for graceful shutdown.
 */

import { createLogger } from '../../../lib/logging/logger.js';
import { startSyncScheduler } from '../../../services/template-sync-scheduler.js';
import { startTerraformSyncScheduler } from '../../../services/terraform-sync-scheduler.js';
import type { Database } from '../../../types/database.js';
import type { GracefulShutdown } from '../shutdown.js';
import type { ServiceContainer } from '../types.js';

const log = createLogger('Schedulers');

/**
 * Start all schedulers and register their cleanup with the shutdown handler.
 */
export async function startSchedulers(
  db: Database,
  services: ServiceContainer,
  shutdown: GracefulShutdown
): Promise<void> {
  // Template sync scheduler
  const stopTemplateSync = startSyncScheduler(db, services.templateService);
  shutdown.register('templateSyncScheduler', stopTemplateSync);
  log.info('Template sync scheduler started');

  // Terraform sync scheduler
  const stopTerraformSync = startTerraformSyncScheduler(db, services.terraformRegistryService);
  shutdown.register('terraformSyncScheduler', stopTerraformSync);
  log.info('Terraform sync scheduler started');

  // Task scheduler
  try {
    await services.schedulerService.start();
    shutdown.register('taskScheduler', () => services.schedulerService.stop());
    log.info('Task scheduler started');
  } catch (err) {
    log.error('Failed to start scheduler', { error: err });
  }
}
