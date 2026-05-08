import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktrees } from '../../src/db/schema';
import type { CommandResult, CommandRunner } from '../../src/services/worktree.service';
import { WorktreeService } from '../../src/services/worktree.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

type ExecArgsHandler = (argv: string[], cwd: string) => Promise<CommandResult>;

function createCommandRunner(handler?: ExecArgsHandler): CommandRunner & {
  execArgs: ReturnType<typeof vi.fn<ExecArgsHandler>>;
} {
  return {
    exec: vi.fn(async (): Promise<CommandResult> => ({ stdout: '', stderr: '' })),
    execArgs: vi.fn(async (argv: string[], cwd: string): Promise<CommandResult> => {
      if (handler) {
        return handler(argv, cwd);
      }
      return { stdout: '', stderr: '' };
    }),
  };
}

describe('WorktreeService DB-backed behavior integration', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('merges a worktree and records mergedAt after the service-level git sequence succeeds', async () => {
    const project = await createTestProject({ path: '/tmp/worktree-merge-success' });
    const agent = await createTestAgent(project.id);
    const worktree = await createTestWorktree(project.id, {
      agentId: agent.id,
      status: 'active',
      branch: 'feature/merge-success',
      path: '/tmp/worktree-merge-success/.worktrees/feature/merge-success',
      baseBranch: 'main',
    });

    const runner = createCommandRunner(async (argv) => {
      if (argv.join(' ') === 'git status --porcelain') {
        return { stdout: 'M src/service.ts\n', stderr: '' };
      }
      if (argv.join(' ') === 'git rev-parse HEAD') {
        return { stdout: 'abc123\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const service = new WorktreeService(db as never, runner);

    const result = await service.merge(worktree.id);

    expect(result.ok).toBe(true);
    const afterMerge = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(afterMerge).toMatchObject({
      status: 'active',
      branch: 'feature/merge-success',
    });
    expect(afterMerge?.mergedAt).toBeTruthy();

    expect(runner.execArgs).toHaveBeenCalledWith(['git', 'add', '-A'], worktree.path);
    expect(runner.execArgs).toHaveBeenCalledWith(
      ['git', 'commit', '-m', 'Auto-commit before merge to main'],
      worktree.path
    );
    expect(runner.execArgs).toHaveBeenCalledWith(['git', 'checkout', 'main'], project.path);
    expect(runner.execArgs).toHaveBeenCalledWith(
      [
        'git',
        'merge',
        'feature/merge-success',
        '--no-ff',
        '-m',
        "Merge branch 'feature/merge-success'",
      ],
      project.path
    );
  });

  it('aborts a conflicting merge and resets the worktree status to active', async () => {
    const project = await createTestProject({ path: '/tmp/worktree-merge-conflict' });
    const agent = await createTestAgent(project.id);
    const worktree = await createTestWorktree(project.id, {
      agentId: agent.id,
      status: 'active',
      branch: 'feature/conflict',
      path: '/tmp/worktree-merge-conflict/.worktrees/feature/conflict',
      baseBranch: 'main',
    });

    const runner = createCommandRunner(async (argv) => {
      const command = argv.join(' ');
      if (command === 'git status --porcelain') {
        return { stdout: '', stderr: '' };
      }
      if (command.startsWith('git merge feature/conflict')) {
        return {
          stdout: '',
          stderr: 'CONFLICT (content): Merge conflict in src/service.ts',
        };
      }
      if (command === 'git diff --name-only --diff-filter=U') {
        return { stdout: 'src/service.ts\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const service = new WorktreeService(db as never, runner);

    const result = await service.merge(worktree.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Merge conflict');
    }

    const afterMerge = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(afterMerge?.status).toBe('active');
    expect(afterMerge?.mergedAt).toBeNull();
    expect(runner.execArgs).toHaveBeenCalledWith(['git', 'merge', '--abort'], project.path);
  });

  it('prunes only stale active worktrees through remove()', async () => {
    const project = await createTestProject({ path: '/tmp/worktree-prune-service' });
    const agent = await createTestAgent(project.id);
    const stale = await createTestWorktree(project.id, {
      agentId: agent.id,
      status: 'active',
      branch: 'feature/stale',
      path: '/tmp/worktree-prune-service/.worktrees/feature/stale',
    });
    const recent = await createTestWorktree(project.id, {
      agentId: agent.id,
      status: 'active',
      branch: 'feature/recent',
      path: '/tmp/worktree-prune-service/.worktrees/feature/recent',
    });

    await db
      .update(worktrees)
      .set({ updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(worktrees.id, stale.id));
    await db
      .update(worktrees)
      .set({ updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(worktrees.id, recent.id));

    const runner = createCommandRunner();
    const service = new WorktreeService(db as never, runner);

    const result = await service.prune(project.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ pruned: 1, failed: [] });

    const staleAfterPrune = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, stale.id),
    });
    const recentAfterPrune = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, recent.id),
    });
    expect(staleAfterPrune?.status).toBe('removed');
    expect(staleAfterPrune?.removedAt).toBeTruthy();
    expect(recentAfterPrune?.status).toBe('active');
    expect(runner.execArgs).toHaveBeenCalledWith(
      ['git', 'worktree', 'remove', stale.path, '--force'],
      project.path
    );
    expect(runner.execArgs).toHaveBeenCalledWith(
      ['git', 'branch', '-D', stale.branch],
      project.path
    );
  });
});
