#!/usr/bin/env bun
/**
 * One-off: bring the persisted `default_model` setting in line with the
 * `DEFAULT_AGENT_MODEL` constant. Earlier in the project the constant was
 * bumped to `claude-opus-4-7`, but a stale row in the SQLite settings table
 * still pinned the resolver to `claude-opus-4-6`, so the "Agent started"
 * banner kept reporting the old model.
 *
 * Idempotent: re-running on an already-correct row is a no-op.
 */
import { Database as BunSQLite } from 'bun:sqlite';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { settings } from '../src/db/schema/index.js';
import { DEFAULT_AGENT_MODEL } from '../src/lib/constants/models.js';

const dbPath = resolve(import.meta.dir, '..', process.env.DB_PATH ?? 'data/agentpane.db');
const sqlite = new BunSQLite(dbPath);
const db = drizzle(sqlite);

const TARGET = JSON.stringify(DEFAULT_AGENT_MODEL);

async function main() {
  const existing = await db.select().from(settings).where(eq(settings.key, 'default_model'));

  if (existing.length === 0) {
    await db.insert(settings).values({
      key: 'default_model',
      value: TARGET,
      // touch the timestamps so audit views show this as a recent change
      updatedAt: new Date().toISOString(),
    });
    console.log(`[fix-default-model] inserted default_model=${TARGET}`);
  } else if (existing[0].value !== TARGET) {
    await db
      .update(settings)
      .set({ value: TARGET, updatedAt: new Date().toISOString() })
      .where(eq(settings.key, 'default_model'));
    console.log(`[fix-default-model] updated default_model: ${existing[0].value} -> ${TARGET}`);
  } else {
    console.log(`[fix-default-model] default_model already ${TARGET}, no change`);
  }

  // Drop the orphan `general.agentModel` row — nothing in the resolver reads
  // it, the Settings UI writes to `default_model` instead. Leaving it around
  // confuses anyone inspecting the DB looking for the source of truth.
  const orphan = await db.select().from(settings).where(eq(settings.key, 'general.agentModel'));
  if (orphan.length > 0) {
    await db.delete(settings).where(eq(settings.key, 'general.agentModel'));
    console.log('[fix-default-model] deleted orphan general.agentModel row');
  }

  sqlite.close();
}

main().catch((err) => {
  console.error('[fix-default-model] failed:', err);
  process.exit(1);
});
