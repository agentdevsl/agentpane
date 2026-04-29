/**
 * Server Configuration (CB-003)
 *
 * Zod-based validation of environment variables at startup.
 * Replaces the minimal validateEnv() function from api.ts.
 */

import { z } from 'zod';
import { isDevAuthAllowed } from '../../lib/api/dev-auth.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { PostgresClientConfig, ServerConfig } from './types.js';

const log = createLogger('ServerConfig');

/**
 * Zod schema for PostgreSQL pool / client configuration (F02-05).
 * Values are validated at boot — invalid configuration aborts startup.
 */
const PostgresConfigSchema = z.object({
  /** Maximum pool connections. Must be >= 1. */
  max: z.coerce.number().int().min(1).max(1000).default(10),
  /** Seconds a connection may remain idle. 0 disables closing idle handles. */
  idleTimeoutSeconds: z.coerce.number().int().min(0).max(86_400).default(30),
  /** Maximum connection lifetime in seconds. 0 disables. */
  maxLifetimeSeconds: z.coerce.number().int().min(0).max(86_400).default(1800),
  /** Seconds to wait for a new connection. Must be >= 1. */
  connectTimeoutSeconds: z.coerce.number().int().min(1).max(600).default(10),
  /** pg_stat_activity application_name value. */
  applicationName: z.string().min(1).max(64).default('agentpane'),
  /** SSL mode. Undefined leaves driver default. */
  ssl: z.enum(['disable', 'require', 'prefer']).optional(),
});

/**
 * Zod schema for server configuration.
 * Validates and coerces environment variables into typed config.
 */
const ServerConfigSchema = z.object({
  dbMode: z.enum(['sqlite', 'postgres']).default('sqlite'),
  databaseUrl: z.string().optional(),
  dbPath: z.string().default('./data/agentpane.db'),
  port: z.coerce.number().int().min(1).max(65535).default(3001),
  corsOrigin: z.string().default('http://localhost:3000'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('debug'),
  nodeEnv: z.string().default('development'),
  skipAuth: z.coerce.boolean().default(false),
  sandboxInitTimeoutMs: z.coerce.number().int().min(1000).default(120_000),
  caddyStreamsUrl: z.string().optional(),
  /**
   * F06-NEW-02 (P0) — Multi-tenant deployment gate (arch29-W1-E).
   *
   * When `true`, the platform is hosting workloads for more than one tenant
   * and shared-sandbox mode (single Anthropic OAuth credentials file, single
   * `/workspace` bind mount, no per-tenant uid/FS isolation) is FORBIDDEN.
   * In that mode the container-exec service and credentials injector must
   * refuse to operate when the resolved sandbox mode is `shared`, because
   * any tenant agent could read another tenant's OAuth token from the
   * shared credentials file.
   *
   * Default: `false` for self-hosted single-team installs (no behaviour
   * change). Hosted / multi-tenant deployments must explicitly opt in by
   * setting `MULTI_TENANT=true` in the environment.
   *
   * The full multi-tenant FS/UID isolation rebuild is L-effort and tracked
   * as a follow-up; this gate is the fail-safe so accidental shared-mode
   * usage cannot silently leak credentials across tenants.
   */
  multiTenant: z.coerce.boolean().default(false),
  postgres: PostgresConfigSchema,
});

/**
 * Parse Postgres env vars into a typed config.
 * Throws via `parseServerConfig` if values are invalid.
 */
export function parsePostgresConfig(env: NodeJS.ProcessEnv = process.env): PostgresClientConfig {
  const raw = {
    max: env.POSTGRES_MAX,
    idleTimeoutSeconds: env.POSTGRES_IDLE_TIMEOUT,
    maxLifetimeSeconds: env.POSTGRES_MAX_LIFETIME,
    connectTimeoutSeconds: env.POSTGRES_CONNECT_TIMEOUT,
    applicationName: env.POSTGRES_APPLICATION_NAME,
    ssl: env.POSTGRES_SSL,
  };
  const result = PostgresConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new PostgresConfigError(`Invalid PostgreSQL configuration: ${issues.join('; ')}`);
  }
  return {
    max: result.data.max,
    idleTimeoutSeconds: result.data.idleTimeoutSeconds,
    maxLifetimeSeconds: result.data.maxLifetimeSeconds,
    connectTimeoutSeconds: result.data.connectTimeoutSeconds,
    applicationName: result.data.applicationName,
    ssl: result.data.ssl,
  };
}

/** Typed error thrown when Postgres configuration is invalid at boot. */
export class PostgresConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresConfigError';
  }
}

/**
 * F06-NEW-02 / arch29-W1-E — Multi-tenant deployment gate helper.
 *
 * Reads the `MULTI_TENANT` env var directly (not from a cached config object)
 * because:
 *
 *  - Service-layer code paths (`container-exec.service.ts`, `credentials-injector.ts`)
 *    do not have access to the bootstrap-time `ServerConfig` instance.
 *  - Sub-processes spawn with the inherited environment, so a single helper
 *    that reads from `process.env` ensures the gate is consistent everywhere.
 *  - This mirrors the `isDevAuthAllowed` pattern in `src/lib/api/dev-auth.ts`.
 *
 * Returns `true` ONLY when `MULTI_TENANT=true`. Any other value (unset,
 * `false`, `0`, garbage) returns `false` — self-hosted single-team installs
 * see no behaviour change.
 *
 * @param env - Optional environment object for testing. Defaults to
 *   `process.env`. Tests can inject a stub without mutating globals.
 */
export function isMultiTenantEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MULTI_TENANT === 'true';
}

/**
 * Parse and validate server configuration from environment variables.
 * Logs warnings for notable settings and exits on fatal misconfigurations.
 */
export function parseServerConfig(): ServerConfig {
  // Parse Postgres pool config separately so we can surface a typed error.
  let postgresConfig: PostgresClientConfig;
  try {
    postgresConfig = parsePostgresConfig(process.env);
  } catch (err) {
    if (err instanceof PostgresConfigError) {
      log.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const raw = {
    dbMode: process.env.DB_MODE,
    databaseUrl: process.env.DATABASE_URL,
    dbPath: process.env.DB_PATH,
    port: process.env.PORT,
    corsOrigin: process.env.CORS_ORIGIN,
    logLevel: process.env.LOG_LEVEL,
    nodeEnv: process.env.NODE_ENV,
    skipAuth: process.env.SKIP_AUTH,
    sandboxInitTimeoutMs: process.env.SANDBOX_INIT_TIMEOUT_MS,
    caddyStreamsUrl: process.env.CADDY_STREAMS_URL,
    multiTenant: process.env.MULTI_TENANT,
    postgres: postgresConfig,
  };

  const result = ServerConfigSchema.safeParse(raw);

  if (!result.success) {
    log.error('Invalid server configuration', {
      data: {
        errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
    process.exit(1);
  }

  const config = result.data;
  const isProduction = config.nodeEnv === 'production';

  // Resolve Caddy streams URL with environment-aware default
  const resolvedCaddyStreamsUrl =
    config.caddyStreamsUrl ??
    (isProduction ? 'http://localhost:3000/v1/stream' : 'http://localhost:3002/v1/stream');

  // Validate postgres requires DATABASE_URL
  if (config.dbMode === 'postgres' && !config.databaseUrl) {
    log.error('DATABASE_URL is required when DB_MODE=postgres');
    process.exit(1);
  }

  // Log warnings
  if (isProduction && config.corsOrigin === 'http://localhost:3000') {
    log.warn('CORS_ORIGIN not set - defaulting to http://localhost:3000');
  }

  // F06-05: route the production gate through the shared helper so the
  // three places that care about dev-auth all agree. The helper looks at
  // live env vars (not config.skipAuth) because sub-processes spawn with
  // inherited env and we want the same gate.
  if (config.skipAuth && config.nodeEnv === 'production') {
    log.error('SKIP_AUTH=true cannot be used in production');
    process.exit(1);
  }
  // Parity check: if the helper disagrees with the local opinion, abort.
  // This catches out-of-band env mutations between config parse and
  // bootstrap completion.
  if (
    config.skipAuth &&
    !isDevAuthAllowed({ ...process.env, SKIP_AUTH: 'true', NODE_ENV: config.nodeEnv })
  ) {
    log.error(
      'SKIP_AUTH=true but isDevAuthAllowed() returned false — env is in an inconsistent state'
    );
    process.exit(1);
  }

  if (config.skipAuth) {
    log.warn(
      'SKIP_AUTH=true is set - authentication is bypassed. All requests will use dev-user identity. Do NOT use in production.'
    );
  }

  // F06-NEW-02 / arch29-W1-E: surface the multi-tenant gate explicitly so
  // operators can see which mode they booted into. The gate's enforcement
  // happens at the container-exec / credentials-injector chokepoints; this
  // log is purely informational at boot.
  if (config.multiTenant) {
    log.warn(
      'MULTI_TENANT=true is set - shared sandbox mode is FORBIDDEN. The container-exec service and credentials injector will refuse to operate when the resolved sandbox mode is "shared". Configure per-codespace sandboxes for every codespace before starting agents.'
    );
  }

  log.info('Environment validated', {
    data: {
      nodeEnv: config.nodeEnv,
      dbMode: config.dbMode,
      port: config.port,
      corsOrigin: config.corsOrigin,
      skipAuth: config.skipAuth,
      multiTenant: config.multiTenant,
    },
  });

  return {
    ...config,
    caddyStreamsUrl: resolvedCaddyStreamsUrl,
  };
}
