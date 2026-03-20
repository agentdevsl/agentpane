/**
 * Server Configuration (CB-003)
 *
 * Zod-based validation of environment variables at startup.
 * Replaces the minimal validateEnv() function from api.ts.
 */

import { z } from 'zod';
import { createLogger } from '../../lib/logging/logger.js';
import type { ServerConfig } from './types.js';

const log = createLogger('ServerConfig');

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
});

/**
 * Parse and validate server configuration from environment variables.
 * Logs warnings for notable settings and exits on fatal misconfigurations.
 */
export function parseServerConfig(): ServerConfig {
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

  if (config.skipAuth && config.nodeEnv === 'production') {
    log.error('SKIP_AUTH=true cannot be used in production');
    process.exit(1);
  }

  if (config.skipAuth) {
    log.warn(
      'SKIP_AUTH=true is set - authentication is bypassed. All requests will use dev-user identity. Do NOT use in production.'
    );
  }

  log.info('Environment validated', {
    data: {
      nodeEnv: config.nodeEnv,
      dbMode: config.dbMode,
      port: config.port,
      corsOrigin: config.corsOrigin,
      skipAuth: config.skipAuth,
    },
  });

  return {
    ...config,
    caddyStreamsUrl: resolvedCaddyStreamsUrl,
  };
}
