import { createId } from '@paralleldrive/cuid2';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventLog, sessionEvents, tasks } from '../../src/db/schema';
import { createTestEventSource, createTestSubscription } from '../factories/event-source.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Cross-Service: Events & Export (IT-183 to IT-184)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-183: webhook pipeline: eventSource → subscription → eventLog → task created', async () => {
    const codespace = await createTestProject({ name: 'Event Pipeline' });

    // Create event source (need a team for it)
    const teamId = createId();
    const { teams } = await import('../../src/db/schema');
    await db.insert(teams).values({
      id: teamId,
      name: 'Event Team',
      slug: `event-team-${teamId.slice(0, 8)}`,
    });

    const source = await createTestEventSource({
      teamId,
      name: 'GitHub Webhook',
      type: 'github',
    });

    const subscription = await createTestSubscription({
      eventSourceId: source.id,
      targetCodespaceId: codespace.id,
      eventTypes: ['issues.opened'],
      promptTemplate: 'Handle issue: {{issue.title}}',
      autoStartAgent: false,
      taskColumn: 'backlog',
    });

    // Simulate incoming event log entry
    const deliveryId = createId();
    await db.insert(eventLog).values({
      id: createId(),
      eventSourceId: source.id,
      eventType: 'issues.opened',
      action: 'opened',
      status: 'task_created',
      payload: { issue: { title: 'Bug: Login broken' } },
      matchedSubscriptions: [{ subscriptionId: subscription.id, taskId: 'task-1' }],
      deliveryId,
    });

    // Create the task as the webhook handler would
    await db.insert(tasks).values({
      id: 'task-1',
      codespaceId: codespace.id,
      title: 'Handle issue: Bug: Login broken',
      column: 'backlog',
      position: 0,
      labels: [],
    });

    // Verify the pipeline
    const logEntry = await db.query.eventLog.findFirst({
      where: eq(eventLog.eventSourceId, source.id),
    });
    expect(logEntry!.status).toBe('task_created');
    expect(logEntry!.matchedSubscriptions).toEqual([
      { subscriptionId: subscription.id, taskId: 'task-1' },
    ]);

    const createdTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, 'task-1'),
    });
    expect(createdTask!.title).toContain('Bug: Login broken');
    expect(createdTask!.codespaceId).toBe(codespace.id);
  });

  it('IT-184: session events queryable in order for export', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    const eventTypes = [
      { type: 'chunk', channel: 'chunks', data: { text: 'Starting...' } },
      { type: 'tool:start', channel: 'toolCalls', data: { tool: 'Read', input: '/file.ts' } },
      { type: 'tool:result', channel: 'toolCalls', data: { tool: 'Read', output: 'contents' } },
      { type: 'chunk', channel: 'chunks', data: { text: 'Analysis complete.' } },
      { type: 'agent:completed', channel: 'presence', data: { status: 'completed' } },
    ];

    for (let i = 0; i < eventTypes.length; i++) {
      await db.insert(sessionEvents).values({
        id: createId(),
        sessionId: session.id,
        // F05-25: bare CUIDs map to session-kind discriminator.
        streamKind: 'session',
        offset: i,
        type: eventTypes[i]!.type,
        channel: eventTypes[i]!.channel,
        data: eventTypes[i]!.data,
        timestamp: Date.now() + i * 100,
      });
    }

    // Query in order by offset
    const events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
      orderBy: asc(sessionEvents.offset),
    });

    expect(events.length).toBe(5);
    expect(events[0]!.type).toBe('chunk');
    expect(events[0]!.offset).toBe(0);
    expect(events[1]!.type).toBe('tool:start');
    expect(events[1]!.offset).toBe(1);
    expect(events[2]!.type).toBe('tool:result');
    expect(events[3]!.type).toBe('chunk');
    expect(events[4]!.type).toBe('agent:completed');
    expect(events[4]!.offset).toBe(4);
  });
});
