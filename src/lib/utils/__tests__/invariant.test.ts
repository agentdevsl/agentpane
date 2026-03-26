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

import { InvariantViolation, invariant, softInvariant } from '../invariant.js';

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
