/**
 * Integration coverage for bootstrap/phases/schedulers.
 *
 * Mirrors the unit-project bootstrap-phase-result test in the integration
 * project so the schedulers phase contributes to combined coverage. Tests:
 * - Non-fatal phase result when scheduler.start() rejects in dev
 * - Fatal phase result when scheduler.start() rejects in production
 * - BackgroundJob registry is started even when scheduler.start() fails
 * - shutdown.register is invoked for the registry drain
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/template-sync-scheduler.js', () => ({
  startSyncScheduler: vi.fn(() => () => {}),
}));

vi.mock('../../src/services/terraform-sync-scheduler.js', () => ({
  startTerraformSyncScheduler: vi.fn(() => () => {}),
}));

vi.mock('../../src/services/memory/dream-scheduler.service.js', () => ({
  startDreamScheduler: vi.fn(() => () => {}),
}));

vi.mock('../../src/services/event-cleanup.service.js', () => ({
  EventCleanupService: class MockEventCleanup {
    name = 'eventCleanup';
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock('../../src/lib/api/rate-limiter.js', () => ({
  createRateLimitCleanupJob: vi.fn(() => ({
    name: 'rateLimitCleanup',
    start: vi.fn(),
    stop: vi.fn(),
    runOnce: vi.fn().mockResolvedValue(0),
    healthSnapshot: vi.fn(),
  })),
}));

import { BackgroundJobRegistry } from '../../src/lib/background/job';
import { startSchedulers } from '../../src/server/bootstrap/phases/schedulers';
import type { GracefulShutdown } from '../../src/server/bootstrap/shutdown';
import type { ServiceContainer } from '../../src/server/bootstrap/types';

function createOutboxRelayStub() {
  return { name: 'eventOutboxRelay', start: vi.fn(), stop: vi.fn() };
}

function createServices(schedulerStart: () => Promise<void>): ServiceContainer {
  return {
    templateService: {} as never,
    terraformRegistryService: {} as never,
    settingsService: {} as never,
    dreamService: null as never,
    eventOutboxRelayService: createOutboxRelayStub() as never,
    schedulerService: {
      start: vi.fn(schedulerStart),
      stop: vi.fn(),
    } as never,
  } as unknown as ServiceContainer;
}

describe('bootstrap/phases/schedulers: startSchedulers', () => {
  const original = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });

  it('returns ok=true when scheduler.start() resolves', async () => {
    process.env.NODE_ENV = 'development';
    const shutdown = { register: vi.fn() } as unknown as GracefulShutdown;
    const services = createServices(() => Promise.resolve());
    const result = await startSchedulers({} as never, services, shutdown);
    expect(result.ok).toBe(true);

    // Verify shutdown wired up the standard registry drain
    expect(shutdown.register).toHaveBeenCalledWith('templateSyncScheduler', expect.any(Function));
    expect(shutdown.register).toHaveBeenCalledWith('terraformSyncScheduler', expect.any(Function));
    expect(shutdown.register).toHaveBeenCalledWith('backgroundJobRegistry', expect.any(Function));
  });

  it('returns ok=false / fatal=false when scheduler.start fails in dev', async () => {
    process.env.NODE_ENV = 'development';
    const shutdown = { register: vi.fn() } as unknown as GracefulShutdown;
    const services = createServices(() => Promise.reject(new Error('boom')));
    const result = await startSchedulers({} as never, services, shutdown);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(false);
      expect(result.error.message).toContain('boom');
    }
  });

  it('returns ok=false / fatal=true when scheduler.start fails in production', async () => {
    process.env.NODE_ENV = 'production';
    const shutdown = { register: vi.fn() } as unknown as GracefulShutdown;
    const services = createServices(() => Promise.reject(new Error('boom-prod')));
    const result = await startSchedulers({} as never, services, shutdown);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(true);
    }
  });

  it('starts the BackgroundJobRegistry even when scheduler.start fails (regression guard)', async () => {
    process.env.NODE_ENV = 'development';
    const shutdownRegister = vi.fn();
    const shutdown = { register: shutdownRegister } as unknown as GracefulShutdown;
    const services = createServices(() => Promise.reject(new Error('scheduler-boom')));
    const registry = new BackgroundJobRegistry();
    const startAllSpy = vi.spyOn(registry, 'startAll');

    const result = await startSchedulers({} as never, services, shutdown, registry);

    expect(result.ok).toBe(false);
    expect(startAllSpy).toHaveBeenCalledTimes(1);
    expect(shutdownRegister).toHaveBeenCalledWith('backgroundJobRegistry', expect.any(Function));

    await registry.stopAll();
  });

  it('registers dreamScheduler when dreamService is provided', async () => {
    process.env.NODE_ENV = 'development';
    const shutdown = { register: vi.fn() } as unknown as GracefulShutdown;
    const services = createServices(() => Promise.resolve());
    services.dreamService = { foo: 'bar' } as never;

    const result = await startSchedulers({} as never, services, shutdown);
    expect(result.ok).toBe(true);
    expect(shutdown.register).toHaveBeenCalledWith('dreamScheduler', expect.any(Function));
  });
});
