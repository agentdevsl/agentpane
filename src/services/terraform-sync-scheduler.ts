/**
 * Terraform Sync Scheduler Service
 *
 * SL-012: Converted from module-level singleton to class-based service with instance state.
 *
 * Background service that periodically syncs Terraform modules from registries
 * based on their configured sync intervals. Runs as a background interval that
 * checks for registries due for sync and triggers the sync process.
 */
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { terraformRegistries } from '../db/schema';
import { createLogger } from '../lib/logging/logger.js';
import type { Database } from '../types/database.js';
import type { TerraformRegistryService } from './terraform-registry.service.js';

const log = createLogger('TerraformSyncScheduler');

/** Scheduler check interval: how often to check for registries needing sync (1 minute) */
const SCHEDULER_INTERVAL_MS = 60 * 1000;

/** Minimum sync interval allowed (5 minutes) to prevent abuse */
export const MIN_SYNC_INTERVAL_MINUTES = 5;

/**
 * Extract error message from unknown error type
 */
function getErrorMessage(error: unknown): string {
  return errorMessage(error);
}

/**
 * Calculate the next sync time based on an interval in minutes
 */
export function calculateNextSyncAt(intervalMinutes: number): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() + intervalMinutes);
  return now.toISOString();
}

/**
 * Class-based Terraform sync scheduler with instance state.
 */
export class TerraformSyncScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastCheckAt: string | null = null;
  private syncInProgress = new Set<string>();

  constructor(
    private db: Database,
    private registryService: TerraformRegistryService
  ) {}

  /**
   * Check for registries due for sync and trigger sync process
   */
  private async checkAndSyncRegistries(): Promise<{ synced: number; errors: number }> {
    const now = new Date().toISOString();
    let synced = 0;
    let errors = 0;

    try {
      const dueRegistries = await this.db.query.terraformRegistries.findMany({
        where: and(
          isNotNull(terraformRegistries.syncIntervalMinutes),
          isNotNull(terraformRegistries.nextSyncAt),
          lte(terraformRegistries.nextSyncAt, now)
        ),
      });

      for (const registry of dueRegistries) {
        if (this.syncInProgress.has(registry.id)) {
          log.info(`Skipping ${registry.name} - sync already in progress`);
          continue;
        }

        if (registry.status === 'syncing') {
          log.info(`Skipping ${registry.name} - status is syncing`);
          continue;
        }

        try {
          this.syncInProgress.add(registry.id);
          log.info(`Starting scheduled sync for: ${registry.name}`);

          const result = await this.registryService.sync(registry.id);

          if (result.ok) {
            synced++;
            log.info(`Successfully synced ${registry.name}: ${result.value.moduleCount} modules`);
          } else {
            errors++;
            log.error(`Failed to sync ${registry.name}: ${result.error.message}`);
          }

          if (registry.syncIntervalMinutes) {
            try {
              const nextSyncAt = calculateNextSyncAt(registry.syncIntervalMinutes);
              await this.db
                .update(terraformRegistries)
                .set({ nextSyncAt })
                .where(eq(terraformRegistries.id, registry.id));
            } catch (updateError) {
              log.error(
                `Failed to update nextSyncAt for ${registry.name}: ${getErrorMessage(updateError)}`
              );
            }
          }
        } catch (error) {
          errors++;
          log.error(`Error syncing ${registry.name}: ${getErrorMessage(error)}`);
        } finally {
          this.syncInProgress.delete(registry.id);
        }
      }
    } catch (error) {
      log.error(`Error checking registries: ${getErrorMessage(error)}`);
    }

    this.lastCheckAt = now;
    return { synced, errors };
  }

  /**
   * Start the scheduler
   */
  start(): () => void {
    if (this.isRunning) {
      log.warn('Scheduler already running');
      return () => this.stop();
    }

    log.info('Starting scheduler');
    this.isRunning = true;

    // Run immediately on start
    this.checkAndSyncRegistries()
      .then(({ synced, errors }) => {
        if (synced > 0 || errors > 0) {
          log.info(`Initial check: ${synced} synced, ${errors} errors`);
        }
      })
      .catch((error) => {
        log.error(`Critical error during startup sync: ${getErrorMessage(error)}`);
      });

    // Set up periodic checking
    this.intervalId = setInterval(async () => {
      try {
        const { synced, errors } = await this.checkAndSyncRegistries();
        if (synced > 0 || errors > 0) {
          log.info(`Periodic check: ${synced} synced, ${errors} errors`);
        }
      } catch (error) {
        log.error(`Error during periodic check: ${getErrorMessage(error)}`);
      }
    }, SCHEDULER_INTERVAL_MS);

    return () => this.stop();
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    log.info('Stopping scheduler');

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;
    this.syncInProgress.clear();
  }

  /**
   * Get the current scheduler state (for debugging/monitoring)
   */
  getState(): Readonly<{
    isRunning: boolean;
    lastCheckAt: string | null;
    syncInProgressCount: number;
  }> {
    return {
      isRunning: this.isRunning,
      lastCheckAt: this.lastCheckAt,
      syncInProgressCount: this.syncInProgress.size,
    };
  }
}

// Backward-compatible module-level API that delegates to a lazily-created instance

let _instance: TerraformSyncScheduler | null = null;

export function startTerraformSyncScheduler(
  db: Database,
  registryService: TerraformRegistryService
): () => void {
  if (_instance) {
    return _instance.start();
  }
  _instance = new TerraformSyncScheduler(db, registryService);
  return _instance.start();
}

export function stopTerraformSyncScheduler(): void {
  _instance?.stop();
  _instance = null;
}

export function getTerraformSchedulerState(): Readonly<{
  isRunning: boolean;
  lastCheckAt: string | null;
  syncInProgressCount: number;
}> {
  if (!_instance) {
    return { isRunning: false, lastCheckAt: null, syncInProgressCount: 0 };
  }
  return _instance.getState();
}
