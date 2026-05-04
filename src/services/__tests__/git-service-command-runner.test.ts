import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../git.service.js';
import type { CommandRunner } from '../worktree.service.js';

function createDb() {
  return {
    query: {
      codespaces: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'cs-1',
          name: 'project',
          path: '/workspace/project',
        }),
      },
    },
  };
}

describe('GitService command execution', () => {
  it('uses execArgs and never falls back to shell exec for status', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('shell path must not be used'));
    const execArgs = vi
      .fn<NonNullable<CommandRunner['execArgs']>>()
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '0\t0\n', stderr: '' });

    const service = new GitService(createDb() as never, { exec, execArgs });
    const result = await service.getStatus('cs-1');

    expect(result.ok).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(execArgs).toHaveBeenCalledWith(
      ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
      '/workspace/project'
    );
  });

  it('has no direct commandRunner.exec call sites in git.service', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../git.service.ts'), 'utf8');

    expect(source).not.toMatch(/commandRunner\.exec\s*\(/);
  });
});
