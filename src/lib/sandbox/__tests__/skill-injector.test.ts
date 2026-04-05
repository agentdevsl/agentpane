import { describe, expect, it, vi } from 'vitest';
import type { MergedAgent, MergedSkill } from '../../config/template-merge.js';
import { injectAgents, injectSkills } from '../skill-injector.js';

function defined<T>(value: T | undefined, label = 'value'): T {
  if (value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

// ── Mock Sandbox ──

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

// ── Skill Factory ──

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

// ── Agent Factory ──

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

describe('injectSkills', () => {
  it('returns zero counts for empty skills array', async () => {
    const sandbox = createMockSandbox();
    const result = await injectSkills(sandbox as never, []);
    expect(result.injected).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('injects a single skill successfully', async () => {
    const sandbox = createMockSandbox();
    const skill = makeSkill();
    const result = await injectSkills(sandbox as never, [skill]);

    expect(result.injected).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('skips skills that already exist on disk', async () => {
    const sandbox = createMockSandbox({ lsStdout: 'terraform-test\nother-skill' });
    const skill = makeSkill({ id: 'terraform-test' });
    const result = await injectSkills(sandbox as never, [skill]);

    expect(result.injected).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects unsafe skill IDs with path traversal', async () => {
    const sandbox = createMockSandbox();
    const skill = makeSkill({ id: '../escape' });
    const result = await injectSkills(sandbox as never, [skill]);

    expect(result.injected).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(defined(result.errors[0], 'errors[0]').message).toContain('Unsafe skill ID');
  });

  it('rejects skill IDs starting with a dot', async () => {
    const sandbox = createMockSandbox();
    const skill = makeSkill({ id: '.hidden' });
    const result = await injectSkills(sandbox as never, [skill]);

    expect(result.errors).toHaveLength(1);
    expect(defined(result.errors[0], 'errors[0]').skillId).toBe('.hidden');
  });

  it('rejects skill IDs containing slashes', async () => {
    const sandbox = createMockSandbox();
    const skill = makeSkill({ id: 'foo/bar' });
    const result = await injectSkills(sandbox as never, [skill]);

    expect(result.errors).toHaveLength(1);
  });

  it('accepts skill IDs with hyphens and underscores', async () => {
    const sandbox = createMockSandbox();
    const skill = makeSkill({ id: 'my-skill_v2' });
    const result = await injectSkills(sandbox as never, [skill]);

    expect(result.injected).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('handles mkdir failure gracefully', async () => {
    const sandbox = createMockSandbox({ mkdirExitCode: 1 });
    const skill = makeSkill();
    const result = await injectSkills(sandbox as never, [skill]);

    expect(result.injected).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(defined(result.errors[0], 'errors[0]').message).toContain('Failed to create directory');
  });

  it('handles write failure gracefully', async () => {
    const sandbox = createMockSandbox({ writeExitCode: 1 });
    const skill = makeSkill();
    const result = await injectSkills(sandbox as never, [skill]);

    expect(result.injected).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(defined(result.errors[0], 'errors[0]').message).toContain('Failed to write');
  });

  it('handles unexpected sandbox.exec throw', async () => {
    const sandbox = createMockSandbox({ writeThrows: new Error('container gone') });
    const skill = makeSkill();
    const result = await injectSkills(sandbox as never, [skill]);

    expect(result.injected).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(defined(result.errors[0], 'errors[0]').message).toContain('container gone');
  });

  it('continues injecting remaining skills after one fails', async () => {
    // First skill has unsafe ID, second is valid
    const sandbox = createMockSandbox();
    const skills = [makeSkill({ id: '../bad' }), makeSkill({ id: 'good-skill', name: 'Good' })];
    const result = await injectSkills(sandbox as never, skills);

    expect(result.injected).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('uses custom workspacePath', async () => {
    const sandbox = createMockSandbox();
    const skill = makeSkill();
    await injectSkills(sandbox as never, [skill], '/custom/path');

    const lsCall = sandbox.calls.find((c: ExecCall) => c.cmd === 'ls');
    expect(lsCall?.args[1]).toBe('/custom/path/.claude/skills');
  });

  it('treats ls failure as empty directory (non-zero exit code)', async () => {
    const sandbox = createMockSandbox({ lsExitCode: 2 });
    const skill = makeSkill();
    const result = await injectSkills(sandbox as never, [skill]);

    // Should still inject since directory is treated as empty
    expect(result.injected).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('treats ls exception as empty directory', async () => {
    const sandbox = createMockSandbox({ lsThrows: true });
    const skill = makeSkill();
    const result = await injectSkills(sandbox as never, [skill]);

    expect(result.injected).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('uses base64 encoding to prevent shell injection', async () => {
    const sandbox = createMockSandbox();
    const skill = makeSkill({ content: 'content with "quotes" and $variables' });
    await injectSkills(sandbox as never, [skill]);

    // Verify the sh -c call uses positional args with base64
    const shCall = sandbox.calls.find((c: ExecCall) => c.cmd === 'sh');
    expect(shCall).toBeDefined();
    expect(shCall!.args[0]).toBe('-c');
    expect(shCall!.args[1]).toContain('base64 -d');
    // The encoded content is passed as a positional arg, not interpolated
    expect(shCall!.args[2]).toBe('--');
  });

  it('builds markdown with frontmatter including tags', async () => {
    const sandbox = createMockSandbox();
    const skill = makeSkill({ tags: ['tf', 'aws'] });
    await injectSkills(sandbox as never, [skill]);

    // Find the sh call and decode the base64 content
    const shCall = sandbox.calls.find((c: ExecCall) => c.cmd === 'sh');
    const encoded = defined(shCall!.args[3], 'shCall.args[3]');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');

    expect(decoded).toContain('---');
    expect(decoded).toContain('name: "Terraform Test"');
    expect(decoded).toContain('description: "Write terraform tests"');
    expect(decoded).toContain('tags: tf, aws');
    expect(decoded).toContain('source: org');
    expect(decoded).toContain('# Terraform Test Skill');
  });

  it('escapes YAML special characters in name and description', async () => {
    const sandbox = createMockSandbox();
    const skill = makeSkill({
      name: 'Skill with "quotes" and \nnewlines',
      description: 'Has \\ backslashes',
    });
    await injectSkills(sandbox as never, [skill]);

    const shCall = sandbox.calls.find((c: ExecCall) => c.cmd === 'sh');
    const decoded = Buffer.from(defined(shCall!.args[3], 'shCall.args[3]'), 'base64').toString(
      'utf-8'
    );

    expect(decoded).toContain('name: "Skill with \\"quotes\\" and \\nnewlines"');
    expect(decoded).toContain('description: "Has \\\\ backslashes"');
  });
});

// ── injectAgents ──

describe('injectAgents', () => {
  it('returns zero counts for empty agents array', async () => {
    const sandbox = createMockSandbox();
    const result = await injectAgents(sandbox as never, []);
    expect(result.injected).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('injects a single agent successfully', async () => {
    const sandbox = createMockSandbox();
    const agent = makeAgent();
    const result = await injectAgents(sandbox as never, [agent]);

    expect(result.injected).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('skips agents that already exist on disk (strips .md extension)', async () => {
    const sandbox = createMockSandbox({ lsStdout: 'tf-module-developer.md\nother.md' });
    const agent = makeAgent({ name: 'tf-module-developer' });
    const result = await injectAgents(sandbox as never, [agent]);

    expect(result.injected).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('rejects unsafe agent names', async () => {
    const sandbox = createMockSandbox();
    const agent = makeAgent({ name: '../escape' });
    const result = await injectAgents(sandbox as never, [agent]);

    expect(result.injected).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(defined(result.errors[0], 'errors[0]').message).toContain('Unsafe agent name');
  });

  it('fails all agents when agents directory mkdir fails', async () => {
    const sandbox = createMockSandbox({ mkdirExitCode: 1 });
    const agents = [makeAgent({ name: 'agent-a' }), makeAgent({ name: 'agent-b' })];
    const result = await injectAgents(sandbox as never, agents);

    expect(result.injected).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(defined(result.errors[0], 'errors[0]').message).toContain('Failed to create directory');
  });

  it('handles write failure for individual agent', async () => {
    const sandbox = createMockSandbox({ writeExitCode: 1 });
    const agent = makeAgent();
    const result = await injectAgents(sandbox as never, [agent]);

    expect(result.injected).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(defined(result.errors[0], 'errors[0]').message).toContain('Failed to write');
  });

  it('handles unexpected exception during agent write', async () => {
    const sandbox = createMockSandbox({ writeThrows: new Error('disk full') });
    const agent = makeAgent();
    const result = await injectAgents(sandbox as never, [agent]);

    expect(result.errors).toHaveLength(1);
    expect(defined(result.errors[0], 'errors[0]').message).toContain('disk full');
  });

  it('continues after one agent fails', async () => {
    const sandbox = createMockSandbox();
    const agents = [makeAgent({ name: '.bad-name' }), makeAgent({ name: 'good-agent' })];
    const result = await injectAgents(sandbox as never, agents);

    expect(result.injected).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('treats ls exception as empty (all agents injected)', async () => {
    const sandbox = createMockSandbox({ lsThrows: true });
    const agent = makeAgent();
    const result = await injectAgents(sandbox as never, [agent]);

    expect(result.injected).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('builds agent markdown with frontmatter', async () => {
    const sandbox = createMockSandbox();
    const agent = makeAgent({ description: 'A "great" agent' });
    await injectAgents(sandbox as never, [agent]);

    const shCall = sandbox.calls.find((c: ExecCall) => c.cmd === 'sh');
    const decoded = Buffer.from(defined(shCall!.args[3], 'shCall.args[3]'), 'base64').toString(
      'utf-8'
    );

    expect(decoded).toContain('---');
    expect(decoded).toContain('name: "tf-module-developer"');
    expect(decoded).toContain('description: "A \\"great\\" agent"');
    expect(decoded).toContain('source: org');
    expect(decoded).toContain('# Module Developer');
  });

  it('uses custom workspacePath', async () => {
    const sandbox = createMockSandbox();
    const agent = makeAgent();
    await injectAgents(sandbox as never, [agent], '/my/workspace');

    const lsCall = sandbox.calls.find((c: ExecCall) => c.cmd === 'ls');
    expect(lsCall?.args[1]).toBe('/my/workspace/.claude/agents');
  });
});
