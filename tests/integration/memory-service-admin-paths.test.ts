/**
 * Integration tests for MemoryService admin and lifecycle methods that
 * aren't already exercised by memory-service.integration.test.ts.
 *
 * Focus:
 *   - updateInsight / approveInsight / rejectInsight wrappers
 *   - search returning SearchResult shape
 *   - healthCheck try/catch (success path)
 *   - finalizeSession with derive failure (swallowed)
 *   - captureMessage swallowing store errors
 *   - getContext error fallback to EMPTY_CONTEXT
 *
 * Run: npx vitest run --project integration tests/integration/memory-service-admin-paths.test.ts
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codespaces } from '../../src/db/schema';
import type {
  InsightDeriverInterface,
  MemoryStoreInterface,
} from '../../src/services/memory/memory.service';
import { MemoryService } from '../../src/services/memory/memory.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

const MEMORY_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS memory_insights (
    id TEXT PRIMARY KEY,
    codespace_id TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    source_session_id TEXT,
    skill_id TEXT,
    tags TEXT,
    metadata TEXT,
    status TEXT DEFAULT 'active',
    category TEXT,
    effectiveness_score REAL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS memory_messages (
    id TEXT PRIMARY KEY,
    codespace_id TEXT NOT NULL,
    memory_session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    turn_number INTEGER NOT NULL,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS memory_insights_codespace_idx ON memory_insights(codespace_id);
  CREATE INDEX IF NOT EXISTS memory_messages_session_idx ON memory_messages(memory_session_id);
`;

function ensureMemoryTables() {
  try {
    for (const stmt of MEMORY_TABLES_SQL.split(';').filter((s) => s.trim())) {
      execRawSql(stmt);
    }
  } catch {
    /* tables may already exist */
  }
}

describe('MemoryService admin + lifecycle coverage gaps', () => {
  let service: MemoryService;
  let codespaceId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    ensureMemoryTables();
    const db = getTestDb();
    const cs = await createTestProject({ name: 'Memory svc admin' });
    codespaceId = cs.id;
    // Build a real service with real store + a stub deriver so finalizeSession
    // exercises the swallow path without needing Anthropic.
    const realService = new MemoryService({} as never, db as never);
    // Replace the deriver with a controllable double via private field access
    (realService as unknown as { deriver: InsightDeriverInterface }).deriver = {
      deriveInsights: async () => ({
        ok: false,
        error: { code: 'M_DERIVE_FAIL', message: 'simulated' },
      }),
    } as never;
    service = realService;
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('initialize() and isAvailable()', async () => {
    await service.initialize();
    expect(service.isAvailable()).toBe(true);
  });

  it('createInsight + updateInsight + approveInsight + rejectInsight + deleteInsight + search round-trip', async () => {
    const created = await service.createInsight(codespaceId, 'pattern X', 'manual', undefined, [
      'auth',
    ]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;

    const updated = await service.updateInsight(id, { content: 'pattern X v2' });
    expect(updated.ok).toBe(true);

    const approved = await service.approveInsight(id);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.status).toBe('active');

    const rejected = await service.rejectInsight(id);
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.status).toBe('rejected');

    // Re-approve so search (status='active' filter) can find it
    await service.approveInsight(id);

    const found = await service.search(codespaceId, 'pattern');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.length).toBeGreaterThan(0);
    expect(found.value[0].type).toBe('insight');

    const deleted = await service.deleteInsight(id);
    expect(deleted.ok).toBe(true);
  });

  it('healthCheck returns counts and available=true on the happy path', async () => {
    await service.createInsight(codespaceId, 'one', 'manual');
    await service.createInsight(codespaceId, 'two', 'manual');
    const health = await service.healthCheck();
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    expect(health.value.available).toBe(true);
    expect(health.value.insightCount).toBeGreaterThanOrEqual(2);
  });

  it('startSession returns a ref with the right ids', async () => {
    const ref = await service.startSession({
      codespaceId,
      agentId: 'agent-1',
      taskId: 'task-1',
    });
    expect(ref).not.toBeNull();
    expect(ref?.codespaceId).toBe(codespaceId);
    expect(ref?.agentId).toBe('agent-1');
    expect(ref?.taskId).toBe('task-1');
    expect(ref?.memorySessionId).toBeTruthy();
  });

  it('finalizeSession swallows deriver returning err (lifecycle method, never throws)', async () => {
    const ref = await service.startSession({
      codespaceId,
      agentId: 'agent-finalize',
      taskId: 'task-finalize',
    });
    expect(ref).not.toBeNull();
    if (!ref) return;
    // The deriver double returns err — finalizeSession must swallow and
    // return undefined without throwing.
    await expect(service.finalizeSession(ref, { status: 'completed' })).resolves.toBeUndefined();
  });

  it('finalizeSession swallows deriver throwing (catch block)', async () => {
    (service as unknown as { deriver: InsightDeriverInterface }).deriver = {
      deriveInsights: async () => {
        throw new Error('deriver exploded');
      },
    } as never;
    const ref = await service.startSession({
      codespaceId,
      agentId: 'agent-throw',
      taskId: 'task-throw',
    });
    expect(ref).not.toBeNull();
    if (!ref) return;
    await expect(service.finalizeSession(ref)).resolves.toBeUndefined();
  });

  it('captureMessage swallows store errors (lifecycle method)', async () => {
    // Replace store with one whose insertMessage throws
    const realService = service;
    (realService as unknown as { store: MemoryStoreInterface }).store = {
      ...(realService.getStore() as never),
      insertMessage: async () => {
        throw new Error('store down');
      },
    } as never;
    const ref = await realService.startSession({
      codespaceId,
      agentId: 'agent-capture',
      taskId: 'task-capture',
    });
    expect(ref).not.toBeNull();
    if (!ref) return;

    await expect(
      realService.captureMessage(ref, {
        role: 'user',
        content: 'will swallow',
        turnNumber: 0,
      })
    ).resolves.toBeUndefined();
  });

  it('getContext returns ok with EMPTY_CONTEXT when assembleContext throws', async () => {
    (service as unknown as { store: MemoryStoreInterface }).store = {
      ...(service.getStore() as never),
      assembleContext: async () => {
        throw new Error('context oops');
      },
    } as never;
    const result = await service.getContext(codespaceId, 'anything');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('');
    expect(result.value.tokenCount).toBe(0);
    expect(result.value.sources.insights).toBe(0);
  });

  it('getInsights with filters reaches the store', async () => {
    await service.createInsight(
      codespaceId,
      'pat',
      'manual',
      undefined,
      undefined,
      undefined,
      'active',
      'pattern'
    );
    const result = await service.getInsights(
      codespaceId,
      { limit: 10 },
      { status: 'active', category: 'pattern' }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
  });

  it('getStore exposes the underlying MemoryStoreService', () => {
    const store = service.getStore();
    expect(store).toBeDefined();
    expect(typeof store.insertInsight).toBe('function');
  });

  it('codespace exists check for cleanup safety', async () => {
    const db = getTestDb();
    const cs = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespaceId),
    });
    expect(cs).toBeTruthy();
  });
});
