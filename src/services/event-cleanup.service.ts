/**
 * Event Cleanup Service
 *
 * Background service that periodically deletes old rows from session_events
 * and event_log tables to bound storage growth. Retention periods are
 * configurable via admin settings (retention.sessionEventsDays,
 * retention.eventLogDays) and take effect without restart.
 *
 * Also performs automated SQLite database backups alongside cleanup cycles.
 * Backup behavior is configurable via admin settings (backup.enabled,
 * backup.intervalHours, backup.maxBackups).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createLogger } from '../lib/logging/logger.js';
import type { Database } from '../types/database.js';
import type { SettingsService } from './settings.service.js';

const log = createLogger('EventCleanup');

/** Default retention: session events kept for 30 days */
const DEFAULT_SESSION_EVENTS_RETENTION_DAYS = 30;

/** Default retention: event log entries kept for 90 days */
const DEFAULT_EVENT_LOG_RETENTION_DAYS = 90;

/** How often the cleanup runs (24 hours) */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Delay before the first cleanup run after startup (60 seconds) */
const INITIAL_DELAY_MS = 60 * 1000;

/** Number of rows to delete per batch to avoid long-held locks */
const BATCH_SIZE = 1000;

/** Default: backups are enabled */
const DEFAULT_BACKUP_ENABLED = true;

/** Default: backup every 24 hours (runs every cleanup cycle) */
const DEFAULT_BACKUP_INTERVAL_HOURS = 24;

/** Default: keep 7 most recent backups */
const DEFAULT_BACKUP_MAX_BACKUPS = 7;

/** Default database path */
const DEFAULT_DB_PATH = './data/agentpane.db';

/** Default backup directory */
const DEFAULT_BACKUP_DIR = './data/backups';

export interface BackupResult {
  performed: boolean;
  skipped: boolean;
  reason?: string;
  backupPath?: string;
  integrityOk?: boolean;
  oldBackupsRemoved?: number;
}

export class EventCleanupService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private initialTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private lastRunAt: string | null = null;
  private lastBackupAt: string | null = null;

  constructor(
    private db: Database,
    private settingsService: SettingsService
  ) {}

  /**
   * Read a numeric retention setting, falling back to the provided default.
   */
  private async getRetentionDays(key: string, defaultDays: number): Promise<number> {
    try {
      const result = await this.settingsService.get(key);
      if (result.ok && result.value) {
        const parsed = JSON.parse(result.value.value);
        if (typeof parsed === 'number' && parsed > 0) {
          return parsed;
        }
      }
    } catch (err) {
      // EH-021: Fall through to default on any read/parse failure
      log.warn('Failed to read retention setting, using default', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
    return defaultDays;
  }

  /**
   * Batch-delete old rows from a table using a parameterized query.
   * Deletes in BATCH_SIZE chunks to avoid long-held locks.
   */
  private batchDelete(
    buildQuery: (cutoff: string) => ReturnType<typeof sql>,
    table: string,
    cutoff: string
  ): number {
    let totalDeleted = 0;
    let batchDeleted = BATCH_SIZE;

    while (batchDeleted >= BATCH_SIZE) {
      try {
        const result = this.db.run(buildQuery(cutoff));
        batchDeleted = result.changes;
        totalDeleted += batchDeleted;
      } catch (err) {
        log.error(`Batch delete failed for ${table}`, {
          error: err instanceof Error ? err : new Error(String(err)),
          data: { table, totalDeletedSoFar: totalDeleted, cutoff },
        });
        break;
      }
    }

    return totalDeleted;
  }

  /**
   * Read a boolean or numeric backup setting, falling back to the provided default.
   */
  private async getBackupSetting<T extends boolean | number>(
    key: string,
    defaultValue: T
  ): Promise<T> {
    try {
      const result = await this.settingsService.get(key);
      if (result.ok && result.value) {
        const parsed = JSON.parse(result.value.value);
        if (typeof parsed === typeof defaultValue) {
          return parsed as T;
        }
      }
    } catch (err) {
      log.warn('Failed to read backup setting, using default', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
    return defaultValue;
  }

  /**
   * Run an automated SQLite database backup.
   *
   * Steps:
   * 1. Check if backup is enabled via settings
   * 2. Check if enough time has elapsed since last backup
   * 3. Run PRAGMA integrity_check
   * 4. Run PRAGMA wal_checkpoint(TRUNCATE)
   * 5. Copy the DB file with a timestamp suffix
   * 6. Clean up old backups beyond maxBackups
   */
  async runBackup(): Promise<BackupResult> {
    const enabled = await this.getBackupSetting('backup.enabled', DEFAULT_BACKUP_ENABLED);
    if (!enabled) {
      return { performed: false, skipped: true, reason: 'Backup disabled via settings' };
    }

    const intervalHours = await this.getBackupSetting(
      'backup.intervalHours',
      DEFAULT_BACKUP_INTERVAL_HOURS
    );
    const maxBackups = await this.getBackupSetting('backup.maxBackups', DEFAULT_BACKUP_MAX_BACKUPS);

    // Check if enough time has elapsed since the last backup
    if (this.lastBackupAt) {
      const elapsedMs = Date.now() - new Date(this.lastBackupAt).getTime();
      const intervalMs = intervalHours * 60 * 60 * 1000;
      if (elapsedMs < intervalMs) {
        return {
          performed: false,
          skipped: true,
          reason: `Only ${Math.round(elapsedMs / 60000)}m since last backup (interval: ${intervalHours}h)`,
        };
      }
    }

    const dbPath = resolve(process.env.DB_PATH || DEFAULT_DB_PATH);
    const backupDir = resolve(
      dirname(dbPath),
      basename(DEFAULT_BACKUP_DIR) === 'backups' ? 'backups' : DEFAULT_BACKUP_DIR
    );

    if (!existsSync(dbPath)) {
      return { performed: false, skipped: true, reason: `DB file not found: ${dbPath}` };
    }

    // Ensure backup directory exists
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }

    // Run integrity check
    let integrityOk = false;
    try {
      this.db.run(sql`PRAGMA integrity_check`);
      // integrity_check returns 'ok' on success; if it doesn't throw, the check passed
      integrityOk = true;
      log.info('Database integrity check passed');
    } catch (err) {
      log.error('Database integrity check failed', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return {
        performed: false,
        skipped: false,
        reason: 'Integrity check failed',
        integrityOk: false,
      };
    }

    // WAL checkpoint to flush pending writes
    try {
      this.db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
      log.info('WAL checkpoint completed');
    } catch (err) {
      log.warn('WAL checkpoint failed, proceeding with backup anyway', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }

    // Copy DB file with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `agentpane_${timestamp}.db`;
    const backupPath = join(backupDir, backupFileName);

    try {
      copyFileSync(dbPath, backupPath);
      log.info('Database backup created', { data: { backupPath } });
    } catch (err) {
      log.error('Failed to copy database file', {
        error: err instanceof Error ? err : new Error(String(err)),
        data: { dbPath, backupPath },
      });
      return {
        performed: false,
        skipped: false,
        reason: 'File copy failed',
        integrityOk,
      };
    }

    // Clean up old backups
    let oldBackupsRemoved = 0;
    try {
      const backupFiles = readdirSync(backupDir)
        .filter((f) => f.startsWith('agentpane_') && f.endsWith('.db'))
        .map((f) => ({
          name: f,
          path: join(backupDir, f),
          mtime: statSync(join(backupDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime); // newest first

      if (backupFiles.length > maxBackups) {
        const toRemove = backupFiles.slice(maxBackups);
        for (const file of toRemove) {
          unlinkSync(file.path);
          oldBackupsRemoved++;
        }
        log.info(`Removed ${oldBackupsRemoved} old backup(s)`);
      }
    } catch (err) {
      log.warn('Failed to clean up old backups', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }

    this.lastBackupAt = new Date().toISOString();

    return {
      performed: true,
      skipped: false,
      backupPath,
      integrityOk,
      oldBackupsRemoved,
    };
  }

  /**
   * Run a single cleanup cycle: read config, compute cutoffs, batch-delete.
   * Also runs a database backup at the end of each cycle.
   */
  async runCleanup(): Promise<{
    sessionEventsDeleted: number;
    eventLogDeleted: number;
    backup: BackupResult;
  }> {
    const sessionEventsDays = await this.getRetentionDays(
      'retention.sessionEventsDays',
      DEFAULT_SESSION_EVENTS_RETENTION_DAYS
    );
    const eventLogDays = await this.getRetentionDays(
      'retention.eventLogDays',
      DEFAULT_EVENT_LOG_RETENTION_DAYS
    );

    const now = new Date();

    function cutoffIso(days: number): string {
      const d = new Date(now);
      d.setDate(d.getDate() - days);
      return d.toISOString();
    }

    const sessionEventsDeleted = this.batchDelete(
      (cutoff) =>
        sql`DELETE FROM session_events WHERE rowid IN (SELECT rowid FROM session_events WHERE created_at < ${cutoff} LIMIT ${BATCH_SIZE})`,
      'session_events',
      cutoffIso(sessionEventsDays)
    );
    const eventLogDeleted = this.batchDelete(
      (cutoff) =>
        sql`DELETE FROM event_log WHERE rowid IN (SELECT rowid FROM event_log WHERE received_at < ${cutoff} LIMIT ${BATCH_SIZE})`,
      'event_log',
      cutoffIso(eventLogDays)
    );

    this.lastRunAt = now.toISOString();

    if (sessionEventsDeleted > 0 || eventLogDeleted > 0) {
      log.info('Event cleanup completed', {
        data: {
          sessionEventsDeleted,
          eventLogDeleted,
          sessionEventsDays,
          eventLogDays,
        },
      });
    } else {
      log.info('Event cleanup completed — no rows to delete');
    }

    // Run database backup after cleanup
    const backup = await this.runBackup();
    if (backup.performed) {
      log.info('Database backup completed after cleanup', {
        data: { backupPath: backup.backupPath, oldBackupsRemoved: backup.oldBackupsRemoved },
      });
    } else if (backup.skipped) {
      log.info('Database backup skipped', { data: { reason: backup.reason } });
    }

    return { sessionEventsDeleted, eventLogDeleted, backup };
  }

  /**
   * Start the cleanup scheduler.
   * Returns a stop function for use with the shutdown handler.
   */
  start(): () => void {
    if (this.isRunning) {
      return () => this.stop();
    }
    this.isRunning = true;

    // Delay the first run to avoid startup contention
    this.initialTimeoutId = setTimeout(() => {
      this.runCleanup().catch((error) => {
        log.error('Event cleanup failed', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });

      // Set up periodic cleanup
      this.intervalId = setInterval(() => {
        this.runCleanup().catch((error) => {
          log.error('Event cleanup failed', {
            error: error instanceof Error ? error : new Error(String(error)),
          });
        });
      }, CLEANUP_INTERVAL_MS);
    }, INITIAL_DELAY_MS);

    return () => this.stop();
  }

  /**
   * Stop the cleanup scheduler and clear all timers.
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    if (this.initialTimeoutId) {
      clearTimeout(this.initialTimeoutId);
      this.initialTimeoutId = null;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;
  }

  /**
   * Get the current service state (for debugging/monitoring).
   */
  getState(): Readonly<{
    isRunning: boolean;
    lastRunAt: string | null;
    lastBackupAt: string | null;
  }> {
    return {
      isRunning: this.isRunning,
      lastRunAt: this.lastRunAt,
      lastBackupAt: this.lastBackupAt,
    };
  }
}
