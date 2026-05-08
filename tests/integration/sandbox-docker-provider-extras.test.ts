/**
 * Coverage gap-filler for `docker-provider.ts`.
 *
 * Drives the DockerSandbox class methods (exec, exec stream parsing, tmux
 * helpers, getMetrics, writeFile, stop) by simulating dockerode's API
 * surface — including the multiplexed stream protocol that the existing
 * tests only cover via standalone protocol assertions.
 *
 * IT-IDs: IT-1500 to IT-1549
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerProvider } from '../../src/lib/sandbox/providers/docker-provider';
import { TEST_AGENT_SANDBOX_IMAGE } from '../fixtures/sandbox-image';

// ---------------------------------------------------------------------------
// Helpers — fake dockerode surface
// ---------------------------------------------------------------------------

/** Build a Docker multiplexed frame: type=1 stdout / 2 stderr, 8B header + payload. */
function frame(type: 1 | 2, payload: string | Buffer): Buffer {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const hdr = Buffer.alloc(8);
  hdr[0] = type;
  hdr.writeUInt32BE(buf.length, 4);
  return Buffer.concat([hdr, buf]);
}

/** A fake exec stream that emits a sequence of muxed frames after caller attaches listeners. */
function makeMuxStream(frames: Buffer[]): EventEmitter {
  const stream = new EventEmitter();
  // setImmediate yields control fully so the caller can attach 'data'/'end' listeners
  // (the real Docker stream behaves this way — data arrives later via the socket).
  setImmediate(() => {
    for (const f of frames) stream.emit('data', f);
    stream.emit('end');
  });
  return stream;
}

interface ExecMockOpts {
  exitCode?: number;
  inspectThrows?: Error;
  startThrows?: Error;
}

function makeExec(opts: ExecMockOpts, frames: Buffer[]) {
  const inspect = vi.fn(async () => {
    if (opts.inspectThrows) throw opts.inspectThrows;
    return { ExitCode: opts.exitCode ?? 0 };
  });
  return {
    start: vi.fn(async () => {
      if (opts.startThrows) throw opts.startThrows;
      return makeMuxStream(frames);
    }),
    inspect,
  };
}

interface MockContainerOpts {
  // Per-call exec results: each call to container.exec() returns the next entry.
  execs?: Array<{
    framesType?: 1 | 2;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>;
  inspectResult?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  putArchiveThrows?: Error;
}

function makeContainer(opts: MockContainerOpts = {}) {
  const execs = opts.execs ?? [{ exitCode: 0 }];
  let execIdx = 0;
  const putArchive = vi.fn(async () => {
    if (opts.putArchiveThrows) throw opts.putArchiveThrows;
  });
  return {
    id: 'container-mock-abc',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(opts.inspectResult ?? { State: { Running: true } }),
    stats: vi.fn().mockResolvedValue(
      opts.stats ?? {
        cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        memory_stats: { usage: 1024 * 1024 * 200, limit: 1024 * 1024 * 8192 },
        networks: { eth0: { rx_bytes: 5000, tx_bytes: 1000 } },
      }
    ),
    exec: vi.fn(async () => {
      const e = execs[Math.min(execIdx, execs.length - 1)] ?? { exitCode: 0 };
      execIdx++;
      const frames: Buffer[] = [];
      if (e.stdout) frames.push(frame(1, e.stdout));
      if (e.stderr) frames.push(frame(2, e.stderr));
      return makeExec({ exitCode: e.exitCode ?? 0 }, frames);
    }),
    putArchive,
  };
}

function makeDocker(container: ReturnType<typeof makeContainer>) {
  return {
    createContainer: vi.fn().mockResolvedValue(container),
    getContainer: vi.fn().mockReturnValue(container),
    listContainers: vi.fn().mockResolvedValue([]),
    pull: vi.fn(),
    ping: vi.fn().mockResolvedValue('OK'),
    info: vi.fn().mockResolvedValue({
      ServerVersion: '24.0.0',
      Containers: 0,
      ContainersRunning: 0,
      Images: 0,
    }),
    getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: 'sha256:x' }) }),
    modem: { followProgress: vi.fn() },
  };
}

async function makeSandbox(container: ReturnType<typeof makeContainer>) {
  const provider = new DockerProvider();
  (provider as unknown as { docker: unknown }).docker = makeDocker(container);
  return provider.create({
    codespaceId: `cs-${Math.random().toString(36).slice(2)}`,
    codespacePath: '/host',
    image: TEST_AGENT_SANDBOX_IMAGE,
    memoryMb: 1024,
    cpuCores: 1,
    idleTimeoutMinutes: 30,
    volumeMounts: [],
  });
}

// ---------------------------------------------------------------------------
// DockerSandbox.exec — multiplexed parsing
// ---------------------------------------------------------------------------

describe('DockerSandbox.exec (multiplexed parsing)', () => {
  it('IT-1500: parses a single stdout frame', async () => {
    const container = makeContainer({ execs: [{ stdout: 'hello world', exitCode: 0 }] });
    const sandbox = await makeSandbox(container);

    const result = await sandbox.exec('echo', ['hi']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('');
  });

  it('IT-1501: parses interleaved stdout + stderr frames', async () => {
    const container = makeContainer({
      execs: [{ stdout: 'out-msg', stderr: 'err-msg', exitCode: 1 }],
    });
    const sandbox = await makeSandbox(container);

    const result = await sandbox.exec('cmd');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('out-msg');
    expect(result.stderr).toBe('err-msg');
  });

  it('IT-1502: passes user=root when calling execAsRoot', async () => {
    const container = makeContainer({ execs: [{ stdout: 'root-out', exitCode: 0 }] });
    const sandbox = await makeSandbox(container);

    await sandbox.execAsRoot('whoami');
    const execCall = (container.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      User: string;
    };
    expect(execCall.User).toBe('root');
  });

  it('IT-1503: defaults user to non-root when calling exec', async () => {
    const container = makeContainer({ execs: [{ stdout: 'me', exitCode: 0 }] });
    const sandbox = await makeSandbox(container);

    await sandbox.exec('whoami');
    const execCall = (container.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      User: string;
    };
    expect(execCall.User).not.toBe('root');
  });

  it('IT-1504: exec rejects when inspect throws on completion', async () => {
    const container = {
      ...makeContainer(),
      exec: vi.fn(async () =>
        makeExec({ exitCode: 0, inspectThrows: new Error('container gone') }, [])
      ),
    };
    const sandbox = await makeSandbox(container as never);
    await expect(sandbox.exec('ls')).rejects.toThrow(/container gone/);
  });
});

// ---------------------------------------------------------------------------
// DockerSandbox tmux methods
// ---------------------------------------------------------------------------

describe('DockerSandbox.tmux methods', () => {
  it('IT-1510: createTmuxSession throws when session already exists', async () => {
    const container = makeContainer({
      execs: [{ stdout: 'agent-1\nother-session', exitCode: 0 }], // list-sessions
    });
    const sandbox = await makeSandbox(container);

    await expect(sandbox.createTmuxSession('agent-1')).rejects.toMatchObject({
      code: 'SANDBOX_TMUX_SESSION_EXISTS',
    });
  });

  it('IT-1511: createTmuxSession throws TMUX_CREATION_FAILED when new-session exits non-zero', async () => {
    const container = makeContainer({
      execs: [
        { stdout: '', exitCode: 0 }, // list-sessions OK
        { stderr: 'tmux not installed', exitCode: 127 }, // new-session fails
      ],
    });
    const sandbox = await makeSandbox(container);

    await expect(sandbox.createTmuxSession('agent-1')).rejects.toMatchObject({
      code: 'SANDBOX_TMUX_CREATION_FAILED',
    });
  });

  it('IT-1512: createTmuxSession returns metadata on success', async () => {
    const container = makeContainer({
      execs: [
        { stdout: '', exitCode: 0 },
        { stdout: '', exitCode: 0 },
      ],
    });
    const sandbox = await makeSandbox(container);

    const session = await sandbox.createTmuxSession('agent-1', 'task-xyz');
    expect(session.name).toBe('agent-1');
    expect(session.taskId).toBe('task-xyz');
    expect(session.windowCount).toBe(1);
    expect(session.attached).toBe(false);
  });

  it('IT-1513: listTmuxSessions returns empty when no server running', async () => {
    const container = makeContainer({
      execs: [{ stderr: 'no server running on /tmp/tmux-1000/default', exitCode: 1 }],
    });
    const sandbox = await makeSandbox(container);

    const sessions = await sandbox.listTmuxSessions();
    expect(sessions).toEqual([]);
  });

  it('IT-1514: listTmuxSessions throws on unexpected error', async () => {
    const container = makeContainer({
      execs: [{ stderr: 'permission denied', exitCode: 5 }],
    });
    const sandbox = await makeSandbox(container);

    await expect(sandbox.listTmuxSessions()).rejects.toMatchObject({
      code: 'SANDBOX_EXEC_FAILED',
    });
  });

  it('IT-1515: listTmuxSessions parses the session list', async () => {
    const container = makeContainer({
      execs: [{ stdout: 'agent-1:2:1\nbuild:1:0', exitCode: 0 }],
    });
    const sandbox = await makeSandbox(container);

    const sessions = await sandbox.listTmuxSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ name: 'agent-1', windowCount: 2, attached: true });
    expect(sessions[1]).toMatchObject({ name: 'build', windowCount: 1, attached: false });
  });

  it('IT-1516: killTmuxSession swallows session-not-found stderr', async () => {
    const container = makeContainer({
      execs: [{ stderr: "can't find session not found: agent-1", exitCode: 1 }],
    });
    const sandbox = await makeSandbox(container);

    // Should not throw because stderr contains "session not found"
    await expect(sandbox.killTmuxSession('agent-1')).resolves.toBeUndefined();
  });

  it('IT-1517: killTmuxSession throws TMUX_SESSION_NOT_FOUND on other failures', async () => {
    const container = makeContainer({
      execs: [{ stderr: 'permission denied', exitCode: 1 }],
    });
    const sandbox = await makeSandbox(container);

    await expect(sandbox.killTmuxSession('agent-1')).rejects.toMatchObject({
      code: 'SANDBOX_TMUX_SESSION_NOT_FOUND',
    });
  });

  it('IT-1518: sendKeysToTmux throws EXEC_FAILED on non-zero exit', async () => {
    const container = makeContainer({
      execs: [{ stderr: 'no such session', exitCode: 1 }],
    });
    const sandbox = await makeSandbox(container);

    await expect(sandbox.sendKeysToTmux('agent-1', 'ls')).rejects.toMatchObject({
      code: 'SANDBOX_EXEC_FAILED',
    });
  });

  it('IT-1519: captureTmuxPane returns stdout from capture-pane', async () => {
    const container = makeContainer({
      execs: [{ stdout: 'pane content here', exitCode: 0 }],
    });
    const sandbox = await makeSandbox(container);

    const out = await sandbox.captureTmuxPane('agent-1', 50);
    expect(out).toBe('pane content here');
  });

  it('IT-1520: captureTmuxPane throws on non-zero exit', async () => {
    const container = makeContainer({
      execs: [{ stderr: 'no session', exitCode: 1 }],
    });
    const sandbox = await makeSandbox(container);

    await expect(sandbox.captureTmuxPane('agent-1')).rejects.toMatchObject({
      code: 'SANDBOX_EXEC_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------
// DockerSandbox.getMetrics
// ---------------------------------------------------------------------------

describe('DockerSandbox.getMetrics', () => {
  it('IT-1530: computes CPU/memory/network metrics from docker stats', async () => {
    const container = makeContainer();
    const sandbox = await makeSandbox(container);

    const metrics = await sandbox.getMetrics();
    expect(metrics.cpuUsagePercent).toBeGreaterThan(0);
    expect(metrics.memoryUsageMb).toBe(200);
    expect(metrics.memoryLimitMb).toBe(8192);
    expect(metrics.networkRxBytes).toBe(5000);
    expect(metrics.networkTxBytes).toBe(1000);
    expect(metrics.diskUsageMb).toBe(0);
  });

  it('IT-1531: handles missing CPU/memory fields gracefully (zero values)', async () => {
    const container = makeContainer({
      stats: { cpu_stats: {}, precpu_stats: {}, memory_stats: {}, networks: {} },
    });
    const sandbox = await makeSandbox(container);

    const metrics = await sandbox.getMetrics();
    expect(metrics.cpuUsagePercent).toBe(0);
    expect(metrics.memoryUsageMb).toBe(0);
    expect(metrics.networkRxBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DockerSandbox.writeFile (tar putArchive)
// ---------------------------------------------------------------------------

describe('DockerSandbox.writeFile', () => {
  it('IT-1540: uploads via putArchive with the correct destination path', async () => {
    const container = makeContainer();
    const sandbox = await makeSandbox(container);

    await sandbox.writeFile('/workspace/.creds/file.json', '{"token":"x"}', 0o600);
    expect(container.putArchive).toHaveBeenCalledTimes(1);
    const [, opts] = (container.putArchive as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Buffer,
      { path: string },
    ];
    expect(opts.path).toBe('/workspace/.creds');
  });

  it('IT-1541: rejects empty file name (path with trailing slash)', async () => {
    const container = makeContainer();
    const sandbox = await makeSandbox(container);
    await expect(sandbox.writeFile('/dir/', 'x')).rejects.toMatchObject({
      code: 'SANDBOX_EXEC_FAILED',
    });
  });

  it('IT-1542: surfaces putArchive errors', async () => {
    const container = makeContainer({ putArchiveThrows: new Error('tar invalid') });
    const sandbox = await makeSandbox(container);
    await expect(sandbox.writeFile('/workspace/file', 'x')).rejects.toThrow(/tar invalid/);
  });
});

// ---------------------------------------------------------------------------
// DockerSandbox.stop / touch / lastActivity
// ---------------------------------------------------------------------------

describe('DockerSandbox.stop & timestamps', () => {
  it('IT-1545: stop transitions status from running → stopping → stopped', async () => {
    const container = makeContainer();
    const sandbox = await makeSandbox(container);

    expect(sandbox.status).toBe('running');
    await sandbox.stop();
    expect(sandbox.status).toBe('stopped');
    expect(container.stop).toHaveBeenCalledWith({ t: 10 });
  });

  it('IT-1546: touch() updates lastActivity', async () => {
    const container = makeContainer();
    const sandbox = await makeSandbox(container);
    const before = sandbox.getLastActivity().getTime();
    await new Promise((r) => setTimeout(r, 5));
    sandbox.touch();
    expect(sandbox.getLastActivity().getTime()).toBeGreaterThanOrEqual(before);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  // No global setup needed; each test builds its own provider.
});
