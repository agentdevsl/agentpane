/**
 * Integration tests for src/server/bootstrap/sandbox/heal-intervals.ts.
 *
 * The heal intervals are setInterval-based cleanup loops for K8s and Nomad
 * providers. They are exported but never invoked by other tests (always
 * mocked), leaving 74 uncovered lines (3% coverage).
 *
 * These tests use vi.useFakeTimers() to drive the 60-second tick deterministically,
 * and mock the provider/db boundary so we can exercise:
 *   - the early-return guards (already-running interval, no provider, healInProgress)
 *   - the validateSandboxes / ensureDefaultSandbox / healthCheck happy path
 *   - the autoInstallCRDs setting branches
 *   - the kubectl apply repair loop and the post-apply CRD wait
 *   - the recheck branch
 *   - the throwing path of validateSandboxes / ensureDefaultSandbox
 *   - Nomad lastError clear-on-recover branch
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ensureDefaultSandbox so we can flip throwing/passing per-test
const ensureDefaultSandboxMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/server/bootstrap/sandbox/sandbox-helpers.js', () => ({
  ensureDefaultSandbox: ensureDefaultSandboxMock,
}));

// Mock node:child_process so kubectl apply never runs and we can spy on calls.
const execMock = vi.hoisted(() =>
  vi.fn((_cmd: string, _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
    if (typeof cb === 'function') cb(null, { stdout: 'applied' });
    return undefined as unknown;
  })
);
vi.mock('node:child_process', () => ({ exec: execMock }));

import {
  startK8sHealInterval,
  startNomadHealInterval,
} from '../../src/server/bootstrap/sandbox/heal-intervals.js';
import type { SandboxState } from '../../src/server/bootstrap/types.js';

type MutableState = Pick<
  SandboxState,
  'k8sProvider' | 'nomadProvider' | 'k8sHealInterval' | 'nomadHealInterval'
>;

function makeState(overrides: Partial<MutableState> = {}): SandboxState {
  return {
    provider: null,
    containerAgentService: null,
    controller: null,
    k8sProvider: null,
    nomadProvider: null,
    k8sHealInterval: null,
    nomadHealInterval: null,
    retryTimer: null,
    retryCount: 0,
    initializing: false,
    reconciled: false,
    initialized: false,
    ...overrides,
  } as SandboxState;
}

function makeDb(
  opts: { settingValue?: string | null; findFirstThrows?: boolean; deleteThrows?: boolean } = {}
) {
  const findFirst = vi.fn(async () => {
    if (opts.findFirstThrows) throw new Error('db down');
    return opts.settingValue === undefined ? { value: null } : { value: opts.settingValue };
  });
  const deleteFn = () => ({
    where: vi.fn(async () => {
      if (opts.deleteThrows) throw new Error('delete failed');
      return undefined;
    }),
  });
  return {
    query: { settings: { findFirst } },
    delete: vi.fn(deleteFn),
  } as unknown as import('../../src/types/database.js').Database;
}

function makeK8sProvider(
  opts: {
    validateSandboxes?: () => Promise<void>;
    healthCheck?: () => Promise<{ healthy: boolean; details?: Record<string, unknown> }>;
    hasValidate?: boolean;
  } = {}
) {
  const obj: Record<string, unknown> = {
    healthCheck:
      opts.healthCheck ??
      vi.fn(async () => ({
        healthy: false,
        details: { crdRegistered: false, namespaceExists: false },
      })),
  };
  if (opts.hasValidate !== false) {
    obj.validateSandboxes = opts.validateSandboxes ?? vi.fn(async () => undefined);
  }
  return obj as unknown as NonNullable<SandboxState['k8sProvider']>;
}

function makeNomadProvider(
  opts: {
    validateSandboxes?: () => Promise<void>;
    healthCheck?: () => Promise<{ healthy: boolean; message?: string }>;
  } = {}
) {
  return {
    validateSandboxes: opts.validateSandboxes ?? vi.fn(async () => undefined),
    healthCheck: opts.healthCheck ?? vi.fn(async () => ({ healthy: true })),
  } as unknown as NonNullable<SandboxState['nomadProvider']>;
}

/** Drive the 60s setInterval forward and let microtasks settle. */
async function tick() {
  await vi.advanceTimersByTimeAsync(60_000);
  // Let async heal-loop microtasks resolve fully.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('startK8sHealInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ensureDefaultSandboxMock.mockReset().mockResolvedValue(undefined);
    execMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('IT-HEAL-K1: is a no-op when interval already exists', () => {
    const existing = setInterval(() => {}, 1000);
    const state = makeState({ k8sHealInterval: existing });
    const db = makeDb();
    startK8sHealInterval(db, state);
    // Interval reference unchanged — no new interval created
    expect(state.k8sHealInterval).toBe(existing);
    clearInterval(existing);
  });

  it('IT-HEAL-K2: returns early on tick when no provider is set', async () => {
    const state = makeState();
    const db = makeDb();
    startK8sHealInterval(db, state);
    expect(state.k8sHealInterval).not.toBeNull();
    await tick();
    // No db query happened (provider guard short-circuits)
    expect(db.query.settings.findFirst).not.toHaveBeenCalled();
    if (state.k8sHealInterval) clearInterval(state.k8sHealInterval);
  });

  it('IT-HEAL-K3: happy path — healthy cluster skips repair', async () => {
    const provider = makeK8sProvider({
      healthCheck: vi.fn(async () => ({ healthy: true })),
    });
    const state = makeState({ k8sProvider: provider });
    const db = makeDb();
    startK8sHealInterval(db, state);
    await tick();
    // Validate + ensureDefault + healthCheck were called; no kubectl apply
    expect(provider.healthCheck).toHaveBeenCalledTimes(1);
    expect(ensureDefaultSandboxMock).toHaveBeenCalledTimes(1);
    expect(execMock).not.toHaveBeenCalled();
    if (state.k8sHealInterval) clearInterval(state.k8sHealInterval);
  });

  it('IT-HEAL-K4: validateSandboxes failure is logged but does not throw', async () => {
    const provider = makeK8sProvider({
      validateSandboxes: vi.fn(async () => {
        throw new Error('cache stale');
      }),
      healthCheck: vi.fn(async () => ({ healthy: true })),
    });
    const state = makeState({ k8sProvider: provider });
    const db = makeDb();
    startK8sHealInterval(db, state);
    await tick();
    // Loop continued past the validate failure to ensureDefault + healthCheck
    expect(ensureDefaultSandboxMock).toHaveBeenCalledTimes(1);
    expect(provider.healthCheck).toHaveBeenCalledTimes(1);
    if (state.k8sHealInterval) clearInterval(state.k8sHealInterval);
  });

  it('IT-HEAL-K5: ensureDefaultSandbox failure does not block healthCheck', async () => {
    ensureDefaultSandboxMock.mockRejectedValueOnce(new Error('default missing'));
    const provider = makeK8sProvider({
      healthCheck: vi.fn(async () => ({ healthy: true })),
    });
    const state = makeState({ k8sProvider: provider });
    const db = makeDb();
    startK8sHealInterval(db, state);
    await tick();
    expect(provider.healthCheck).toHaveBeenCalledTimes(1);
    if (state.k8sHealInterval) clearInterval(state.k8sHealInterval);
  });

  it('IT-HEAL-K6: skips repair when autoInstallCRDs is false in DB settings', async () => {
    const provider = makeK8sProvider();
    const state = makeState({ k8sProvider: provider });
    const db = makeDb({ settingValue: JSON.stringify({ autoInstallCRDs: false }) });
    startK8sHealInterval(db, state);
    await tick();
    expect(db.query.settings.findFirst).toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    if (state.k8sHealInterval) clearInterval(state.k8sHealInterval);
  });

  it('IT-HEAL-K7: tolerates DB error when reading autoInstallCRDs (defaults to true)', async () => {
    const recheck = vi.fn(async () => ({ healthy: true }));
    const provider = makeK8sProvider({
      healthCheck: vi
        .fn()
        .mockResolvedValueOnce({
          healthy: false,
          details: { crdRegistered: false, namespaceExists: false },
        })
        .mockImplementation(recheck),
    });
    const state = makeState({ k8sProvider: provider });
    const db = makeDb({ findFirstThrows: true });
    startK8sHealInterval(db, state);
    await tick();
    // autoInstall defaulted to true → kubectl apply should have been attempted
    expect(execMock).toHaveBeenCalled();
    if (state.k8sHealInterval) clearInterval(state.k8sHealInterval);
  });

  it('IT-HEAL-K8: skips repair when health.details indicates no repair needed', async () => {
    const provider = makeK8sProvider({
      healthCheck: vi.fn(async () => ({
        healthy: false,
        details: { crdRegistered: true, namespaceExists: true },
      })),
    });
    const state = makeState({ k8sProvider: provider });
    const db = makeDb();
    startK8sHealInterval(db, state);
    await tick();
    expect(execMock).not.toHaveBeenCalled();
    if (state.k8sHealInterval) clearInterval(state.k8sHealInterval);
  });

  it('IT-HEAL-K9: runs kubectl apply repair loop and recheck (success branch)', async () => {
    const recheck = vi.fn(async () => ({ healthy: true }));
    const provider = makeK8sProvider({
      healthCheck: vi
        .fn()
        .mockResolvedValueOnce({
          healthy: false,
          details: { crdRegistered: false, namespaceExists: false },
        })
        .mockImplementationOnce(recheck),
    });
    const state = makeState({ k8sProvider: provider });
    const db = makeDb();
    startK8sHealInterval(db, state);
    await tick();
    // 4 + 2 manifests = 6 base apply attempts plus 1 CRD probe via execAsync2.
    // We just assert the apply loop ran and recheck was invoked.
    expect(execMock).toHaveBeenCalled();
    expect(provider.healthCheck).toHaveBeenCalledTimes(2);
    if (state.k8sHealInterval) clearInterval(state.k8sHealInterval);
  });

  it('IT-HEAL-K10: logs warn when recheck still unhealthy after repair', async () => {
    const provider = makeK8sProvider({
      healthCheck: vi
        .fn()
        .mockResolvedValueOnce({
          healthy: false,
          details: { crdRegistered: false, namespaceExists: false },
        })
        .mockResolvedValueOnce({ healthy: false }),
    });
    const state = makeState({ k8sProvider: provider });
    const db = makeDb();
    startK8sHealInterval(db, state);
    await tick();
    expect(provider.healthCheck).toHaveBeenCalledTimes(2);
    if (state.k8sHealInterval) clearInterval(state.k8sHealInterval);
  });
});

describe('startNomadHealInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ensureDefaultSandboxMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('IT-HEAL-N1: is a no-op when interval already exists', () => {
    const existing = setInterval(() => {}, 1000);
    const state = makeState({ nomadHealInterval: existing });
    const db = makeDb();
    startNomadHealInterval(db, state);
    expect(state.nomadHealInterval).toBe(existing);
    clearInterval(existing);
  });

  it('IT-HEAL-N2: returns early on tick when no provider is set', async () => {
    const state = makeState();
    const db = makeDb();
    startNomadHealInterval(db, state);
    await tick();
    expect(ensureDefaultSandboxMock).not.toHaveBeenCalled();
    if (state.nomadHealInterval) clearInterval(state.nomadHealInterval);
  });

  it('IT-HEAL-N3: clears lastError when cluster recovers (healthy)', async () => {
    const provider = makeNomadProvider({
      healthCheck: vi.fn(async () => ({ healthy: true })),
    });
    const state = makeState({ nomadProvider: provider });
    const db = makeDb();
    startNomadHealInterval(db, state);
    await tick();
    expect(provider.validateSandboxes).toHaveBeenCalledTimes(1);
    expect(provider.healthCheck).toHaveBeenCalledTimes(1);
    expect(db.delete).toHaveBeenCalledTimes(1);
    if (state.nomadHealInterval) clearInterval(state.nomadHealInterval);
  });

  it('IT-HEAL-N4: tolerates db.delete failure on recovery', async () => {
    const provider = makeNomadProvider({
      healthCheck: vi.fn(async () => ({ healthy: true })),
    });
    const state = makeState({ nomadProvider: provider });
    const db = makeDb({ deleteThrows: true });
    startNomadHealInterval(db, state);
    await tick();
    // Should not throw — error is swallowed
    expect(provider.healthCheck).toHaveBeenCalledTimes(1);
    if (state.nomadHealInterval) clearInterval(state.nomadHealInterval);
  });

  it('IT-HEAL-N5: logs warn when cluster is unhealthy', async () => {
    const provider = makeNomadProvider({
      healthCheck: vi.fn(async () => ({ healthy: false, message: 'leader gone' })),
    });
    const state = makeState({ nomadProvider: provider });
    const db = makeDb();
    startNomadHealInterval(db, state);
    await tick();
    expect(provider.healthCheck).toHaveBeenCalledTimes(1);
    expect(db.delete).not.toHaveBeenCalled();
    if (state.nomadHealInterval) clearInterval(state.nomadHealInterval);
  });

  it('IT-HEAL-N6: validateSandboxes failure is swallowed', async () => {
    const provider = makeNomadProvider({
      validateSandboxes: vi.fn(async () => {
        throw new Error('cache stale');
      }),
      healthCheck: vi.fn(async () => ({ healthy: true })),
    });
    const state = makeState({ nomadProvider: provider });
    const db = makeDb();
    startNomadHealInterval(db, state);
    await tick();
    expect(provider.healthCheck).toHaveBeenCalledTimes(1);
    if (state.nomadHealInterval) clearInterval(state.nomadHealInterval);
  });

  it('IT-HEAL-N7: ensureDefaultSandbox failure is swallowed', async () => {
    ensureDefaultSandboxMock.mockRejectedValueOnce(new Error('default missing'));
    const provider = makeNomadProvider({
      healthCheck: vi.fn(async () => ({ healthy: true })),
    });
    const state = makeState({ nomadProvider: provider });
    const db = makeDb();
    startNomadHealInterval(db, state);
    await tick();
    expect(provider.healthCheck).toHaveBeenCalledTimes(1);
    if (state.nomadHealInterval) clearInterval(state.nomadHealInterval);
  });

  it('IT-HEAL-N8: outer try/catch handles healthCheck throwing', async () => {
    const provider = makeNomadProvider({
      healthCheck: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    const state = makeState({ nomadProvider: provider });
    const db = makeDb();
    startNomadHealInterval(db, state);
    await tick();
    // Should not throw — outer try/catch handles it
    expect(provider.healthCheck).toHaveBeenCalledTimes(1);
    if (state.nomadHealInterval) clearInterval(state.nomadHealInterval);
  });
});
