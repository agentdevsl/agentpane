import { exec as execCallback, execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeService } from '../../src/services/worktree.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);

// Check if git is available
let gitAvailable = true;
beforeAll(async () => {
  try {
    await exec('git --version');
  } catch {
    gitAvailable = false;
  }
});

describe('WorktreeService Integration', () => {
  let tempDir: string;
  let projectPath: string;
  let worktreeService: WorktreeService;
  let setupSuccessful = false;

  // F06-NEW-01: integration runner provides both `exec` (legacy shell) and
  // `execArgs` (positional, no shell). The service uses execArgs for every
  // git/cp invocation; exec remains for the user-script init path.
  const commandRunner = {
    exec: async (command: string, cwd: string) => {
      const result = await exec(command, { cwd });
      return { stdout: result.stdout, stderr: result.stderr };
    },
    execArgs: async (argv: string[], cwd: string) => {
      if (argv.length === 0) {
        throw new Error('argv must contain at least one element');
      }
      const [cmd, ...args] = argv;
      const result = await execFile(cmd as string, args, { cwd });
      return { stdout: result.stdout, stderr: result.stderr };
    },
  };

  beforeEach(async () => {
    setupSuccessful = false;
    if (!gitAvailable) return;

    try {
      await setupTestDatabase();

      // Create a temporary directory for git operations
      tempDir = await mkdtemp(join(tmpdir(), 'worktree-test-'));
      projectPath = join(tempDir, 'test-repo');

      // Initialize a git repository with main as default branch
      await exec(`mkdir -p ${projectPath}`);
      await exec('git init -b main', { cwd: projectPath });
      await exec('git config user.email "test@test.com"', { cwd: projectPath });
      await exec('git config user.name "Test User"', { cwd: projectPath });

      // Create initial commit
      await exec('echo "# Test" > README.md', { cwd: projectPath });
      await exec('git add .', { cwd: projectPath });
      await exec('git commit -m "Initial commit"', { cwd: projectPath });

      const db = getTestDb();
      worktreeService = new WorktreeService(db, commandRunner);
      setupSuccessful = true;
    } catch (error) {
      console.warn('Setup failed, skipping integration tests:', error);
    }
  });

  afterEach(async () => {
    if (!setupSuccessful) return;

    try {
      await clearTestDatabase();

      // Clean up temporary directory
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Cleanup errors are non-fatal
    }
  });

  it('creates a worktree with new branch', async () => {
    if (!setupSuccessful) return;

    const project = await createTestProject({ path: projectPath });
    const agent = await createTestAgent(project.id, { name: 'Test Agent' });
    const task = await createTestTask(project.id, { title: 'Test task' });

    const result = await worktreeService.create(
      {
        codespaceId: project.id,
        agentId: agent.id,
        taskId: task.id,
        taskTitle: task.title,
        baseBranch: 'main',
      },
      {
        skipEnvCopy: true,
        skipDepsInstall: true,
        skipInitScript: true,
      }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('active');
      expect(result.value.branch).toContain('test-task');
      expect(result.value.baseBranch).toBe('main');
    }
  });

  it('gets diff for worktree changes', async () => {
    if (!setupSuccessful) return;

    const project = await createTestProject({ path: projectPath });
    const agent = await createTestAgent(project.id, { name: 'Test Agent' });
    const task = await createTestTask(project.id, { title: 'Test task' });

    const createResult = await worktreeService.create(
      {
        codespaceId: project.id,
        agentId: agent.id,
        taskId: task.id,
        taskTitle: task.title,
        baseBranch: 'main',
      },
      {
        skipEnvCopy: true,
        skipDepsInstall: true,
        skipInitScript: true,
      }
    );

    if (!createResult.ok) return;

    // Make a change in the worktree
    await exec('echo "new content" > test.txt', { cwd: createResult.value.path });
    await exec('git add .', { cwd: createResult.value.path });
    await exec('git commit -m "Add test file"', { cwd: createResult.value.path });

    const diffResult = await worktreeService.getDiff(createResult.value.id);

    expect(diffResult.ok).toBe(true);
    if (diffResult.ok) {
      expect(diffResult.value.stats.filesChanged).toBeGreaterThan(0);
      expect(diffResult.value.stats.additions).toBeGreaterThan(0);
    }
  });

  it('removes worktree and branch', async () => {
    if (!setupSuccessful) return;

    const project = await createTestProject({ path: projectPath });
    const agent = await createTestAgent(project.id, { name: 'Test Agent' });
    const task = await createTestTask(project.id, { title: 'Test task' });

    const createResult = await worktreeService.create(
      {
        codespaceId: project.id,
        agentId: agent.id,
        taskId: task.id,
        taskTitle: task.title,
        baseBranch: 'main',
      },
      {
        skipEnvCopy: true,
        skipDepsInstall: true,
        skipInitScript: true,
      }
    );

    if (!createResult.ok) return;

    const removeResult = await worktreeService.remove(createResult.value.id, true);

    expect(removeResult.ok).toBe(true);

    // Verify worktree status is updated
    const statusResult = await worktreeService.getStatus(createResult.value.id);
    expect(statusResult.ok).toBe(true);
    if (statusResult.ok) {
      expect(statusResult.value.status).toBe('removed');
    }
  });

  it('commits changes in worktree', async () => {
    if (!setupSuccessful) return;

    const project = await createTestProject({ path: projectPath });
    const agent = await createTestAgent(project.id, { name: 'Test Agent' });
    const task = await createTestTask(project.id, { title: 'Test task' });

    const createResult = await worktreeService.create(
      {
        codespaceId: project.id,
        agentId: agent.id,
        taskId: task.id,
        taskTitle: task.title,
        baseBranch: 'main',
      },
      {
        skipEnvCopy: true,
        skipDepsInstall: true,
        skipInitScript: true,
      }
    );

    if (!createResult.ok) return;

    // Make a change in the worktree
    await exec('echo "new file" > new-file.txt', { cwd: createResult.value.path });

    const commitResult = await worktreeService.commit(createResult.value.id, 'Add new file');

    expect(commitResult.ok).toBe(true);
    if (commitResult.ok) {
      expect(commitResult.value).toBeTruthy();
      expect(commitResult.value.length).toBeGreaterThan(0);
    }
  });

  it('lists worktrees for a project', async () => {
    if (!setupSuccessful) return;

    const project = await createTestProject({ path: projectPath });
    const agent = await createTestAgent(project.id, { name: 'Test Agent' });
    const task1 = await createTestTask(project.id, { title: 'Task 1' });
    const task2 = await createTestTask(project.id, { title: 'Task 2' });

    const wt1 = await worktreeService.create(
      {
        codespaceId: project.id,
        agentId: agent.id,
        taskId: task1.id,
        taskTitle: task1.title,
        baseBranch: 'main',
      },
      {
        skipEnvCopy: true,
        skipDepsInstall: true,
        skipInitScript: true,
      }
    );

    const wt2 = await worktreeService.create(
      {
        codespaceId: project.id,
        agentId: agent.id,
        taskId: task2.id,
        taskTitle: task2.title,
        baseBranch: 'main',
      },
      {
        skipEnvCopy: true,
        skipDepsInstall: true,
        skipInitScript: true,
      }
    );

    if (!wt1.ok || !wt2.ok) return;

    const listResult = await worktreeService.list(project.id);

    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.length).toBe(2);
    }
  });
});
