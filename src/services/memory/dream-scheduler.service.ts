/**
 * DreamScheduler — Background scheduler for periodic skill improvement analysis.
 *
 * Follows the same pattern as TemplateSyncScheduler:
 * - setInterval-based tick loop
 * - Configurable interval via settings
 * - Minimum interval enforcement
 * - Singleton instance management
 *
 * Default: runs every 24 hours when enabled.
 */

import { createLogger } from '../../lib/logging/logger.js';
import type { SettingsService } from '../settings.service.js';
import type { DreamService } from './dream.service.js';

const log = createLogger('DreamScheduler');

/** Default check interval: how often to check if a dream cycle is due (5 minutes) */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Minimum dream interval (1 hour) to prevent excessive API usage */
const MIN_DREAM_INTERVAL_HOURS = 1;

/** Default dream interval (24 hours) */
const DEFAULT_DREAM_INTERVAL_HOURS = 24;

export class DreamScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastDreamAt: string | null = null;
  private dreamInProgress = false;

  constructor(
    private dreamService: DreamService,
    private settingsService: SettingsService
  ) {}

  /**
   * Check if dreaming is enabled and a cycle is due.
   */
  private async checkAndDream(): Promise<void> {
    if (this.dreamInProgress) return;

    try {
      // Check if dreaming is enabled
      const enabledResult = await this.settingsService.get('memory.dreaming.enabled');
      if (!enabledResult.ok || !enabledResult.value) return;
      let dreamingEnabled = false;
      try {
        dreamingEnabled = JSON.parse(enabledResult.value.value) === true;
      } catch {
        dreamingEnabled = enabledResult.value.value === 'true';
      }
      if (!dreamingEnabled) return;

      // Check interval
      const intervalResult = await this.settingsService.get('memory.dreaming.intervalHours');
      let intervalHoursRaw = DEFAULT_DREAM_INTERVAL_HOURS;
      if (intervalResult.ok && intervalResult.value) {
        try {
          const parsed = JSON.parse(intervalResult.value.value);
          if (typeof parsed === 'number') intervalHoursRaw = parsed;
        } catch {
          // keep default
        }
      }
      const intervalHours = Math.max(intervalHoursRaw, MIN_DREAM_INTERVAL_HOURS);

      // Check if enough time has passed
      if (this.lastDreamAt) {
        const lastDream = new Date(this.lastDreamAt).getTime();
        const now = Date.now();
        const elapsedHours = (now - lastDream) / (1000 * 60 * 60);
        if (elapsedHours < intervalHours) return;
      }

      // Run dream cycle
      this.dreamInProgress = true;
      log.info('Starting scheduled dream cycle');

      try {
        const result = await this.dreamService.runDreamCycle();
        this.lastDreamAt = new Date().toISOString();

        if (result.ok) {
          log.info('Scheduled dream cycle completed', {
            data: {
              skillsAnalyzed: result.value.skillsAnalyzed,
              suggestionsGenerated: result.value.suggestionsGenerated,
              tokensUsed: result.value.tokensUsed,
            },
          });
        } else {
          log.warn('Scheduled dream cycle returned error', {
            data: { error: result.error },
          });
        }
      } finally {
        this.dreamInProgress = false;
      }
    } catch (error) {
      this.dreamInProgress = false;
      log.error('Dream scheduler check failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Start the scheduler.
   */
  start(): () => void {
    if (this.isRunning) {
      return () => this.stop();
    }
    this.isRunning = true;

    // Don't run immediately on start — wait for first interval
    this.intervalId = setInterval(async () => {
      try {
        await this.checkAndDream();
      } catch (_error) {
        // Swallowed — logged inside checkAndDream
      }
    }, CHECK_INTERVAL_MS);

    log.info('Dream scheduler started', {
      data: { checkIntervalMs: CHECK_INTERVAL_MS },
    });

    return () => this.stop();
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    log.info('Dream scheduler stopped');
  }
}

// --- Singleton management ---

let _instance: DreamScheduler | null = null;

/**
 * Start the dream scheduler (singleton).
 * Returns a cleanup function for graceful shutdown.
 */
export function startDreamScheduler(
  dreamService: DreamService,
  settingsService: SettingsService
): () => void {
  if (_instance) {
    return _instance.start();
  }
  _instance = new DreamScheduler(dreamService, settingsService);
  return _instance.start();
}

export function stopDreamScheduler(): void {
  _instance?.stop();
  _instance = null;
}
