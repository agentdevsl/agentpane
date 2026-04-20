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

  // ── F06-02: positional-argv execArgs ──

  it('F06-02: execArgs passes argv literally (no shell interpolation)', async () => {
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const runner = createSandboxCommandRunner(sandbox);

    // Hostile values containing every shell metacharacter we can think of.
    const hostileUrl = 'https://evil.example/$(rm -rf /);`id`';
    const hostileTarget = '/tmp/foo && curl evil.example';
    await runner.execArgs!(['git', 'clone', '--', hostileUrl, hostileTarget], '/workspace/parent');

    // The argv must be passed to sandbox.exec as literal positional args
    // after `--`, NOT composed into the shell string. Only the `cwd`
    // appears inside the shell template, and it's single-quote-escaped.
    expect(sandbox.exec).toHaveBeenCalledTimes(1);
    const [cmd, args] = sandbox.exec.mock.calls[0]!;
    expect(cmd).toBe('sh');
    expect(args[0]).toBe('-c');
    expect(args[1]).toBe(`cd '/workspace/parent' && exec "$@"`);
    expect(args[2]).toBe('--');
    // Hostile values are at args[3..] verbatim, not interpolated.
    expect(args.slice(3)).toEqual(['git', 'clone', '--', hostileUrl, hostileTarget]);
    // Critical: the shell command string does NOT contain the hostile
    // payload — the metacharacters cannot be interpreted by `sh -c`.
    expect(args[1]).not.toContain(hostileUrl);
    expect(args[1]).not.toContain(hostileTarget);
    expect(args[1]).not.toContain('$(');
    expect(args[1]).not.toContain('&&\\ curl');
  });

  it('F06-02: execArgs escapes cwd but not argv values', async () => {
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const runner = createSandboxCommandRunner(sandbox);

    await runner.execArgs!(['echo', "it's fine"], "/work/it's here");

    const [, args] = sandbox.exec.mock.calls[0]!;
    // cwd is single-quote-escaped in the shell template
    expect(args[1]).toContain("cd '/work/it'\\''s here' && exec \"$@\"");
    // argv values pass through unchanged
    expect(args.slice(3)).toEqual(['echo', "it's fine"]);
  });

  it('F06-02: execArgs rejects empty argv', async () => {
    const sandbox = {
      exec: vi.fn(),
    };
    const runner = createSandboxCommandRunner(sandbox);

    await expect(runner.execArgs!([], '/workspace')).rejects.toThrow();
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it('F06-02: execArgs throws on non-zero exit with stderr', async () => {
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'fatal: bad url' }),
    };
    const runner = createSandboxCommandRunner(sandbox);

    await expect(
      runner.execArgs!(['git', 'clone', 'bad://url', '/tmp/x'], '/workspace')
    ).rejects.toThrow('Command failed with exit code 128');
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
