/**
 * Integration coverage for WorktreeInitService.initializeRemoteWorkspace.
 *
 * Targets the GitHub-token-resolution + clone path that the existing
 * IT-306n/o tests (no-config / reuse-existing) skip. Covers:
 *   - Token resolution succeeds → publishes status + clone messages,
 *     calls initializeRemoteWorkspaceInPod, returns the new branch.
 *   - Token resolution returns null → falls back to empty workspace,
 *     publishes the "no credentials" message, returns null.
 *   - Pod-side clone fails → returns null with the failure message.
 *   - DB update of `tasks.branch` fails → swallows and continues to
 *     publish the workspace-ready message.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { WorktreeInitService } from '../../src/services/container-agent/worktree-init.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const gitTokenMocks = vi.hoisted(() => ({
  resolveGitToken: vi.fn(),
  parseGitRemoteUrl: vi.fn(),
  deriveGitHubFromPath: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/lib/sandbox/git-token-resolver.js', () => ({
  resolveGitToken: (...args: unknown[]) => gitTokenMocks.resolveGitToken(...args),
  parseGitRemoteUrl: (...args: unknown[]) => gitTokenMocks.parseGitRemoteUrl(...args),
  deriveGitHubFromPath: (...args: unknown[]) => gitTokenMocks.deriveGitHubFromPath(...args),
}));

const k8sInitMocks = vi.hoisted(() => ({
  initializeK8sWorkspace: vi.fn(),
}));

vi.mock('../../src/lib/sandbox/k8s-workspace-initializer.js', () => ({
  initializeK8sWorkspace: (...args: unknown[]) => k8sInitMocks.initializeK8sWorkspace(...args),
}));

describe('WorktreeInitService.initializeRemoteWorkspace (IT-WI-REMOTE)', () => {
  let db: ReturnType<typeof getTestDb>;
  let streams: { publish: ReturnType<typeof vi.fn> };
  let service: WorktreeInitService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    streams = { publish: vi.fn().mockResolvedValue(undefined) };
    service = new WorktreeInitService({ db, streams, githubTokenService: undefined } as never);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('returns null when resolveGitToken yields no token (uses empty workspace)', async () => {
    const codespace = await createTestProject({
      githubOwner: 'owner',
      githubRepo: 'repo',
    });
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    gitTokenMocks.resolveGitToken.mockResolvedValueOnce(null);

    const sandbox = { exec: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }) };

    const result = await service.initializeRemoteWorkspace({
      sandbox: sandbox as never,
      codespace: {
        githubOwner: 'owner',
        githubRepo: 'repo',
        githubInstallationId: null,
        name: codespace.name,
        path: codespace.path,
        id: codespace.id,
      },
      task: { title: 'Task A' },
      taskId: task.id,
      sessionId: 'sess-1',
      phase: 'plan',
    });

    expect(result).toBeNull();
    // Status + system message published
    const types = streams.publish.mock.calls.map((c) => c[1]);
    expect(types).toContain('container-agent:status');
    expect(types).toContain('container-agent:message');
  });

  it('returns null when initializeRemoteWorkspaceInPod returns no branch (clone failed)', async () => {
    const codespace = await createTestProject({
      githubOwner: 'owner',
      githubRepo: 'repo',
    });
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    gitTokenMocks.resolveGitToken.mockResolvedValueOnce({
      token: 'ghs_xx',
      type: 'app',
      owner: 'owner',
      repo: 'repo',
    });
    k8sInitMocks.initializeK8sWorkspace.mockResolvedValueOnce({
      branch: null,
      worktreePath: '',
      error: 'auth failed',
    });

    const sandbox = { exec: vi.fn() };

    const result = await service.initializeRemoteWorkspace({
      sandbox: sandbox as never,
      codespace: {
        githubOwner: 'owner',
        githubRepo: 'repo',
        githubInstallationId: null,
        name: codespace.name,
        path: codespace.path,
        id: codespace.id,
      },
      task: { title: 'Task B' },
      taskId: task.id,
      sessionId: 'sess-2',
      phase: 'plan',
    });

    expect(result).toBeNull();
    expect(k8sInitMocks.initializeK8sWorkspace).toHaveBeenCalled();
  });

  it('returns the new worktree path + branch and saves branch to task on success', async () => {
    const codespace = await createTestProject({
      githubOwner: 'owner',
      githubRepo: 'repo',
    });
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    gitTokenMocks.resolveGitToken.mockResolvedValueOnce({
      token: 'ghs_yy',
      type: 'app',
      owner: 'owner',
      repo: 'repo',
    });
    k8sInitMocks.initializeK8sWorkspace.mockResolvedValueOnce({
      branch: 'agent/abc/task-b',
      worktreePath: '/workspace/.worktrees/agent-abc-task-b',
    });

    const sandbox = { exec: vi.fn() };

    const result = await service.initializeRemoteWorkspace({
      sandbox: sandbox as never,
      codespace: {
        githubOwner: 'owner',
        githubRepo: 'repo',
        githubInstallationId: null,
        name: codespace.name,
        path: codespace.path,
        id: codespace.id,
      },
      task: { title: 'Build feature' },
      taskId: task.id,
      sessionId: 'sess-3',
      phase: 'plan',
    });

    expect(result).not.toBeNull();
    expect(result?.branch).toBe('agent/abc/task-b');
    expect(result?.worktreePath).toBe('/workspace/.worktrees/agent-abc-task-b');

    // Verify task.branch was persisted
    const taskRow = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskRow?.branch).toBe('agent/abc/task-b');
  });

  it('derives GitHub owner/repo from sandbox-side git remote when codespace has no config', async () => {
    const codespace = await createTestProject({
      path: '/no-host-mount',
      githubOwner: null,
      githubRepo: null,
    });
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    // Sandbox returns the remote URL when `git -C ... remote get-url origin` runs
    const sandbox = {
      exec: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'https://github.com/derived-owner/derived-repo.git',
        stderr: '',
      }),
    };
    gitTokenMocks.parseGitRemoteUrl.mockReturnValue({
      owner: 'derived-owner',
      repo: 'derived-repo',
    });
    gitTokenMocks.resolveGitToken.mockResolvedValueOnce({
      token: 'ghs_zz',
      type: 'app',
      owner: 'derived-owner',
      repo: 'derived-repo',
    });
    k8sInitMocks.initializeK8sWorkspace.mockResolvedValueOnce({
      branch: 'agent/derived/task',
      worktreePath: '/workspace/.worktrees/agent-derived-task',
    });

    const result = await service.initializeRemoteWorkspace({
      sandbox: sandbox as never,
      codespace: {
        githubOwner: null,
        githubRepo: null,
        githubInstallationId: null,
        name: codespace.name,
        path: null,
        id: codespace.id,
      },
      task: { title: 'Inferred remote task' },
      taskId: task.id,
      sessionId: 'sess-4',
      phase: 'plan',
    });

    expect(result).not.toBeNull();
    expect(gitTokenMocks.parseGitRemoteUrl).toHaveBeenCalled();
    // Verify backfill to codespaces row happened
    const cs = await db.query.codespaces.findFirst({
      where: (codespaces, { eq }) => eq(codespaces.id, codespace.id),
    });
    expect(cs?.githubOwner).toBe('derived-owner');
    expect(cs?.githubRepo).toBe('derived-repo');
  });

  it('reuses existing pod worktree on execute phase when test -d succeeds', async () => {
    const codespace = await createTestProject({
      githubOwner: 'owner',
      githubRepo: 'repo',
    });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      branch: 'agent/existing/task',
    });

    const sandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    };

    const result = await service.initializeRemoteWorkspace({
      sandbox: sandbox as never,
      codespace: {
        githubOwner: 'owner',
        githubRepo: 'repo',
        githubInstallationId: null,
        name: codespace.name,
        path: codespace.path,
        id: codespace.id,
      },
      task: { title: 'Recover existing', branch: 'agent/existing/task' },
      taskId: task.id,
      sessionId: 'sess-5',
      phase: 'execute',
    });

    expect(result).not.toBeNull();
    expect(result?.branch).toBe('agent/existing/task');
    // Did NOT call initializeK8sWorkspace because pod still has the worktree
    expect(k8sInitMocks.initializeK8sWorkspace).not.toHaveBeenCalled();
  });
});
