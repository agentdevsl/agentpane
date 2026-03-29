import { createLogger } from '../logging/logger.js';

const log = createLogger('CircuitBreaker');

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Name of the service being protected */
  name: string;
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms before attempting to half-open (default: 30000) */
  resetTimeoutMs?: number;
  /** Optional callback when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreaker {
  readonly name: string;
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.onStateChange = options.onStateChange;
  }

  getState(): CircuitState {
    if (this.state === 'open' && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.transition('half_open');
    }
    return this.state;
  }

  /**
   * Execute a function with circuit breaker protection.
   * Throws immediately if the circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'open') {
      const remainingMs = Math.max(0, this.resetTimeoutMs - (Date.now() - this.lastFailureTime));
      throw new Error(
        `Circuit breaker '${this.name}' is open — service unavailable. ` +
          `Will retry after ${Math.ceil(remainingMs / 1000)}s.`
      );
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Record a successful call */
  onSuccess(): void {
    if (this.state === 'half_open') {
      log.info(`Circuit breaker '${this.name}' recovered — closing circuit`, {
        data: { previousFailures: this.failureCount },
      });
    }
    this.failureCount = 0;
    if (this.state !== 'closed') {
      this.transition('closed');
    }
  }

  /** Record a failed call */
  onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half_open') {
      log.warn(`Circuit breaker '${this.name}' test call failed — reopening circuit`);
      this.transition('open');
    } else if (this.failureCount >= this.failureThreshold) {
      log.warn(`Circuit breaker '${this.name}' opened after ${this.failureCount} failures`, {
        data: { threshold: this.failureThreshold, resetTimeoutMs: this.resetTimeoutMs },
      });
      this.transition('open');
    }
  }

  /** Reset the circuit breaker to closed state */
  reset(): void {
    this.failureCount = 0;
    this.lastFailureTime = 0;
    if (this.state !== 'closed') {
      this.transition('closed');
    }
  }

  /** Get diagnostic info */
  getInfo(): { name: string; state: CircuitState; failureCount: number; lastFailureTime: number } {
    return {
      name: this.name,
      state: this.getState(),
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    this.state = to;
    this.onStateChange?.(from, to);
  }
}
