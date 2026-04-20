/**
 * F11-03 — Graceful agent shutdown contract.
 *
 * `flushRunningAgents` must:
 *   1. Snapshot agents whose status is running/planning/starting.
 *   2. Emit one `agent:interrupted` event per agent that has a session.
 *   3. Mark every snapshotted agent as 'paused' in the DB.
 *   4. Best-effort stop any running sandboxes (failures are swallowed).
 *   5. Never exceed its budget — a stuck provider must not block the suite.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Sandbox, SandboxProvider } from '../../../lib/sandbox/providers/sandbox-provider.js';
import type { SessionService } from '../../../services/session.service.js';
import { flushRunningAgents } from '../phases/agent-shutdown.js';

type RunningRow = { id: string; currentSessionId: string | null };

interface FakeDb {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  _updated: Array<{ ids: string[]; status: string }>;
}

function makeDb(rows: RunningRow[]): FakeDb {
  const state: FakeDb = {
    _updated: [],
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
    update: vi.fn(),
  };

  state.update.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(async () => {
        state._updated.push({
          ids: rows.map((r) => r.id),
          status: 'paused',
        });
      }),
    }),
  });

  return state;
}

function makeSessionService(): {
  svc: Pick<SessionService, 'publish'>;
  published: Array<{ sessionId: string; event: unknown }>;
} {
  const published: Array<{ sessionId: string; event: unknown }> = [];
  return {
    svc: {
      publish: vi.fn(async (sessionId: string, event: unknown) => {
        published.push({ sessionId, event });
      }) as unknown as SessionService['publish'],
    },
    published,
  };
}

function makeProvider(sandboxes: Array<{ id: string; status: Sandbox['status'] }>): {
  provider: SandboxProvider;
  stopped: string[];
} {
  const stopped: string[] = [];
  const provider = {
    name: 'fake',
    create: vi.fn(),
    get: vi.fn(),
    getById: vi.fn(async (id: string) => {
      if (!sandboxes.some((s) => s.id === id)) return null;
      return {
        stop: async () => {
          stopped.push(id);
        },
      } as unknown as Sandbox;
    }),
    list: vi.fn(async () => sandboxes),
    recover: vi.fn(),
    pullImage: vi.fn(),
    isImageAvailable: vi.fn(),
    healthCheck: vi.fn(),
    cleanup: vi.fn(),
  } as unknown as SandboxProvider;
  return { provider, stopped };
}

describe('F11-03: flushRunningAgents', () => {
  it('returns 0 and performs no writes when there are no running agents', async () => {
    const db = makeDb([]);
    const { svc } = makeSessionService();

    const count = await flushRunningAgents({
      db: db as never,
      sessionService: svc as SessionService,
      getSandboxProvider: () => null,
      budgetMs: 1_000,
    });

    expect(count).toBe(0);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('publishes agent:interrupted for each running agent with a session', async () => {
    const db = makeDb([
      { id: 'a1', currentSessionId: 's1' },
      { id: 'a2', currentSessionId: 's2' },
      { id: 'a3', currentSessionId: null }, // no session — skipped for publish
    ]);
    const { svc, published } = makeSessionService();

    const count = await flushRunningAgents({
      db: db as never,
      sessionService: svc as SessionService,
      getSandboxProvider: () => null,
      budgetMs: 1_000,
    });

    expect(count).toBe(3);
    expect(published).toHaveLength(2);
    expect(published.map((p) => p.sessionId).sort()).toEqual(['s1', 's2']);
    for (const p of published) {
      const event = p.event as { type: string; reason: string };
      expect(event.type).toBe('agent:interrupted');
      expect(event.reason).toBe('server_shutdown');
    }
  });

  it('marks all snapshotted agents as paused in the DB', async () => {
    const db = makeDb([
      { id: 'a1', currentSessionId: 's1' },
      { id: 'a2', currentSessionId: null },
    ]);
    const { svc } = makeSessionService();

    await flushRunningAgents({
      db: db as never,
      sessionService: svc as SessionService,
      getSandboxProvider: () => null,
      budgetMs: 1_000,
    });

    expect(db._updated).toEqual([{ ids: ['a1', 'a2'], status: 'paused' }]);
  });

  it('best-effort stops running sandboxes when a provider is available', async () => {
    const db = makeDb([{ id: 'a1', currentSessionId: 's1' }]);
    const { svc } = makeSessionService();
    const { provider, stopped } = makeProvider([
      { id: 'sb1', status: 'running' },
      { id: 'sb2', status: 'running' },
      { id: 'sb3', status: 'stopped' }, // skipped — already stopped
    ]);

    await flushRunningAgents({
      db: db as never,
      sessionService: svc as SessionService,
      getSandboxProvider: () => provider,
      budgetMs: 2_000,
    });

    expect(stopped.sort()).toEqual(['sb1', 'sb2']);
  });

  it('does not throw when the provider list() fails — shutdown continues', async () => {
    const db = makeDb([{ id: 'a1', currentSessionId: 's1' }]);
    const { svc } = makeSessionService();
    const badProvider = {
      name: 'broken',
      list: vi.fn().mockRejectedValue(new Error('provider offline')),
      create: vi.fn(),
      get: vi.fn(),
      getById: vi.fn(),
      recover: vi.fn(),
      pullImage: vi.fn(),
      isImageAvailable: vi.fn(),
      healthCheck: vi.fn(),
      cleanup: vi.fn(),
    } as unknown as SandboxProvider;

    const count = await flushRunningAgents({
      db: db as never,
      sessionService: svc as SessionService,
      getSandboxProvider: () => badProvider,
      budgetMs: 500,
    });

    // db update still happened — logging the sandbox failure must not block
    expect(count).toBe(1);
    expect(db._updated).toHaveLength(1);
  });

  it('respects the budget and exits even when publish hangs', async () => {
    const db = makeDb([{ id: 'a1', currentSessionId: 's1' }]);
    const svc = {
      publish: vi.fn(() => new Promise<void>(() => undefined)),
    } as unknown as SessionService;

    const start = Date.now();
    const count = await flushRunningAgents({
      db: db as never,
      sessionService: svc,
      getSandboxProvider: () => null,
      budgetMs: 300,
    });
    const elapsed = Date.now() - start;

    expect(count).toBe(1);
    expect(elapsed).toBeLessThan(2_000);
  });
});
