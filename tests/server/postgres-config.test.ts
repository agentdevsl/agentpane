/**
 * F02-05: PostgreSQL client configuration tests.
 *
 * Verifies that env-driven pool / client settings are parsed, validated,
 * and surface typed errors at boot for invalid values.
 */
import { describe, expect, it } from 'vitest';
import { PostgresConfigError, parsePostgresConfig } from '../../src/server/bootstrap/server-config';

describe('parsePostgresConfig (F02-05)', () => {
  it('applies sensible defaults with an empty env', () => {
    const cfg = parsePostgresConfig({});
    expect(cfg.max).toBe(10);
    expect(cfg.idleTimeoutSeconds).toBe(30);
    expect(cfg.maxLifetimeSeconds).toBe(1800);
    expect(cfg.connectTimeoutSeconds).toBe(10);
    expect(cfg.applicationName).toBe('agentpane');
    expect(cfg.ssl).toBeUndefined();
  });

  it('reads env overrides for every tunable', () => {
    const cfg = parsePostgresConfig({
      POSTGRES_MAX: '25',
      POSTGRES_IDLE_TIMEOUT: '60',
      POSTGRES_MAX_LIFETIME: '3600',
      POSTGRES_CONNECT_TIMEOUT: '15',
      POSTGRES_APPLICATION_NAME: 'agentpane-prod',
      POSTGRES_SSL: 'require',
    });
    expect(cfg.max).toBe(25);
    expect(cfg.idleTimeoutSeconds).toBe(60);
    expect(cfg.maxLifetimeSeconds).toBe(3600);
    expect(cfg.connectTimeoutSeconds).toBe(15);
    expect(cfg.applicationName).toBe('agentpane-prod');
    expect(cfg.ssl).toBe('require');
  });

  it('throws a typed PostgresConfigError for negative pool size', () => {
    expect(() => parsePostgresConfig({ POSTGRES_MAX: '-1' })).toThrow(PostgresConfigError);
  });

  it('throws a typed PostgresConfigError for zero pool size', () => {
    expect(() => parsePostgresConfig({ POSTGRES_MAX: '0' })).toThrow(PostgresConfigError);
  });

  it('throws a typed PostgresConfigError for non-numeric pool size', () => {
    expect(() => parsePostgresConfig({ POSTGRES_MAX: 'not-a-number' })).toThrow(
      PostgresConfigError
    );
  });

  it('rejects unsupported SSL modes', () => {
    expect(() => parsePostgresConfig({ POSTGRES_SSL: 'bogus' })).toThrow(PostgresConfigError);
  });

  it('rejects connect-timeout below 1 second', () => {
    expect(() => parsePostgresConfig({ POSTGRES_CONNECT_TIMEOUT: '0' })).toThrow(
      PostgresConfigError
    );
  });

  it('rejects idle-timeout above the one-day ceiling', () => {
    expect(() => parsePostgresConfig({ POSTGRES_IDLE_TIMEOUT: '999999' })).toThrow(
      PostgresConfigError
    );
  });

  it('accepts idle-timeout of 0 (keep connections open forever)', () => {
    const cfg = parsePostgresConfig({ POSTGRES_IDLE_TIMEOUT: '0' });
    expect(cfg.idleTimeoutSeconds).toBe(0);
  });

  it('rejects empty application_name', () => {
    expect(() => parsePostgresConfig({ POSTGRES_APPLICATION_NAME: '' })).toThrow(
      PostgresConfigError
    );
  });
});
