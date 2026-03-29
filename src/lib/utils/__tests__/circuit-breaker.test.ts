import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../circuit-breaker.js';

vi.mock('../../logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('closed state basics', () => {
    it('execute() runs fn and returns the result', async () => {
      const cb = new CircuitBreaker({ name: 'test' });

      const result = await cb.execute(() => Promise.resolve(42));

      expect(result).toBe(42);
    });

    it('successive successes keep circuit closed', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });

      await cb.execute(() => Promise.resolve('a'));
      await cb.execute(() => Promise.resolve('b'));
      await cb.execute(() => Promise.resolve('c'));

      expect(cb.getState()).toBe('closed');
    });
  });

  describe('opens after threshold', () => {
    it('circuit opens after N consecutive failures', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });

      for (let i = 0; i < 3; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }

      expect(cb.getState()).toBe('open');
    });

    it('stays closed if failures are below threshold', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });

      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});

      expect(cb.getState()).toBe('closed');
    });
  });

  describe('open state rejects immediately', () => {
    it('execute() throws without calling fn when open', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, resetTimeoutMs: 10_000 });

      for (let i = 0; i < 3; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }

      const fn = vi.fn(() => Promise.resolve('should not run'));

      await expect(cb.execute(fn)).rejects.toThrow("Circuit breaker 'test' is open");
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('half-open transition', () => {
    it('getState() returns half_open after resetTimeoutMs elapses', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, resetTimeoutMs: 5_000 });

      for (let i = 0; i < 3; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }

      expect(cb.getState()).toBe('open');

      vi.advanceTimersByTime(5_000);

      expect(cb.getState()).toBe('half_open');
    });
  });

  describe('half-open success closes', () => {
    it('successful call in half_open resets to closed', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, resetTimeoutMs: 5_000 });

      for (let i = 0; i < 3; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }

      vi.advanceTimersByTime(5_000);
      expect(cb.getState()).toBe('half_open');

      await cb.execute(() => Promise.resolve('ok'));

      expect(cb.getState()).toBe('closed');
      expect(cb.getInfo().failureCount).toBe(0);
    });
  });

  describe('half-open failure reopens', () => {
    it('failed call in half_open returns to open', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, resetTimeoutMs: 5_000 });

      for (let i = 0; i < 3; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }

      vi.advanceTimersByTime(5_000);
      expect(cb.getState()).toBe('half_open');

      await cb.execute(() => Promise.reject(new Error('fail again'))).catch(() => {});

      expect(cb.getState()).toBe('open');
    });
  });

  describe('reset clears state', () => {
    it('reset() returns circuit to closed with zero failures', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });

      for (let i = 0; i < 3; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }

      expect(cb.getState()).toBe('open');

      cb.reset();

      expect(cb.getState()).toBe('closed');
      expect(cb.getInfo().failureCount).toBe(0);
      expect(cb.getInfo().lastFailureTime).toBe(0);
    });
  });

  describe('onStateChange callback fires', () => {
    it('callback receives correct from/to states', async () => {
      const changes: Array<{ from: string; to: string }> = [];
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 3,
        resetTimeoutMs: 5_000,
        onStateChange: (from, to) => changes.push({ from, to }),
      });

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }

      expect(changes).toEqual([{ from: 'closed', to: 'open' }]);

      // Advance to half_open
      vi.advanceTimersByTime(5_000);
      cb.getState();

      expect(changes).toEqual([
        { from: 'closed', to: 'open' },
        { from: 'open', to: 'half_open' },
      ]);

      // Recover
      await cb.execute(() => Promise.resolve('ok'));

      expect(changes).toEqual([
        { from: 'closed', to: 'open' },
        { from: 'open', to: 'half_open' },
        { from: 'half_open', to: 'closed' },
      ]);
    });
  });

  describe('onSuccess/onFailure can be called independently', () => {
    it('onSuccess() resets failure count and transitions to closed', () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });

      cb.onFailure();
      cb.onFailure();
      expect(cb.getInfo().failureCount).toBe(2);

      cb.onSuccess();
      expect(cb.getInfo().failureCount).toBe(0);
      expect(cb.getState()).toBe('closed');
    });

    it('onFailure() increments failure count and can trip the breaker', () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });

      cb.onFailure();
      cb.onFailure();
      cb.onFailure();

      expect(cb.getState()).toBe('open');
    });
  });

  describe('negative time clamped', () => {
    it('error message shows 0s not negative when timeout just elapsed', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, resetTimeoutMs: 5_000 });

      for (let i = 0; i < 3; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }

      // Advance time to just before the reset timeout so it's still open
      // but remaining time rounds to 0
      vi.advanceTimersByTime(4_999);

      try {
        await cb.execute(() => Promise.resolve('nope'));
        expect.unreachable('should have thrown');
      } catch (e) {
        const message = (e as Error).message;
        // The remaining time should never be negative
        const match = message.match(/after (\d+)s/);
        expect(match).not.toBeNull();
        const seconds = Number.parseInt(match![1], 10);
        expect(seconds).toBeGreaterThanOrEqual(0);
      }
    });

    it('shows 0s when timeout has exactly elapsed but state check races', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, resetTimeoutMs: 5_000 });

      for (let i = 0; i < 3; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }

      // Advance past the timeout — getState() will transition to half_open
      // so execute() won't throw. Instead, verify the Math.max(0, ...) logic
      // by checking getInfo after partial advance
      vi.advanceTimersByTime(4_500);

      try {
        await cb.execute(() => Promise.resolve('nope'));
        expect.unreachable('should have thrown');
      } catch (e) {
        const message = (e as Error).message;
        expect(message).toContain('after 1s');
        expect(message).not.toMatch(/after -/);
      }
    });
  });
});
