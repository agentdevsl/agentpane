/**
 * Integration tests for src/server/bootstrap/sandbox/nomad-init.ts.
 *
 * Mocks createNomadSandboxProvider + ensureDefaultSandbox + decryptToken
 * + validateNomadAddress so the orchestrator's branches (no address,
 * SSRF rejection, healthy fast path, network-isolation re-throw,
 * fallbackToDocker, persistNomadLastError, settings parse failure,
 * recover failure tolerance) are exercised without a real Nomad cluster.
 *
 * IT-IDs: IT-2430 to IT-2459
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import type { SandboxState } from '../../src/server/bootstrap/types';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const nomadMocks = vi.hoisted(() => ({
  createNomadSandboxProvider: vi.fn(),
  ensureDefaultSandbox: vi.fn(),
  validateNomadAddress: vi.fn(async () => ({ valid: true as const })),
  decryptToken: vi.fn((s: string) => `decrypted:${s}`),
}));

vi.mock('../../src/lib/sandbox/providers/nomad-sandbox-provider.js', () => ({
  createNomadSandboxProvider: nomadMocks.createNomadSandboxProvider,
}));
vi.mock('../../src/server/bootstrap/sandbox/sandbox-helpers.js', () => ({
  ensureDefaultSandbox: nomadMocks.ensureDefaultSandbox,
}));
vi.mock('../../src/server/routes/sandbox-nomad.js', () => ({
  validateNomadAddress: nomadMocks.validateNomadAddress,
}));
vi.mock('../../src/lib/crypto/server-encryption.js', () => ({
  decryptToken: nomadMocks.decryptToken,
}));

vi.mock('@agentpane/nomad-sandbox-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentpane/nomad-sandbox-sdk')>();
  return actual;
});

import { initNomadProvider } from '../../src/server/bootstrap/sandbox/nomad-init';

function makeProviderStub(overrides: Record<string, unknown> = {}) {
  return {
    name: 'nomad-mock',
    healthCheck: vi.fn(async () => ({
      healthy: true,
      version: '1.7.0',
      leader: '10.0.0.1:4647',
      datacenter: 'dc1',
    })),
    assertNetworkIsolationSupport: vi.fn(async () => undefined),
    recover: vi.fn(async () => ({ recovered: 0, removed: 0 })),
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(async () => []),
    ...overrides,
  };
}

function makeSandboxState(): SandboxState {
  return {
    provider: null,
    containerAgentService: null,
    k8sProvider: null,
    nomadProvider: null,
    controller: null,
    k8sHealInterval: null,
    nomadHealInterval: null,
    retryTimer: null,
    retryCount: 0,
    initializing: false,
    reconciled: false,
    initAttempted: false,
  } as unknown as SandboxState;
}

async function persistSettings(value: Record<string, unknown>): Promise<void> {
  const db = getTestDb();
  await db
    .insert(settings)
    .values({ key: 'sandbox.nomad', value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value) } });
}

async function getLastError(): Promise<string | null> {
  const db = getTestDb();
  const row = await db.query.settings.findFirst({
    where: eq(settings.key, 'sandbox.nomad.lastError'),
  });
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as { error: string };
    return parsed.error;
  } catch {
    return row.value;
  }
}

describe('initNomadProvider', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    vi.clearAllMocks();
    nomadMocks.validateNomadAddress.mockResolvedValue({ valid: true as const });
    nomadMocks.decryptToken.mockImplementation((s: string) => `decrypted:${s}`);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── No-config / DB empty ───────────────────────────────────────────

  it('IT-2430: returns null when no sandbox.nomad setting exists', async () => {
    const result = await initNomadProvider(getTestDb() as never, makeSandboxState(), false);
    expect(result).toBeNull();
    expect(nomadMocks.createNomadSandboxProvider).not.toHaveBeenCalled();
  });

  it('IT-2431: returns null when settings have no address', async () => {
    await persistSettings({ namespace: 'default' });
    const result = await initNomadProvider(getTestDb() as never, makeSandboxState(), false);
    expect(result).toBeNull();
    expect(nomadMocks.createNomadSandboxProvider).not.toHaveBeenCalled();
  });

  it('IT-2432: tolerates malformed JSON in sandbox.nomad value (logs and returns null)', async () => {
    const db = getTestDb();
    await db.insert(settings).values({ key: 'sandbox.nomad', value: '{broken json' });
    const result = await initNomadProvider(db as never, makeSandboxState(), false);
    expect(result).toBeNull();
  });

  // ─── SSRF rejection ────────────────────────────────────────────────

  it('IT-2433: rejects stored address that fails SSRF validation', async () => {
    await persistSettings({ address: 'http://169.254.169.254/latest/meta-data' });
    nomadMocks.validateNomadAddress.mockResolvedValue({
      valid: false,
      error: 'cloud metadata blocked',
    });
    const result = await initNomadProvider(getTestDb() as never, makeSandboxState(), false);
    expect(result).toBeNull();
    expect(await getLastError()).toContain('cloud metadata blocked');
    expect(nomadMocks.createNomadSandboxProvider).not.toHaveBeenCalled();
  });

  // ─── Healthy fast path ─────────────────────────────────────────────

  it('IT-2434: returns provider when healthy + assigns to sandboxState + clears lastError', async () => {
    await persistSettings({ address: 'http://203.0.113.1:4646' });
    // Pre-seed a lastError so we can verify it's cleared.
    const db = getTestDb();
    await db
      .insert(settings)
      .values({ key: 'sandbox.nomad.lastError', value: JSON.stringify({ error: 'old' }) });
    const provider = makeProviderStub();
    nomadMocks.createNomadSandboxProvider.mockReturnValue(provider);

    const state = makeSandboxState();
    const result = await initNomadProvider(db as never, state, false);

    expect(result).toBe(provider);
    expect(state.nomadProvider).toBe(provider);
    expect(provider.assertNetworkIsolationSupport).toHaveBeenCalled();
    expect(provider.recover).toHaveBeenCalled();
    expect(nomadMocks.ensureDefaultSandbox).toHaveBeenCalledWith(
      provider,
      'Nomad',
      expect.anything()
    );
    expect(await getLastError()).toBeNull();
  });

  it('IT-2435: decrypts stored token and forwards to provider factory', async () => {
    await persistSettings({
      address: 'http://203.0.113.1:4646',
      token: 'encrypted-blob',
      namespace: 'production',
    });
    const provider = makeProviderStub();
    nomadMocks.createNomadSandboxProvider.mockReturnValue(provider);

    await initNomadProvider(getTestDb() as never, makeSandboxState(), false);
    expect(nomadMocks.decryptToken).toHaveBeenCalledWith('encrypted-blob');
    expect(nomadMocks.createNomadSandboxProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        address: 'http://203.0.113.1:4646',
        token: 'decrypted:encrypted-blob',
        namespace: 'production',
      })
    );
  });

  it('IT-2436: drops token but still inits provider when decryption fails', async () => {
    await persistSettings({ address: 'http://203.0.113.1:4646', token: 'corrupt' });
    nomadMocks.decryptToken.mockImplementation(() => {
      throw new Error('decrypt failed');
    });
    const provider = makeProviderStub();
    nomadMocks.createNomadSandboxProvider.mockReturnValue(provider);

    const result = await initNomadProvider(getTestDb() as never, makeSandboxState(), false);
    expect(result).toBe(provider);
    expect(nomadMocks.createNomadSandboxProvider).toHaveBeenCalledWith(
      expect.objectContaining({ token: undefined })
    );
  });

  it('IT-2437: tolerates recover() failure (continues init, logs)', async () => {
    await persistSettings({ address: 'http://203.0.113.1:4646' });
    const provider = makeProviderStub({
      recover: vi.fn(async () => {
        throw new Error('recover exploded');
      }),
    });
    nomadMocks.createNomadSandboxProvider.mockReturnValue(provider);
    const result = await initNomadProvider(getTestDb() as never, makeSandboxState(), false);
    expect(result).toBe(provider);
    expect(nomadMocks.ensureDefaultSandbox).toHaveBeenCalled();
  });

  // ─── Unhealthy paths ──────────────────────────────────────────────

  it('IT-2438: returns null when health check fails (no fallback)', async () => {
    await persistSettings({ address: 'http://203.0.113.1:4646' });
    const provider = makeProviderStub({
      healthCheck: vi.fn(async () => ({ healthy: false, message: 'cluster down' })),
    });
    nomadMocks.createNomadSandboxProvider.mockReturnValue(provider);

    const result = await initNomadProvider(getTestDb() as never, makeSandboxState(), false);
    expect(result).toBeNull();
    expect(await getLastError()).toBe('cluster down');
  });

  it('IT-2439: returns null when health check fails (fallback enabled — only differs in log level)', async () => {
    await persistSettings({ address: 'http://203.0.113.1:4646' });
    const provider = makeProviderStub({
      healthCheck: vi.fn(async () => ({ healthy: false, message: 'unhealthy' })),
    });
    nomadMocks.createNomadSandboxProvider.mockReturnValue(provider);

    const result = await initNomadProvider(getTestDb() as never, makeSandboxState(), true);
    expect(result).toBeNull();
    expect(await getLastError()).toBe('unhealthy');
  });

  it('IT-2440: returns null when healthCheck has no message (uses default diagnosis)', async () => {
    await persistSettings({ address: 'http://203.0.113.1:4646' });
    const provider = makeProviderStub({
      healthCheck: vi.fn(async () => ({ healthy: false })),
    });
    nomadMocks.createNomadSandboxProvider.mockReturnValue(provider);
    const result = await initNomadProvider(getTestDb() as never, makeSandboxState(), false);
    expect(result).toBeNull();
    expect(await getLastError()).toContain('health check failed');
  });

  // ─── Init / SDK error paths ───────────────────────────────────────

  it('IT-2441: returns null when createNomadSandboxProvider throws (generic error)', async () => {
    await persistSettings({ address: 'http://203.0.113.1:4646' });
    nomadMocks.createNomadSandboxProvider.mockImplementation(() => {
      throw new Error('factory boom');
    });

    const result = await initNomadProvider(getTestDb() as never, makeSandboxState(), false);
    expect(result).toBeNull();
    expect(await getLastError()).toBe('factory boom');
  });

  it('IT-2442: returns null when healthCheck throws ConnectionError (treated as infra)', async () => {
    await persistSettings({ address: 'http://203.0.113.1:4646' });
    const { ConnectionError } = await import('@agentpane/nomad-sandbox-sdk');
    const provider = makeProviderStub({
      healthCheck: vi.fn(async () => {
        throw new ConnectionError('http://203.0.113.1:4646', new Error('refused'));
      }),
    });
    nomadMocks.createNomadSandboxProvider.mockReturnValue(provider);

    const result = await initNomadProvider(getTestDb() as never, makeSandboxState(), true);
    expect(result).toBeNull();
    const last = await getLastError();
    expect(last).toContain('203.0.113.1');
  });

  it('IT-2443: re-throws when network isolation is unsupported (NOMAD-800) — fail-closed', async () => {
    await persistSettings({ address: 'http://203.0.113.1:4646' });
    const provider = makeProviderStub({
      assertNetworkIsolationSupport: vi.fn(async () => {
        const err = new Error('network mode none unsupported');
        (err as { code?: string }).code = 'NOMAD-800';
        throw err;
      }),
    });
    nomadMocks.createNomadSandboxProvider.mockReturnValue(provider);

    await expect(
      initNomadProvider(getTestDb() as never, makeSandboxState(), false)
    ).rejects.toMatchObject({ code: 'NOMAD-800' });
  });
});
