/**
 * Integration tests for `credentials-injector.ts`.
 *
 * Exercises the full inject/remove/exists/refresh surface using a Sandbox
 * mock, plus the multi-tenant gate (F06-NEW-02 / arch29-W1-E). The DB shape
 * is mocked at the duck-type level — only `query.settings.findFirst` and
 * the tenant-boundary readers are touched.
 *
 * IT-IDs: IT-1770 to IT-1799
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CredentialsInjector,
  createCredentialsInjector,
  loadHostCredentials,
} from '../../src/lib/sandbox/credentials-injector';
import type { OAuthCredentials } from '../../src/lib/sandbox/types';

// Stub the host credentials reader so tests don't read the developer's
// real credentials file when `inject()` is called without explicit creds.
vi.mock('../../src/lib/utils/resolve-anthropic-key', () => ({
  readCredentialsFile: vi.fn(async () => null),
}));

interface ExecCall {
  cmd: string;
  args: string[];
}

function createMockSandbox(overrides?: {
  mkdirExitCode?: number;
  writeExitCode?: number;
  testExitCode?: number;
  hasWriteFile?: boolean;
  writeFileThrows?: Error;
  removeThrows?: Error;
  testThrows?: Error;
}) {
  const calls: ExecCall[] = [];
  const sandbox = {
    exec: vi.fn(async (cmd: string, args: string[] = []) => {
      calls.push({ cmd, args });
      if (cmd === 'rm' && overrides?.removeThrows) throw overrides.removeThrows;
      if (cmd === 'test') {
        if (overrides?.testThrows) throw overrides.testThrows;
        return { exitCode: overrides?.testExitCode ?? 0, stdout: '', stderr: '' };
      }
      if (cmd === 'mkdir') {
        return {
          exitCode: overrides?.mkdirExitCode ?? 0,
          stdout: '',
          stderr: overrides?.mkdirExitCode !== 0 ? 'permission denied' : '',
        };
      }
      if (cmd === 'sh' || cmd === 'chmod') {
        return {
          exitCode: overrides?.writeExitCode ?? 0,
          stdout: '',
          stderr: overrides?.writeExitCode !== 0 ? 'write failed' : '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    writeFile: overrides?.hasWriteFile
      ? vi.fn(async (_path: string, _content: string, _mode?: number) => {
          if (overrides?.writeFileThrows) throw overrides.writeFileThrows;
        })
      : undefined,
    calls,
  } as Record<string, unknown>;
  return sandbox;
}

function makeMockDb(
  sandboxModeValue: string | null,
  options: { teamCount?: number; userCount?: number } = {}
): unknown {
  return {
    query: {
      settings: {
        findFirst: vi.fn(async () =>
          sandboxModeValue === null ? null : { key: 'sandbox.mode', value: sandboxModeValue }
        ),
      },
      teams: {
        findMany: vi.fn(async () =>
          Array.from({ length: options.teamCount ?? 1 }, (_, i) => ({ id: `team-${i}` }))
        ),
      },
      users: {
        findMany: vi.fn(async () =>
          Array.from({ length: options.userCount ?? 1 }, (_, i) => ({ id: `user-${i}` }))
        ),
      },
    },
  };
}

const sampleCreds: OAuthCredentials = {
  accessToken: 'sk-ant-oat01-test-token',
  refreshToken: '',
  expiresAt: Date.now() + 60_000,
  scope: 'user:inference',
};

// ─── inject() happy paths ──────────────────────────────────────────────

describe('CredentialsInjector.inject (integration)', () => {
  it('IT-1770: writes credentials via writeFile when supported', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds);
    expect(result.ok).toBe(true);
    expect(sandbox.writeFile).toHaveBeenCalledTimes(1);
    // mkdir + verify test should be the only exec calls
    const execCalls = sandbox.calls as ExecCall[];
    expect(execCalls.find((c) => c.cmd === 'mkdir')).toBeDefined();
    expect(execCalls.find((c) => c.cmd === 'test')).toBeDefined();
  });

  it('IT-1771: falls back to base64+chmod path when writeFile unsupported', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: false });
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds);
    expect(result.ok).toBe(true);
    const execCalls = sandbox.calls as ExecCall[];
    expect(execCalls.find((c) => c.cmd === 'sh')).toBeDefined();
    expect(execCalls.find((c) => c.cmd === 'chmod')).toBeDefined();
  });

  it('IT-1772: returns CREDENTIALS_NOT_FOUND when no creds and host file empty', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const result = await new CredentialsInjector().inject(sandbox as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_CREDENTIALS_NOT_FOUND');
  });

  it('IT-1773: returns CREDENTIALS_INJECTION_FAILED when mkdir fails', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: true, mkdirExitCode: 2 });
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_CREDENTIALS_INJECTION_FAILED');
      expect(result.error.message).toContain('Failed to create .claude directory');
    }
  });

  it('IT-1774: returns CREDENTIALS_INJECTION_FAILED when writeFile throws', async () => {
    const sandbox = createMockSandbox({
      hasWriteFile: true,
      writeFileThrows: new Error('connection refused'),
    });
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_CREDENTIALS_INJECTION_FAILED');
      expect(result.error.message).toContain('connection refused');
    }
  });

  it('IT-1775: returns CREDENTIALS_INJECTION_FAILED when fallback sh write fails', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: false, writeExitCode: 1 });
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Failed to write credentials');
  });

  it('IT-1776: returns CREDENTIALS_INJECTION_FAILED when verify test fails', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: true, testExitCode: 1 });
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Credentials file was not created');
  });

  it('IT-1777: returns CREDENTIALS_INJECTION_FAILED when an unexpected error throws', async () => {
    const sandbox = {
      exec: vi.fn().mockRejectedValue(new Error('catastrophic failure')),
      writeFile: vi.fn(),
    };
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('catastrophic failure');
  });
});

// ─── remove() ──────────────────────────────────────────────────────────

describe('CredentialsInjector.remove (integration)', () => {
  it('IT-1780: removes the credentials file', async () => {
    const sandbox = createMockSandbox();
    const result = await new CredentialsInjector().remove(sandbox as never);
    expect(result.ok).toBe(true);
    const execCalls = sandbox.calls as ExecCall[];
    const rmCall = execCalls.find((c) => c.cmd === 'rm');
    expect(rmCall).toBeDefined();
    expect(rmCall!.args).toContain('-f');
  });

  it('IT-1781: returns CREDENTIALS_INJECTION_FAILED when remove throws', async () => {
    const sandbox = createMockSandbox({ removeThrows: new Error('no such container') });
    const result = await new CredentialsInjector().remove(sandbox as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('no such container');
  });
});

// ─── exists() ──────────────────────────────────────────────────────────

describe('CredentialsInjector.exists (integration)', () => {
  it('IT-1785: returns true when test exit code is 0', async () => {
    const sandbox = createMockSandbox({ testExitCode: 0 });
    expect(await new CredentialsInjector().exists(sandbox as never)).toBe(true);
  });

  it('IT-1786: returns false when test exit code is non-zero', async () => {
    const sandbox = createMockSandbox({ testExitCode: 1 });
    expect(await new CredentialsInjector().exists(sandbox as never)).toBe(false);
  });

  it('IT-1787: returns false when exec throws', async () => {
    const sandbox = createMockSandbox({ testThrows: new Error('container gone') });
    expect(await new CredentialsInjector().exists(sandbox as never)).toBe(false);
  });
});

// ─── refresh() ────────────────────────────────────────────────────────

describe('CredentialsInjector.refresh (integration)', () => {
  it('IT-1788: re-injects from host (returns CREDENTIALS_NOT_FOUND when host empty)', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const result = await new CredentialsInjector().refresh(sandbox as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_CREDENTIALS_NOT_FOUND');
  });
});

// ─── factory ──────────────────────────────────────────────────────────

describe('createCredentialsInjector (integration)', () => {
  it('IT-1789: returns a fresh CredentialsInjector instance', () => {
    const inj = createCredentialsInjector();
    expect(inj).toBeInstanceOf(CredentialsInjector);
  });
});

// ─── loadHostCredentials helper ──────────────────────────────────────

describe('loadHostCredentials (integration)', () => {
  it('IT-1790: returns CREDENTIALS_NOT_FOUND when host file is empty', async () => {
    const result = await loadHostCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_CREDENTIALS_NOT_FOUND');
  });
});

// ─── multi-tenant gate (F06-NEW-02) ──────────────────────────────────

describe('CredentialsInjector multi-tenant gate (integration)', () => {
  it('IT-1795: rejects MULTI_TENANT=true + shared mode', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(JSON.stringify('shared'));
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds, {
      db: db as never,
      codespaceId: 'cs-1',
      env: { MULTI_TENANT: 'true' } as NodeJS.ProcessEnv,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX');
    }
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it('IT-1796: allows MULTI_TENANT=true + per-project mode', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(JSON.stringify('per-project'));
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds, {
      db: db as never,
      env: { MULTI_TENANT: 'true' } as NodeJS.ProcessEnv,
    });
    expect(result.ok).toBe(true);
  });

  it('IT-1797: allows shared mode for self-hosted single-team install', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(JSON.stringify('shared'));
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds, {
      db: db as never,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.ok).toBe(true);
  });

  it('IT-1798: rejects shared mode when multiple teams exist (boundary inference)', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(JSON.stringify('shared'), { teamCount: 2 });
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds, {
      db: db as never,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX');
    }
  });

  it('IT-1799: skips gate entirely when no context provided (legacy callers)', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const result = await new CredentialsInjector().inject(sandbox as never, sampleCreds);
    expect(result.ok).toBe(true);
  });
});
