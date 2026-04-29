/**
 * createPgClient — F02-17 (arch29-W2-R).
 *
 * Centralised PostgreSQL client constructor. Replaces the previous pattern
 * where three separate call sites (`src/server/bootstrap/phases/database.ts`,
 * `src/db/client.ts`, `src/lib/bootstrap/phases/postgres.ts`) constructed a
 * `postgres()` client independently — only the first applied the validated
 * pool / timeout / SSL configuration, leaving the other two with the driver
 * defaults (`max: 10`, no idle close, no `application_name`, no SSL toggle).
 *
 * After F02-17 every PG client must be created via `createPgClient(config)`
 * so production deployments have a single, observable, audited connection
 * profile in `pg_stat_activity`. The function delegates to
 * `parsePostgresConfig` (which reads `POSTGRES_MAX` / `POSTGRES_IDLE_TIMEOUT`
 * / etc. from the environment) and then materialises a `postgres-js` client
 * with the typed knobs applied.
 *
 * Usage:
 * ```ts
 * import { createPgClient } from './postgres-client.js';
 * const client = createPgClient(connectionString);
 * const db = drizzle(client, { schema: pgSchema });
 * ```
 *
 * Tests: `tests/server/postgres-config.test.ts` covers the parser; the
 * pool-exhaustion regression test at
 * `tests/integration/postgres-pool-exhaustion.test.ts` proves that opening
 * 25 short-lived connections through `createPgClient` succeeds where the
 * unconfigured (`max: 10`) form would queue and time out.
 */

import postgres from 'postgres';
import { PostgresConfigError, parsePostgresConfig } from '../server/bootstrap/server-config.js';
import type { PostgresClientConfig } from '../server/bootstrap/types.js';

/**
 * Apply the validated `PostgresClientConfig` to a `postgres-js` client
 * options object. Pure — does not read environment variables or open a
 * connection. Exported for tests and callers that have already parsed the
 * config (e.g. the primary bootstrap phase).
 */
export function buildPostgresOptions(config: PostgresClientConfig): postgres.Options<{}> {
  return {
    max: config.max,
    idle_timeout: config.idleTimeoutSeconds,
    max_lifetime: config.maxLifetimeSeconds,
    connect_timeout: config.connectTimeoutSeconds,
    connection: { application_name: config.applicationName },
    ssl:
      config.ssl === 'disable'
        ? false
        : config.ssl === 'require' || config.ssl === 'prefer'
          ? config.ssl
          : undefined,
  };
}

/**
 * Construct a configured `postgres-js` client.
 *
 * @param connectionString - DSN (e.g. `postgres://user:pass@host:5432/db`).
 * @param config - Optional pre-parsed config; if omitted the function reads
 *   environment variables via `parsePostgresConfig`.
 * @throws {PostgresConfigError} If env-var-driven configuration is invalid.
 */
export function createPgClient(
  connectionString: string,
  config?: PostgresClientConfig
): ReturnType<typeof postgres> {
  const resolved = config ?? parsePostgresConfig(process.env);
  return postgres(connectionString, buildPostgresOptions(resolved));
}

export type { PostgresClientConfig };
// Re-export so callers don't have to reach into the bootstrap module.
export { PostgresConfigError, parsePostgresConfig };
