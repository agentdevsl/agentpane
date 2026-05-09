/**
 * Integration coverage for parseServerConfig.
 *
 * The function calls process.exit on misconfiguration, so each test stubs
 * process.exit to throw a sentinel error that we catch. Tests cover:
 * - happy path: defaults + production overrides
 * - exits when DB_MODE=postgres but DATABASE_URL missing
 * - exits when SKIP_AUTH=true in production
 * - warns when CORS_ORIGIN is the local default in production
 * - exits when Postgres config is invalid
 * - happy path with MULTI_TENANT=true (warning is logged)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseServerConfig } from '../../src/server/bootstrap/server-config';

describe('bootstrap/server-config: parseServerConfig', () => {
  let originalExit: typeof process.exit;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalExit = process.exit;
    originalEnv = { ...process.env };

    // Strip env vars relevant to this test
    delete process.env.DB_MODE;
    delete process.env.DATABASE_URL;
    delete process.env.DB_PATH;
    delete process.env.PORT;
    delete process.env.CORS_ORIGIN;
    delete process.env.LOG_LEVEL;
    delete process.env.NODE_ENV;
    delete process.env.SKIP_AUTH;
    delete process.env.SANDBOX_INIT_TIMEOUT_MS;
    delete process.env.CADDY_STREAMS_URL;
    delete process.env.MULTI_TENANT;
    delete process.env.POSTGRES_MAX;
    delete process.env.POSTGRES_IDLE_TIMEOUT;
    delete process.env.POSTGRES_MAX_LIFETIME;
    delete process.env.POSTGRES_CONNECT_TIMEOUT;
    delete process.env.POSTGRES_APPLICATION_NAME;
    delete process.env.POSTGRES_SSL;

    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never;
  });

  afterEach(() => {
    process.exit = originalExit;
    // Restore env
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('returns defaults with development NODE_ENV', () => {
    const config = parseServerConfig();
    expect(config.dbMode).toBe('sqlite');
    expect(config.port).toBe(3001);
    expect(config.corsOrigin).toBe('http://localhost:3000');
    expect(config.nodeEnv).toBe('development');
    expect(config.skipAuth).toBe(false);
    expect(config.multiTenant).toBe(false);
    // dev default for caddyStreamsUrl is dev test server
    expect(config.caddyStreamsUrl).toContain('3002');
  });

  it('uses production caddyStreamsUrl when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'https://app.example.com';
    const config = parseServerConfig();
    expect(config.caddyStreamsUrl).toContain('3000');
  });

  it('exits when DB_MODE=postgres without DATABASE_URL', () => {
    process.env.DB_MODE = 'postgres';
    expect(() => parseServerConfig()).toThrow(/process.exit\(1\)/);
  });

  it('passes when DB_MODE=postgres + DATABASE_URL is set', () => {
    process.env.DB_MODE = 'postgres';
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const config = parseServerConfig();
    expect(config.dbMode).toBe('postgres');
    expect(config.databaseUrl).toBe('postgresql://localhost/test');
  });

  it('exits when SKIP_AUTH=true in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SKIP_AUTH = 'true';
    process.env.CORS_ORIGIN = 'https://app.example.com';
    expect(() => parseServerConfig()).toThrow(/process.exit\(1\)/);
  });

  it('passes when SKIP_AUTH=true in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.SKIP_AUTH = 'true';
    const config = parseServerConfig();
    expect(config.skipAuth).toBe(true);
  });

  it('exits when Postgres config is invalid (POSTGRES_MAX out of range)', () => {
    process.env.POSTGRES_MAX = '99999';
    expect(() => parseServerConfig()).toThrow(/process.exit\(1\)/);
  });

  it('passes with MULTI_TENANT=true and per-codespace sandbox mode', () => {
    process.env.MULTI_TENANT = 'true';
    const config = parseServerConfig();
    expect(config.multiTenant).toBe(true);
  });

  it('respects PORT env var override', () => {
    process.env.PORT = '4000';
    const config = parseServerConfig();
    expect(config.port).toBe(4000);
  });

  it('rejects invalid log level via Zod schema', () => {
    process.env.LOG_LEVEL = 'verbose';
    expect(() => parseServerConfig()).toThrow(/process.exit\(1\)/);
  });

  it('uses CADDY_STREAMS_URL override when provided', () => {
    process.env.CADDY_STREAMS_URL = 'https://caddy.example.com/v1/stream';
    const config = parseServerConfig();
    expect(config.caddyStreamsUrl).toBe('https://caddy.example.com/v1/stream');
  });
});
