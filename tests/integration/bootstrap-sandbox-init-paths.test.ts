/**
 * Integration tests for src/server/bootstrap/sandbox/sandbox-init.ts.
 *
 * Mocks docker-init / k8s-init / nomad-init at module scope so the
 * orchestrator's branches (provider selection, retry scheduling, timeout
 * handling, reconciliation flag flipping, ContainerAgentService wiring)
 * are exercised without standing up real container infrastructure.
 *
 * Run: npx vitest run --project integration tests/integration/bootstrap-sandbox-init-paths.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import type { SandboxState, ServiceContainer } from '../../src/server/bootstrap/types';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const initMocks = vi.hoisted(() => ({
  initK8sProvider: vi.fn(),
  initNomadProvider: vi.fn(),
  initDockerProvider: vi.fn(),
}));

vi.mock('../../src/server/bootstrap/sandbox/k8s-init.js', () => ({
  initK8sProvider: initMocks.initK8sProvider,
}));
vi.mock('../../src/server/bootstrap/sandbox/nomad-init.js', () => ({
  initNomadProvider: initMocks.initNomadProvider,
}));
vi.mock('../../src/server/bootstrap/sandbox/docker-init.js', () => ({
  initDockerProvider: initMocks.initDockerProvider,
}));
vi.mock('../../src/server/bootstrap/sandbox/heal-intervals.js', () => ({
  startK8sHealInterval: vi.fn(),
  startNomadHealInterval: vi.fn(),
}));
vi.mock('../../src/server/bootstrap/phases/sandbox-reconciliation.js', () => ({
  reconcileSandboxes: vi.fn(async () => undefined),
}));

import { initSandboxProvider } from '../../src/server/bootstrap/sandbox/sandbox-init';

function makeProvider(name: string) {
  return {
    name,
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(async () => []),
    healthCheck: vi.fn(async () => ({ healthy: true })),
  };
}

function makeServices(): ServiceContainer {
  return {
    durableStreamsService: {} as never,
    sandboxConfigService: {} as never,
    apiKeyService: {} as never,
    worktreeService: {} as never,
    githubService: {} as never,
    skillTrackingService: {} as never,
    taskService: { setContainerAgentService: vi.fn() } as never,
    containerAgentService: null,
  } as unknown as ServiceContainer;
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

describe('initSandboxProvider', () => {
  let originalNodeEnv: string | undefined;

  beforeEach(async () => {
    await setupTestDatabase();
    originalNodeEnv = process.env.NODE_ENV;
    initMocks.initK8sProvider.mockReset();
    initMocks.initNomadProvider.mockReset();
    initMocks.initDockerProvider.mockReset();
  });

  afterEach(async () => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    await clearTestDatabase();
    vi.restoreAllMocks();
  });

  it('Docker default: with no settings row, falls through to docker-init and flips initAttempted', async () => {
    process.env.NODE_ENV = 'development';
    initMocks.initDockerProvider.mockResolvedValueOnce(makeProvider('docker'));

    const db = getTestDb();
    const services = makeServices();
    const state = makeSandboxState();
    await initSandboxProvider(db, services, state, 5000, 'sqlite');
    expect(initMocks.initDockerProvider).toHaveBeenCalled();
    expect(initMocks.initK8sProvider).not.toHaveBeenCalled();
    expect(initMocks.initNomadProvider).not.toHaveBeenCalled();
    expect(state.initAttempted).toBe(true);
    expect(state.provider?.name).toBe('docker');
    expect(state.reconciled).toBe(true);
  });

  it('Kubernetes selection: respects sandbox.defaults.provider="kubernetes" and uses k8s-init', async () => {
    process.env.NODE_ENV = 'development';
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ provider: 'kubernetes', fallbackToDocker: false }),
    });
    initMocks.initK8sProvider.mockResolvedValueOnce(makeProvider('kubernetes'));

    const services = makeServices();
    const state = makeSandboxState();
    await initSandboxProvider(db, services, state, 5000, 'sqlite');
    expect(initMocks.initK8sProvider).toHaveBeenCalledWith(db, state, false /* fallbackToDocker */);
    expect(initMocks.initDockerProvider).not.toHaveBeenCalled();
    expect(state.provider?.name).toBe('kubernetes');
    expect(state.initAttempted).toBe(true);
  });

  it('K8s init returns null and fallbackToDocker=true: falls back to Docker', async () => {
    process.env.NODE_ENV = 'development';
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ provider: 'kubernetes', fallbackToDocker: true }),
    });
    initMocks.initK8sProvider.mockResolvedValueOnce(null);
    initMocks.initDockerProvider.mockResolvedValueOnce(makeProvider('docker-fallback'));

    const services = makeServices();
    const state = makeSandboxState();
    await initSandboxProvider(db, services, state, 5000, 'sqlite');
    expect(initMocks.initK8sProvider).toHaveBeenCalled();
    expect(initMocks.initDockerProvider).toHaveBeenCalled();
    expect(state.provider?.name).toBe('docker-fallback');
  });

  it('K8s init returns null and fallbackToDocker=false: provider stays null, no Docker fallback', async () => {
    process.env.NODE_ENV = 'development';
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ provider: 'kubernetes', fallbackToDocker: false }),
    });
    initMocks.initK8sProvider.mockResolvedValueOnce(null);

    const services = makeServices();
    const state = makeSandboxState();
    await initSandboxProvider(db, services, state, 5000, 'sqlite');
    expect(initMocks.initK8sProvider).toHaveBeenCalled();
    expect(initMocks.initDockerProvider).not.toHaveBeenCalled();
    expect(state.provider).toBeNull();
    // initAttempted always flips so the readiness gate opens
    expect(state.initAttempted).toBe(true);
  });

  it('Nomad selection: respects sandbox.defaults.provider="nomad"', async () => {
    process.env.NODE_ENV = 'development';
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ provider: 'nomad', fallbackToDocker: false }),
    });
    initMocks.initNomadProvider.mockResolvedValueOnce(makeProvider('nomad'));

    const services = makeServices();
    const state = makeSandboxState();
    await initSandboxProvider(db, services, state, 5000, 'sqlite');
    expect(initMocks.initNomadProvider).toHaveBeenCalled();
    expect(state.provider?.name).toBe('nomad');
  });

  it('Nomad-specific fallback override (sandbox.nomad.fallbackToDocker) takes effect', async () => {
    process.env.NODE_ENV = 'development';
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ provider: 'nomad', fallbackToDocker: false }),
    });
    await db.insert(settings).values({
      key: 'sandbox.nomad',
      value: JSON.stringify({ fallbackToDocker: true }),
    });
    initMocks.initNomadProvider.mockResolvedValueOnce(null);
    initMocks.initDockerProvider.mockResolvedValueOnce(makeProvider('docker-from-nomad'));

    const services = makeServices();
    const state = makeSandboxState();
    await initSandboxProvider(db, services, state, 5000, 'sqlite');
    expect(initMocks.initNomadProvider).toHaveBeenCalledWith(db, state, true);
    expect(initMocks.initDockerProvider).toHaveBeenCalled();
  });

  it('Initialization timeout schedules a retry but still flips initAttempted', async () => {
    process.env.NODE_ENV = 'development';
    initMocks.initDockerProvider.mockImplementationOnce(
      () => new Promise<unknown>(() => undefined) // never resolves
    );

    const db = getTestDb();
    const services = makeServices();
    const state = makeSandboxState();
    await initSandboxProvider(db, services, state, 50 /* tiny timeout */, 'sqlite');
    expect(state.initAttempted).toBe(true);
    expect(state.provider).toBeNull();
    // Reconciled stays false because the provider never came up
    expect(state.reconciled).toBe(false);
    // Clean up the retry timer so the test process can exit
    if (state.retryTimer) clearTimeout(state.retryTimer);
  });

  it('Settings row with malformed JSON falls back to Docker default', async () => {
    process.env.NODE_ENV = 'development';
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: '{not-valid-json',
    });
    initMocks.initDockerProvider.mockResolvedValueOnce(makeProvider('docker-from-bad-json'));

    const services = makeServices();
    const state = makeSandboxState();
    await initSandboxProvider(db, services, state, 5000, 'sqlite');
    expect(initMocks.initDockerProvider).toHaveBeenCalled();
    expect(state.provider?.name).toBe('docker-from-bad-json');
  });

  it('After successful init, runs reconciliation and flips reconciled=true', async () => {
    process.env.NODE_ENV = 'development';
    initMocks.initDockerProvider.mockResolvedValueOnce(makeProvider('docker-recon'));

    const db = getTestDb();
    const services = makeServices();
    const state = makeSandboxState();
    expect(state.reconciled).toBe(false);
    await initSandboxProvider(db, services, state, 5000, 'sqlite');
    expect(state.reconciled).toBe(true);
  });

  it('Cleans existing retry timer when provider becomes ready (onSandboxProviderReady)', async () => {
    process.env.NODE_ENV = 'development';
    initMocks.initDockerProvider.mockResolvedValueOnce(makeProvider('docker-clean'));

    const db = getTestDb();
    const services = makeServices();
    const state = makeSandboxState();
    // Pretend an earlier retry was scheduled
    const fakeTimer = setTimeout(() => undefined, 10_000);
    state.retryTimer = fakeTimer as ReturnType<typeof setTimeout>;
    state.retryCount = 3;
    await initSandboxProvider(db, services, state, 5000, 'sqlite');
    expect(state.retryTimer).toBeNull();
    expect(state.retryCount).toBe(0);
  });

  // Verify settings row read path that hits the Nomad sub-setting `try` catch.
  it('Nomad sub-setting JSON parse failure is swallowed (warn only)', async () => {
    process.env.NODE_ENV = 'development';
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ provider: 'nomad', fallbackToDocker: false }),
    });
    await db.insert(settings).values({
      key: 'sandbox.nomad',
      value: '{not-json',
    });
    initMocks.initNomadProvider.mockResolvedValueOnce(makeProvider('nomad-bad-sub'));

    const services = makeServices();
    const state = makeSandboxState();
    await initSandboxProvider(db, services, state, 5000, 'sqlite');
    expect(state.provider?.name).toBe('nomad-bad-sub');
  });

  // Settings row with no value (null) takes Docker default
  it('Settings row present but with empty value falls through to Docker default', async () => {
    process.env.NODE_ENV = 'development';
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: '',
    });
    initMocks.initDockerProvider.mockResolvedValueOnce(makeProvider('docker-empty-val'));

    const services = makeServices();
    const state = makeSandboxState();
    await initSandboxProvider(db, services, state, 5000, 'sqlite');
    expect(state.provider?.name).toBe('docker-empty-val');
  });
});
