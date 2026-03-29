import { createLogger } from '../logging/logger.js';

const log = createLogger('StreamsHealthCheck');

export interface StreamsHealthCheckOptions {
  /** Health check interval in ms (default: 30000) */
  intervalMs?: number;
  /** Number of consecutive failures before marking unhealthy (default: 3) */
  failureThreshold?: number;
  /** Function to perform the health check (e.g., publish a ping) */
  checkFn: () => Promise<void>;
}

export class StreamsHealthCheck {
  private healthy = true;
  private consecutiveFailures = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastCheckAt: string | null = null;
  private readonly intervalMs: number;
  private readonly failureThreshold: number;
  private readonly checkFn: () => Promise<void>;

  constructor(options: StreamsHealthCheckOptions) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.checkFn = options.checkFn;
  }

  start(): void {
    if (this.intervalId) return;

    // Run immediately
    this.check().catch((err) => {
      log.warn('Unexpected error in streams health check', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.intervalId = setInterval(() => {
      this.check().catch((err) => {
        log.warn('Unexpected error in streams health check', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  getStatus(): {
    healthy: boolean;
    consecutiveFailures: number;
    lastCheckAt: string | null;
  } {
    return {
      healthy: this.healthy,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckAt: this.lastCheckAt,
    };
  }

  private async check(): Promise<void> {
    this.lastCheckAt = new Date().toISOString();
    try {
      await this.checkFn();
      if (!this.healthy) {
        log.info('Streams server recovered', {
          data: { previousFailures: this.consecutiveFailures },
        });
      }
      this.consecutiveFailures = 0;
      this.healthy = true;
    } catch (error) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold && this.healthy) {
        this.healthy = false;
        log.error('Streams server marked unhealthy', {
          error,
          data: {
            consecutiveFailures: this.consecutiveFailures,
            threshold: this.failureThreshold,
          },
        });
      } else if (!this.healthy) {
        log.warn('Streams server still unhealthy', {
          data: { consecutiveFailures: this.consecutiveFailures },
        });
      }
    }
  }
}
