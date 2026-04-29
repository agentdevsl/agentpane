/**
 * Regression test for F04-10 — `SandboxService.create()` must invoke
 * `SandboxConfigService.assertQuota()` before provisioning a new sandbox.
 *
 * Before fix: `assertQuota` exists with zero callers, so a tenant whose
 * config exceeds the deployment quota silently succeeds; the resource
 * cap is fictional. After fix: `create()` reads the active sandbox count
 * from `sandbox_instances`, calls `assertQuota`, and returns
 * `SANDBOX_QUOTA_EXCEEDED` (HTTP 403) without touching the provider.
 *
 * This test uses a stub provider so we never call Docker/K8s — the unit
 * under test is the quota gate itself. Real Drizzle is used per CLAUDE.md.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sandboxInstances } from '../../src/db/schema';
import type { DurableStreamsService } from '../../src/services/durable-streams.service.js';
import { SandboxService } from '../../src/services/sandbox.service.js';
import { SandboxConfigService } from '../../src/services/sandbox-config.service.js';
import { createTestProject } from '../factories/project.factory.js';
import {
  clearTestDatabase,
  execRawSql,
  getTestDb,
  setupTestDatabase,
} from '../helpers/database.js';

// Mock credentials injector to avoid filesystem dependency on
// ~/.claude/.credentials.json — we are testing the quota gate, not the
// real credential-injection path.
vi.mock('../../src/lib/sandbox/credentials-injector.js', () => ({
  createCredentialsInjector: vi.fn().mockReturnValue({
    inject: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    refresh: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  }),
}));

// `sandbox_instances` is not part of the base test migrations — only tests
// that hit the SandboxService need this table. Keep the DDL local so we
// don't pollute the global test schema.
const SANDBOX_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS "sandbox_instances" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "codespace_id" TEXT NOT NULL UNIQUE,
  "container_id" TEXT NOT NULL,
  "status" TEXT DEFAULT 'stopped' NOT NULL,
  "image" TEXT NOT NULL,
  "memory_mb" INTEGER NOT NULL,
  "cpu_cores" INTEGER NOT NULL,
  "idle_timeout_minutes" INTEGER NOT NULL,
  "volume_mounts" TEXT DEFAULT '[]',
  "env" TEXT,
  "error_message" TEXT,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "last_activity_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "stopped_at" TEXT,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);
`;

function makeNoopStreams(): DurableStreamsService {
  return {
    publish: vi.fn(async () => ({ ok: true, value: 0 })),
    publishWithBackpressure: vi.fn(async () => ({ ok: true, value: { offset: 0 } })),
    createStream: vi.fn(async () => ({ ok: true, value: undefined })),
    deleteStream: vi.fn(async () => undefined),
  } as unknown as DurableStreamsService;
}

function makeStubProvider() {
  // Track which provider methods get hit so we can assert that the quota
  // gate fires *before* any provider work happens.
  return {
    name: 'test-provider',
    create: vi.fn(),
    getById: vi.fn(),
    isImageAvailable: vi.fn(async () => true),
    pullImage: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => ({ healthy: true })),
    list: vi.fn(async () => []),
  };
}

describe('F04-10 — SandboxService.create() enforces quota', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    execRawSql(SANDBOX_TABLES_SQL);
  });

  afterEach(async () => {
    try {
      execRawSql('DELETE FROM sandbox_instances');
    } catch {
      // Table may not exist if setup failed.
    }
    await clearTestDatabase();
  });

  it('rejects with SANDBOX_QUOTA_EXCEEDED when active count is at the ceiling', async () => {
    const db = getTestDb();
    // Two separate codespaces because `sandbox_instances.codespace_id` has a
    // UNIQUE constraint — one sandbox per codespace.
    const projectA = await createTestProject({ name: 'A' });
    const projectB = await createTestProject({ name: 'B' });
    const projectC = await createTestProject({ name: 'C' });

    // Pre-seed `sandbox_instances` with two `running` rows so the count
    // is already at the quota ceiling.
    await db.insert(sandboxInstances).values([
      {
        id: 'sb-existing-1',
        codespaceId: projectA.id,
        containerId: 'c-1',
        status: 'running',
        image:
          'ghcr.io/agentdevsl/agent-sandbox@sha256:1111111111111111111111111111111111111111111111111111111111111111',
        memoryMb: 2048,
        cpuCores: 1,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      },
      {
        id: 'sb-existing-2',
        codespaceId: projectB.id,
        containerId: 'c-2',
        status: 'running',
        image:
          'ghcr.io/agentdevsl/agent-sandbox@sha256:2222222222222222222222222222222222222222222222222222222222222222',
        memoryMb: 2048,
        cpuCores: 1,
        idleTimeoutMinutes: 30,
        volumeMounts: [],
      },
    ]);

    const provider = makeStubProvider();
    const sandboxConfigService = new SandboxConfigService(db as any);
    const service = new SandboxService(
      db as any,
      provider as any,
      makeNoopStreams(),
      sandboxConfigService,
      { maxSandboxes: 2, maxCpuCores: 8, maxMemoryMb: 16384 }
    );

    const result = await service.create({
      codespaceId: projectC.id,
      codespacePath: projectC.path,
      image:
        'ghcr.io/agentdevsl/agent-sandbox@sha256:3333333333333333333333333333333333333333333333333333333333333333',
      memoryMb: 4096,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
      volumeMounts: [],
    });

    // Before fix: succeeds silently because no caller invoked assertQuota.
    // After fix: rejects with SANDBOX_QUOTA_EXCEEDED.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_QUOTA_EXCEEDED');
    }

    // Provider must not have been touched — the gate fires before any
    // real provisioning work.
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.isImageAvailable).not.toHaveBeenCalled();
  });

  it('rejects when requested cpuCores exceed the per-sandbox ceiling', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const provider = makeStubProvider();
    const sandboxConfigService = new SandboxConfigService(db as any);
    const service = new SandboxService(
      db as any,
      provider as any,
      makeNoopStreams(),
      sandboxConfigService,
      { maxSandboxes: 10, maxCpuCores: 4, maxMemoryMb: 16384 }
    );

    const result = await service.create({
      codespaceId: project.id,
      codespacePath: project.path,
      image:
        'ghcr.io/agentdevsl/agent-sandbox@sha256:4444444444444444444444444444444444444444444444444444444444444444',
      memoryMb: 4096,
      cpuCores: 8, // exceeds maxCpuCores: 4
      idleTimeoutMinutes: 30,
      volumeMounts: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_QUOTA_EXCEEDED');
    }
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('passes the gate when no quota is configured (backward compatibility)', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    // No quota / no SandboxConfigService passed — quota gate is bypassed
    // and the request reaches the provider. The stub provider throws an
    // expected error (we're not testing the create path here, only that
    // the gate doesn't reject when unconfigured).
    const provider = makeStubProvider();
    provider.create.mockRejectedValueOnce(new Error('expected provider stub'));

    const service = new SandboxService(db as any, provider as any, makeNoopStreams());

    const result = await service.create({
      codespaceId: project.id,
      codespacePath: project.path,
      image:
        'ghcr.io/agentdevsl/agent-sandbox@sha256:5555555555555555555555555555555555555555555555555555555555555555',
      memoryMb: 4096,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
      volumeMounts: [],
    });

    // Reaches the provider (quota gate is off) — provider stub rejection
    // surfaces as a CONTAINER_CREATION_FAILED error, NOT as a quota
    // rejection.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).not.toBe('SANDBOX_QUOTA_EXCEEDED');
    }
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
});
