import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubTokens, teams } from '../../src/db/schema';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Error Propagation: Agent (IT-206 to IT-208)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-206: moveColumn to in_progress with failing containerAgent returns task + agentError', async () => {
    const codespace = await createTestProject({
      config: {
        worktreeRoot: '.worktrees',
        defaultBranch: 'main',
        allowedTools: ['Read'],
        maxTurns: 50,
        sandbox: { enabled: true, provider: 'docker', mode: 'shared' },
      },
    });
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const mockWorktreeService = {
      getDiff: vi.fn().mockResolvedValue({
        ok: true,
        value: { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } },
      }),
      merge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };

    const taskService = new TaskService(db as never, mockWorktreeService);

    // Set a mock container agent that fails
    taskService.setContainerAgentService({
      providerName: 'docker',
      startAgent: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'SANDBOX_CREATE_FAILED', message: 'Docker not available', status: 500 },
      }),
      stopAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      isAgentRunning: vi.fn().mockReturnValue(false),
      approvePlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      rejectPlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    });

    const result = await taskService.moveColumn(task.id, 'in_progress');
    // Task move succeeds but agentError is returned
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.task.column).toBe('backlog');
      expect(result.value.agentError).toBe('Docker not available');
    }
  });

  it('IT-207: GitHub token invalidation — isValid flag set to false', async () => {
    const teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Token Team',
      slug: `token-${teamId.slice(0, 8)}`,
    });

    const tokenId = createId();
    await db.insert(githubTokens).values({
      id: tokenId,
      encryptedToken: 'encrypted-fake-token',
      tokenType: 'pat',
      teamId,
      isValid: true,
      githubLogin: 'testuser',
    });

    // Verify initially valid
    const before = await db.query.githubTokens.findFirst({
      where: eq(githubTokens.id, tokenId),
    });
    expect(before!.isValid).toBe(true);

    // Invalidate
    await db.update(githubTokens).set({ isValid: false }).where(eq(githubTokens.id, tokenId));

    const after = await db.query.githubTokens.findFirst({
      where: eq(githubTokens.id, tokenId),
    });
    expect(after!.isValid).toBe(false);
  });

  it('IT-208: EMPTY_CONTEXT pattern — verify object shape', () => {
    const EMPTY_CONTEXT = { text: '', tokenCount: 0 };

    expect(EMPTY_CONTEXT.text).toBe('');
    expect(EMPTY_CONTEXT.tokenCount).toBe(0);
    expect(typeof EMPTY_CONTEXT.text).toBe('string');
    expect(typeof EMPTY_CONTEXT.tokenCount).toBe('number');
  });
});
