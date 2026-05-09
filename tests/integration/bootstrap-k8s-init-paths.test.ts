/**
 * Integration tests for src/server/bootstrap/sandbox/k8s-init.ts.
 *
 * Mocks createAgentSandboxProvider + SandboxController + ensureDefaultSandbox
 * so the orchestrator's branches (healthy fast path, network-isolation
 * re-throw, fallbackToDocker, persistK8sLastError, settings parse failure)
 * are exercised without standing up a real cluster.
 *
 * Run: npx vitest run --project integration tests/integration/bootstrap-k8s-init-paths.test.ts
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import type { SandboxState } from '../../src/server/bootstrap/types';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const k8sMocks = vi.hoisted(() => ({
  createAgentSandboxProvider: vi.fn(),
  SandboxControllerStart: vi.fn(),
  ensureDefaultSandbox: vi.fn(),
}));

vi.mock('../../src/lib/sandbox/providers/agent-sandbox-provider.js', () => ({
  createAgentSandboxProvider: k8sMocks.createAgentSandboxProvider,
}));
vi.mock('../../src/lib/sandbox/controllers/sandbox-controller.js', () => ({
  SandboxController: class {
    client: unknown;
    namespace: string;
    constructor(client: unknown, namespace: string) {
      this.client = client;
      this.namespace = namespace;
    }
    start = k8sMocks.SandboxControllerStart;
  },
}));
vi.mock('../../src/server/bootstrap/sandbox/sandbox-helpers.js', () => ({
  ensureDefaultSandbox: k8sMocks.ensureDefaultSandbox,
}));

import { initK8sProvider } from '../../src/server/bootstrap/sandbox/k8s-init';

function makeProviderStub(overrides: Record<string, unknown> = {}) {
  return {
    name: 'k8s-mock',
    client: {},
    healthCheck: vi.fn(async () => ({
      healthy: true,
      details: { clusterVersion: '1.28', clusterReachable: true, controller: { installed: true } },
    })),
    assertNetworkIsolationSupport: vi.fn(async () => undefined),
    recover: vi.fn(async () => ({ recovered: 0, removed: 0 })),
    initWarmPool: vi.fn(async () => undefined),
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(async () => []),
    ...overrides,
  };
}

function makeSandboxState(): SandboxState {
  return {
    provider: null,
    containerAgentService: null,
    k8sProvider: null,
    nomadProvider: null,
    controller: null,
    k8sHealInterval: null,
    nomadHealInterval: null,
    retryTimer: null,
    retryCount: 0,
    initializing: false,
    reconciled: false,
    initAttempted: false,
  };
}

describe('initK8sProvider', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    k8sMocks.createAgentSandboxProvider.mockReset();
    k8sMocks.SandboxControllerStart.mockReset();
    k8sMocks.ensureDefaultSandbox.mockReset();
  });

  afterEach(async () => {
    await clearTestDatabase();
    vi.restoreAllMocks();
  });

  it('healthy provider returns the provider, clears K8s lastError, runs default sandbox setup', async () => {
    const db = getTestDb();
    // Pre-existing lastError row that should get cleared
    await db.insert(settings).values({
      key: 'sandbox.kubernetes.lastError',
      value: JSON.stringify({ error: 'old error', timestamp: '2026-01-01T00:00:00Z' }),
    });

    const provider = makeProviderStub();
    k8sMocks.createAgentSandboxProvider.mockReturnValueOnce(provider);

    const state = makeSandboxState();
    const result = await initK8sProvider(db, state, false);
    expect(result).toBe(provider);
    expect(state.k8sProvider).toBe(provider);
    expect(provider.assertNetworkIsolationSupport).toHaveBeenCalled();
    // ensureDefaultSandbox runs on the happy path
    expect(k8sMocks.ensureDefaultSandbox).toHaveBeenCalled();

    // lastError row was cleared
    const stale = await db.query.settings.findFirst({
      where: eq(settings.key, 'sandbox.kubernetes.lastError'),
    });
    expect(stale).toBeUndefined();
  });

  it('healthy provider with controller NOT installed starts the built-in controller', async () => {
    const db = getTestDb();
    const provider = makeProviderStub({
      healthCheck: vi.fn(async () => ({
        healthy: true,
        details: {
          clusterVersion: '1.28',
          clusterReachable: true,
          controller: { installed: false },
        },
      })),
    });
    k8sMocks.createAgentSandboxProvider.mockReturnValueOnce(provider);

    const state = makeSandboxState();
    const result = await initK8sProvider(db, state, false);
    expect(result).toBe(provider);
    expect(k8sMocks.SandboxControllerStart).toHaveBeenCalled();
    expect(state.controller).toBeDefined();
  });

  it('warm pool failure on healthy path is swallowed and provider is still returned', async () => {
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.kubernetes',
      value: JSON.stringify({ enableWarmPool: true }),
    });
    const provider = makeProviderStub({
      initWarmPool: vi.fn(async () => {
        throw new Error('warm pool sad');
      }),
    });
    k8sMocks.createAgentSandboxProvider.mockReturnValueOnce(provider);

    const state = makeSandboxState();
    const result = await initK8sProvider(db, state, false);
    expect(result).toBe(provider);
    expect(provider.initWarmPool).toHaveBeenCalled();
  });

  it('recover failure on healthy path is swallowed and provider is still returned', async () => {
    const db = getTestDb();
    const provider = makeProviderStub({
      recover: vi.fn(async () => {
        throw new Error('recover boom');
      }),
    });
    k8sMocks.createAgentSandboxProvider.mockReturnValueOnce(provider);

    const state = makeSandboxState();
    const result = await initK8sProvider(db, state, false);
    expect(result).toBe(provider);
  });

  it('unhealthy provider with k8sFallbackToDocker=true returns null without persisting an error', async () => {
    const db = getTestDb();
    const provider = makeProviderStub({
      healthCheck: vi.fn(async () => ({
        healthy: false,
        message: 'Cluster down',
        details: { clusterReachable: false },
      })),
    });
    k8sMocks.createAgentSandboxProvider.mockReturnValueOnce(provider);

    const state = makeSandboxState();
    const result = await initK8sProvider(db, state, true /* fallback */);
    expect(result).toBeNull();
    // No error persisted in fallback mode (operator intent: silent fallback to Docker)
    const last = await db.query.settings.findFirst({
      where: eq(settings.key, 'sandbox.kubernetes.lastError'),
    });
    expect(last).toBeUndefined();
  });

  it('unhealthy provider with fallbackToDocker=false persists the diagnosis to settings', async () => {
    const db = getTestDb();
    const provider = makeProviderStub({
      healthCheck: vi.fn(async () => ({
        healthy: false,
        message: 'CRD missing',
        details: {
          clusterVersion: '1.28',
          clusterReachable: true,
          crdRegistered: false,
        },
      })),
    });
    k8sMocks.createAgentSandboxProvider.mockReturnValueOnce(provider);

    const state = makeSandboxState();
    const result = await initK8sProvider(db, state, false /* no fallback */);
    expect(result).toBeNull();
    const last = await db.query.settings.findFirst({
      where: eq(settings.key, 'sandbox.kubernetes.lastError'),
    });
    expect(last).toBeDefined();
    const parsed = JSON.parse(last!.value!) as { error: string; timestamp: string };
    expect(parsed.error).toContain('CRD');
  });

  it('unhealthy provider with namespace missing diagnoses correctly', async () => {
    const db = getTestDb();
    const provider = makeProviderStub({
      healthCheck: vi.fn(async () => ({
        healthy: false,
        details: {
          clusterVersion: '1.28',
          clusterReachable: true,
          crdRegistered: true,
          namespaceExists: false,
          namespace: 'agentpane-sandboxes',
        },
      })),
    });
    k8sMocks.createAgentSandboxProvider.mockReturnValueOnce(provider);

    const state = makeSandboxState();
    await initK8sProvider(db, state, false);

    const last = await db.query.settings.findFirst({
      where: eq(settings.key, 'sandbox.kubernetes.lastError'),
    });
    expect(last).toBeDefined();
    const parsed = JSON.parse(last!.value!) as { error: string };
    expect(parsed.error).toContain("'agentpane-sandboxes'");
  });

  it('createAgentSandboxProvider throwing with K8S_NETWORK_ISOLATION_UNSUPPORTED re-throws (fail-closed)', async () => {
    const db = getTestDb();
    const err = Object.assign(new Error('network isolation not supported'), {
      code: 'K8S_NETWORK_ISOLATION_UNSUPPORTED',
    });
    k8sMocks.createAgentSandboxProvider.mockImplementationOnce(() => {
      throw err;
    });

    const state = makeSandboxState();
    await expect(initK8sProvider(db, state, true)).rejects.toBe(err);
  });

  it('healthy path re-throws K8S_NETWORK_ISOLATION_UNSUPPORTED from assertNetworkIsolationSupport', async () => {
    const db = getTestDb();
    const provider = makeProviderStub({
      assertNetworkIsolationSupport: vi.fn(async () => {
        throw Object.assign(new Error('no NetworkPolicy v1 support'), {
          code: 'K8S_NETWORK_ISOLATION_UNSUPPORTED',
        });
      }),
    });
    k8sMocks.createAgentSandboxProvider.mockReturnValueOnce(provider);

    const state = makeSandboxState();
    await expect(initK8sProvider(db, state, true)).rejects.toMatchObject({
      code: 'K8S_NETWORK_ISOLATION_UNSUPPORTED',
    });
  });

  it('createAgentSandboxProvider throwing a generic error with fallback=false persists the message', async () => {
    const db = getTestDb();
    k8sMocks.createAgentSandboxProvider.mockImplementationOnce(() => {
      throw new Error('kubeconfig missing');
    });

    const state = makeSandboxState();
    const result = await initK8sProvider(db, state, false);
    expect(result).toBeNull();
    const last = await db.query.settings.findFirst({
      where: eq(settings.key, 'sandbox.kubernetes.lastError'),
    });
    expect(last).toBeDefined();
    const parsed = JSON.parse(last!.value!) as { error: string };
    expect(parsed.error).toContain('kubeconfig missing');
  });

  it('createAgentSandboxProvider throwing a generic error with fallback=true does NOT persist', async () => {
    const db = getTestDb();
    k8sMocks.createAgentSandboxProvider.mockImplementationOnce(() => {
      throw new Error('kubeconfig missing');
    });

    const state = makeSandboxState();
    const result = await initK8sProvider(db, state, true);
    expect(result).toBeNull();
    const last = await db.query.settings.findFirst({
      where: eq(settings.key, 'sandbox.kubernetes.lastError'),
    });
    expect(last).toBeUndefined();
  });

  it('Settings JSON parse failure is swallowed (uses defaults)', async () => {
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.kubernetes',
      value: '{not-json',
    });
    const provider = makeProviderStub();
    k8sMocks.createAgentSandboxProvider.mockReturnValueOnce(provider);

    const state = makeSandboxState();
    const result = await initK8sProvider(db, state, false);
    expect(result).toBe(provider);
  });

  it('Custom k8s settings are passed through to createAgentSandboxProvider', async () => {
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.kubernetes',
      value: JSON.stringify({
        namespace: 'my-ns',
        kubeContext: 'my-ctx',
        runtimeClassName: 'gvisor',
        warmPoolSize: 3,
        enableWarmPool: true,
        skipTLSVerify: true,
      }),
    });
    const provider = makeProviderStub();
    k8sMocks.createAgentSandboxProvider.mockReturnValueOnce(provider);

    const state = makeSandboxState();
    await initK8sProvider(db, state, false);
    const passed = k8sMocks.createAgentSandboxProvider.mock.calls[0]![0];
    expect(passed).toMatchObject({
      namespace: 'my-ns',
      kubeContext: 'my-ctx',
      runtimeClassName: 'gvisor',
      warmPoolSize: 3,
      enableWarmPool: true,
      skipTLSVerify: true,
    });
  });
});
