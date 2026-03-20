/**
 * Terraform Sync Scheduler Service
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
  return error instanceof Error ? error.message : String(error);
}

type SchedulerState = {
  intervalId: ReturnType<typeof setInterval> | null;
  isRunning: boolean;
  lastCheckAt: string | null;
  syncInProgress: Set<string>;
};

const state: SchedulerState = {
  intervalId: null,
  isRunning: false,
  lastCheckAt: null,
  syncInProgress: new Set(),
};

/**
 * Calculate the next sync time based on an interval in minutes
 */
export function calculateNextSyncAt(intervalMinutes: number): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() + intervalMinutes);
  return now.toISOString();
}

/**
 * Check for registries due for sync and trigger sync process
 */
async function checkAndSyncRegistries(
  db: Database,
  registryService: TerraformRegistryService
): Promise<{ synced: number; errors: number }> {
  const now = new Date().toISOString();
  let synced = 0;
  let errors = 0;

  try {
    // Find registries where:
    // - syncIntervalMinutes is set (auto-sync enabled)
    // - nextSyncAt is in the past or now
    // Note: status='syncing' check happens in the loop below
    const dueRegistries = await db.query.terraformRegistries.findMany({
      where: and(
        isNotNull(terraformRegistries.syncIntervalMinutes),
        isNotNull(terraformRegistries.nextSyncAt),
        lte(terraformRegistries.nextSyncAt, now)
      ),
    });

    for (const registry of dueRegistries) {
      // Skip if already syncing this registry
      if (state.syncInProgress.has(registry.id)) {
        log.info(`Skipping ${registry.name} - sync already in progress`);
        continue;
      }

      // Skip if registry is currently in syncing state
      if (registry.status === 'syncing') {
        log.info(`Skipping ${registry.name} - status is syncing`);
        continue;
      }

      try {
        state.syncInProgress.add(registry.id);
        log.info(`Starting scheduled sync for: ${registry.name}`);

        const result = await registryService.sync(registry.id);

        if (result.ok) {
          synced++;
          log.info(`Successfully synced ${registry.name}: ${result.value.moduleCount} modules`);
        } else {
          errors++;
          log.error(`Failed to sync ${registry.name}: ${result.error.message}`);
        }

        // Update nextSyncAt for next scheduled sync regardless of sync result
        // This is the single source of truth for scheduling — the registry service does not set nextSyncAt
        if (registry.syncIntervalMinutes) {
          try {
            const nextSyncAt = calculateNextSyncAt(registry.syncIntervalMinutes);
            await db
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
        state.syncInProgress.delete(registry.id);
      }
    }
  } catch (error) {
    log.error(`Error checking registries: ${getErrorMessage(error)}`);
  }

  state.lastCheckAt = now;
  return { synced, errors };
}

/**
 * Start the Terraform sync scheduler
 *
 * Initializes a background interval that periodically checks for registries
 * due for sync and triggers the sync process.
 *
 * @param db - Database instance
 * @param registryService - Terraform registry service instance for syncing
 * @returns Cleanup function to stop the scheduler
 */
export function startTerraformSyncScheduler(
  db: Database,
  registryService: TerraformRegistryService
): () => void {
  if (state.isRunning) {
    log.warn('Scheduler already running');
    return () => stopTerraformSyncScheduler();
  }

  log.info('Starting scheduler');
  state.isRunning = true;

  // Run immediately on start
  checkAndSyncRegistries(db, registryService)
    .then(({ synced, errors }) => {
      if (synced > 0 || errors > 0) {
        log.info(`Initial check: ${synced} synced, ${errors} errors`);
      }
    })
    .catch((error) => {
      log.error(`Critical error during startup sync: ${getErrorMessage(error)}`);
    });

  // Set up periodic checking
  state.intervalId = setInterval(async () => {
    try {
      const { synced, errors } = await checkAndSyncRegistries(db, registryService);
      if (synced > 0 || errors > 0) {
        log.info(`Periodic check: ${synced} synced, ${errors} errors`);
      }
    } catch (error) {
      log.error(`Error during periodic check: ${getErrorMessage(error)}`);
    }
  }, SCHEDULER_INTERVAL_MS);

  return () => stopTerraformSyncScheduler();
}

/**
 * Stop the Terraform sync scheduler
 *
 * Cleans up the background interval and resets state.
 */
export function stopTerraformSyncScheduler(): void {
  if (!state.isRunning) {
    return;
  }

  log.info('Stopping scheduler');

  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }

  state.isRunning = false;
  state.syncInProgress.clear();
}

/**
 * Get the current scheduler state (for debugging/monitoring)
 */
export function getTerraformSchedulerState(): Readonly<{
  isRunning: boolean;
  lastCheckAt: string | null;
  syncInProgressCount: number;
}> {
  return {
    isRunning: state.isRunning,
    lastCheckAt: state.lastCheckAt,
    syncInProgressCount: state.syncInProgress.size,
  };
}
