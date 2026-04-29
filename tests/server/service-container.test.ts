/**
 * Regression tests for `createServiceContainer` wiring.
 *
 * Findings under test:
 *   - F01-03: `EventOutboxRelayService` must be constructed and exposed on
 *     the container so `phases/schedulers.ts` can register it with the
 *     BackgroundJobRegistry. Before fix: not constructed.
 *   - F01-04: `PlanModeService` must be constructed and exposed so
 *     `phases/router.ts` can pass it to `/api/admin/metrics/plan-mode` and
 *     `/api/metrics`. Before fix: not constructed (router gets `undefined`,
 *     metrics endpoint always returns zeros via the stub branch).
 *   - F01-05: `TaskCreationService` must be constructed with `settingsService`
 *     so admin overrides for task-creation model / system prompt take effect.
 *     Before fix: 4th arg omitted, settings silently ignored.
 *
 * Each test asserts the constructed container's shape — these checks fail
 * on `main` (because the fields are missing or undefined / settingsService
 * is not threaded) and pass with the wire-up.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServiceContainer } from '../../src/server/bootstrap/service-container.js';
import type { ServerConfig } from '../../src/server/bootstrap/types.js';
import { EventOutboxRelayService } from '../../src/services/event-outbox-relay.service.js';
import { PlanModeService } from '../../src/services/plan-mode.service.js';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database.js';

function makeConfig(): ServerConfig {
  return {
    dbMode: 'sqlite',
    dbPath: ':memory:',
    port: 3001,
    corsOrigin: 'http://localhost:3000',
    logLevel: 'error',
    nodeEnv: 'test',
    skipAuth: false,
    sandboxInitTimeoutMs: 30_000,
    caddyStreamsUrl: 'http://localhost:2019',
    postgres: {
      max: 10,
      idleTimeoutSeconds: 30,
      maxLifetimeSeconds: 0,
      connectTimeoutSeconds: 10,
      applicationName: 'agentpane-test',
    },
  };
}

describe('createServiceContainer wiring', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('F01-03: registers an EventOutboxRelayService instance on the container', () => {
    const db = getTestDb();
    const services = createServiceContainer(db as any, makeConfig());

    // Before fix: `eventOutboxRelayService` was not present on the container.
    expect(services.eventOutboxRelayService).toBeDefined();
    expect(services.eventOutboxRelayService).toBeInstanceOf(EventOutboxRelayService);
    expect(services.eventOutboxRelayService.name).toBe('eventOutboxRelay');
  });

  it('F01-04: constructs a PlanModeService instance on the container', () => {
    const db = getTestDb();
    const services = createServiceContainer(db as any, makeConfig());

    // Before fix: `planModeService` was undefined; the admin-metrics endpoint
    // fell through to the stub branch (always-zero counters).
    expect(services.planModeService).toBeDefined();
    expect(services.planModeService).toBeInstanceOf(PlanModeService);
    // The metrics getter must not throw when no events have been published.
    const metrics = services.planModeService.getMetrics();
    expect(metrics).toBeDefined();
  });

  it('F01-05: TaskCreationService is constructed with settingsService', async () => {
    const db = getTestDb();
    const services = createServiceContainer(db as any, makeConfig());

    // Persist an admin override for the task-creation model.
    const customModel = 'claude-sonnet-4-7-test-override';
    const setResult = await services.settingsService.setTaskCreationModel(customModel);
    expect(setResult.ok).toBe(true);

    // The TaskCreationService must read the override from settingsService;
    // before fix it ignored it (4th arg was undefined) and returned the
    // hard-coded default.
    const wired = (services.taskCreationService as any).settingsService;
    expect(wired).toBeDefined();
    expect(wired).toBe(services.settingsService);

    // End-to-end: round-trip the override through the service's resolution path.
    const observed = await wired.getTaskCreationModel();
    expect(observed).toBe(customModel);
  });
});
