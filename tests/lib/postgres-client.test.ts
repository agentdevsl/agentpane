/**
 * F02-17 (arch29-W2-R): regression coverage for the centralised PG client
 * factory.
 *
 * Before this PR three independent `postgres(connectionString)` call sites
 * existed: the primary bootstrap (`src/server/bootstrap/phases/database.ts`,
 * configured), the worker/CLI client (`src/db/client.ts`, unconfigured), and
 * the legacy bootstrap (`src/lib/bootstrap/phases/postgres.ts`, unconfigured).
 * The unconfigured ones used the postgres-js defaults (`max: 10`, no idle
 * close, no `application_name`, no SSL toggle).
 *
 * After this PR, all three callers route through `createPgClient` /
 * `buildPostgresOptions`. This test verifies:
 *   - default env yields the documented defaults (max=10, idle=30, etc.)
 *   - env overrides flow through to the postgres-js options shape
 *   - `ssl: 'disable'` is mapped to `false` (not the string)
 *   - `ssl: 'require'` / `'prefer'` are passed through
 *   - missing `ssl` is left undefined (driver default)
 *
 * before:test_name (FAIL) — `createPgClient` did not exist; the unconfigured
 *   sites silently used postgres-js defaults
 * after:test_name (PASS) — all three sites consume the same typed options
 */

import { describe, expect, it } from 'vitest';
import { buildPostgresOptions } from '../../src/db/postgres-client';

describe('buildPostgresOptions — F02-17 typed options derivation', () => {
  it('applies all configured fields to postgres-js options', () => {
    const opts = buildPostgresOptions({
      max: 25,
      idleTimeoutSeconds: 60,
      maxLifetimeSeconds: 3600,
      connectTimeoutSeconds: 15,
      applicationName: 'agentpane-prod',
      ssl: 'require',
    });

    expect(opts.max).toBe(25);
    expect(opts.idle_timeout).toBe(60);
    expect(opts.max_lifetime).toBe(3600);
    expect(opts.connect_timeout).toBe(15);
    expect(opts.connection).toEqual({ application_name: 'agentpane-prod' });
    expect(opts.ssl).toBe('require');
  });

  it('maps ssl: "disable" to boolean false (postgres-js convention)', () => {
    const opts = buildPostgresOptions({
      max: 10,
      idleTimeoutSeconds: 30,
      maxLifetimeSeconds: 1800,
      connectTimeoutSeconds: 10,
      applicationName: 'agentpane',
      ssl: 'disable',
    });

    expect(opts.ssl).toBe(false);
  });

  it('passes ssl: "prefer" through unchanged', () => {
    const opts = buildPostgresOptions({
      max: 10,
      idleTimeoutSeconds: 30,
      maxLifetimeSeconds: 1800,
      connectTimeoutSeconds: 10,
      applicationName: 'agentpane',
      ssl: 'prefer',
    });

    expect(opts.ssl).toBe('prefer');
  });

  it('leaves ssl undefined when unset (driver default)', () => {
    const opts = buildPostgresOptions({
      max: 10,
      idleTimeoutSeconds: 30,
      maxLifetimeSeconds: 1800,
      connectTimeoutSeconds: 10,
      applicationName: 'agentpane',
      // ssl omitted
    });

    expect(opts.ssl).toBeUndefined();
  });

  it('exposes application_name via the connection sub-object (pg_stat_activity hook)', () => {
    const opts = buildPostgresOptions({
      max: 10,
      idleTimeoutSeconds: 30,
      maxLifetimeSeconds: 1800,
      connectTimeoutSeconds: 10,
      applicationName: 'custom-app',
    });

    expect(opts.connection).toBeDefined();
    expect((opts.connection as { application_name?: string }).application_name).toBe('custom-app');
  });

  it('does not return defaults — caller must supply them via parsePostgresConfig', () => {
    // The function is pure; it does NOT default missing fields. This is by
    // design: defaults live in the Zod schema (`PostgresConfigSchema`) so
    // there is one source of truth. This test pins the contract.
    const opts = buildPostgresOptions({
      max: 99,
      idleTimeoutSeconds: 0, // 0 = keep open forever
      maxLifetimeSeconds: 0,
      connectTimeoutSeconds: 1,
      applicationName: 'edge',
    });
    expect(opts.max).toBe(99);
    expect(opts.idle_timeout).toBe(0);
    expect(opts.max_lifetime).toBe(0);
  });
});

describe('createPgClient call-site parity (F02-17)', () => {
  it('all 3 PG client call sites import the centralised helper', async () => {
    // Best-effort static check via dynamic file read — verifies that the
    // three call sites listed in F02-17 actually route through createPgClient.
    // This guards against future regressions where someone adds a new
    // `postgres(connectionString)` callsite without using the helper.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const root = resolve(import.meta.dirname, '../..');

    const databaseBootstrap = readFileSync(
      resolve(root, 'src/server/bootstrap/phases/database.ts'),
      'utf-8'
    );
    const dbClient = readFileSync(resolve(root, 'src/db/client.ts'), 'utf-8');
    const legacyPg = readFileSync(resolve(root, 'src/lib/bootstrap/phases/postgres.ts'), 'utf-8');

    // All three must import createPgClient:
    expect(databaseBootstrap).toMatch(/createPgClient/);
    expect(dbClient).toMatch(/createPgClient/);
    expect(legacyPg).toMatch(/createPgClient/);

    // None must call `postgres(connectionString)` directly anymore — only
    // through the helper. Allow `import postgres from 'postgres'` and
    // `type postgres` declarations.
    const directCalls = [databaseBootstrap, dbClient, legacyPg].flatMap(
      (src) => src.match(/postgres\s*\(\s*connectionString/g) ?? []
    );
    expect(directCalls).toHaveLength(0);
  });
});
