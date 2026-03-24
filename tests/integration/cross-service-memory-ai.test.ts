import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionEvents, tasks } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Cross-Service: Memory & AI (IT-185 to IT-186)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-185: session events simulate memory capture with various event types', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    // Simulate memory-related events during agent execution
    const memoryEvents = [
      {
        type: 'chunk',
        channel: 'chunks',
        data: { text: 'I found the bug in the authentication module.' },
      },
      {
        type: 'tool:start',
        channel: 'toolCalls',
        data: { tool: 'Grep', input: { pattern: 'auth.*error', path: 'src/' } },
      },
      {
        type: 'tool:result',
        channel: 'toolCalls',
        data: { tool: 'Grep', output: 'src/auth.ts:42: authError(...)' },
      },
      {
        type: 'chunk',
        channel: 'chunks',
        data: { text: 'The fix involves updating the token validation logic.' },
      },
      {
        type: 'agent:turn',
        channel: 'presence',
        data: { turnNumber: 1, tokensUsed: 1500 },
      },
    ];

    for (let i = 0; i < memoryEvents.length; i++) {
      await db.insert(sessionEvents).values({
        id: createId(),
        sessionId: session.id,
        offset: i,
        type: memoryEvents[i]!.type,
        channel: memoryEvents[i]!.channel,
        data: memoryEvents[i]!.data,
        timestamp: Date.now() + i * 100,
      });
    }

    // Verify event data stored correctly
    const events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(events.length).toBe(5);

    // Verify specific event data shapes
    const chunkEvents = events.filter((e) => e.type === 'chunk');
    expect(chunkEvents.length).toBe(2);
    expect((chunkEvents[0]!.data as Record<string, unknown>).text).toContain('authentication');

    const toolEvents = events.filter((e) => e.type === 'tool:start');
    expect(toolEvents.length).toBe(1);
    expect((toolEvents[0]!.data as Record<string, unknown>).tool).toBe('Grep');
  });

  it('IT-186: standard codespace + task creation flow with all fields', async () => {
    const codespace = await createTestProject({
      name: 'AI Project',
      description: 'AI-powered service',
    });

    const task = await createTestTask(codespace.id, {
      title: 'Implement RAG pipeline',
      description: 'Build retrieval-augmented generation pipeline',
      labels: ['ai', 'backend'],
      column: 'backlog',
      position: 0,
    });

    // Verify task created in backlog with all fields
    const retrieved = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(retrieved).toBeTruthy();
    expect(retrieved!.codespaceId).toBe(codespace.id);
    expect(retrieved!.title).toBe('Implement RAG pipeline');
    expect(retrieved!.description).toBe('Build retrieval-augmented generation pipeline');
    expect(retrieved!.labels).toEqual(['ai', 'backend']);
    expect(retrieved!.column).toBe('backlog');
    expect(retrieved!.position).toBe(0);
    expect(retrieved!.agentId).toBeNull();
    expect(retrieved!.sessionId).toBeNull();
    expect(retrieved!.worktreeId).toBeNull();
    expect(retrieved!.approvedAt).toBeNull();
    expect(retrieved!.completedAt).toBeNull();
  });
});
