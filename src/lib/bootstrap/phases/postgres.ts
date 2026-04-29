import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type postgres from 'postgres';
import { createPgClient } from '../../../db/postgres-client.js';
import * as pgSchema from '../../../db/schema/postgres/index.js';
import { createError } from '../../errors/base.js';
import { errorMessage } from '../../utils/error-message';
import { err, ok } from '../../utils/result.js';
import type { BootstrapContext } from '../types.js';

export const initializePostgres = async (_ctx: BootstrapContext) => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return err(
      createError('BOOTSTRAP_PG_INIT_FAILED', 'DATABASE_URL is required when DB_MODE=postgres', 500)
    );
  }

  let client: ReturnType<typeof postgres> | null = null;

  try {
    // F02-17 (arch29-W2-R): centralised pool / timeout / SSL config via
    // `createPgClient` so this legacy bootstrap path matches the primary
    // path. Without this the legacy callers were stuck on postgres-js
    // defaults (`max: 10`, no idle close, no `application_name`).
    client = createPgClient(connectionString);
  } catch (error) {
    return err(
      createError('BOOTSTRAP_PG_INIT_FAILED', 'Failed to create PostgreSQL client', 500, {
        error: errorMessage(error),
      })
    );
  }

  try {
    await client`SELECT 1 as test`;
  } catch (error) {
    await client.end().catch(() => {
      // Best-effort: connection cleanup after failed connection test
    });
    return err(
      createError('BOOTSTRAP_PG_INIT_FAILED', 'PostgreSQL connection test failed', 500, {
        error: errorMessage(error),
      })
    );
  }

  try {
    const db = drizzle(client, { schema: pgSchema });
    await migrate(db, { migrationsFolder: './src/db/migrations-pg' });
    return ok(db);
  } catch (error) {
    await client.end().catch(() => {
      // Best-effort: connection cleanup after failed migration
    });
    return err(
      createError('BOOTSTRAP_PG_INIT_FAILED', 'PostgreSQL migration failed', 500, {
        error: errorMessage(error),
      })
    );
  }
};
