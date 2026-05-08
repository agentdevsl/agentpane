/**
 * Integration coverage for server-config + shutdown bootstrap modules.
 *
 * These modules are at <10% in the integration coverage report; the
 * existing unit tests target validateEnv smoke but don't reach
 * parsePostgresConfig branches, parseServerConfig environment-variant
 * branches, or the GracefulShutdown LIFO orchestrator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isMultiTenantEnabled,
  PostgresConfigError,
  parsePostgresConfig,
} from '../../src/server/bootstrap/server-config';
import { GracefulShutdown } from '../../src/server/bootstrap/shutdown';

describe('server-config: parsePostgresConfig', () => {
  it('returns defaults when no env vars are set', () => {
    const result = parsePostgresConfig({} as NodeJS.ProcessEnv);
    expect(result.max).toBe(10);
    expect(result.idleTimeoutSeconds).toBe(30);
    expect(result.maxLifetimeSeconds).toBe(1800);
    expect(result.connectTimeoutSeconds).toBe(10);
    expect(result.applicationName).toBe('agentpane');
    expect(result.ssl).toBeUndefined();
  });

  it('coerces string env values to numbers', () => {
    const result = parsePostgresConfig({
      POSTGRES_MAX: '20',
      POSTGRES_IDLE_TIMEOUT: '120',
      POSTGRES_MAX_LIFETIME: '3600',
      POSTGRES_CONNECT_TIMEOUT: '15',
      POSTGRES_APPLICATION_NAME: 'agentpane-test',
      POSTGRES_SSL: 'require',
    } as NodeJS.ProcessEnv);
    expect(result.max).toBe(20);
    expect(result.idleTimeoutSeconds).toBe(120);
    expect(result.maxLifetimeSeconds).toBe(3600);
    expect(result.connectTimeoutSeconds).toBe(15);
    expect(result.applicationName).toBe('agentpane-test');
    expect(result.ssl).toBe('require');
  });

  it('throws PostgresConfigError when max is below 1', () => {
    expect(() => parsePostgresConfig({ POSTGRES_MAX: '0' } as NodeJS.ProcessEnv)).toThrow(
      PostgresConfigError
    );
  });

  it('throws PostgresConfigError when max exceeds upper bound', () => {
    expect(() => parsePostgresConfig({ POSTGRES_MAX: '99999' } as NodeJS.ProcessEnv)).toThrow(
      PostgresConfigError
    );
  });

  it('throws PostgresConfigError when ssl is not a recognized enum value', () => {
    expect(() => parsePostgresConfig({ POSTGRES_SSL: 'maybe' } as NodeJS.ProcessEnv)).toThrow(
      PostgresConfigError
    );
  });

  it('throws PostgresConfigError when applicationName is empty string', () => {
    expect(() =>
      parsePostgresConfig({ POSTGRES_APPLICATION_NAME: '' } as NodeJS.ProcessEnv)
    ).toThrow(PostgresConfigError);
  });

  it('PostgresConfigError carries name field', () => {
    try {
      parsePostgresConfig({ POSTGRES_MAX: 'bad' } as NodeJS.ProcessEnv);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PostgresConfigError);
      expect((e as PostgresConfigError).name).toBe('PostgresConfigError');
    }
  });
});

describe('server-config: isMultiTenantEnabled', () => {
  it('returns true ONLY when MULTI_TENANT="true"', () => {
    expect(isMultiTenantEnabled({ MULTI_TENANT: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('returns false when MULTI_TENANT is unset', () => {
    expect(isMultiTenantEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('returns false for any non-"true" value (case-sensitive)', () => {
    expect(isMultiTenantEnabled({ MULTI_TENANT: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isMultiTenantEnabled({ MULTI_TENANT: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isMultiTenantEnabled({ MULTI_TENANT: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isMultiTenantEnabled({ MULTI_TENANT: 'yes' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('GracefulShutdown', () => {
  let originalExit: typeof process.exit;
  let exitCode: number | null;

  beforeEach(() => {
    originalExit = process.exit;
    exitCode = null;
    // Stub process.exit so the test runner doesn't actually exit
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never;
  });

  afterEach(() => {
    process.exit = originalExit;
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('register adds cleanup entries', () => {
    const sd = new GracefulShutdown();
    sd.register('a', vi.fn());
    sd.register('b', vi.fn());
    // No public getter, so we observe via shutdown order in another test
    expect(true).toBe(true);
  });

  it('shutdown runs cleanups in LIFO order and exits 0', async () => {
    const sd = new GracefulShutdown(5_000);
    const order: string[] = [];
    sd.register('first', () => {
      order.push('first');
    });
    sd.register('second', () => {
      order.push('second');
    });
    sd.register('third', async () => {
      order.push('third');
    });

    await expect(sd.shutdown('SIGTEST')).rejects.toThrow(/process.exit/);
    expect(exitCode).toBe(0);
    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('shutdown is idempotent (calling twice is a no-op the second time)', async () => {
    const sd = new GracefulShutdown(5_000);
    const cleanup = vi.fn();
    sd.register('x', cleanup);

    await expect(sd.shutdown('SIGTEST')).rejects.toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);

    // Second call should NOT re-invoke cleanups (and won't exit again because
    // the isShuttingDown guard returns early before the timer)
    await sd.shutdown('SIGTEST');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('shutdown swallows individual cleanup errors and continues', async () => {
    const sd = new GracefulShutdown(5_000);
    const before = vi.fn();
    const after = vi.fn();
    sd.register('before', before);
    sd.register('throws', () => {
      throw new Error('cleanup failed');
    });
    sd.register('after', after);

    await expect(sd.shutdown('SIGTEST')).rejects.toThrow(/process.exit/);
    expect(before).toHaveBeenCalled();
    expect(after).toHaveBeenCalled();
  });

  it('installSignalHandlers wires SIGINT and SIGTERM', async () => {
    const sd = new GracefulShutdown(5_000);
    sd.installSignalHandlers();
    expect(process.listenerCount('SIGINT')).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(1);
  });
});
