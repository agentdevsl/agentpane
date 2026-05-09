/**
 * Integration coverage for bootstrap/phases/agent-shutdown error paths.
 *
 * Targets the catch blocks in flushRunningAgents:
 * - synchronous throw inside the publish promise (Promise.allSettled wraps it)
 * - paused-update throw → log + continue
 * - sandbox provider list/getById/stop throw → log + continue
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../../src/db/schema';
import { flushRunningAgents } from '../../src/server/bootstrap/phases/agent-shutdown';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('bootstrap/phases/agent-shutdown error paths', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('survives a sandbox provider that throws on list()', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    await createTestAgent(codespace.id, { status: 'running' });

    const provider = {
      list: vi.fn().mockRejectedValue(new Error('docker daemon down')),
      getById: vi.fn(),
    } as never;

    const result = await flushRunningAgents({
      db,
      sessionService: { publish: vi.fn() } as never,
      getSandboxProvider: () => provider,
      budgetMs: 1000,
    });

    expect(result).toBe(1);
    expect((provider as unknown as { list: ReturnType<typeof vi.fn> }).list).toHaveBeenCalled();
  });

  it('survives a publish that throws synchronously (caught by try/catch)', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);
    const agent = await createTestAgent(codespace.id, { status: 'running' });

    // Link agent → session via direct update (factory does not expose this seam)
    await db.update(agents).set({ currentSessionId: session.id }).where(eq(agents.id, agent.id));

    const publish = vi.fn().mockImplementation(() => {
      throw new Error('publish sync throw');
    });

    const result = await flushRunningAgents({
      db,
      sessionService: { publish } as never,
      getSandboxProvider: () => null,
      budgetMs: 1000,
    });
    expect(result).toBe(1);
    expect(publish).toHaveBeenCalled();
  });

  it('continues when a single sandbox.stop throws (Promise.allSettled per-sandbox)', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    await createTestAgent(codespace.id, { status: 'running' });

    const stopGood = vi.fn().mockResolvedValue(undefined);
    const stopBad = vi.fn().mockRejectedValue(new Error('stop failed'));

    const provider = {
      list: vi.fn().mockResolvedValue([
        { id: 'sb-good', codespaceId: codespace.id, status: 'running' },
        { id: 'sb-bad', codespaceId: codespace.id, status: 'running' },
      ]),
      getById: vi
        .fn()
        .mockImplementation((id: string) =>
          id === 'sb-good' ? { id, stop: stopGood } : { id, stop: stopBad }
        ),
    } as never;

    const result = await flushRunningAgents({
      db,
      sessionService: { publish: vi.fn() } as never,
      getSandboxProvider: () => provider,
      budgetMs: 5000,
    });

    expect(result).toBe(1);
    expect(stopGood).toHaveBeenCalled();
    expect(stopBad).toHaveBeenCalled();
  });

  it('returns 0 and logs when the initial agent snapshot fails', async () => {
    // Use an empty stub db that throws on select() to hit the snapshot catch
    const db = {
      select: vi.fn(() => {
        throw new Error('select crashed');
      }),
    } as never;

    const result = await flushRunningAgents({
      db,
      sessionService: { publish: vi.fn() } as never,
      getSandboxProvider: () => null,
      budgetMs: 1000,
    });

    expect(result).toBe(0);
  });

  it('skips publish when agent.currentSessionId is null', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    await createTestAgent(codespace.id, { status: 'running' }); // no currentSessionId

    const publish = vi.fn();
    const result = await flushRunningAgents({
      db,
      sessionService: { publish } as never,
      getSandboxProvider: () => null,
      budgetMs: 1000,
    });

    expect(result).toBe(1);
    expect(publish).not.toHaveBeenCalled();
  });
});
