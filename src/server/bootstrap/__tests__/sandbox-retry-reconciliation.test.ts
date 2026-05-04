/**
 * F01-01 — Sandbox reconciliation on retry path.
 *
 * The background sandbox provider initialization supports retries with
 * exponential backoff (see `scheduleSandboxRetry`). A previous version of
 * the code ran reconciliation only in the outer `.then()` callback on
 * `server-bootstrap.ts`, which resolved before any retry had a chance to
 * succeed — a server whose provider only came up on retry would therefore
 * never reconcile stale DB rows, leaving `/api/health` stuck at "not
 * ready" forever.
 *
 * These tests assert reconciliation runs on both paths:
 *   1. Initial attempt succeeds → reconciliation runs.
 *   2. Initial attempt fails, first retry succeeds → reconciliation runs.
 *   3. Initial attempt fails and retry chain gives up → reconciliation
 *      does NOT run (provider never came up).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmittingSandboxProvider } from '../../../lib/sandbox/providers/sandbox-provider.js';

// Module mocks must be hoisted — declared before imports that use them.
vi.mock('../sandbox/docker-init.js', () => ({
  initDockerProvider: vi.fn(),
}));
vi.mock('../sandbox/k8s-init.js', () => ({
  initK8sProvider: vi.fn(),
}));
vi.mock('../sandbox/nomad-init.js', () => ({
  initNomadProvider: vi.fn(),
}));
vi.mock('../sandbox/heal-intervals.js', () => ({
  startK8sHealInterval: vi.fn(),
  startNomadHealInterval: vi.fn(),
}));
vi.mock('../../../services/container-agent.service.js', () => ({
  createContainerAgentService: vi.fn(() => ({
    getRunningAgents: () => [],
    stopAgent: vi.fn(),
    dispose: vi.fn(),
  })),
}));
vi.mock('../phases/sandbox-reconciliation.js', () => ({
  reconcileSandboxes: vi.fn(async () => ({
    providerCount: 0,
    dbCount: 0,
    adoptedCount: 0,
    terminatedCount: 0,
    adopted: [],
    terminated: [],
  })),
}));

import { reconcileSandboxes } from '../phases/sandbox-reconciliation.js';
import { initDockerProvider } from '../sandbox/docker-init.js';
import { initSandboxProvider } from '../sandbox/sandbox-init.js';
import type { SandboxState, ServiceContainer } from '../types.js';

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

function makeServices(): ServiceContainer {
  // Only the fields touched by initSandboxProviderCore / container-agent are
  // needed; the rest are unused in this code path.
  return {
    taskService: { setContainerAgentService: vi.fn() } as never,
    durableStreamsService: {} as never,
    apiKeyService: {} as never,
    worktreeService: {} as never,
    githubService: {} as never,
    skillTrackingService: {} as never,
    containerAgentService: null,
  } as unknown as ServiceContainer;
}

function makeProvider(name = 'docker-mock'): EventEmittingSandboxProvider {
  // Minimal stub — only `.name` is read by the init wiring.
  return {
    name,
    list: async () => [],
    create: async () => {
      throw new Error('not-used');
    },
    get: async () => null,
    getById: async () => null,
    pullImage: async () => {
      throw new Error('not-used');
    },
    isImageAvailable: async () => false,
    healthCheck: async () => ({ healthy: true }),
    cleanup: async () => 0,
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
  } as unknown as EventEmittingSandboxProvider;
}

// Minimal DB stub — settings lookup returns undefined so Docker is chosen.
function makeDb() {
  return {
    query: {
      settings: {
        findFirst: async () => undefined,
      },
    },
  } as never;
}

describe('F01-01: Sandbox reconciliation on retry path', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(initDockerProvider).mockReset();
    vi.mocked(reconcileSandboxes).mockClear();
    // Dev mode has maxRetries=0, which cuts the retry chain — use production
    // semantics so the retry path is exercised.
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('runs reconciliation on the initial-success path', async () => {
    const state = makeSandboxState();
    const services = makeServices();
    const db = makeDb();
    const provider = makeProvider();

    // initDockerProvider sets the provider on the state; emulate that by
    // returning the provider — sandbox-init.ts assigns it into state.provider.
    vi.mocked(initDockerProvider).mockImplementation(async () => provider);

    await initSandboxProvider(db, services, state, 5_000, 'sqlite');

    expect(state.provider).toBe(provider);
    expect(state.reconciled).toBe(true);
    expect(reconcileSandboxes).toHaveBeenCalledTimes(1);
  });

  it('runs reconciliation on the retry-success path (initial fail → retry succeeds)', async () => {
    const state = makeSandboxState();
    const services = makeServices();
    const db = makeDb();
    const provider = makeProvider();

    // First call: throw to trigger retry. Second call (retry): succeed.
    vi.mocked(initDockerProvider)
      .mockImplementationOnce(async () => {
        throw new Error('docker daemon not reachable');
      })
      .mockImplementationOnce(async () => provider);

    // Kick off — initial attempt fails, retry is scheduled.
    const initPromise = initSandboxProvider(db, services, state, 5_000, 'sqlite');
    await initPromise;

    // At this point the provider is null and a retry timer is armed.
    expect(state.provider).toBeNull();
    expect(state.reconciled).toBe(false);
    expect(state.retryTimer).not.toBeNull();
    expect(reconcileSandboxes).not.toHaveBeenCalled();

    // Advance timers to fire the first retry (base delay in prod = 15s, retry
    // count was just incremented from 0, so delay = 15_000 * 2^0 = 15_000ms).
    await vi.advanceTimersByTimeAsync(15_000);
    // Let microtasks flush so the retry's await chain (reconciliation +
    // flag flip) completes.
    await Promise.resolve();
    await Promise.resolve();

    expect(state.provider).toBe(provider);
    expect(state.reconciled).toBe(true);
    expect(reconcileSandboxes).toHaveBeenCalledTimes(1);
  });
});
