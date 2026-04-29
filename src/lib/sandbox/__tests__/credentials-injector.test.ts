/**
 * F06-NEW-02 (P0) / arch29-W1-E — Multi-tenant gate for credentials injection.
 *
 * Red→green regression tests for the multi-tenant gate enforced by
 * `CredentialsInjector.inject()`. Without the gate, shared sandbox mode
 * silently accepts the injection and writes a global Anthropic OAuth
 * credentials file at `~/.claude/.credentials.json` that every tenant
 * agent in the shared container could read.
 *
 * Test bar (per arch29 plan):
 *   - With `MULTI_TENANT=true` + `sandbox.mode='shared'` → inject() must
 *     return an `err()` Result with code
 *     `MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX` (PASS after fix).
 *   - With `MULTI_TENANT=true` + `sandbox.mode='per-project'` → inject()
 *     proceeds normally.
 *   - With `MULTI_TENANT` unset (default) → inject() proceeds normally
 *     regardless of sandbox.mode (no behaviour change for self-hosted).
 *   - When the `sandbox.mode` row is missing → defaults to 'shared' and
 *     the gate fires under MULTI_TENANT=true.
 */

import { describe, expect, it, vi } from 'vitest';
import type { OAuthCredentials } from '../types.js';

// Stub the host credentials reader so tests don't read the developer's
// real credentials file when `inject()` is called without explicit creds.
vi.mock('../../utils/resolve-anthropic-key.js', () => ({
  readCredentialsFile: vi.fn(async () => null),
}));

import { CredentialsInjector } from '../credentials-injector.js';

interface ExecCall {
  cmd: string;
  args: string[];
}

function createMockSandbox(overrides?: {
  mkdirExitCode?: number;
  writeExitCode?: number;
  testExitCode?: number;
  hasWriteFile?: boolean;
}) {
  const calls: ExecCall[] = [];
  const sandbox = {
    exec: vi.fn(async (cmd: string, args: string[] = []) => {
      calls.push({ cmd, args });
      if (cmd === 'mkdir') {
        return {
          exitCode: overrides?.mkdirExitCode ?? 0,
          stdout: '',
          stderr: '',
        };
      }
      if (cmd === 'sh' || cmd === 'chmod') {
        return {
          exitCode: overrides?.writeExitCode ?? 0,
          stdout: '',
          stderr: '',
        };
      }
      if (cmd === 'test') {
        return {
          exitCode: overrides?.testExitCode ?? 0,
          stdout: '',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    writeFile: overrides?.hasWriteFile
      ? vi.fn(async (_path: string, _content: string, _mode?: number) => {
          /* noop */
        })
      : undefined,
    calls,
  } as Record<string, unknown>;
  return sandbox;
}

/**
 * Build a minimal mock `Database` with a settings row. The test exercises
 * the multi-tenant gate's read of `sandbox.mode`, so we only need the
 * `query.settings.findFirst` shape.
 *
 * Returned as `any` because the real `Database` type is the dual-dialect
 * Drizzle union and constructing a fully-typed instance for tests is
 * not the point — the gate only uses `.query.settings.findFirst`.
 */
// biome-ignore lint/suspicious/noExplicitAny: minimal test mock
function makeMockDb(sandboxModeValue: string | null): any {
  const findFirst = vi.fn(async () => {
    if (sandboxModeValue === null) return null;
    return { key: 'sandbox.mode', value: sandboxModeValue };
  });
  return {
    query: {
      settings: { findFirst },
    },
    _findFirst: findFirst,
  };
}

const sampleCreds: OAuthCredentials = {
  accessToken: 'sk-ant-oat01-test-token',
  refreshToken: '',
  expiresAt: Date.now() + 60_000,
  scope: 'user:inference',
};

describe('F06-NEW-02 / arch29-W1-E — CredentialsInjector multi-tenant gate', () => {
  it('rejects when MULTI_TENANT=true and sandbox.mode is "shared"', async () => {
    const injector = new CredentialsInjector();
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(JSON.stringify('shared'));

    const result = await injector.inject(sandbox as never, sampleCreds, {
      db,
      codespaceId: 'codespace-123',
      env: { MULTI_TENANT: 'true' } as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX');
      expect(result.error.details).toMatchObject({ codespaceId: 'codespace-123' });
    }
    // Crucially: the credentials file was NEVER written.
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it('rejects when MULTI_TENANT=true and sandbox.mode row is missing (defaults to shared)', async () => {
    const injector = new CredentialsInjector();
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(null);

    const result = await injector.inject(sandbox as never, sampleCreds, {
      db,
      codespaceId: 'codespace-456',
      env: { MULTI_TENANT: 'true' } as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX');
    }
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it('allows injection when MULTI_TENANT=true and sandbox.mode is "per-project"', async () => {
    const injector = new CredentialsInjector();
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(JSON.stringify('per-project'));

    const result = await injector.inject(sandbox as never, sampleCreds, {
      db,
      codespaceId: 'codespace-789',
      env: { MULTI_TENANT: 'true' } as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(true);
    expect(sandbox.writeFile).toHaveBeenCalledTimes(1);
  });

  it('allows injection in shared mode when MULTI_TENANT is unset (default self-hosted)', async () => {
    const injector = new CredentialsInjector();
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(JSON.stringify('shared'));

    const result = await injector.inject(sandbox as never, sampleCreds, {
      db,
      codespaceId: 'codespace-self-hosted',
      // env has no MULTI_TENANT key.
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(true);
    expect(sandbox.writeFile).toHaveBeenCalledTimes(1);
  });

  it('allows injection in shared mode when MULTI_TENANT=false', async () => {
    const injector = new CredentialsInjector();
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(JSON.stringify('shared'));

    const result = await injector.inject(sandbox as never, sampleCreds, {
      db,
      codespaceId: 'codespace-explicit-false',
      env: { MULTI_TENANT: 'false' } as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(true);
    expect(sandbox.writeFile).toHaveBeenCalledTimes(1);
  });

  it('allows injection in shared mode when MULTI_TENANT is some other string (e.g. "1")', async () => {
    // Explicit "MULTI_TENANT=true" is the only opt-in value. Any other
    // truthy string falls back to the default (gate disabled).
    const injector = new CredentialsInjector();
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(JSON.stringify('shared'));

    const result = await injector.inject(sandbox as never, sampleCreds, {
      db,
      env: { MULTI_TENANT: '1' } as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(true);
  });

  it('skips the gate entirely when no context is provided (legacy callers / tests)', async () => {
    // Without a context the injector keeps its original behaviour, so
    // existing tests and any other call sites that don't yet pass `context`
    // continue to work. New call sites (sandbox.service.ts) opt in.
    const injector = new CredentialsInjector();
    const sandbox = createMockSandbox({ hasWriteFile: true });

    const result = await injector.inject(sandbox as never, sampleCreds);

    expect(result.ok).toBe(true);
    expect(sandbox.writeFile).toHaveBeenCalledTimes(1);
  });

  it('rejects on refresh() too when MULTI_TENANT=true and sandbox.mode is "shared"', async () => {
    const injector = new CredentialsInjector();
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(JSON.stringify('shared'));

    const result = await injector.refresh(sandbox as never, {
      db,
      codespaceId: 'refresh-test',
      env: { MULTI_TENANT: 'true' } as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX');
    }
  });

  it('returns 500 status code on the typed error', async () => {
    const injector = new CredentialsInjector();
    const sandbox = createMockSandbox({ hasWriteFile: true });
    const db = makeMockDb(JSON.stringify('shared'));

    const result = await injector.inject(sandbox as never, sampleCreds, {
      db,
      env: { MULTI_TENANT: 'true' } as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(500);
    }
  });
});
