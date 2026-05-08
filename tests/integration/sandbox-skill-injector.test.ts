/**
 * Integration tests for `skill-injector.ts` (injectSkills + injectAgents).
 *
 * Mirrors the existing unit tests at the integration project so the lines
 * count toward combined integration+functional coverage. Mocks the Sandbox
 * `exec` interface — no DB required.
 *
 * IT-IDs: IT-1720 to IT-1759
 */
import { describe, expect, it, vi } from 'vitest';
import type { MergedAgent, MergedSkill } from '../../src/lib/config/template-merge';
import { injectAgents, injectSkills } from '../../src/lib/sandbox/skill-injector';

interface ExecCall {
  cmd: string;
  args: string[];
}

function createMockSandbox(overrides?: {
  lsStdout?: string;
  lsExitCode?: number;
  mkdirExitCode?: number;
  writeExitCode?: number;
  lsThrows?: boolean;
  writeThrows?: Error;
}) {
  const calls: ExecCall[] = [];
  const sandbox = {
    exec: vi.fn(async (cmd: string, args: string[] = []) => {
      calls.push({ cmd, args });
      if (cmd === 'ls') {
        if (overrides?.lsThrows) throw new Error('sandbox connection lost');
        return {
          exitCode: overrides?.lsExitCode ?? 0,
          stdout: overrides?.lsStdout ?? '',
          stderr: '',
        };
      }
      if (cmd === 'mkdir') {
        return {
          exitCode: overrides?.mkdirExitCode ?? 0,
          stdout: '',
          stderr: overrides?.mkdirExitCode !== 0 ? 'permission denied' : '',
        };
      }
      if (cmd === 'sh') {
        if (overrides?.writeThrows) throw overrides.writeThrows;
        return {
          exitCode: overrides?.writeExitCode ?? 0,
          stdout: '',
          stderr: overrides?.writeExitCode !== 0 ? 'write failed' : '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    calls,
  };
  return sandbox;
}

function makeSkill(overrides: Partial<MergedSkill> = {}): MergedSkill {
  return {
    id: 'terraform-test',
    name: 'Terraform Test',
    description: 'Write terraform tests',
    tags: ['terraform', 'testing'],
    content: '# Terraform Test Skill\n\nWrite tests for modules.',
    sourceType: 'org',
    ...overrides,
  };
}

function makeAgent(overrides: Partial<MergedAgent> = {}): MergedAgent {
  return {
    name: 'tf-module-developer',
    description: 'Develops Terraform modules',
    content: '# Module Developer\n\nImplement Terraform modules.',
    sourceType: 'org',
    ...overrides,
  };
}

// ── injectSkills ──

describe('injectSkills (integration)', () => {
  it('IT-1720: returns zero counts for empty skills array', async () => {
    const sandbox = createMockSandbox();
    const result = await injectSkills(sandbox as never, []);
    expect(result).toEqual({ injected: 0, skipped: 0, errors: [] });
  });

  it('IT-1721: injects a single skill successfully', async () => {
    const sandbox = createMockSandbox();
    const result = await injectSkills(sandbox as never, [makeSkill()]);
    expect(result.injected).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('IT-1722: skips skills already on disk', async () => {
    const sandbox = createMockSandbox({ lsStdout: 'terraform-test\nother' });
    const result = await injectSkills(sandbox as never, [makeSkill()]);
    expect(result.injected).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('IT-1723: rejects path-traversal skill IDs', async () => {
    const sandbox = createMockSandbox();
    const result = await injectSkills(sandbox as never, [makeSkill({ id: '../escape' })]);
    expect(result.injected).toBe(0);
    expect(result.errors[0]!.message).toContain('Unsafe skill ID');
  });

  it('IT-1724: rejects skill IDs starting with dot', async () => {
    const sandbox = createMockSandbox();
    const result = await injectSkills(sandbox as never, [makeSkill({ id: '.hidden' })]);
    expect(result.errors).toHaveLength(1);
  });

  it('IT-1725: rejects skill IDs containing slashes', async () => {
    const sandbox = createMockSandbox();
    const result = await injectSkills(sandbox as never, [makeSkill({ id: 'foo/bar' })]);
    expect(result.errors).toHaveLength(1);
  });

  it('IT-1726: accepts hyphens and underscores in skill IDs', async () => {
    const sandbox = createMockSandbox();
    const result = await injectSkills(sandbox as never, [makeSkill({ id: 'my-skill_v2' })]);
    expect(result.injected).toBe(1);
  });

  it('IT-1727: handles mkdir failure', async () => {
    const sandbox = createMockSandbox({ mkdirExitCode: 1 });
    const result = await injectSkills(sandbox as never, [makeSkill()]);
    expect(result.errors[0]!.message).toContain('Failed to create directory');
  });

  it('IT-1728: handles write failure', async () => {
    const sandbox = createMockSandbox({ writeExitCode: 1 });
    const result = await injectSkills(sandbox as never, [makeSkill()]);
    expect(result.errors[0]!.message).toContain('Failed to write');
  });

  it('IT-1729: handles unexpected exec throw', async () => {
    const sandbox = createMockSandbox({ writeThrows: new Error('container gone') });
    const result = await injectSkills(sandbox as never, [makeSkill()]);
    expect(result.errors[0]!.message).toContain('container gone');
  });

  it('IT-1730: continues injecting after one fails', async () => {
    const sandbox = createMockSandbox();
    const result = await injectSkills(sandbox as never, [
      makeSkill({ id: '../bad' }),
      makeSkill({ id: 'good' }),
    ]);
    expect(result.injected).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('IT-1731: uses custom workspacePath', async () => {
    const sandbox = createMockSandbox();
    await injectSkills(sandbox as never, [makeSkill()], '/custom');
    const lsCall = sandbox.calls.find((c) => c.cmd === 'ls');
    expect(lsCall?.args[1]).toBe('/custom/.claude/skills');
  });

  it('IT-1732: treats ls non-zero exit as empty directory', async () => {
    const sandbox = createMockSandbox({ lsExitCode: 2 });
    const result = await injectSkills(sandbox as never, [makeSkill()]);
    expect(result.injected).toBe(1);
  });

  it('IT-1733: treats ls throw as empty directory', async () => {
    const sandbox = createMockSandbox({ lsThrows: true });
    const result = await injectSkills(sandbox as never, [makeSkill()]);
    expect(result.injected).toBe(1);
  });

  it('IT-1734: writes content base64-encoded via positional args', async () => {
    const sandbox = createMockSandbox();
    await injectSkills(sandbox as never, [makeSkill()]);
    const shCall = sandbox.calls.find((c) => c.cmd === 'sh');
    expect(shCall!.args[0]).toBe('-c');
    expect(shCall!.args[1]).toContain('base64 -d');
    expect(shCall!.args[2]).toBe('--');
  });

  it('IT-1735: builds frontmatter with name/description/tags/source', async () => {
    const sandbox = createMockSandbox();
    await injectSkills(sandbox as never, [makeSkill({ tags: ['tf', 'aws'] })]);
    const shCall = sandbox.calls.find((c) => c.cmd === 'sh');
    const decoded = Buffer.from(shCall!.args[3]!, 'base64').toString('utf-8');
    expect(decoded).toContain('name: "Terraform Test"');
    expect(decoded).toContain('description: "Write terraform tests"');
    expect(decoded).toMatch(/tags:\s*\n\s*- "tf"\s*\n\s*- "aws"/);
    expect(decoded).toContain('source: "org"');
  });

  it('IT-1736: emits executionSkill when present', async () => {
    const sandbox = createMockSandbox();
    await injectSkills(sandbox as never, [
      makeSkill({ executionSkill: true } as Partial<MergedSkill>),
    ]);
    const shCall = sandbox.calls.find((c) => c.cmd === 'sh');
    const decoded = Buffer.from(shCall!.args[3]!, 'base64').toString('utf-8');
    expect(decoded).toContain('executionSkill: true');
  });

  it('IT-1737: omits description when empty', async () => {
    const sandbox = createMockSandbox();
    await injectSkills(sandbox as never, [makeSkill({ description: undefined })]);
    const shCall = sandbox.calls.find((c) => c.cmd === 'sh');
    const decoded = Buffer.from(shCall!.args[3]!, 'base64').toString('utf-8');
    expect(decoded).not.toContain('description:');
  });

  it('IT-1738: omits tags when empty array', async () => {
    const sandbox = createMockSandbox();
    await injectSkills(sandbox as never, [makeSkill({ tags: [] })]);
    const shCall = sandbox.calls.find((c) => c.cmd === 'sh');
    const decoded = Buffer.from(shCall!.args[3]!, 'base64').toString('utf-8');
    expect(decoded).not.toContain('tags:');
  });

  it('IT-1739: drops unsafe tags but keeps clean ones', async () => {
    const sandbox = createMockSandbox();
    await injectSkills(sandbox as never, [makeSkill({ tags: ['foo\n---\nevil: true', 'clean'] })]);
    const shCall = sandbox.calls.find((c) => c.cmd === 'sh');
    const decoded = Buffer.from(shCall!.args[3]!, 'base64').toString('utf-8');
    expect(decoded).not.toMatch(/^evil:/m);
    expect(decoded).toContain('"clean"');
  });
});

// ── injectAgents ──

describe('injectAgents (integration)', () => {
  it('IT-1750: returns zero counts for empty agents array', async () => {
    const sandbox = createMockSandbox();
    const result = await injectAgents(sandbox as never, []);
    expect(result).toEqual({ injected: 0, skipped: 0, errors: [] });
  });

  it('IT-1751: injects a single agent', async () => {
    const sandbox = createMockSandbox();
    const result = await injectAgents(sandbox as never, [makeAgent()]);
    expect(result.injected).toBe(1);
  });

  it('IT-1752: skips agents that already exist (strips .md suffix)', async () => {
    const sandbox = createMockSandbox({ lsStdout: 'tf-module-developer.md\nother.md' });
    const result = await injectAgents(sandbox as never, [makeAgent()]);
    expect(result.skipped).toBe(1);
  });

  it('IT-1753: rejects unsafe agent name', async () => {
    const sandbox = createMockSandbox();
    const result = await injectAgents(sandbox as never, [makeAgent({ name: '../escape' })]);
    expect(result.errors[0]!.message).toContain('Unsafe agent name');
  });

  it('IT-1754: each agent fails when mkdir fails', async () => {
    const sandbox = createMockSandbox({ mkdirExitCode: 1 });
    const result = await injectAgents(sandbox as never, [
      makeAgent({ name: 'a' }),
      makeAgent({ name: 'b' }),
    ]);
    expect(result.errors).toHaveLength(2);
  });

  it('IT-1755: handles write exit code', async () => {
    const sandbox = createMockSandbox({ writeExitCode: 1 });
    const result = await injectAgents(sandbox as never, [makeAgent()]);
    expect(result.errors[0]!.message).toContain('Failed to write');
  });

  it('IT-1756: handles unexpected throw on agent write', async () => {
    const sandbox = createMockSandbox({ writeThrows: new Error('disk full') });
    const result = await injectAgents(sandbox as never, [makeAgent()]);
    expect(result.errors[0]!.message).toContain('disk full');
  });

  it('IT-1757: continues after one agent fails', async () => {
    const sandbox = createMockSandbox();
    const result = await injectAgents(sandbox as never, [
      makeAgent({ name: '.bad' }),
      makeAgent({ name: 'good' }),
    ]);
    expect(result.injected).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('IT-1758: treats ls throw as empty directory', async () => {
    const sandbox = createMockSandbox({ lsThrows: true });
    const result = await injectAgents(sandbox as never, [makeAgent()]);
    expect(result.injected).toBe(1);
  });

  it('IT-1759: agent frontmatter contains name/description/source', async () => {
    const sandbox = createMockSandbox();
    await injectAgents(sandbox as never, [makeAgent({ description: 'A "great" agent' })]);
    const shCall = sandbox.calls.find((c) => c.cmd === 'sh');
    const decoded = Buffer.from(shCall!.args[3]!, 'base64').toString('utf-8');
    expect(decoded).toContain('name: "tf-module-developer"');
    expect(decoded).toContain('source: "org"');
  });

  it('IT-1760: omits description when empty', async () => {
    const sandbox = createMockSandbox();
    await injectAgents(sandbox as never, [makeAgent({ description: undefined })]);
    const shCall = sandbox.calls.find((c) => c.cmd === 'sh');
    const decoded = Buffer.from(shCall!.args[3]!, 'base64').toString('utf-8');
    expect(decoded).not.toContain('description:');
  });

  it('IT-1761: uses custom workspacePath for agents', async () => {
    const sandbox = createMockSandbox();
    await injectAgents(sandbox as never, [makeAgent()], '/my/ws');
    const lsCall = sandbox.calls.find((c) => c.cmd === 'ls');
    expect(lsCall?.args[1]).toBe('/my/ws/.claude/agents');
  });
});
