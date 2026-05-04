#!/usr/bin/env bun
/**
 * One-off: zero out `durationMs` on synthetic orphan-flush tool:result
 * events. The previous reconcile flush computed the duration as
 * `Date.now() - startTimestamp`, which counted the wall-clock idle
 * time between the agent runner crashing and reconcile running — so
 * tools that actually ran for milliseconds showed bogus durations
 * like "21m 46s" in the UI. The reconcile path now emits 0; this
 * cleans up rows already written before that fix.
 *
 * Idempotent: runs only against rows whose `result` matches the
 * synthetic message. Safe to re-run.
 */
import { Database as BunSQLite } from 'bun:sqlite';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { sessionEvents } from '../src/db/schema/index.js';

const dbPath = resolve(import.meta.dir, '..', process.env.DB_PATH ?? 'data/agentpane.db');
const sqlite = new BunSQLite(dbPath);
const db = drizzle(sqlite);

const SYNTHETIC_RESULT = 'Agent runner terminated before this tool returned';

async function main() {
  // Drizzle's column-level `data` is JSON-stored-as-text; we patch via
  // json_set in raw SQL because Drizzle has no first-class JSON-update
  // primitive. The WHERE clause filters to synthetic rows only.
  const result = await db.run(
    sql`UPDATE ${sessionEvents}
        SET data = json_set(data, '$.durationMs', 0)
        WHERE type = 'container-agent:tool:result'
          AND json_extract(data, '$.result') = ${SYNTHETIC_RESULT}
          AND json_extract(data, '$.durationMs') > 0`
  );
  console.log(`[fix-synthetic-tool-results] patched ${result.changes ?? 0} row(s)`);
  sqlite.close();
}

main().catch((err) => {
  console.error('[fix-synthetic-tool-results] failed:', err);
  process.exit(1);
});
