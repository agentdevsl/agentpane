/**
 * Graceful Shutdown (CB-006)
 *
 * LIFO cleanup registration with timeout safety net.
 * Services register their cleanup functions during bootstrap,
 * and they are called in reverse order on SIGINT/SIGTERM.
 */

import { createLogger } from '../../lib/logging/logger.js';

const log = createLogger('GracefulShutdown');

interface CleanupEntry {
  name: string;
  cleanup: () => void | Promise<void>;
}

/**
 * Manages graceful shutdown with LIFO-ordered cleanup.
 *
 * Services register their cleanup functions during bootstrap.
 * On shutdown, cleanups run in reverse registration order (LIFO)
 * so that dependencies are torn down before their dependents.
 */
export class GracefulShutdown {
  private cleanups: CleanupEntry[] = [];
  private isShuttingDown = false;
  private readonly timeoutMs: number;

  constructor(timeoutMs = 30_000) {
    this.timeoutMs = timeoutMs;
  }

  /** Register a cleanup function. Last registered runs first (LIFO). */
  register(name: string, cleanup: () => void | Promise<void>): void {
    this.cleanups.push({ name, cleanup });
  }

  /** Execute all cleanups in LIFO order. Safe to call multiple times. */
  async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    log.info(`Received ${signal}, shutting down gracefully...`);

    // Force-exit safety net
    const forceExitTimer = setTimeout(() => {
      log.error(`Graceful shutdown timed out after ${this.timeoutMs}ms, forcing exit`);
      process.exit(1);
    }, this.timeoutMs);
    forceExitTimer.unref();

    // LIFO order: reverse the array
    const reversed = [...this.cleanups].reverse();

    for (const entry of reversed) {
      try {
        await entry.cleanup();
        log.debug(`Cleanup complete: ${entry.name}`);
      } catch (err) {
        log.warn(`Cleanup failed: ${entry.name}`, {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    log.info('Shutdown complete');
    process.exit(0);
  }

  /** Install signal handlers for SIGINT and SIGTERM. */
  installSignalHandlers(): void {
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
  }
}
