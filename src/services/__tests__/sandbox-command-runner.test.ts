import { describe, expect, it, vi } from 'vitest';
import { createSandboxCommandRunner } from '../worktree.service.js';

describe('createSandboxCommandRunner', () => {
  it('executes command with correct cd prefix', async () => {
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
    };

    const runner = createSandboxCommandRunner(sandbox);
    await runner.exec('git status', '/workspace/project');

    expect(sandbox.exec).toHaveBeenCalledWith('sh', [
      '-c',
      "cd '/workspace/project' && git status",
    ]);
  });

  it('throws on non-zero exit code with stderr message', async () => {
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'fatal: not a git repo' }),
    };

    const runner = createSandboxCommandRunner(sandbox);

    await expect(runner.exec('git status', '/workspace')).rejects.toThrow(
      'Command failed with exit code 1'
    );
  });

  it('returns stdout and stderr correctly', async () => {
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'branch-name', stderr: 'warning' }),
    };

    const runner = createSandboxCommandRunner(sandbox);
    const result = await runner.exec('git branch --show-current', '/workspace');

    expect(result.stdout).toBe('branch-name');
    expect(result.stderr).toBe('warning');
  });

  it('handles shell escaping in cwd with single quotes', async () => {
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    };

    const runner = createSandboxCommandRunner(sandbox);
    await runner.exec('git status', "/workspace/it's-a-project");

    expect(sandbox.exec).toHaveBeenCalledWith('sh', [
      '-c',
      "cd '/workspace/it'\\''s-a-project' && git status",
    ]);
  });
});
