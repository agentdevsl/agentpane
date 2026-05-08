/**
 * Integration tests for `tmux-manager.ts`.
 *
 * Manages tmux sessions inside sandboxes. Mocks the SandboxProvider/Sandbox
 * interfaces to verify session create/get/list/send/capture/kill/killAll.
 *
 * IT-IDs: IT-1800 to IT-1839
 */
import { describe, expect, it, vi } from 'vitest';
import { createTmuxManager, TmuxManager } from '../../src/lib/sandbox/tmux-manager';
import type { TmuxSession } from '../../src/lib/sandbox/types';

function makeSession(name: string): TmuxSession {
  return { name, taskId: undefined, createdAt: new Date(), windows: 1 } as unknown as TmuxSession;
}

function createMockSandbox(overrides?: {
  createThrows?: Error;
  listThrows?: Error;
  killThrows?: Error;
  sendThrows?: Error;
  captureThrows?: Error;
  sessions?: TmuxSession[];
  pane?: string;
}) {
  return {
    id: 'sandbox-1',
    createTmuxSession: vi.fn(async (name: string, taskId?: string) => {
      if (overrides?.createThrows) throw overrides.createThrows;
      return { name, taskId, createdAt: new Date(), windows: 1 } as unknown as TmuxSession;
    }),
    listTmuxSessions: vi.fn(async () => {
      if (overrides?.listThrows) throw overrides.listThrows;
      return overrides?.sessions ?? [];
    }),
    killTmuxSession: vi.fn(async () => {
      if (overrides?.killThrows) throw overrides.killThrows;
    }),
    sendKeysToTmux: vi.fn(async () => {
      if (overrides?.sendThrows) throw overrides.sendThrows;
    }),
    captureTmuxPane: vi.fn(async () => {
      if (overrides?.captureThrows) throw overrides.captureThrows;
      return overrides?.pane ?? 'pane output';
    }),
  };
}

function createMockProvider(getById: ReturnType<typeof vi.fn>, get?: ReturnType<typeof vi.fn>) {
  return {
    name: 'mock',
    getById,
    get: get ?? vi.fn().mockResolvedValue(null),
  } as never;
}

describe('TmuxManager.createSession', () => {
  it('IT-1800: creates session by sandboxId', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    const result = await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    expect(result.ok).toBe(true);
    expect(sandbox.createTmuxSession).toHaveBeenCalledWith('agent-1', undefined);
  });

  it('IT-1801: creates session by codespaceId when sandboxId not given', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn(), vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    const result = await manager.createSession({ codespaceId: 'cs-1', sessionName: 'agent-2' });
    expect(result.ok).toBe(true);
    expect(provider.get).toHaveBeenCalledWith('cs-1');
  });

  it('IT-1802: returns CONTAINER_NOT_FOUND when sandbox missing', async () => {
    const provider = createMockProvider(vi.fn().mockResolvedValue(null));
    const manager = new TmuxManager(provider);

    const result = await manager.createSession({ sandboxId: 'missing', sessionName: 'agent-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
  });

  it('IT-1803: derives session name from taskId when sessionName missing', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    const result = await manager.createSession({ sandboxId: 'sandbox-1', taskId: 'task-xyz' });
    expect(result.ok).toBe(true);
    expect(sandbox.createTmuxSession).toHaveBeenCalledWith('agent-task-xyz', 'task-xyz');
  });

  it('IT-1804: derives a session name from random id when no taskId/sessionName', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    const result = await manager.createSession({ sandboxId: 'sandbox-1' });
    expect(result.ok).toBe(true);
    const name = sandbox.createTmuxSession.mock.calls[0]?.[0];
    expect(name).toMatch(/^agent-/);
  });

  it('IT-1805: sends cd command when workingDirectory provided', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({
      sandboxId: 'sandbox-1',
      sessionName: 'agent-1',
      workingDirectory: '/workspace',
    });
    expect(sandbox.sendKeysToTmux).toHaveBeenCalledWith('agent-1', 'cd /workspace');
  });

  it('IT-1806: runs initialCommand when provided', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({
      sandboxId: 'sandbox-1',
      sessionName: 'agent-1',
      initialCommand: 'npm test',
    });
    expect(sandbox.sendKeysToTmux).toHaveBeenCalledWith('agent-1', 'npm test');
  });

  it('IT-1807: returns TMUX_CREATION_FAILED on createTmuxSession throw', async () => {
    const sandbox = createMockSandbox({ createThrows: new Error('tmux not installed') });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    const result = await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_TMUX_CREATION_FAILED');
      expect(result.error.message).toContain('tmux not installed');
    }
  });

  it('IT-1808: passes through SandboxError thrown from sandbox.createTmuxSession', async () => {
    const customErr = { code: 'SANDBOX_X', message: 'custom', status: 500 } as never;
    const sandbox = createMockSandbox({ createThrows: customErr });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    const result = await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_X');
  });
});

describe('TmuxManager.getSession', () => {
  it('IT-1810: returns null when session not tracked', async () => {
    const provider = createMockProvider(vi.fn());
    const manager = new TmuxManager(provider);

    const result = await manager.getSession('untracked');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('IT-1811: returns null and cleans up tracking when sandbox no longer exists', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn());
    (provider.getById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(sandbox)
      .mockResolvedValueOnce(null);
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });

    const result = await manager.getSession('agent-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('IT-1812: returns the session when found in sandbox listing', async () => {
    const target = makeSession('agent-1');
    const sandbox = createMockSandbox({ sessions: [target, makeSession('other')] });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.getSession('agent-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.name).toBe('agent-1');
  });

  it('IT-1813: returns null when session not in current sandbox listing', async () => {
    const sandbox = createMockSandbox({ sessions: [] });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.getSession('agent-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('IT-1814: returns EXEC_FAILED error when listTmuxSessions throws', async () => {
    const sandbox = createMockSandbox({ listThrows: new Error('socket closed') });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.getSession('agent-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
  });
});

describe('TmuxManager.listSessions', () => {
  it('IT-1820: returns sessions when sandbox found', async () => {
    const sessions = [makeSession('a'), makeSession('b')];
    const sandbox = createMockSandbox({ sessions });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    const result = await manager.listSessions('sandbox-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });

  it('IT-1821: returns CONTAINER_NOT_FOUND when sandbox missing', async () => {
    const provider = createMockProvider(vi.fn().mockResolvedValue(null));
    const manager = new TmuxManager(provider);

    const result = await manager.listSessions('missing');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
  });

  it('IT-1822: returns EXEC_FAILED when listTmuxSessions throws', async () => {
    const sandbox = createMockSandbox({ listThrows: new Error('boom') });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    const result = await manager.listSessions('sandbox-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
  });
});

describe('TmuxManager.sendCommand', () => {
  it('IT-1825: returns TMUX_SESSION_NOT_FOUND for unknown session', async () => {
    const provider = createMockProvider(vi.fn());
    const manager = new TmuxManager(provider);
    const result = await manager.sendCommand('unknown', 'ls');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_TMUX_SESSION_NOT_FOUND');
  });

  it('IT-1826: returns CONTAINER_NOT_FOUND when sandbox lookup returns null', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn());
    (provider.getById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(sandbox)
      .mockResolvedValueOnce(null);
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.sendCommand('agent-1', 'ls');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
  });

  it('IT-1827: sends keys when session and sandbox are present', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.sendCommand('agent-1', 'ls -la');
    expect(result.ok).toBe(true);
    expect(sandbox.sendKeysToTmux).toHaveBeenLastCalledWith('agent-1', 'ls -la');
  });

  it('IT-1828: returns EXEC_FAILED when sendKeysToTmux throws plain Error', async () => {
    const sandbox = createMockSandbox({ sendThrows: new Error('pipe broken') });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.sendCommand('agent-1', 'ls');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
  });

  it('IT-1829: passes through SandboxError thrown from sendKeysToTmux', async () => {
    const customErr = { code: 'SANDBOX_X', message: 'custom', status: 500 } as never;
    const sandbox = createMockSandbox({ sendThrows: customErr });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.sendCommand('agent-1', 'ls');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_X');
  });
});

describe('TmuxManager.captureOutput', () => {
  it('IT-1830: returns the captured pane', async () => {
    const sandbox = createMockSandbox({ pane: 'hello world' });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.captureOutput('agent-1', 50);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('hello world');
    expect(sandbox.captureTmuxPane).toHaveBeenLastCalledWith('agent-1', 50);
  });

  it('IT-1831: returns TMUX_SESSION_NOT_FOUND for unknown session', async () => {
    const provider = createMockProvider(vi.fn());
    const manager = new TmuxManager(provider);
    const result = await manager.captureOutput('unknown');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_TMUX_SESSION_NOT_FOUND');
  });

  it('IT-1832: returns CONTAINER_NOT_FOUND when sandbox missing on capture', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn());
    (provider.getById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(sandbox)
      .mockResolvedValueOnce(null);
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.captureOutput('agent-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
  });

  it('IT-1833: returns EXEC_FAILED when captureTmuxPane throws', async () => {
    const sandbox = createMockSandbox({ captureThrows: new Error('boom') });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.captureOutput('agent-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
  });
});

describe('TmuxManager.killSession', () => {
  it('IT-1834: returns ok when session not tracked (best-effort)', async () => {
    const provider = createMockProvider(vi.fn());
    const manager = new TmuxManager(provider);
    const result = await manager.killSession('unknown');
    expect(result.ok).toBe(true);
  });

  it('IT-1835: returns ok and cleans up tracking when sandbox missing', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn());
    (provider.getById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(sandbox)
      .mockResolvedValueOnce(null);
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.killSession('agent-1');
    expect(result.ok).toBe(true);
  });

  it('IT-1836: kills session and removes tracking on success', async () => {
    const sandbox = createMockSandbox();
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.killSession('agent-1');
    expect(result.ok).toBe(true);
    expect(sandbox.killTmuxSession).toHaveBeenCalledWith('agent-1');
    // After kill, the session should be untracked (subsequent send should fail)
    const followUp = await manager.sendCommand('agent-1', 'x');
    expect(followUp.ok).toBe(false);
  });

  it('IT-1837: silently swallows "session not found" errors', async () => {
    const sandbox = createMockSandbox({
      killThrows: new Error("can't find session: agent-1"),
    });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.killSession('agent-1');
    expect(result.ok).toBe(true);
  });

  it('IT-1838: surfaces other errors as EXEC_FAILED', async () => {
    const sandbox = createMockSandbox({ killThrows: new Error('socket closed') });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    await manager.createSession({ sandboxId: 'sandbox-1', sessionName: 'agent-1' });
    const result = await manager.killSession('agent-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
  });
});

describe('TmuxManager.killAllSessions', () => {
  it('IT-1840: returns CONTAINER_NOT_FOUND when sandbox missing', async () => {
    const provider = createMockProvider(vi.fn().mockResolvedValue(null));
    const manager = new TmuxManager(provider);
    const result = await manager.killAllSessions('sandbox-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_CONTAINER_NOT_FOUND');
  });

  it('IT-1841: returns EXEC_FAILED when listTmuxSessions throws', async () => {
    const sandbox = createMockSandbox({ listThrows: new Error('socket closed') });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);
    const result = await manager.killAllSessions('sandbox-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANDBOX_EXEC_FAILED');
  });

  it('IT-1842: kills all sessions and returns the count', async () => {
    const sandbox = createMockSandbox({
      sessions: [makeSession('a'), makeSession('b'), makeSession('c')],
    });
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    const result = await manager.killAllSessions('sandbox-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(3);
    expect(sandbox.killTmuxSession).toHaveBeenCalledTimes(3);
  });

  it('IT-1843: continues after individual kill failure', async () => {
    let count = 0;
    const sandbox = {
      ...createMockSandbox({ sessions: [makeSession('a'), makeSession('b')] }),
      killTmuxSession: vi.fn(async (name: string) => {
        count++;
        if (name === 'a') throw new Error('boom');
      }),
    };
    const provider = createMockProvider(vi.fn().mockResolvedValue(sandbox));
    const manager = new TmuxManager(provider);

    const result = await manager.killAllSessions('sandbox-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(1); // only 'b' succeeded
    expect(count).toBe(2);
  });
});

describe('TmuxManager statics & factory', () => {
  it('IT-1850: createSessionName returns "agent-{taskId}"', () => {
    expect(TmuxManager.createSessionName('task-xyz')).toBe('agent-task-xyz');
  });

  it('IT-1851: createTmuxManager factory returns a fresh instance', () => {
    const provider = createMockProvider(vi.fn());
    const m = createTmuxManager(provider);
    expect(m).toBeInstanceOf(TmuxManager);
  });
});
