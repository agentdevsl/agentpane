/**
 * Template Sync Scheduler Service
 *
 * SL-012: Converted from module-level singleton to class-based service with instance state.
 *
 * Background service that periodically syncs templates from GitHub based on their
 * configured sync intervals. Runs as a background interval that checks for templates
 * due for sync and triggers the sync process.
 */
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { templates } from '../db/schema';
import type { Database } from '../types/database.js';
import type { TemplateService } from './template.service.js';

/** Scheduler check interval: how often to check for templates needing sync (1 minute) */
const SCHEDULER_INTERVAL_MS = 60 * 1000;

/** Minimum sync interval allowed (5 minutes) to prevent abuse */
export const MIN_SYNC_INTERVAL_MINUTES = 5;

/**
 * Extract error message from unknown error type
 */
function _getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 * Validate sync interval value
 * Must be >= 5 minutes or null (disabled)
 */
export function validateSyncInterval(interval: number | null | undefined): boolean {
  if (interval === null || interval === undefined) {
    return true; // Disabled is valid
  }
  return typeof interval === 'number' && interval >= MIN_SYNC_INTERVAL_MINUTES;
}

/**
 * Class-based template sync scheduler with instance state.
 */
export class TemplateSyncScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastCheckAt: string | null = null;
  private syncInProgress = new Set<string>();

  constructor(
    private db: Database,
    private templateService: TemplateService
  ) {}

  /**
   * Check for templates due for sync and trigger sync process
   */
  private async checkAndSyncTemplates(): Promise<{ synced: number; errors: number }> {
    const now = new Date().toISOString();
    let synced = 0;
    let errors = 0;

    try {
      const dueTemplates = await this.db.query.templates.findMany({
        where: and(
          isNotNull(templates.syncIntervalMinutes),
          isNotNull(templates.nextSyncAt),
          lte(templates.nextSyncAt, now)
        ),
      });

      for (const template of dueTemplates) {
        if (this.syncInProgress.has(template.id)) {
          continue;
        }

        if (template.status === 'syncing') {
          continue;
        }

        try {
          this.syncInProgress.add(template.id);

          const result = await this.templateService.sync(template.id);

          if (result.ok) {
            synced++;
          } else {
            errors++;
          }

          if (template.syncIntervalMinutes) {
            try {
              const nextSyncAt = calculateNextSyncAt(template.syncIntervalMinutes);
              await this.db
                .update(templates)
                .set({ nextSyncAt })
                .where(eq(templates.id, template.id));
            } catch (_updateError) {}
          }
        } catch (_error) {
          errors++;
        } finally {
          this.syncInProgress.delete(template.id);
        }
      }
    } catch (_error) {}

    this.lastCheckAt = now;
    return { synced, errors };
  }

  /**
   * Start the scheduler
   */
  start(): () => void {
    if (this.isRunning) {
      return () => this.stop();
    }
    this.isRunning = true;

    // Run immediately on start
    this.checkAndSyncTemplates()
      .then(({ synced, errors }) => {
        if (synced > 0 || errors > 0) {
        }
      })
      .catch((_error) => {});

    // Set up periodic checking
    this.intervalId = setInterval(async () => {
      try {
        const { synced, errors } = await this.checkAndSyncTemplates();
        if (synced > 0 || errors > 0) {
        }
      } catch (_error) {}
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

let _instance: TemplateSyncScheduler | null = null;

export function startSyncScheduler(db: Database, templateService: TemplateService): () => void {
  if (_instance) {
    // Delegate to existing instance's start(), which handles the "already running" warning
    return _instance.start();
  }
  _instance = new TemplateSyncScheduler(db, templateService);
  return _instance.start();
}

export function stopSyncScheduler(): void {
  _instance?.stop();
  _instance = null;
}

export function getSchedulerState(): Readonly<{
  isRunning: boolean;
  lastCheckAt: string | null;
  syncInProgressCount: number;
}> {
  if (!_instance) {
    return { isRunning: false, lastCheckAt: null, syncInProgressCount: 0 };
  }
  return _instance.getState();
}
