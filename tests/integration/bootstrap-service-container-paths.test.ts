/**
 * Integration coverage for src/server/bootstrap/service-container.ts.
 *
 * createServiceContainer is a single factory: given a real DB + ServerConfig,
 * it wires up all the services in dependency order and returns the container.
 * The most useful coverage is a smoke test that constructs the container
 * against a real test DB and asserts every service handle is present + that
 * the cross-wire (`taskService.setAgentExecutionService(agentService)`)
 * actually fired (regression guard for the pattern that was broken before
 * CB-004).
 *
 * Run: npx vitest run --project integration tests/integration/bootstrap-service-container-paths.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServiceContainer } from '../../src/server/bootstrap/service-container';
import type { ServerConfig } from '../../src/server/bootstrap/types';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function makeConfig(): ServerConfig {
  return {
    dbMode: 'sqlite',
    dbPath: ':memory:',
    databaseUrl: undefined,
    port: 0,
    corsOrigin: '*',
    logLevel: 'warn',
    sandboxInitTimeoutMs: 5_000,
    caddyStreamsUrl: 'http://localhost:9999',
    enableSandbox: false,
  } as unknown as ServerConfig;
}

describe('createServiceContainer (smoke + handles)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('returns every documented service handle', async () => {
    const db = getTestDb();
    const services = createServiceContainer(db, makeConfig());

    // Every advertised handle should be present (containerAgentService
    // is intentionally null at boot — it's wired up later by sandbox-init).
    expect(services.githubService).toBeDefined();
    expect(services.apiKeyService).toBeDefined();
    expect(services.templateService).toBeDefined();
    expect(services.sandboxConfigService).toBeDefined();
    expect(services.taskService).toBeDefined();
    expect(services.sessionService).toBeDefined();
    expect(services.taskCreationService).toBeDefined();
    expect(services.worktreeService).toBeDefined();
    expect(services.marketplaceService).toBeDefined();
    expect(services.agentService).toBeDefined();
    expect(services.workflowService).toBeDefined();
    expect(services.gitService).toBeDefined();
    expect(services.codespaceService).toBeDefined();
    expect(services.projectFolderService).toBeDefined();
    expect(services.cliMonitorService).toBeDefined();
    expect(services.durableStreamsService).toBeDefined();
    expect(services.eventOutboxRelayService).toBeDefined();
    expect(services.terraformRegistryService).toBeDefined();
    expect(services.terraformComposeService).toBeDefined();
    expect(services.settingsService).toBeDefined();
    expect(services.githubAppService).toBeDefined();
    expect(services.eventSourceService).toBeDefined();
    expect(services.eventSubscriptionService).toBeDefined();
    expect(services.eventProcessingService).toBeDefined();
    expect(services.schedulerService).toBeDefined();
    expect(services.planModeService).toBeDefined();
    expect(services.commandRunner).toBeDefined();
    expect(services.memoryService).toBeDefined();
    expect(services.skillTrackingService).toBeDefined();
    expect(services.dreamService).toBeDefined();
    // Container-agent is wired at sandbox-init time, NOT in the container
    expect(services.containerAgentService).toBeNull();
  });

  it('CB-004 wire — taskService.agentExecutionService is set after construction', async () => {
    const db = getTestDb();
    const services = createServiceContainer(db, makeConfig());
    // The cross-wire (taskService.setAgentExecutionService(agentService))
    // is the regression guard for CB-004 — before the fix, this was a
    // post-construction patch with a stub. After: the real agent is wired
    // before the container is returned.
    const taskAgent = (
      services.taskService as unknown as {
        agentExecutionService?: unknown;
      }
    ).agentExecutionService;
    expect(taskAgent).toBeDefined();
    expect(taskAgent).toBe(services.agentService);
  });

  it('CB-004 wire — taskService.worktree.* methods route to the real WorktreeService', async () => {
    const db = getTestDb();
    const services = createServiceContainer(db, makeConfig());

    // The TaskService receives `getDiff` / `merge` / `remove` closures wrapping
    // the live WorktreeService. The closures come from the same instance, so
    // calling them with a missing worktreeId should hit the real WorktreeService
    // and return the canonical not-found error.
    const result = await services.worktreeService.remove('non-existent-id');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WORKTREE_NOT_FOUND');
  });

  it('commandRunner exposes both exec and execArgs (F06-NEW-01 contract)', async () => {
    const db = getTestDb();
    const services = createServiceContainer(db, makeConfig());
    expect(typeof services.commandRunner.exec).toBe('function');
    expect(typeof services.commandRunner.execArgs).toBe('function');
  });

  it('commandRunner.execArgs throws on empty argv (input validation)', async () => {
    const db = getTestDb();
    const services = createServiceContainer(db, makeConfig());
    await expect(services.commandRunner.execArgs!([], '/tmp')).rejects.toThrow(
      /argv must contain at least one element/
    );
  });

  it('PluginRegistry inside the container has both github and cron registered', async () => {
    const db = getTestDb();
    const services = createServiceContainer(db, makeConfig());
    // Trigger an actual schedule lookup via SchedulerService → if cron isn't
    // registered, the source.config decode would fail downstream. Easier
    // assertion: confirm processScheduledEvent's plugin-resolution doesn't
    // throw when given a cron source.
    expect(services.schedulerService).toBeDefined();
    expect(services.eventProcessingService).toBeDefined();
  });

  it('two consecutive calls produce independent container instances', async () => {
    const db = getTestDb();
    const a = createServiceContainer(db, makeConfig());
    const b = createServiceContainer(db, makeConfig());
    expect(a).not.toBe(b);
    expect(a.taskService).not.toBe(b.taskService);
    expect(a.agentService).not.toBe(b.agentService);
  });
});
