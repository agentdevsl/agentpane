import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventLog, tasks, teamProjectFolders, teams } from '../../src/db/schema';
import type { EventSourcePlugin, NormalizedEvent } from '../../src/lib/events/plugin-interface';
import { PluginRegistry } from '../../src/lib/events/plugin-registry';
import { ok } from '../../src/lib/utils/result';
import { EventProcessingService } from '../../src/services/event-processing.service';
import { EventSourceService } from '../../src/services/event-source.service';
import { EventSubscriptionService } from '../../src/services/event-subscription.service';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------------------------------------------------------------------------
// Mock plugin that implements the EventSourcePlugin interface
// ---------------------------------------------------------------------------

function createMockPlugin(overrides: Partial<EventSourcePlugin> = {}): EventSourcePlugin {
  return {
    type: 'github',

    async verifySignature(_payload, _signature, _secret) {
      return ok(true);
    },

    parseEvent(headers: Headers, rawBody: string): ReturnType<EventSourcePlugin['parseEvent']> {
      const body = JSON.parse(rawBody);
      const eventType = headers.get('x-github-event') ?? body.eventType ?? 'push';
      const action = body.action ?? null;
      const deliveryId = headers.get('x-github-delivery') ?? body.deliveryId ?? createId();

      const normalized: NormalizedEvent = {
        type: eventType,
        action,
        deliveryId,
        source: {
          repo: body.repository?.full_name ?? 'owner/repo',
          branch: body.ref ?? 'refs/heads/main',
          labels: body.labels ?? [],
          author: body.sender?.login ?? 'testuser',
        },
        data: {
          title: body.title ?? body.issue?.title ?? undefined,
          body: body.body ?? body.issue?.body ?? undefined,
          url: body.html_url ?? undefined,
          number: body.number ?? undefined,
        },
        raw: body,
      };

      return ok(normalized);
    },

    getEventTypes() {
      return [
        { type: 'push', label: 'Push', actions: [] },
        { type: 'issues', label: 'Issues', actions: ['opened', 'closed'] },
        { type: 'pull_request', label: 'Pull Request', actions: ['opened', 'closed', 'merged'] },
      ];
    },

    getTemplateVariables(_eventType: string) {
      return [
        { name: 'event.type', description: 'Event type' },
        { name: 'event.action', description: 'Event action' },
        { name: 'issue.title', description: 'Issue title' },
      ];
    },

    matchesFilter(_event, _filter) {
      return true;
    },

    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock worktree service (TaskService dependency)
// ---------------------------------------------------------------------------

const mockWorktreeService = {
  getDiff: async () => ok({ files: [], stats: { added: 0, removed: 0, changed: 0 } } as any),
  merge: async () => ok(undefined as any),
  remove: async () => ok(undefined as any),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Event Processing Pipeline (IT-313 to IT-319)', () => {
  let db: ReturnType<typeof getTestDb>;
  let pluginRegistry: PluginRegistry;
  let eventSourceService: EventSourceService;
  let subscriptionService: EventSubscriptionService;
  let taskService: TaskService;
  let processingService: EventProcessingService;

  let teamId: string;
  let codespaceId: string;
  let sourceSlug: string;
  let sourceId: string;
  let _plaintextSecret: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    // Instantiate real services
    eventSourceService = new EventSourceService(db as any);
    subscriptionService = new EventSubscriptionService(db as any);
    taskService = new TaskService(db as any, mockWorktreeService);

    // Set up plugin registry with mock plugin
    pluginRegistry = new PluginRegistry();
    pluginRegistry.register('github', createMockPlugin());

    processingService = new EventProcessingService(
      db as any,
      pluginRegistry,
      eventSourceService,
      subscriptionService,
      taskService
    );

    // Create team
    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Pipeline Team',
      slug: `pipeline-team-${teamId.slice(0, 6)}`,
    });

    // Create event source via the real service
    const sourceResult = await eventSourceService.create({
      teamId,
      name: 'Pipeline GitHub Source',
      type: 'github',
    });
    expect(sourceResult.ok).toBe(true);
    if (!sourceResult.ok) throw new Error('Failed to create event source');
    sourceSlug = sourceResult.value.source.slug;
    sourceId = sourceResult.value.source.id;
    _plaintextSecret = sourceResult.value.plaintextSecret;

    // Create codespace with projectFolderId
    const codespace = await createTestProject();
    codespaceId = codespace.id;

    // Link team to codespace's project folder
    await db.insert(teamProjectFolders).values({
      teamId,
      projectFolderId: codespace.projectFolderId!,
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function makeHeaders(overrides: Record<string, string> = {}): Headers {
    const h = new Headers({
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-github-delivery': createId(),
      ...overrides,
    });
    return h;
  }

  function makeBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      action: 'opened',
      issue: {
        title: 'Test issue title',
        body: 'Test issue body',
      },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'testuser' },
      ...overrides,
    });
  }

  async function createSubscription(
    overrides: { eventTypes?: string[]; promptTemplate?: string; name?: string } = {}
  ) {
    const result = await subscriptionService.create({
      name: overrides.name ?? 'Test Subscription',
      eventSourceId: sourceId,
      targetCodespaceId: codespaceId,
      eventTypes: overrides.eventTypes ?? [],
      promptTemplate: overrides.promptTemplate ?? 'Handle event: {{event.type}} {{event.action}}',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Failed to create subscription');
    return result.value;
  }

  // -------------------------------------------------------------------------
  // IT-313: Full pipeline — webhook → source lookup → parse → log →
  //         match subscription → task created
  // -------------------------------------------------------------------------

  it('IT-313: Full pipeline processes webhook and creates task', async () => {
    await createSubscription();

    const deliveryId = createId();
    const headers = makeHeaders({ 'x-github-delivery': deliveryId });
    const body = makeBody();

    const result = await processingService.processIncomingEvent(sourceSlug, headers, body);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const processing = result.value;
    expect(processing.eventSourceId).toBe(sourceId);
    expect(processing.eventLogId).toBeTruthy();
    expect(processing.status).toBe('processed');
    expect(processing.matchCount).toBe(1);
    expect(processing.tasksCreated).toHaveLength(1);

    // Verify the task was actually created in the database
    const taskId = processing.tasksCreated[0]!;
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });
    expect(task).toBeDefined();
    expect(task!.codespaceId).toBe(codespaceId);
    expect(task!.column).toBe('backlog');

    // Verify event log entry exists
    const logEntry = await db.query.eventLog.findFirst({
      where: eq(eventLog.id, processing.eventLogId),
    });
    expect(logEntry).toBeDefined();
    expect(logEntry!.eventSourceId).toBe(sourceId);
    expect(logEntry!.eventType).toBe('issues');
    expect(logEntry!.status).toBe('task_created');
    expect(logEntry!.deliveryId).toBe(deliveryId);
  });

  // -------------------------------------------------------------------------
  // IT-314: Disabled source → returns SOURCE_DISABLED error, no task created
  // -------------------------------------------------------------------------

  it('IT-314: Disabled source returns SOURCE_DISABLED error', async () => {
    await createSubscription();

    // Disable the event source
    const updateResult = await eventSourceService.update(sourceId, { isEnabled: false });
    expect(updateResult.ok).toBe(true);

    const headers = makeHeaders();
    const body = makeBody();

    const result = await processingService.processIncomingEvent(sourceSlug, headers, body);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('EVENT_SOURCE_DISABLED');

    // Verify no tasks were created
    const allTasks = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespaceId),
    });
    expect(allTasks).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // IT-315: Duplicate deliveryId → returns status 'duplicate', no second task
  // -------------------------------------------------------------------------

  it('IT-315: Duplicate deliveryId returns duplicate status', async () => {
    await createSubscription();

    const deliveryId = createId();
    const headers = makeHeaders({ 'x-github-delivery': deliveryId });
    const body = makeBody();

    // First event should succeed
    const firstResult = await processingService.processIncomingEvent(sourceSlug, headers, body);
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) return;
    expect(firstResult.value.status).toBe('processed');
    expect(firstResult.value.tasksCreated).toHaveLength(1);

    // Count tasks after first event
    const tasksAfterFirst = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespaceId),
    });
    const countAfterFirst = tasksAfterFirst.length;
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);

    // Second event with same deliveryId should be deduplicated
    const secondResult = await processingService.processIncomingEvent(sourceSlug, headers, body);
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) return;
    expect(secondResult.value.status).toBe('duplicate');
    expect(secondResult.value.tasksCreated).toHaveLength(0);
    expect(secondResult.value.matchCount).toBe(0);

    // Verify no additional tasks were created after the duplicate
    const tasksAfterSecond = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespaceId),
    });
    expect(tasksAfterSecond.length).toBe(countAfterFirst);
  });

  // -------------------------------------------------------------------------
  // IT-316: Subscription eventTypes filter — subscription listens for
  //         'issues.opened', send 'push' event → no match, no task
  // -------------------------------------------------------------------------

  it('IT-316: Subscription eventTypes filter blocks non-matching event types', async () => {
    // Subscription only listens for 'issues.opened'
    await createSubscription({ eventTypes: ['issues.opened'] });

    const deliveryId = createId();
    // Send a 'push' event that does NOT match the subscription filter
    const headers = makeHeaders({
      'x-github-event': 'push',
      'x-github-delivery': deliveryId,
    });
    const body = makeBody({ action: null });

    const result = await processingService.processIncomingEvent(sourceSlug, headers, body);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Event was processed but no subscriptions matched (status depends on matchCount)
    expect(result.value.matchCount).toBe(0);
    expect(result.value.tasksCreated).toHaveLength(0);

    // Verify no tasks were created
    const allTasks = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespaceId),
    });
    expect(allTasks).toHaveLength(0);

    // Verify event was still logged
    const logEntry = await db.query.eventLog.findFirst({
      where: eq(eventLog.id, result.value.eventLogId),
    });
    expect(logEntry).toBeDefined();
    expect(logEntry!.eventType).toBe('push');
    expect(logEntry!.status).toBe('ignored');
  });

  // -------------------------------------------------------------------------
  // IT-317: Multiple subscriptions match same event → multiple tasks created
  // -------------------------------------------------------------------------

  it('IT-317: Multiple subscriptions matching same event create multiple tasks', async () => {
    // Create three subscriptions that all match any event type (wildcard)
    await createSubscription({ name: 'Sub A' });
    await createSubscription({ name: 'Sub B' });
    await createSubscription({ name: 'Sub C' });

    const deliveryId = createId();
    const headers = makeHeaders({ 'x-github-delivery': deliveryId });
    const body = makeBody();

    const result = await processingService.processIncomingEvent(sourceSlug, headers, body);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('processed');
    expect(result.value.matchCount).toBe(3);
    expect(result.value.tasksCreated).toHaveLength(3);

    // Verify each reported task ID exists in the database
    for (const taskId of result.value.tasksCreated) {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
      });
      expect(task).toBeDefined();
      expect(task!.codespaceId).toBe(codespaceId);
    }
  });

  // -------------------------------------------------------------------------
  // IT-318: Subscription promptTemplate with {{event.title}} → task
  //         description interpolated
  // -------------------------------------------------------------------------

  it('IT-318: Subscription promptTemplate variables are interpolated in task description', async () => {
    await createSubscription({
      promptTemplate:
        'Fix issue "{{issue.title}}" in {{repo.full_name}} (event: {{event.type}}.{{event.action}})',
    });

    const deliveryId = createId();
    const headers = makeHeaders({ 'x-github-delivery': deliveryId });
    const body = makeBody({
      action: 'opened',
      issue: { title: 'Bug in login form', body: 'Login fails with 500 error' },
      repository: { full_name: 'acme/webapp' },
    });

    const result = await processingService.processIncomingEvent(sourceSlug, headers, body);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.tasksCreated).toHaveLength(1);

    const taskId = result.value.tasksCreated[0]!;
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });
    expect(task).toBeDefined();

    // The description should contain the interpolated template
    expect(task!.description).toContain('Bug in login form');
    expect(task!.description).toContain('acme/webapp');
    expect(task!.description).toContain('issues.opened');
  });

  // -------------------------------------------------------------------------
  // IT-319: No matching subscriptions → event logged (status 'processed'),
  //         matchCount=0, tasksCreated=[]
  // -------------------------------------------------------------------------

  it('IT-319: No matching subscriptions logs event with zero matches', async () => {
    // No subscriptions created — so nothing can match

    const deliveryId = createId();
    const headers = makeHeaders({ 'x-github-delivery': deliveryId });
    const body = makeBody();

    const result = await processingService.processIncomingEvent(sourceSlug, headers, body);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // With no matching subscriptions and no tasks, status should be 'ignored'
    expect(result.value.status).toBe('ignored');
    expect(result.value.matchCount).toBe(0);
    expect(result.value.tasksCreated).toHaveLength(0);
    expect(result.value.eventSourceId).toBe(sourceId);
    expect(result.value.eventLogId).toBeTruthy();

    // Verify event was still logged in the database
    const logEntry = await db.query.eventLog.findFirst({
      where: eq(eventLog.id, result.value.eventLogId),
    });
    expect(logEntry).toBeDefined();
    expect(logEntry!.eventSourceId).toBe(sourceId);
    expect(logEntry!.eventType).toBe('issues');
    expect(logEntry!.deliveryId).toBe(deliveryId);
    expect(logEntry!.status).toBe('ignored');
  });

  // -------------------------------------------------------------------------
  // IT-319b: Signature verification failure → returns error
  // -------------------------------------------------------------------------

  it('IT-319b: Signature verification failure returns SIGNATURE_INVALID error', async () => {
    await createSubscription();

    // Re-register plugin with a signature verifier that rejects
    pluginRegistry.register(
      'github',
      createMockPlugin({
        async verifySignature(_payload, _signature, _secret) {
          return ok(false);
        },
      })
    );

    const headers = makeHeaders();
    const body = makeBody();

    const result = await processingService.processIncomingEvent(sourceSlug, headers, body);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EVENT_SIGNATURE_INVALID');
  });
});
