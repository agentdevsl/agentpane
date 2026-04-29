/**
 * Regression test for F03-12 — `containerAgentService.reconcile()` is now
 * invoked by the bootstrap reconciliation path. Before fix: dead code (no
 * caller); orphaned `tasks.column='in_progress'` tasks left over from a
 * previous server crash sit at `in_progress` indefinitely. After fix:
 * `runSandboxReconciliation()` calls `reconcile()` after the sandbox
 * provider comes up, and the orphan task is moved back to `backlog`.
 *
 * The test exercises `runSandboxReconciliation` directly with a stubbed
 * sandbox provider + container-agent service so the contract is asserted
 * end-to-end: bootstrap's reconciliation phase causes the orphan task to
 * move. On `main` the wire is missing, so reconcile() is never invoked
 * and the orphan remains.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { runSandboxReconciliation } from '../../src/server/bootstrap/sandbox/sandbox-init.js';
import type { SandboxState, ServiceContainer } from '../../src/server/bootstrap/types.js';
import { createContainerAgentService } from '../../src/services/container-agent.service.js';
import type { DurableStreamsService } from '../../src/services/durable-streams.service.js';
import { createTestProject } from '../factories/project.factory.js';
import { createTestTask } from '../factories/task.factory.js';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database.js';

function makeNoopStreams(): DurableStreamsService {
  return {
    publish: vi.fn(async () => ({ ok: true, value: 0 })),
    publishWithBackpressure: vi.fn(async () => ({ ok: true, value: { offset: 0 } })),
    createStream: vi.fn(async () => ({ ok: true, value: undefined })),
    deleteStream: vi.fn(async () => undefined),
  } as unknown as DurableStreamsService;
}

function makeNoopProvider() {
  return {
    name: 'test-provider',
    create: vi.fn(),
    getById: vi.fn(),
    isImageAvailable: vi.fn(),
    pullImage: vi.fn(),
    healthCheck: vi.fn(async () => ({ healthy: true })),
    list: vi.fn(async () => []),
  };
}

function makeNoopApiKeyService() {
  return {
    getDecryptedKey: vi.fn(async () => null),
  };
}

function makeSandboxState(
  containerAgentService: ServiceContainer['containerAgentService']
): SandboxState {
  return {
    provider: { name: 'test-provider', list: async () => [] } as any,
    containerAgentService,
    k8sProvider: null,
    nomadProvider: null,
    controller: null,
    k8sHealInterval: null,
    nomadHealInterval: null,
    retryTimer: null,
    retryCount: 0,
    initializing: false,
    reconciled: false,
  };
}

describe('F03-12 — bootstrap calls containerAgentService.reconcile()', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('moves orphaned in_progress task to backlog through bootstrap reconcile path', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    // Stale task left from a previous server run — process crashed before
    // it could move the task off `in_progress`.
    const orphan = await createTestTask(project.id, {
      column: 'in_progress',
      lastAgentStatus: 'running',
    });

    // Build a fresh container-agent service. Because no agent has been
    // started this run, `state.hasAnyRunningAgent(taskId)` returns false
    // — the task is orphaned by the reconcile() contract.
    const containerAgentService = createContainerAgentService(
      db as any,
      makeNoopProvider() as any,
      makeNoopStreams(),
      makeNoopApiKeyService() as any
    );

    // Spy on reconcile() so we can verify the bootstrap path actually
    // calls it. On `main` this spy never fires because the wire is
    // missing — the test fails. With the fix it fires once.
    const reconcileSpy = vi.spyOn(containerAgentService, 'reconcile');

    const sandboxState = makeSandboxState(containerAgentService);

    const services = {} as any as ServiceContainer;

    await runSandboxReconciliation(db as any, services, sandboxState, 'sqlite');

    // Wire assertion: reconcile() was actually called.
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    // Behavior assertion: orphan task is now in backlog.
    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, orphan.id) });
    expect(dbTask?.column).toBe('backlog');
    expect(dbTask?.lastAgentStatus).toBeNull();

    // The reconciled flag should flip true regardless.
    expect(sandboxState.reconciled).toBe(true);
  });

  it('skips reconcile when containerAgentService is null (no provider yet)', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    // Task that should NOT be touched if reconcile is skipped.
    const task = await createTestTask(project.id, {
      column: 'in_progress',
      lastAgentStatus: 'running',
    });

    const sandboxState = makeSandboxState(null);

    const services = {} as any as ServiceContainer;

    // No throw, no orphan move, but reconciled flag should still flip true.
    await runSandboxReconciliation(db as any, services, sandboxState, 'sqlite');

    expect(sandboxState.reconciled).toBe(true);

    // Task untouched (no reconcile path).
    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.column).toBe('in_progress');
  });
});
