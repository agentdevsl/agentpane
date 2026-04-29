/**
 * F02-15 (P0): SchedulerService dialect compatibility against Postgres.
 *
 * The April 29 review found 12+ SQLite-specific raw SQL fragments
 * (`json_set`, `json_extract`, `datetime('now')`) issued by
 * `SchedulerService` on the dual-dialect `Database` type. With
 * `DB_MODE=postgres` set, every cron tick raised
 * `function json_set(jsonb, text, text) does not exist` and the
 * scheduler was fully broken at runtime.
 *
 * This test exercises the public scheduler API paths that previously
 * called those functions, verifying they now work on Postgres:
 *
 *   - `triggerManual()` (json_set + datetime('now') in manual update)
 *   - `pauseSource()` (json_set on pausedAt + status)
 *   - `resumeSource()` (3-way json_set cascade + is_enabled boolean)
 *   - `start()` -> internal `tick()` (json_extract in WHERE clause)
 *
 * Without the F02-15 fix, every test below FAILS with
 * `function json_set(jsonb, text, text) does not exist` (or similar).
 * With the fix, they PASS — the SQL is portable across both dialects.
 *
 * Gating
 * ------
 * Gated behind `POSTGRES_INTEGRATION=true` so CI does not require Docker
 * unless the opt-in env var is set. The describe.skip placeholder runs
 * when disabled so test reports show the file as "skipped" not "empty".
 *
 * Local dev:
 *   docker compose -f docker/docker-compose.postgres.yml up -d
 *   POSTGRES_INTEGRATION=true \
 *     POSTGRES_URL=postgres://agentpane:agentpane_dev@localhost:5432/agentpane_test \
 *     bun vitest run tests/integration/scheduler-pg.test.ts
 *
 * Note: Use a DEDICATED test database. Setup issues
 * `DROP SCHEMA ... CASCADE` to start from a clean slate.
 */
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pgSchema from '../../src/db/schema/postgres/index.js';
import type { CronEventSourceConfig } from '../../src/db/schema/shared/cron-config.js';
import { _resetDbDialectCacheForTests } from '../../src/lib/db/dialect.js';
import { CronEventSourcePlugin } from '../../src/lib/events/plugins/cron-plugin.js';
import { SchedulerService } from '../../src/services/scheduler.service.js';
import type { Database } from '../../src/types/database.js';

const ENABLED = process.env.POSTGRES_INTEGRATION === 'true';
const URL = process.env.POSTGRES_URL;

type Pg = ReturnType<typeof postgres>;

async function resetSchema(client: Pg): Promise<void> {
  await client`DROP SCHEMA IF EXISTS public CASCADE`;
  await client`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await client`CREATE SCHEMA public`;
  await client`GRANT ALL ON SCHEMA public TO CURRENT_USER`;
}

const suite = ENABLED && URL ? describe : describe.skip;

suite('F02-15: SchedulerService Postgres dialect compatibility', () => {
  let client: Pg | null = null;
  let db: Database;
  let scheduler: SchedulerService;
  const TEAM_ID = 'team-pg-scheduler';

  beforeAll(async () => {
    process.env.DB_MODE = 'postgres';
    _resetDbDialectCacheForTests();

    client = postgres(URL!, { max: 4, idle_timeout: 1 });
    await resetSchema(client);
    const drizzleDb = drizzlePg(client, { schema: pgSchema });
    await migratePg(drizzleDb, { migrationsFolder: './src/db/migrations-pg' });

    db = drizzleDb as unknown as Database;

    // Seed a team so event_sources FK is satisfied.
    await client`
      INSERT INTO teams (id, name, slug, owner_id)
      VALUES (${TEAM_ID}, 'Scheduler PG Test', 'scheduler-pg-test', 'system')
      ON CONFLICT (id) DO NOTHING
    `;

    // Build minimal stubs for the scheduler's collaborators. The SQL paths
    // exercised by this test do not invoke the plugin or processing service.
    const registry = {
      get: () => new CronEventSourcePlugin(),
      register: () => {},
      getRegisteredTypes: () => ['cron'],
    } as unknown as ConstructorParameters<typeof SchedulerService>[1];

    const eventProcessing = {
      processScheduledEvent: async () =>
        ({
          ok: true,
          value: {
            status: 'processed',
            tasksCreated: [],
            matchCount: 0,
            eventLogId: 'el-1',
          },
        }) as never,
    } as unknown as ConstructorParameters<typeof SchedulerService>[2];

    const eventSources = {
      getById: async (id: string) => {
        const rows = await client!<
          Array<{
            id: string;
            team_id: string;
            name: string;
            type: string;
            slug: string;
            webhook_secret: string | null;
            is_enabled: boolean;
            config: Record<string, unknown>;
            event_count: number;
            last_event_at: string | null;
            status: string;
            created_at: string;
            updated_at: string;
          }>
        >`SELECT * FROM event_sources WHERE id = ${id}`;
        const row = rows[0];
        if (!row) {
          return {
            ok: false,
            error: { code: 'EVENT_SOURCE_NOT_FOUND', message: 'Not found', status: 404 },
          };
        }
        return {
          ok: true,
          value: {
            id: row.id,
            teamId: row.team_id,
            name: row.name,
            type: row.type,
            slug: row.slug,
            webhookSecret: row.webhook_secret,
            isEnabled: row.is_enabled,
            config: row.config,
            eventCount: row.event_count,
            lastEventAt: row.last_event_at,
            githubInstallationId: null,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        };
      },
      decryptSecret: () => null,
      incrementEventCount: async () => ({ ok: true, value: undefined }),
    } as unknown as ConstructorParameters<typeof SchedulerService>[3];

    scheduler = new SchedulerService(db, registry, eventProcessing, eventSources);
  });

  afterAll(async () => {
    if (scheduler) {
      await scheduler.stop().catch(() => {});
    }
    if (client) {
      await client.end({ timeout: 5 });
    }
    delete process.env.DB_MODE;
    _resetDbDialectCacheForTests();
  });

  /**
   * Insert a cron event_source with a config blob via raw SQL so the
   * test does not depend on the codebase's EventSourceService.create()
   * (which hashes the slug etc).
   */
  async function insertCronSource(
    id: string,
    overrides: Partial<CronEventSourceConfig> = {},
    extras: { isEnabled?: boolean; status?: 'active' | 'disabled' | 'error' } = {}
  ): Promise<void> {
    const config: CronEventSourceConfig = {
      scheduleType: 'interval',
      interval: 60,
      timezone: 'UTC',
      budget: {},
      // Default: nextRunAt is 60 seconds in the past so tick() picks it up.
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      lastRunAt: new Date(Date.now() - 120_000).toISOString(),
      consecutiveErrors: 0,
      pausedAt: null,
      ...overrides,
    };
    const isEnabled = extras.isEnabled ?? true;
    const status = extras.status ?? 'active';

    await client!`
      INSERT INTO event_sources
        (id, team_id, name, type, slug, is_enabled, config, event_count, status, created_at, updated_at)
      VALUES (
        ${id},
        ${TEAM_ID},
        ${`Test ${id}`},
        'cron',
        ${`slug-${id}`},
        ${isEnabled},
        ${JSON.stringify(config)}::jsonb,
        0,
        ${status},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
    `;
  }

  async function getConfig(id: string): Promise<CronEventSourceConfig> {
    const rows = await client!<{ config: CronEventSourceConfig }[]>`
      SELECT config FROM event_sources WHERE id = ${id}
    `;
    return rows[0]!.config;
  }

  // ---------------------------------------------------------------------------
  // triggerManual() — exercises json_set/json_set/datetime('now') manual path
  // ---------------------------------------------------------------------------

  it('triggerManual() updates nextRunAt and lastRunAt on Postgres', async () => {
    const id = 'src-manual';
    await insertCronSource(id);

    // Without F02-15: throws `function json_set(jsonb, text, text) does not exist`.
    const result = await scheduler.triggerManual(id);
    expect(result.ok).toBe(true);

    const after = await getConfig(id);
    expect(typeof after.nextRunAt).toBe('string');
    expect(typeof after.lastRunAt).toBe('string');
    // The nextRunAt should be advanced beyond the 60s-ago seed.
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  // ---------------------------------------------------------------------------
  // pauseSource() — exercises json_set on pausedAt + status update
  // ---------------------------------------------------------------------------

  it('pauseSource() sets status=disabled and writes pausedAt via portable jsonb_set', async () => {
    const id = 'src-pause';
    await insertCronSource(id);

    // Without F02-15: throws on jsonb_set vs json_set mismatch.
    const result = await scheduler.pauseSource(id);
    expect(result.ok).toBe(true);

    const rows = await client!<
      { status: string; config: CronEventSourceConfig }[]
    >`SELECT status, config FROM event_sources WHERE id = ${id}`;
    expect(rows[0]!.status).toBe('disabled');
    expect(typeof rows[0]!.config.pausedAt).toBe('string');
  });

  // ---------------------------------------------------------------------------
  // resumeSource() — exercises 3-way json_set cascade + boolean is_enabled
  // ---------------------------------------------------------------------------

  it('resumeSource() resets consecutiveErrors, clears pausedAt, advances nextRunAt', async () => {
    const id = 'src-resume';
    await insertCronSource(
      id,
      { consecutiveErrors: 3, pausedAt: new Date().toISOString() },
      { status: 'disabled' }
    );

    // Without F02-15: 3-way json_set cascade + `is_enabled = 1` (PG wants TRUE)
    // both fail. With the fix: jsonSetMany dispatches per dialect and the JS
    // boolean literal is correctly encoded by the postgres-js driver.
    const result = await scheduler.resumeSource(id);
    expect(result.ok).toBe(true);

    const after = await getConfig(id);
    expect(after.consecutiveErrors).toBe(0);
    expect(after.pausedAt).toBeNull();
    expect(typeof after.nextRunAt).toBe('string');
  });

  // ---------------------------------------------------------------------------
  // tick() WHERE clause — exercises json_extract on PG (`#>>`)
  // ---------------------------------------------------------------------------

  it('start() runs tick() against Postgres without raising json_extract errors', async () => {
    // Insert a fresh source that's overdue so tick() picks it up.
    const id = 'src-tick';
    await insertCronSource(id);

    // start() runs recoverSchedules() then an immediate tick(). The tick's
    // WHERE clause uses json_extract / `#>>` to compare nextRunAt <= now.
    // Without F02-15 this raises `function json_extract(jsonb, unknown) does
    // not exist`. With the fix: dialect-aware extract picks the right
    // function per backend.
    await scheduler.start();
    try {
      // Wait a tiny tick for the async tick path to settle.
      await new Promise((r) => setTimeout(r, 100));

      // The source should have been processed: lastRunAt updated and/or
      // nextRunAt advanced past the original 60s-ago seed.
      const after = await getConfig(id);
      expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now() - 1000);
    } finally {
      await scheduler.stop();
    }
  });
});

if (!ENABLED || !URL) {
  describe.skip('F02-15 scheduler PG compat (gated)', () => {
    it('set POSTGRES_INTEGRATION=true and POSTGRES_URL to enable', () => {
      expect(true).toBe(true);
    });
  });
}
