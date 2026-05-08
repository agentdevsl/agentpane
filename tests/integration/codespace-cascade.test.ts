import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, codespaces, sessionEvents, sessions, tasks, worktrees } from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestSessionEvent } from '../factories/session-event.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Codespace FK cascade integration', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    execRawSql('PRAGMA foreign_keys = ON');
  });

  afterEach(async () => {
    execRawSql('PRAGMA foreign_keys = OFF');
    await clearTestDatabase();
  });

  it('deleting a codespace cascades to agents, sessions, tasks, and worktrees', async () => {
    const codespace = await createTestProject({
      name: 'Cascade Test',
      path: '/tmp/cascade-test',
    });
    const agent = await createTestAgent(codespace.id, { status: 'idle' });
    const session = await createTestSession(codespace.id, { status: 'active' });
    const task = await createTestTask(codespace.id, {
      title: 'Cascade Task',
      column: 'in_progress',
    });
    const worktree = await createTestWorktree(codespace.id, { status: 'active' });

    expect(await db.query.agents.findFirst({ where: eq(agents.id, agent.id) })).toBeTruthy();
    expect(await db.query.sessions.findFirst({ where: eq(sessions.id, session.id) })).toBeTruthy();
    expect(await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) })).toBeTruthy();
    expect(
      await db.query.worktrees.findFirst({ where: eq(worktrees.id, worktree.id) })
    ).toBeTruthy();

    await db.delete(codespaces).where(eq(codespaces.id, codespace.id));

    expect(await db.query.agents.findMany({ where: eq(agents.codespaceId, codespace.id) })).toEqual(
      []
    );
    expect(
      await db.query.sessions.findMany({ where: eq(sessions.codespaceId, codespace.id) })
    ).toEqual([]);
    expect(await db.query.tasks.findMany({ where: eq(tasks.codespaceId, codespace.id) })).toEqual(
      []
    );
    expect(
      await db.query.worktrees.findMany({ where: eq(worktrees.codespaceId, codespace.id) })
    ).toEqual([]);
  });

  it('session events are independent stream records and are not removed by session FK cascade', async () => {
    const codespace = await createTestProject({
      name: 'Session Event Stream Kind',
      path: '/tmp/session-event-stream-kind',
    });
    const session = await createTestSession(codespace.id, { status: 'active' });
    const event = await createTestSessionEvent(session.id, {
      offset: 0,
      type: 'chunk',
      channel: 'chunks',
      data: { text: 'persisted stream event' },
    });

    await db.delete(codespaces).where(eq(codespaces.id, codespace.id));

    expect(
      await db.query.sessions.findFirst({ where: eq(sessions.id, session.id) })
    ).toBeUndefined();
    expect(
      await db.query.sessionEvents.findFirst({ where: eq(sessionEvents.id, event.id) })
    ).toMatchObject({
      id: event.id,
      sessionId: session.id,
      streamKind: 'session',
    });
  });

  it('raw FK cascade does not enforce running-agent safety policy', async () => {
    const codespace = await createTestProject({
      name: 'Agent Race',
      path: '/tmp/agent-race',
    });
    const agent = await createTestAgent(codespace.id, { status: 'running' });
    const session = await createTestSession(codespace.id, {
      status: 'active',
      agentId: agent.id,
    });
    await createTestTask(codespace.id, {
      title: 'Active Task',
      column: 'in_progress',
      agentId: agent.id,
      sessionId: session.id,
    });

    await db.delete(codespaces).where(eq(codespaces.id, codespace.id));

    expect(
      await db.query.codespaces.findFirst({ where: eq(codespaces.id, codespace.id) })
    ).toBeUndefined();
    expect(await db.query.agents.findFirst({ where: eq(agents.id, agent.id) })).toBeUndefined();
  });
});
