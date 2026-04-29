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
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { BackgroundJob, BackgroundJobSnapshot } from '../lib/background/job.js';
import { getDbDialect } from '../lib/db/dialect.js';
import { createLogger } from '../lib/logging/logger.js';
import type { Database } from '../types/database.js';
import type { SettingsService } from './settings.service.js';

const log = createLogger('EventCleanup');

/** Default retention: session events kept for 60 days */
const DEFAULT_SESSION_EVENTS_RETENTION_DAYS = 60;

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

export interface BackupResult {
  performed: boolean;
  skipped: boolean;
  reason?: string;
  backupPath?: string;
  integrityOk?: boolean;
  oldBackupsRemoved?: number;
}

export class EventCleanupService implements BackgroundJob {
  readonly name = 'eventCleanup';
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private initialTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private lastRunAt: string | null = null;
  private lastBackupAt: string | null = null;
  private lastError: string | null = null;

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
   *
   * F02-15: portable across SQLite and Postgres. The original implementation
   * used `WHERE rowid IN (SELECT rowid FROM ...)` which is SQLite-specific
   * (Postgres uses `ctid`). Both tables have a stable text `id` primary key,
   * so we use `WHERE id IN (SELECT id FROM ... LIMIT N)` which works on
   * both. Postgres also supports the same subquery shape.
   *
   * The dispatch on `db.run` vs `db.execute` is handled by reading
   * `getDbDialect()`; both branches return a `{ changes: number }` shape.
   */
  private async batchDelete(
    buildQuery: (cutoff: string) => ReturnType<typeof sql>,
    table: string,
    cutoff: string
  ): Promise<number> {
    let totalDeleted = 0;
    let batchDeleted = BATCH_SIZE;
    const dialect = getDbDialect();

    while (batchDeleted >= BATCH_SIZE) {
      try {
        const query = buildQuery(cutoff);
        if (dialect === 'postgres') {
          const result = (await (
            this.db as unknown as {
              execute: (q: ReturnType<typeof sql>) => Promise<{ count?: number; length?: number }>;
            }
          ).execute(query)) as { count?: number; length?: number };
          batchDeleted =
            typeof result?.count === 'number' ? result.count : (result?.length ?? 0);
        } else {
          const result = (
            this.db as unknown as {
              run: (q: ReturnType<typeof sql>) => { changes: number };
            }
          ).run(query);
          batchDeleted = result.changes;
        }
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
    // F02-15: SQLite file-copy backups are only meaningful for the SQLite
    // backend. On Postgres the operator runs `pg_dump` out-of-process, so
    // the in-process backup loop is a no-op. Guarding here also prevents
    // the SQLite-only `PRAGMA integrity_check` / `PRAGMA wal_checkpoint`
    // calls below from raising on a PG connection.
    if (getDbDialect() === 'postgres') {
      return {
        performed: false,
        skipped: true,
        reason: 'Backup skipped: SQLite-only feature (use pg_dump for Postgres)',
      };
    }

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
    const backupDir = resolve(dirname(dbPath), 'backups');

    if (!existsSync(dbPath)) {
      log.warn('Database file not found for backup', { data: { dbPath } });
      return { performed: false, skipped: true, reason: 'Database file not found' };
    }

    // Ensure backup directory exists
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }

    // Run integrity check — query the result and verify it returns 'ok'
    let integrityOk = false;
    try {
      const rows = this.db.all<{ integrity_check: string }>(sql`PRAGMA integrity_check`);
      const firstRow = rows[0];
      if (firstRow && firstRow.integrity_check === 'ok') {
        integrityOk = true;
        log.info('Database integrity check passed');
      } else {
        const details = rows.map((r) => r.integrity_check).join('; ');
        log.error('Database integrity check found issues', {
          data: { details },
        });
        return {
          performed: false,
          skipped: false,
          reason: 'Integrity check failed',
        };
      }
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
      // Restrict backup file to owner-only read/write
      chmodSync(backupPath, 0o600);
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

    const sessionEventsDeleted = await this.batchDelete(
      (cutoff) =>
        // F02-15: portable across SQLite and Postgres — both treat the
        // text `id` PK identically; SQLite's `rowid` is not available on
        // Postgres so we cannot reuse it.
        sql`DELETE FROM session_events WHERE id IN (SELECT id FROM session_events WHERE created_at < ${cutoff} LIMIT ${BATCH_SIZE})`,
      'session_events',
      cutoffIso(sessionEventsDays)
    );
    const eventLogDeleted = await this.batchDelete(
      (cutoff) =>
        sql`DELETE FROM event_log WHERE id IN (SELECT id FROM event_log WHERE received_at < ${cutoff} LIMIT ${BATCH_SIZE})`,
      'event_log',
      cutoffIso(eventLogDays)
    );

    this.lastRunAt = now.toISOString();
    this.lastError = null;

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
   * Start the cleanup scheduler. Idempotent per the {@link BackgroundJob}
   * contract: calling while already running is a no-op.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    // Delay the first run to avoid startup contention
    this.initialTimeoutId = setTimeout(() => {
      this.runCleanup().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        log.error('Event cleanup failed', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });

      // Set up periodic cleanup
      this.intervalId = setInterval(() => {
        this.runCleanup().catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error);
          log.error('Event cleanup failed', {
            error: error instanceof Error ? error : new Error(String(error)),
          });
        });
      }, CLEANUP_INTERVAL_MS);
    }, INITIAL_DELAY_MS);
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

  /**
   * {@link BackgroundJob.healthSnapshot} — returns a minimal snapshot
   * suitable for an ops endpoint. Never throws.
   */
  healthSnapshot(): BackgroundJobSnapshot {
    return {
      name: this.name,
      running: this.isRunning,
      lastRunAt: this.lastRunAt ?? undefined,
      lastError: this.lastError ?? undefined,
    };
  }
}
