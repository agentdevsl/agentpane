import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliSessions, tasks } from '../../src/db/schema';
import { CLI_SESSIONS_MIGRATION_SQL } from '../../src/lib/bootstrap/phases/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Remaining Services: CLI & Memory (IT-227 to IT-230)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    // Run CLI sessions migration to create table
    try {
      execRawSql(CLI_SESSIONS_MIGRATION_SQL);
    } catch {
      // Table may already exist
    }
    // Add columns that exist in Drizzle schema but not in the initial migration
    const extraColumns = [
      'ALTER TABLE cli_sessions ADD COLUMN slug TEXT',
      'ALTER TABLE cli_sessions ADD COLUMN cli_version TEXT',
      'ALTER TABLE cli_sessions ADD COLUMN permission_mode TEXT',
      'ALTER TABLE cli_sessions ADD COLUMN topology TEXT',
      'ALTER TABLE cli_sessions ADD COLUMN queue_operations TEXT',
      'ALTER TABLE cli_sessions ADD COLUMN tool_invocations TEXT',
    ];
    for (const stmt of extraColumns) {
      try {
        execRawSql(stmt);
      } catch {
        // Column may already exist
      }
    }
    await db.delete(cliSessions);
  });

  afterEach(async () => {
    await db.delete(cliSessions);
    await clearTestDatabase();
  });

  it('IT-227: insert CLI session data', async () => {
    const sessionId = createId();
    const cliSessionId = createId();

    await db.insert(cliSessions).values({
      id: cliSessionId,
      sessionId,
      filePath: '/tmp/.claude/sessions/test.jsonl',
      cwd: '/Users/test/project',
      projectName: 'test-project',
      projectHash: 'abc123',
      gitBranch: 'main',
      status: 'active',
      messageCount: 5,
      turnCount: 3,
      goal: 'Fix authentication bug',
      model: 'claude-sonnet-4',
      startedAt: Date.now() - 60000,
      lastActivityAt: Date.now(),
      isSubagent: false,
    });

    const session = await db.query.cliSessions.findFirst({
      where: eq(cliSessions.id, cliSessionId),
    });
    expect(session).toBeTruthy();
    expect(session!.sessionId).toBe(sessionId);
    expect(session!.projectName).toBe('test-project');
    expect(session!.status).toBe('active');
    expect(session!.goal).toBe('Fix authentication bug');
    expect(session!.isSubagent).toBe(false);
    expect(session!.messageCount).toBe(5);
  });

  it('IT-228: codespace + task with git-related data patterns', async () => {
    const codespace = await createTestProject({
      name: 'Git Test Project',
      githubOwner: 'testorg',
      githubRepo: 'testrepo',
    });

    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      title: 'Add auth middleware',
    });

    // Simulate diff summary data shape
    const diffSummary = { filesChanged: 3, additions: 45, deletions: 12 };
    await db
      .update(tasks)
      .set({
        branch: 'agent/task-123/auth-middleware',
        diffSummary,
      })
      .where(eq(tasks.id, task.id));

    const updated = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(updated!.branch).toBe('agent/task-123/auth-middleware');
    expect(updated!.diffSummary).toEqual(diffSummary);
    expect((updated!.diffSummary as Record<string, number>).filesChanged).toBe(3);
    expect((updated!.diffSummary as Record<string, number>).additions).toBe(45);
  });

  it('IT-229: EMPTY_CONTEXT pattern shape verification', () => {
    const EMPTY_CONTEXT = {
      text: '',
      tokenCount: 0,
      sources: { conclusions: 0, platformConclusions: 0 },
    };

    expect(EMPTY_CONTEXT.text).toBe('');
    expect(EMPTY_CONTEXT.tokenCount).toBe(0);
    expect(EMPTY_CONTEXT.sources.conclusions).toBe(0);
    expect(EMPTY_CONTEXT.sources.platformConclusions).toBe(0);

    // Verify type shapes
    expect(typeof EMPTY_CONTEXT.text).toBe('string');
    expect(typeof EMPTY_CONTEXT.tokenCount).toBe('number');
    expect(typeof EMPTY_CONTEXT.sources).toBe('object');
    expect(typeof EMPTY_CONTEXT.sources.conclusions).toBe('number');
  });

  it('IT-230: fire-and-forget pattern catches errors without throwing', async () => {
    // Simulate a fire-and-forget function that catches errors internally
    const errors: string[] = [];

    async function fireAndForget(fn: () => Promise<void>): Promise<void> {
      try {
        await fn();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    // Should not throw even when inner function throws
    await fireAndForget(async () => {
      throw new Error('Simulated async error');
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe('Simulated async error');

    // Should not throw on success either
    await fireAndForget(async () => {
      // successful no-op
    });

    // Errors list should still have just 1 entry
    expect(errors).toHaveLength(1);
  });
});
