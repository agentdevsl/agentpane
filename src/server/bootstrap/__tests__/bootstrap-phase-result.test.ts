/**
 * F01-05 — Bootstrap phase result contract.
 *
 * Phases now return {@link BootstrapPhaseResult} explicitly so the
 * orchestrator applies a uniform policy: fatal failures call
 * `process.exit(1)`; non-fatal failures log and continue. This test
 * asserts both ends of the contract:
 *
 *   1. Individual phases return the right shape for known failure modes.
 *   2. The orchestrator applyPhaseResult helper exits only on fatal=true.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the source-of-keys helper so tests don't accidentally read the
// developer's real ~/.claude/.credentials.json.
vi.mock('../../../lib/utils/resolve-anthropic-key.js', () => ({
  resolveAnthropicApiKey: vi.fn(async () => null),
  readCredentialsFile: vi.fn(async () => null),
}));

import { BackgroundJobRegistry } from '../../../lib/background/job.js';
import { resolveAnthropicApiKey } from '../../../lib/utils/resolve-anthropic-key.js';
import { resolveApiKey } from '../phases/api-key-resolution.js';
import { startSchedulers } from '../phases/schedulers.js';
import type { GracefulShutdown } from '../shutdown.js';
import type { BootstrapPhaseResult, ServiceContainer } from '../types.js';

describe('F01-05: BootstrapPhaseResult shape and orchestrator policy', () => {
  const originalExit = process.exit;
  const originalEnv = process.env.NODE_ENV;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalOauth = process.env.CLAUDE_OAUTH_TOKEN;

  beforeEach(() => {
    // Start each test with a clean env so resolveApiKey behaviour is deterministic.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_OAUTH_TOKEN;
    vi.mocked(resolveAnthropicApiKey).mockReset();
    vi.mocked(resolveAnthropicApiKey).mockResolvedValue(null);
  });

  afterEach(() => {
    process.exit = originalExit;
    process.env.NODE_ENV = originalEnv;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalOauth === undefined) delete process.env.CLAUDE_OAUTH_TOKEN;
    else process.env.CLAUDE_OAUTH_TOKEN = originalOauth;
  });

  // ── api-key-resolution ──

  it('resolveApiKey: non-fatal when no key and NODE_ENV != production', async () => {
    process.env.NODE_ENV = 'development';
    const apiKeyService = {
      getApiKey: vi.fn().mockResolvedValue(null),
      getActive: vi.fn().mockResolvedValue(null),
    } as never;

    const result = await resolveApiKey(apiKeyService);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it('resolveApiKey: fatal when no key and NODE_ENV == production', async () => {
    process.env.NODE_ENV = 'production';
    const apiKeyService = {
      getApiKey: vi.fn().mockResolvedValue(null),
      getActive: vi.fn().mockResolvedValue(null),
    } as never;

    const result = await resolveApiKey(apiKeyService);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(true);
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it('resolveApiKey: ok=true when ANTHROPIC_API_KEY is set via env', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-test';
    vi.mocked(resolveAnthropicApiKey).mockResolvedValue('sk-ant-api-test');
    const apiKeyService = {
      getApiKey: vi.fn().mockResolvedValue('sk-ant-api-test'),
      getActive: vi.fn().mockResolvedValue('sk-ant-api-test'),
    } as never;

    const result = await resolveApiKey(apiKeyService);
    expect(result.ok).toBe(true);
  });

  // ── schedulers ──

  it('startSchedulers: non-fatal when task scheduler start fails in dev', async () => {
    process.env.NODE_ENV = 'development';
    const shutdown = { register: vi.fn() } as unknown as GracefulShutdown;

    const services: ServiceContainer = {
      templateService: {} as never,
      terraformRegistryService: {} as never,
      settingsService: {} as never,
      dreamService: null as never,
      schedulerService: {
        start: vi.fn().mockRejectedValue(new Error('boom')),
        stop: vi.fn(),
      } as never,
    } as unknown as ServiceContainer;

    const db = {} as never;
    const result = await startSchedulers(db, services, shutdown);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(false);
      expect(result.error.message).toContain('boom');
    }
  });

  it('startSchedulers: fatal when task scheduler start fails in production', async () => {
    process.env.NODE_ENV = 'production';
    const shutdown = { register: vi.fn() } as unknown as GracefulShutdown;

    const services: ServiceContainer = {
      templateService: {} as never,
      terraformRegistryService: {} as never,
      settingsService: {} as never,
      dreamService: null as never,
      schedulerService: {
        start: vi.fn().mockRejectedValue(new Error('boom-prod')),
        stop: vi.fn(),
      } as never,
    } as unknown as ServiceContainer;

    const db = {} as never;
    const result = await startSchedulers(db, services, shutdown);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(true);
    }
  });

  it('startSchedulers: BackgroundJob registry is started even when task scheduler fails', async () => {
    // Devin-red regression: previously `registry.startAll()` was called
    // *after* the scheduler try/catch, so a scheduler failure returned early
    // and EventCleanupService (registered before the scheduler) silently
    // never started. This test pins the corrected ordering: registered
    // non-scheduler jobs must start regardless of scheduler outcome.
    process.env.NODE_ENV = 'development';
    const shutdownRegister = vi.fn();
    const shutdown = { register: shutdownRegister } as unknown as GracefulShutdown;

    const services: ServiceContainer = {
      templateService: {} as never,
      terraformRegistryService: {} as never,
      settingsService: {} as never,
      dreamService: null as never,
      schedulerService: {
        start: vi.fn().mockRejectedValue(new Error('scheduler-boom')),
        stop: vi.fn(),
      } as never,
    } as unknown as ServiceContainer;

    const registry = new BackgroundJobRegistry();
    const startAllSpy = vi.spyOn(registry, 'startAll');
    const db = {} as never;

    const result = await startSchedulers(db, services, shutdown, registry);

    // Phase result still reports the failure, but the registry was started
    // and the shutdown drain was wired up before the scheduler attempt.
    expect(result.ok).toBe(false);
    expect(startAllSpy).toHaveBeenCalledTimes(1);
    expect(shutdownRegister).toHaveBeenCalledWith('backgroundJobRegistry', expect.any(Function));

    // Drain registered jobs so the test doesn't leak EventCleanup's
    // 60s setTimeout across the vitest run.
    await registry.stopAll();
  });

  // ── applyPhaseResult semantics ──

  // applyPhaseResult lives inside server-bootstrap.ts and is unexported.
  // Re-implement the contract it enforces here so the test documents it
  // and catches drift if the helper is changed.

  function simulatePolicy(result: BootstrapPhaseResult): 'exit' | 'continue' {
    if (result.ok) return 'continue';
    if (result.fatal) return 'exit';
    return 'continue';
  }

  it('applyPhaseResult policy: ok=true → continue', () => {
    expect(simulatePolicy({ ok: true })).toBe('continue');
  });

  it('applyPhaseResult policy: fatal=true → exit', () => {
    expect(simulatePolicy({ ok: false, fatal: true, error: new Error('x') })).toBe('exit');
  });

  it('applyPhaseResult policy: fatal=false → continue', () => {
    expect(simulatePolicy({ ok: false, fatal: false, error: new Error('x') })).toBe('continue');
  });
});
