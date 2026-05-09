/**
 * Functional Bug-Proving Tests for WorktreeService
 *
 * Each test exercises REAL WorktreeService code against an in-memory SQLite
 * database. Only the CommandRunner is mocked.
 *
 * Focus areas:
 *   - Setup-failure recovery: env copy, deps install, init script set status='error'
 *   - Branch-already-exists guard
 *   - Codespace/agent-missing pre-checks
 *   - remove() resets status to 'error' on git failure
 *   - merge() conflict + general error paths set status back to 'active'
 *   - getDiff / getStatus / list / getByBranch / runInitScript paths
 *   - createSandboxCommandRunner shell-injection guards (validateShellCommand)
 *
 * Run: npx vitest run --project functional tests/functional/prove-worktree-bugs.test.ts
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktrees } from '../../src/db/schema';
import {
  createSandboxCommandRunner,
  validateShellCommand,
  WorktreeService,
} from '../../src/services/worktree.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

type Responder = (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;

function buildRunner(responder: Responder = async () => ({ stdout: '', stderr: '' })) {
  return {
    exec: vi.fn(async (cmd: string, cwd: string) => responder(cmd, cwd)),
    execArgs: vi.fn(async (argv: string[], cwd: string) => responder(argv.join(' '), cwd)),
  };
}

describe('Bug-Proving Tests: WorktreeService', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ═══════════════════════════════════════════════════════════════════
  // create(): pre-flight pre-checks
  // ═══════════════════════════════════════════════════════════════════
  describe('create() pre-flight guards', () => {
    it('returns CREATION_FAILED when codespace lookup misses', async () => {
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.create({
        codespaceId: 'no-such-codespace',
        agentId: 'agent-x',
        taskId: 'task-x',
        taskTitle: 'Anything',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_CREATION_FAILED');
      expect(JSON.stringify(result.error)).toContain('Codespace not found');
    });

    it('returns CREATION_FAILED when agent lookup misses', async () => {
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const codespace = await createTestProject({
        name: 'Agent missing',
        path: '/tmp/agent-miss',
      });
      const result = await service.create({
        codespaceId: codespace.id,
        agentId: 'no-such-agent',
        taskId: 'task-x',
        taskTitle: 'A title',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_CREATION_FAILED');
      expect(JSON.stringify(result.error)).toContain('Agent not found');
    });

    it('returns BRANCH_EXISTS when git branch --list shows the branch', async () => {
      const runner = buildRunner(async (cmd) => {
        if (cmd.startsWith('git branch --list')) {
          return { stdout: '  fix-bug-abc123\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);
      const codespace = await createTestProject({
        name: 'Branch exists',
        path: '/tmp/branch-exists',
      });
      const agent = await createTestAgent(codespace.id);
      const task = await createTestTask(codespace.id, { title: 'Fix bug' });

      const result = await service.create({
        codespaceId: codespace.id,
        agentId: agent.id,
        taskId: task.id,
        taskTitle: 'Fix bug',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_BRANCH_EXISTS');
    });

    it('returns CREATION_FAILED when `git worktree add` throws', async () => {
      const runner = buildRunner(async (cmd) => {
        if (cmd.startsWith('git worktree add')) {
          throw new Error('fatal: invalid reference');
        }
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);
      const codespace = await createTestProject({
        name: 'wt add fails',
        path: '/tmp/wt-add-fails',
      });
      const agent = await createTestAgent(codespace.id);
      const task = await createTestTask(codespace.id, { title: 'Bad ref' });

      const result = await service.create({
        codespaceId: codespace.id,
        agentId: agent.id,
        taskId: task.id,
        taskTitle: 'Bad ref',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_CREATION_FAILED');

      // No row was inserted (failure was BEFORE insert)
      const rows = await db.query.worktrees.findMany({
        where: eq(worktrees.codespaceId, codespace.id),
      });
      expect(rows.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // create(): post-insert setup failures set status='error' and propagate
  // ═══════════════════════════════════════════════════════════════════
  describe('create() setup-failure recovery', () => {
    async function arrangeReadyCodespace(name: string, path: string) {
      const codespace = await createTestProject({ name, path });
      const agent = await createTestAgent(codespace.id);
      const task = await createTestTask(codespace.id, { title: name });
      return { codespace, agent, task };
    }

    it('env copy failure sets worktree status to error and returns ENV_COPY_FAILED', async () => {
      const { codespace, agent, task } = await arrangeReadyCodespace(
        'env-copy-fail',
        '/tmp/env-copy-fail'
      );
      const runner = buildRunner(async (cmd) => {
        if (cmd.startsWith('cp')) throw new Error('cp: no such file');
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);

      const result = await service.create(
        {
          codespaceId: codespace.id,
          agentId: agent.id,
          taskId: task.id,
          taskTitle: task.title,
        },
        { skipDepsInstall: true, skipInitScript: true }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_ENV_COPY_FAILED');

      // Worktree row was inserted, then status set to 'error'
      const rows = await db.query.worktrees.findMany({
        where: eq(worktrees.codespaceId, codespace.id),
      });
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('error');
    });

    it('deps install failure sets worktree status to error', async () => {
      const { codespace, agent, task } = await arrangeReadyCodespace('deps-fail', '/tmp/deps-fail');
      const runner = buildRunner(async (cmd) => {
        if (cmd === 'bun install') throw new Error('bun: command not found');
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);

      const result = await service.create(
        {
          codespaceId: codespace.id,
          agentId: agent.id,
          taskId: task.id,
          taskTitle: task.title,
        },
        { skipEnvCopy: true, skipInitScript: true }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_INIT_SCRIPT_FAILED');

      const rows = await db.query.worktrees.findMany({
        where: eq(worktrees.codespaceId, codespace.id),
      });
      expect(rows[0].status).toBe('error');
    });

    it('init script failure sets worktree status to error', async () => {
      const codespace = await createTestProject({
        name: 'init-fail',
        path: '/tmp/init-fail',
        config: { initScript: 'echo hello && false' },
      });
      const agent = await createTestAgent(codespace.id);
      const task = await createTestTask(codespace.id, { title: 'init-fail' });

      const runner = buildRunner(async (cmd) => {
        if (cmd === 'echo hello && false') throw new Error('non-zero exit');
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);

      const result = await service.create(
        {
          codespaceId: codespace.id,
          agentId: agent.id,
          taskId: task.id,
          taskTitle: task.title,
        },
        { skipEnvCopy: true, skipDepsInstall: true }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_INIT_SCRIPT_FAILED');

      const rows = await db.query.worktrees.findMany({
        where: eq(worktrees.codespaceId, codespace.id),
      });
      expect(rows[0].status).toBe('error');
    });

    it('successful create skipping all setup leaves status=active', async () => {
      const { codespace, agent, task } = await arrangeReadyCodespace('skip-all', '/tmp/skip-all');
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);

      const result = await service.create(
        {
          codespaceId: codespace.id,
          agentId: agent.id,
          taskId: task.id,
          taskTitle: task.title,
        },
        { skipEnvCopy: true, skipDepsInstall: true, skipInitScript: true }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('active');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // remove(): error path resets status to 'error' (not stuck in 'removing')
  // ═══════════════════════════════════════════════════════════════════
  describe('remove() error recovery', () => {
    it('git worktree remove failure sets status=error and returns REMOVAL_FAILED', async () => {
      const codespace = await createTestProject({
        name: 'remove-fail',
        path: '/tmp/remove-fail',
      });
      const agent = await createTestAgent(codespace.id);
      const wt = await createTestWorktree(codespace.id, {
        agentId: agent.id,
        status: 'active',
        branch: 'remove-bug-x',
      });

      const runner = buildRunner(async (cmd) => {
        if (cmd.startsWith('git worktree remove')) {
          throw new Error('fatal: working tree busy');
        }
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);

      const result = await service.remove(wt.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_REMOVAL_FAILED');

      const after = await db.query.worktrees.findFirst({ where: eq(worktrees.id, wt.id) });
      expect(after?.status).toBe('error');
    });

    it('successful remove with force=true uses --force argv', async () => {
      const codespace = await createTestProject({
        name: 'remove-ok',
        path: '/tmp/remove-ok',
      });
      const agent = await createTestAgent(codespace.id);
      const wt = await createTestWorktree(codespace.id, {
        agentId: agent.id,
        status: 'active',
      });

      const seenArgv: string[][] = [];
      const runner = {
        exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
        execArgs: vi.fn(async (argv: string[]) => {
          seenArgv.push(argv);
          return { stdout: '', stderr: '' };
        }),
      };
      const service = new WorktreeService(db, runner);
      const result = await service.remove(wt.id, true);
      expect(result.ok).toBe(true);

      const removeCall = seenArgv.find((a) => a[0] === 'git' && a[2] === 'remove');
      expect(removeCall).toBeDefined();
      expect(removeCall).toContain('--force');

      const after = await db.query.worktrees.findFirst({ where: eq(worktrees.id, wt.id) });
      expect(after?.status).toBe('removed');
      expect(after?.removedAt).toBeTruthy();
    });

    it('remove() with missing worktree returns NOT_FOUND', async () => {
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.remove('does-not-exist');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_NOT_FOUND');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // merge(): error branches reset status='active'
  // ═══════════════════════════════════════════════════════════════════
  describe('merge() error recovery', () => {
    it('general merge throw resets status to active and returns CREATION_FAILED', async () => {
      const codespace = await createTestProject({
        name: 'merge-throw',
        path: '/tmp/merge-throw',
      });
      const agent = await createTestAgent(codespace.id);
      const wt = await createTestWorktree(codespace.id, {
        agentId: agent.id,
        status: 'active',
      });

      const runner = buildRunner(async (cmd) => {
        if (cmd.includes('git add') || cmd.includes('git status')) {
          return { stdout: '', stderr: '' };
        }
        if (cmd.startsWith('git commit')) return { stdout: '', stderr: '' };
        if (cmd.startsWith('git rev-parse')) return { stdout: 'sha1', stderr: '' };
        if (cmd.startsWith('git checkout')) {
          throw new Error('fatal: cannot checkout');
        }
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);

      const result = await service.merge(wt.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_CREATION_FAILED');

      const after = await db.query.worktrees.findFirst({ where: eq(worktrees.id, wt.id) });
      expect(after?.status).toBe('active');
    });

    it('successful merge sets mergedAt and status=active', async () => {
      const codespace = await createTestProject({
        name: 'merge-ok',
        path: '/tmp/merge-ok',
      });
      const agent = await createTestAgent(codespace.id);
      const wt = await createTestWorktree(codespace.id, {
        agentId: agent.id,
        status: 'active',
      });

      const runner = buildRunner(async (cmd) => {
        if (cmd.includes('git add') || cmd.includes('git status'))
          return { stdout: '', stderr: '' };
        if (cmd.startsWith('git commit')) return { stdout: '', stderr: '' };
        if (cmd.startsWith('git rev-parse')) return { stdout: 'sha1', stderr: '' };
        if (cmd.startsWith('git checkout')) return { stdout: '', stderr: '' };
        if (cmd.startsWith('git pull')) return { stdout: '', stderr: '' };
        if (cmd.startsWith('git merge')) return { stdout: 'Merging…', stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);

      const result = await service.merge(wt.id);
      expect(result.ok).toBe(true);

      const after = await db.query.worktrees.findFirst({ where: eq(worktrees.id, wt.id) });
      expect(after?.status).toBe('active');
      expect(after?.mergedAt).toBeTruthy();
    });

    it('merge() returns NOT_FOUND for unknown id', async () => {
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.merge('nope');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_NOT_FOUND');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // commit(): empty change short-circuit
  // ═══════════════════════════════════════════════════════════════════
  describe('commit() empty-tree behaviour', () => {
    it('returns ok with empty SHA when working tree is clean (no status output)', async () => {
      const codespace = await createTestProject({
        name: 'commit-clean',
        path: '/tmp/commit-clean',
      });
      const wt = await createTestWorktree(codespace.id, { status: 'active' });

      const runner = buildRunner(async (cmd) => {
        if (cmd.includes('git status')) return { stdout: '', stderr: '' }; // clean
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);
      const result = await service.commit(wt.id, 'no changes here');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe('');
    });

    it('returns NOT_FOUND for missing worktree', async () => {
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.commit('nope', 'msg');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_NOT_FOUND');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // runInitScript(): missing script, sanitization, NOT_FOUND
  // ═══════════════════════════════════════════════════════════════════
  describe('runInitScript()', () => {
    it('returns ok when codespace has no initScript configured', async () => {
      const codespace = await createTestProject({
        name: 'no-init',
        path: '/tmp/no-init',
        // initScript NOT set
      });
      const wt = await createTestWorktree(codespace.id);
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);

      const result = await service.runInitScript(wt.id);
      expect(result.ok).toBe(true);
      // runner.exec should not have been called for the script
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('returns ok when initScript sanitizes to empty string', async () => {
      const codespace = await createTestProject({
        name: 'empty-init',
        path: '/tmp/empty-init',
        config: { initScript: ' ' },
      });
      const wt = await createTestWorktree(codespace.id);
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.runInitScript(wt.id);
      expect(result.ok).toBe(true);
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('returns NOT_FOUND when worktree id is unknown', async () => {
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.runInitScript('missing');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_NOT_FOUND');
    });

    it('runs sanitized script through runner.exec on success', async () => {
      const codespace = await createTestProject({
        name: 'init-ok',
        path: '/tmp/init-ok',
        config: { initScript: 'echo OK' },
      });
      const wt = await createTestWorktree(codespace.id);
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.runInitScript(wt.id);
      expect(result.ok).toBe(true);
      expect(runner.exec).toHaveBeenCalledWith('echo OK', wt.path);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // installDeps() / copyEnv() NOT_FOUND
  // ═══════════════════════════════════════════════════════════════════
  describe('installDeps() / copyEnv() unknown id', () => {
    it('installDeps returns NOT_FOUND for missing worktree', async () => {
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.installDeps('nope');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_NOT_FOUND');
    });

    it('copyEnv returns NOT_FOUND for missing worktree', async () => {
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.copyEnv('nope');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_NOT_FOUND');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // getDiff() / getStatus()
  // ═══════════════════════════════════════════════════════════════════
  describe('getDiff() / getStatus()', () => {
    it('getDiff returns parsed file stats and hunks', async () => {
      const codespace = await createTestProject({
        name: 'diff',
        path: '/tmp/diff',
      });
      const wt = await createTestWorktree(codespace.id, {
        baseBranch: 'main',
        path: '/tmp/diff/.worktrees/feat',
      });

      const numstatOut = '3\t1\tsrc/foo.ts\n10\t0\tsrc/bar.ts';
      const fullDiffOut =
        'diff --git a/src/foo.ts b/src/foo.ts\n@@ -1,3 +1,5 @@\n+added line\n' +
        'diff --git a/src/bar.ts b/src/bar.ts\n@@ -1,0 +1,10 @@\n+line\n';
      const runner = buildRunner(async (cmd) => {
        if (cmd.includes('--numstat')) return { stdout: numstatOut, stderr: '' };
        if (cmd.includes('git diff main...HEAD')) return { stdout: fullDiffOut, stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);
      const result = await service.getDiff(wt.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.files).toHaveLength(2);
      expect(result.value.stats.filesChanged).toBe(2);
      expect(result.value.stats.additions).toBe(13);
      expect(result.value.stats.deletions).toBe(1);
      // Hunks parsed from full diff
      const fooFile = result.value.files.find((f) => f.path === 'src/foo.ts');
      expect(fooFile?.hunks.length).toBeGreaterThan(0);
    });

    it('getDiff returns NOT_FOUND for missing worktree', async () => {
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.getDiff('nope');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_NOT_FOUND');
    });

    it('getDiff returns CREATION_FAILED when git diff throws', async () => {
      const codespace = await createTestProject({
        name: 'diff-fail',
        path: '/tmp/diff-fail',
      });
      const wt = await createTestWorktree(codespace.id);
      const runner = buildRunner(async (cmd) => {
        if (cmd.includes('git diff')) throw new Error('fatal: bad revspec');
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);
      const result = await service.getDiff(wt.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('WORKTREE_CREATION_FAILED');
    });

    it('getStatus returns the row and NOT_FOUND otherwise', async () => {
      const codespace = await createTestProject({
        name: 'status',
        path: '/tmp/status',
      });
      const wt = await createTestWorktree(codespace.id, { branch: 'feat-x' });
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const ok = await service.getStatus(wt.id);
      expect(ok.ok).toBe(true);
      if (!ok.ok) return;
      expect(ok.value.branch).toBe('feat-x');

      const miss = await service.getStatus('nope');
      expect(miss.ok).toBe(false);
      if (miss.ok) return;
      expect(miss.error.code).toBe('WORKTREE_NOT_FOUND');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // list() filesystem sync (stale rows are scheduled for cleanup)
  // ═══════════════════════════════════════════════════════════════════
  describe('list()', () => {
    it('returns only worktrees whose paths exist on disk; stale rows are flagged for cleanup', async () => {
      const codespace = await createTestProject({
        name: 'list',
        path: '/tmp/list',
      });
      // Real path that exists on disk → stays
      await createTestWorktree(codespace.id, { branch: 'real-1', path: '/tmp' });
      // Path that does NOT exist → flagged stale + scheduled for delete
      await createTestWorktree(codespace.id, {
        branch: 'stale-1',
        path: '/tmp/this-path-does-not-exist-at-all-xyz',
      });

      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.list(codespace.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Only the existing-path worktree is returned
      expect(result.value.length).toBe(1);
      expect(result.value[0].branch).toBe('real-1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // getByBranch()
  // ═══════════════════════════════════════════════════════════════════
  describe('getByBranch()', () => {
    it('returns the row when branch matches and null otherwise', async () => {
      const codespace = await createTestProject({
        name: 'by-branch',
        path: '/tmp/by-branch',
      });
      const wt = await createTestWorktree(codespace.id, { branch: 'unique-branch-1' });
      const runner = buildRunner();
      const service = new WorktreeService(db, runner);

      const found = await service.getByBranch(codespace.id, 'unique-branch-1');
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value?.id).toBe(wt.id);

      const missing = await service.getByBranch(codespace.id, 'no-such-branch');
      expect(missing.ok).toBe(true);
      if (!missing.ok) return;
      expect(missing.value).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // prune(): only stale active worktrees are removed; failures bubble up
  // ═══════════════════════════════════════════════════════════════════
  describe('prune()', () => {
    it('removes stale active worktrees and reports counts', async () => {
      const codespace = await createTestProject({
        name: 'prune',
        path: '/tmp/prune',
      });
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      // Stale: active and old
      const staleWt = await createTestWorktree(codespace.id, {
        branch: 'stale',
        status: 'active',
      });
      // Set updatedAt to 30 days ago via direct update — there is no service
      // API to back-date; this is fixture maintenance, not a tested transition.
      await db.update(worktrees).set({ updatedAt: oldDate }).where(eq(worktrees.id, staleWt.id));

      // Recent active — not stale
      await createTestWorktree(codespace.id, { branch: 'recent', status: 'active' });

      const runner = buildRunner();
      const service = new WorktreeService(db, runner);
      const result = await service.prune(codespace.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pruned).toBe(1);
      expect(result.value.failed.length).toBe(0);
    });

    it('captures per-worktree removal failures into failed[]', async () => {
      const codespace = await createTestProject({
        name: 'prune-fail',
        path: '/tmp/prune-fail',
      });
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const staleWt = await createTestWorktree(codespace.id, {
        branch: 'stale-fails',
        status: 'active',
      });
      await db.update(worktrees).set({ updatedAt: oldDate }).where(eq(worktrees.id, staleWt.id));

      const runner = buildRunner(async (cmd) => {
        if (cmd.startsWith('git worktree remove')) {
          throw new Error('busy');
        }
        return { stdout: '', stderr: '' };
      });
      const service = new WorktreeService(db, runner);
      const result = await service.prune(codespace.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pruned).toBe(0);
      expect(result.value.failed.length).toBe(1);
      expect(result.value.failed[0].branch).toBe('stale-fails');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // validateShellCommand: rejects metacharacters
  // ═══════════════════════════════════════════════════════════════════
  describe('validateShellCommand', () => {
    it('throws on shell metacharacters', () => {
      expect(() => validateShellCommand('ls; rm -rf /')).toThrow();
      expect(() => validateShellCommand('echo `whoami`')).toThrow();
      expect(() => validateShellCommand('echo $(whoami)')).toThrow();
      expect(() => validateShellCommand('echo $' + '{HOME}')).toThrow();
      expect(() => validateShellCommand('cmd && other')).toThrow();
      expect(() => validateShellCommand('cmd || other')).toThrow();
      expect(() => validateShellCommand('echo > /etc/passwd')).toThrow();
    });

    it('throws on NUL byte and Unicode line separators', () => {
      expect(() => validateShellCommand('foo bar')).toThrow();
      expect(() => validateShellCommand('foo bar')).toThrow();
      expect(() => validateShellCommand('foo bar')).toThrow();
    });

    it('accepts a benign command', () => {
      expect(() => validateShellCommand('git status')).not.toThrow();
      expect(() => validateShellCommand('npm install --frozen-lockfile')).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // createSandboxCommandRunner — exec + execArgs delegate to sandbox.exec
  // ═══════════════════════════════════════════════════════════════════
  describe('createSandboxCommandRunner', () => {
    it('exec runs command via sh -c with cd into cwd', async () => {
      const sandboxExec = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
      const runner = createSandboxCommandRunner({ exec: sandboxExec });

      const result = await runner.exec('git status', '/work/dir');
      expect(result.stdout).toBe('ok');
      expect(sandboxExec).toHaveBeenCalledWith('sh', ['-c', `cd '/work/dir' && git status`]);
    });

    it('exec rejects shell metacharacters', async () => {
      const sandboxExec = vi.fn();
      const runner = createSandboxCommandRunner({ exec: sandboxExec });
      await expect(runner.exec('rm; sudo', '/x')).rejects.toBeDefined();
      expect(sandboxExec).not.toHaveBeenCalled();
    });

    it('exec throws COMMAND_FAILED on non-zero exit', async () => {
      const sandboxExec = vi.fn(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'fatal',
      }));
      const runner = createSandboxCommandRunner({ exec: sandboxExec });
      await expect(runner.exec('git status', '/x')).rejects.toBeDefined();
    });

    it('execArgs runs argv via positional sh -c "$@" template', async () => {
      const sandboxExec = vi.fn(async () => ({ exitCode: 0, stdout: 'argv ok', stderr: '' }));
      const runner = createSandboxCommandRunner({ exec: sandboxExec });

      const result = await runner.execArgs!(['git', 'log', '--oneline'], '/repo');
      expect(result.stdout).toBe('argv ok');
      const callArgs = sandboxExec.mock.calls[0]!;
      expect(callArgs[0]).toBe('sh');
      expect(callArgs[1]).toEqual([
        '-c',
        `cd '/repo' && exec "$@"`,
        '--',
        'git',
        'log',
        '--oneline',
      ]);
    });

    it('execArgs throws when argv is empty', async () => {
      const sandboxExec = vi.fn();
      const runner = createSandboxCommandRunner({ exec: sandboxExec });
      await expect(runner.execArgs!([], '/x')).rejects.toBeDefined();
      expect(sandboxExec).not.toHaveBeenCalled();
    });

    it('execArgs throws COMMAND_FAILED on non-zero exit', async () => {
      const sandboxExec = vi.fn(async () => ({ exitCode: 2, stdout: '', stderr: 'oops' }));
      const runner = createSandboxCommandRunner({ exec: sandboxExec });
      await expect(runner.execArgs!(['git', 'pull'], '/x')).rejects.toBeDefined();
    });
  });
});
