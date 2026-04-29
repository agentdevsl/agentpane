/**
 * F06-NEW-02 (P0) / arch29-W1-E — Multi-tenant gate for container-exec startAgent.
 *
 * Red→green regression tests for the multi-tenant gate enforced by the
 * `assertSharedSandboxAllowed` helper that runs before every agent start.
 * Without the gate, shared sandbox mode silently lets every tenant agent
 * share the same `/workspace` bind mount and the same Anthropic OAuth
 * credentials file at `~/.claude/.credentials.json`.
 *
 * Test bar (per arch29 plan):
 *   - With `MULTI_TENANT=true` + `sandbox.mode='shared'` →
 *     `assertSharedSandboxAllowed()` throws an `AppError` with code
 *     `MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX`.
 *   - With `MULTI_TENANT=true` + `sandbox.mode='per-project'` → no throw.
 *   - With `MULTI_TENANT` unset (default) → no throw regardless of mode.
 *   - The helper falls back to 'shared' when the setting row is missing
 *     or malformed (safer default — gate fires).
 *
 * The gate is exercised end-to-end at the `ContainerExecService.startAgent`
 * boundary in `tests/integration/container-exec-service.test.ts`; the
 * tests below isolate the helper itself so the regression cannot be
 * masked by mock plumbing in the integration suite.
 */

import { describe, expect, it, vi } from 'vitest';
import { assertSharedSandboxAllowed, resolveSandboxMode } from '../shared-helpers.js';

/**
 * Build a minimal mock `Database` with a `query.settings.findFirst` shape.
 * The helper only reads `sandbox.mode` so we can keep the mock tiny.
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

describe('F06-NEW-02 / arch29-W1-E — assertSharedSandboxAllowed', () => {
  describe('rejects shared sandbox mode under MULTI_TENANT=true', () => {
    it('throws with code MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX when sandbox.mode is "shared"', async () => {
      const db = makeMockDb(JSON.stringify('shared'));
      await expect(
        assertSharedSandboxAllowed(db, 'codespace-1', {
          MULTI_TENANT: 'true',
        } as NodeJS.ProcessEnv)
      ).rejects.toThrow(/MULTI_TENANT=true is set but sandbox mode is "shared"/);
    });

    it('attaches the codespaceId to the error details', async () => {
      const db = makeMockDb(JSON.stringify('shared'));
      try {
        await assertSharedSandboxAllowed(db, 'codespace-with-details', {
          MULTI_TENANT: 'true',
        } as NodeJS.ProcessEnv);
        throw new Error('expected gate to throw');
      } catch (caught) {
        const errorObj = caught as {
          code?: string;
          details?: Record<string, unknown>;
        };
        expect(errorObj.code).toBe('MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX');
        expect(errorObj.details).toMatchObject({ codespaceId: 'codespace-with-details' });
      }
    });

    it('throws when sandbox.mode row is missing (safer default of "shared")', async () => {
      const db = makeMockDb(null);
      await expect(
        assertSharedSandboxAllowed(db, undefined, {
          MULTI_TENANT: 'true',
        } as NodeJS.ProcessEnv)
      ).rejects.toThrow(/sandbox mode is "shared"/);
    });

    it('throws when sandbox.mode value is malformed JSON (safer default of "shared")', async () => {
      const db = makeMockDb('not-valid-json{');
      await expect(
        assertSharedSandboxAllowed(db, undefined, {
          MULTI_TENANT: 'true',
        } as NodeJS.ProcessEnv)
      ).rejects.toThrow(/sandbox mode is "shared"/);
    });

    it('throws when sandbox.mode is some unexpected enum value (safer default of "shared")', async () => {
      const db = makeMockDb(JSON.stringify('unrecognised-mode'));
      await expect(
        assertSharedSandboxAllowed(db, undefined, {
          MULTI_TENANT: 'true',
        } as NodeJS.ProcessEnv)
      ).rejects.toThrow(/sandbox mode is "shared"/);
    });
  });

  describe('does NOT reject when MULTI_TENANT=true but sandbox.mode is "per-project"', () => {
    it('returns without throwing', async () => {
      const db = makeMockDb(JSON.stringify('per-project'));
      await expect(
        assertSharedSandboxAllowed(db, 'codespace-isolated', {
          MULTI_TENANT: 'true',
        } as NodeJS.ProcessEnv)
      ).resolves.toBeUndefined();
    });
  });

  describe('skips the gate when MULTI_TENANT is unset/false (default self-hosted)', () => {
    it('returns without throwing when env has no MULTI_TENANT key', async () => {
      const db = makeMockDb(JSON.stringify('shared'));
      await expect(
        assertSharedSandboxAllowed(db, 'self-hosted', {} as NodeJS.ProcessEnv)
      ).resolves.toBeUndefined();
    });

    it('returns without throwing when MULTI_TENANT=false', async () => {
      const db = makeMockDb(JSON.stringify('shared'));
      await expect(
        assertSharedSandboxAllowed(db, 'self-hosted', {
          MULTI_TENANT: 'false',
        } as NodeJS.ProcessEnv)
      ).resolves.toBeUndefined();
    });

    it('returns without throwing when MULTI_TENANT is "1" (only "true" opts in)', async () => {
      // Explicit "MULTI_TENANT=true" is the only opt-in value. Any other
      // truthy string keeps the gate disabled.
      const db = makeMockDb(JSON.stringify('shared'));
      await expect(
        assertSharedSandboxAllowed(db, 'self-hosted', {
          MULTI_TENANT: '1',
        } as NodeJS.ProcessEnv)
      ).resolves.toBeUndefined();
    });

    it('does not query the database when MULTI_TENANT is not "true"', async () => {
      // Performance: the gate must short-circuit so self-hosted installs
      // don't pay an extra DB read on every agent start.
      const db = makeMockDb(JSON.stringify('shared'));
      const dbAny = db as unknown as { _findFirst: ReturnType<typeof vi.fn> };
      await assertSharedSandboxAllowed(db, undefined, {} as NodeJS.ProcessEnv);
      expect(dbAny._findFirst).not.toHaveBeenCalled();
    });
  });
});

describe('F06-NEW-02 / arch29-W1-E — resolveSandboxMode', () => {
  it('returns "shared" when the setting row is missing', async () => {
    const db = makeMockDb(null);
    const mode = await resolveSandboxMode(db);
    expect(mode).toBe('shared');
  });

  it('returns "shared" when the value is malformed JSON', async () => {
    const db = makeMockDb('not-json{');
    const mode = await resolveSandboxMode(db);
    expect(mode).toBe('shared');
  });

  it('returns "shared" when the value is an unrecognised enum', async () => {
    const db = makeMockDb(JSON.stringify('something-else'));
    const mode = await resolveSandboxMode(db);
    expect(mode).toBe('shared');
  });

  it('returns "shared" when explicitly set to "shared"', async () => {
    const db = makeMockDb(JSON.stringify('shared'));
    const mode = await resolveSandboxMode(db);
    expect(mode).toBe('shared');
  });

  it('returns "per-project" when explicitly set to "per-project"', async () => {
    const db = makeMockDb(JSON.stringify('per-project'));
    const mode = await resolveSandboxMode(db);
    expect(mode).toBe('per-project');
  });
});
