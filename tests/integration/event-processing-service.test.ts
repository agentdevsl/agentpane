import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventLog, eventSources, eventSubscriptions, tasks, teams } from '../../src/db/schema';
import { createTestEventSource, createTestSubscription } from '../factories/event-source.factory';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Event Processing Data Patterns (IT-157 to IT-162)', () => {
  let db: ReturnType<typeof getTestDb>;
  let teamId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Event Team',
      slug: `event-team-${teamId.slice(0, 6)}`,
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-157: event source stores webhookSecret for signature verification', async () => {
    const secret = 'test-webhook-secret';
    const source = await createTestEventSource({
      teamId,
      webhookSecret: secret,
    });

    // Verify the secret is stored
    const found = await db.query.eventSources.findFirst({
      where: eq(eventSources.id, source.id),
    });

    expect(found).toBeDefined();
    expect(found!.webhookSecret).toBe(secret);
  });

  it('IT-158: subscription with eventType filter matches incoming event type', async () => {
    const source = await createTestEventSource({ teamId });
    const codespace = await createTestProject();

    // Create subscription that listens for 'issues.opened'
    const sub = await createTestSubscription({
      eventSourceId: source.id,
      targetCodespaceId: codespace.id,
      eventTypes: ['issues.opened', 'issues.closed'],
    });

    // Simulate matching: query subscriptions where eventType would match
    const incomingEventType = 'issues.opened';
    const allSubs = await db.query.eventSubscriptions.findMany({
      where: and(
        eq(eventSubscriptions.eventSourceId, source.id),
        eq(eventSubscriptions.isEnabled, true)
      ),
    });

    // Filter subs whose eventTypes array includes the incoming type
    const matchingSubs = allSubs.filter((s) => {
      const types = s.eventTypes as string[];
      return types.length === 0 || types.includes(incomingEventType);
    });

    expect(matchingSubs).toHaveLength(1);
    expect(matchingSubs[0].id).toBe(sub.id);
  });

  it('IT-159: matching subscription leads to task creation in codespace', async () => {
    const source = await createTestEventSource({ teamId });
    const codespace = await createTestProject();

    const sub = await createTestSubscription({
      eventSourceId: source.id,
      targetCodespaceId: codespace.id,
      eventTypes: ['push'],
      promptTemplate: 'Handle push event: {{ref}}',
    });

    // Simulate creating a task for the matching subscription
    const taskId = createId();
    await db.insert(tasks).values({
      id: taskId,
      codespaceId: codespace.id,
      title: 'Handle push event: refs/heads/main',
      column: sub.taskColumn ?? 'backlog',
      position: 0,
      labels: sub.taskLabels ?? [],
    });

    // Verify task was created in the correct codespace
    const createdTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });
    expect(createdTask).toBeDefined();
    expect(createdTask!.codespaceId).toBe(codespace.id);
    expect(createdTask!.column).toBe('backlog');

    // Log the event
    await db.insert(eventLog).values({
      id: createId(),
      eventSourceId: source.id,
      eventType: 'push',
      status: 'task_created',
      deliveryId: createId(),
      matchedSubscriptions: [{ subscriptionId: sub.id, taskId }],
    });

    const logEntry = await db.query.eventLog.findFirst({
      where: eq(eventLog.eventSourceId, source.id),
    });
    expect(logEntry).toBeDefined();
    expect(logEntry!.status).toBe('task_created');
    const matched = logEntry!.matchedSubscriptions as Array<{
      subscriptionId: string;
      taskId?: string;
    }>;
    expect(matched[0].taskId).toBe(taskId);
  });

  it('IT-160: non-matching eventType results in eventLog with status=ignored', async () => {
    const source = await createTestEventSource({ teamId });
    const codespace = await createTestProject();

    // Subscription only listens for 'push' events
    await createTestSubscription({
      eventSourceId: source.id,
      targetCodespaceId: codespace.id,
      eventTypes: ['push'],
    });

    // Incoming event is 'pull_request.opened' - doesn't match
    const incomingEventType = 'pull_request.opened';
    const allSubs = await db.query.eventSubscriptions.findMany({
      where: eq(eventSubscriptions.eventSourceId, source.id),
    });

    const matchingSubs = allSubs.filter((s) => {
      const types = s.eventTypes as string[];
      return types.length === 0 || types.includes(incomingEventType);
    });
    expect(matchingSubs).toHaveLength(0);

    // Log as ignored
    await db.insert(eventLog).values({
      id: createId(),
      eventSourceId: source.id,
      eventType: incomingEventType,
      status: 'ignored',
      deliveryId: createId(),
      matchedSubscriptions: [],
    });

    const logEntry = await db.query.eventLog.findFirst({
      where: eq(eventLog.eventSourceId, source.id),
    });
    expect(logEntry).toBeDefined();
    expect(logEntry!.status).toBe('ignored');
  });

  it('IT-161: disabled event source is excluded from active source queries', async () => {
    const activeSource = await createTestEventSource({
      teamId,
      isEnabled: true,
      status: 'active',
    });
    const disabledSource = await createTestEventSource({
      teamId,
      isEnabled: false,
      status: 'disabled',
    });

    // Query for active sources only
    const activeSources = await db.query.eventSources.findMany({
      where: and(eq(eventSources.teamId, teamId), eq(eventSources.isEnabled, true)),
    });

    const activeIds = activeSources.map((s) => s.id);
    expect(activeIds).toContain(activeSource.id);
    expect(activeIds).not.toContain(disabledSource.id);
  });

  it('IT-162: eventLog supports all status transitions', async () => {
    const source = await createTestEventSource({ teamId });
    const logId = createId();

    // Insert with initial status 'received'
    await db.insert(eventLog).values({
      id: logId,
      eventSourceId: source.id,
      eventType: 'push',
      status: 'received',
      deliveryId: createId(),
    });

    let entry = await db.query.eventLog.findFirst({ where: eq(eventLog.id, logId) });
    expect(entry!.status).toBe('received');

    // Transition to 'matched'
    await db.update(eventLog).set({ status: 'matched' }).where(eq(eventLog.id, logId));
    entry = await db.query.eventLog.findFirst({ where: eq(eventLog.id, logId) });
    expect(entry!.status).toBe('matched');

    // Transition to 'task_created'
    await db.update(eventLog).set({ status: 'task_created' }).where(eq(eventLog.id, logId));
    entry = await db.query.eventLog.findFirst({ where: eq(eventLog.id, logId) });
    expect(entry!.status).toBe('task_created');

    // Verify 'ignored' status is also accepted (insert a new entry)
    const ignoredId = createId();
    await db.insert(eventLog).values({
      id: ignoredId,
      eventSourceId: source.id,
      eventType: 'ping',
      status: 'ignored',
      deliveryId: createId(),
    });
    const ignoredEntry = await db.query.eventLog.findFirst({ where: eq(eventLog.id, ignoredId) });
    expect(ignoredEntry!.status).toBe('ignored');

    // Verify 'error' status is accepted
    const errorId = createId();
    await db.insert(eventLog).values({
      id: errorId,
      eventSourceId: source.id,
      eventType: 'push',
      status: 'error',
      error: 'Processing timeout',
      deliveryId: createId(),
    });
    const errorEntry = await db.query.eventLog.findFirst({ where: eq(eventLog.id, errorId) });
    expect(errorEntry!.status).toBe('error');
    expect(errorEntry!.error).toBe('Processing timeout');
  });
});
