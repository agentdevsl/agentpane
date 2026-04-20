import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../logging/logger.js', () => ({
  createLogger: () => mockLogger,
}));

// F10-04: stub the telemetry sink so tests can observe captureException calls.
const mockCapture = vi.hoisted(() => vi.fn());
vi.mock('../../telemetry/error-sink.js', () => ({
  captureException: mockCapture,
}));

import { InvariantViolation, invariant, softInvariant, strictInvariant } from '../invariant.js';

describe('invariant', () => {
  it('does not throw when condition is truthy', () => {
    expect(() => invariant(true, 'msg')).not.toThrow();
    expect(() => invariant('non-empty', 'msg')).not.toThrow();
    expect(() => invariant({ key: 'value' }, 'msg')).not.toThrow();
    expect(() => invariant(1, 'msg')).not.toThrow();
    expect(() => invariant([1, 2, 3], 'msg')).not.toThrow();
  });

  it('throws InvariantViolation when condition is falsy in test env', () => {
    expect(() => invariant(false, 'failed')).toThrow(InvariantViolation);
    expect(() => invariant(null, 'failed')).toThrow(InvariantViolation);
    expect(() => invariant(undefined, 'failed')).toThrow(InvariantViolation);
    expect(() => invariant(0, 'failed')).toThrow(InvariantViolation);
    expect(() => invariant('', 'failed')).toThrow(InvariantViolation);
  });

  it('includes message in thrown error', () => {
    try {
      invariant(false, 'something went wrong');
    } catch (e) {
      expect(e).toBeInstanceOf(InvariantViolation);
      expect((e as InvariantViolation).message).toBe('something went wrong');
    }
  });

  it('includes context in thrown error', () => {
    const context = { taskId: '123', status: 'invalid' };

    try {
      invariant(false, 'bad state', context);
    } catch (e) {
      expect(e).toBeInstanceOf(InvariantViolation);
      expect((e as InvariantViolation).context).toEqual(context);
    }
  });

  it('InvariantViolation has correct name property', () => {
    const error = new InvariantViolation('test');

    expect(error.name).toBe('InvariantViolation');
    expect(error).toBeInstanceOf(Error);
  });

  it('forwards violations to the telemetry sink (F10-04)', () => {
    mockCapture.mockClear();
    expect(() => invariant(false, 'sink test', { taskId: 't1' })).toThrow(InvariantViolation);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    const [err, ctx] = mockCapture.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(err).toBeInstanceOf(InvariantViolation);
    expect(ctx.source).toBe('invariant');
    expect(ctx.taskId).toBe('t1');
  });

  describe('production mode', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('logs instead of throwing in production', () => {
      const context = { agentId: 'a1' };

      expect(() => invariant(false, 'prod violation', context)).not.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith('Invariant violation: prod violation', {
        data: context,
      });
    });
  });
});

describe('strictInvariant', () => {
  it('does not throw when condition is truthy', () => {
    expect(() => strictInvariant(true, 'msg')).not.toThrow();
    expect(() => strictInvariant('non-empty', 'msg')).not.toThrow();
    expect(() => strictInvariant({ key: 'value' }, 'msg')).not.toThrow();
    expect(() => strictInvariant(1, 'msg')).not.toThrow();
    expect(() => strictInvariant([1, 2, 3], 'msg')).not.toThrow();
  });

  it('throws InvariantViolation when condition is falsy', () => {
    expect(() => strictInvariant(false, 'failed')).toThrow(InvariantViolation);
    expect(() => strictInvariant(null, 'failed')).toThrow(InvariantViolation);
    expect(() => strictInvariant(undefined, 'failed')).toThrow(InvariantViolation);
    expect(() => strictInvariant(0, 'failed')).toThrow(InvariantViolation);
    expect(() => strictInvariant('', 'failed')).toThrow(InvariantViolation);
  });

  it('includes context in thrown error', () => {
    const context = { userId: 'u1', action: 'delete' };

    try {
      strictInvariant(false, 'auth check failed', context);
    } catch (e) {
      expect(e).toBeInstanceOf(InvariantViolation);
      expect((e as InvariantViolation).context).toEqual(context);
    }
  });

  it('logs with critical prefix on violation', () => {
    const context = { paymentId: 'p1' };

    expect(() => strictInvariant(false, 'amount mismatch', context)).toThrow(InvariantViolation);
    expect(mockLogger.error).toHaveBeenCalledWith('Critical invariant violation: amount mismatch', {
      data: context,
    });
  });

  describe('production mode', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('throws InvariantViolation even in production', () => {
      expect(() => strictInvariant(false, 'critical failure')).toThrow(InvariantViolation);
    });

    it('logs with critical prefix in production', () => {
      const context = { agentId: 'a1' };

      expect(() => strictInvariant(false, 'security violation', context)).toThrow(
        InvariantViolation
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Critical invariant violation: security violation',
        { data: context }
      );
    });
  });
});

describe('softInvariant', () => {
  it('returns true when condition is truthy', () => {
    expect(softInvariant(true, 'msg')).toBe(true);
    expect(softInvariant('non-empty', 'msg')).toBe(true);
    expect(softInvariant(42, 'msg')).toBe(true);
  });

  it('returns false when condition is falsy', () => {
    expect(softInvariant(false, 'msg')).toBe(false);
    expect(softInvariant(null, 'msg')).toBe(false);
    expect(softInvariant(undefined, 'msg')).toBe(false);
  });

  it('never throws even when condition is falsy', () => {
    expect(() => softInvariant(false, 'should not throw')).not.toThrow();
    expect(() => softInvariant(null, 'should not throw')).not.toThrow();
    expect(() => softInvariant(0, 'should not throw')).not.toThrow();
  });

  it('logs warning on violation', () => {
    const context = { field: 'email' };

    softInvariant(false, 'missing field', context);

    expect(mockLogger.warn).toHaveBeenCalledWith('Soft invariant violation: missing field', {
      data: context,
    });
  });
});
