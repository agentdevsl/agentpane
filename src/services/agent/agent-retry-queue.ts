import { createLogger } from '../../lib/logging/logger.js';

const log = createLogger('AgentRetryQueue');

export interface RetryableTask {
  taskId: string;
  agentId: string;
  codespaceId: string;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: number;
  errorMessage: string;
}

export interface AgentRetryQueueOptions {
  /** Maximum retry attempts per task (default: 3) */
  maxAttempts?: number;
  /** Initial backoff delay in ms (default: 30000) */
  initialBackoffMs?: number;
  /** Maximum backoff delay in ms (default: 300000 = 5 min) */
  maxBackoffMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** How often to check the queue in ms (default: 10000) */
  pollIntervalMs?: number;
  /** Function to restart a task */
  restartFn?: (taskId: string) => Promise<void>;
}

/**
 * Manages automatic retry of failed agent tasks with exponential backoff.
 * Tasks that fail due to transient errors (rate limits, network issues) are
 * automatically re-queued rather than requiring manual restart.
 */
export class AgentRetryQueue {
  private queue = new Map<string, RetryableTask>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly backoffMultiplier: number;
  private readonly pollIntervalMs: number;
  private restartFn: ((taskId: string) => Promise<void>) | null = null;

  constructor(options: AgentRetryQueueOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.initialBackoffMs = options.initialBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 300_000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    if (options.restartFn) {
      this.restartFn = options.restartFn;
    }
  }

  /** Set the restart function (for deferred initialization) */
  setRestartFn(fn: (taskId: string) => Promise<void>): void {
    this.restartFn = fn;
  }

  /**
   * Enqueue a failed task for retry.
   * Returns true if the task was enqueued, false if max attempts exceeded.
   */
  enqueue(params: {
    taskId: string;
    agentId: string;
    codespaceId: string;
    errorMessage: string;
    currentAttempt?: number;
  }): boolean {
    const existing = this.queue.get(params.taskId);
    const attempt = (existing?.attempt ?? params.currentAttempt ?? 0) + 1;

    if (attempt > this.maxAttempts) {
      log.info('Task exceeded max retry attempts', {
        data: { taskId: params.taskId, attempt, maxAttempts: this.maxAttempts },
      });
      this.queue.delete(params.taskId);
      return false;
    }

    const backoffDelay = Math.min(
      this.initialBackoffMs * this.backoffMultiplier ** (attempt - 1),
      this.maxBackoffMs
    );

    const task: RetryableTask = {
      taskId: params.taskId,
      agentId: params.agentId,
      codespaceId: params.codespaceId,
      attempt,
      maxAttempts: this.maxAttempts,
      nextRetryAt: Date.now() + backoffDelay,
      errorMessage: params.errorMessage,
    };

    this.queue.set(params.taskId, task);

    log.info('Task enqueued for retry', {
      data: {
        taskId: params.taskId,
        attempt,
        maxAttempts: this.maxAttempts,
        nextRetryInMs: backoffDelay,
      },
    });

    return true;
  }

  /** Remove a task from the retry queue (e.g., if manually restarted) */
  cancel(taskId: string): boolean {
    return this.queue.delete(taskId);
  }

  /** Start processing the retry queue */
  start(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      this.processQueue().catch((err) => {
        log.warn('Error processing retry queue', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.pollIntervalMs);
  }

  /** Stop processing the retry queue */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Get current queue state for monitoring */
  getQueueState(): ReadonlyArray<RetryableTask> {
    return Array.from(this.queue.values());
  }

  /** Get the number of tasks in the queue */
  get size(): number {
    return this.queue.size;
  }

  private async processQueue(): Promise<void> {
    if (!this.restartFn) {
      if (this.queue.size > 0) {
        log.warn('Retry queue has tasks but no restartFn is set — tasks will not be processed', {
          data: { queueSize: this.queue.size },
        });
      }
      return;
    }

    const now = Date.now();
    const readyTasks = Array.from(this.queue.values()).filter((t) => t.nextRetryAt <= now);

    for (const task of readyTasks) {
      try {
        log.info('Retrying task', {
          data: { taskId: task.taskId, attempt: task.attempt, maxAttempts: task.maxAttempts },
        });
        await this.restartFn(task.taskId);
        this.queue.delete(task.taskId);
      } catch (retryErr) {
        log.warn('Retry attempt failed for task', {
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          data: { taskId: task.taskId, attempt: task.attempt },
        });
        // Create a new task object to avoid in-place mutation
        const nextAttempt = task.attempt + 1;
        if (nextAttempt > this.maxAttempts) {
          log.error('Task permanently failed after all retry attempts', {
            data: { taskId: task.taskId, totalAttempts: task.attempt },
          });
          this.queue.delete(task.taskId);
        } else {
          this.queue.set(task.taskId, {
            ...task,
            attempt: nextAttempt,
            nextRetryAt:
              Date.now() +
              Math.min(
                this.initialBackoffMs * this.backoffMultiplier ** (nextAttempt - 1),
                this.maxBackoffMs
              ),
          });
        }
      }
    }
  }
}
