/**
 * arch29-W2-I (F04-06) — `writeFile` parity across Docker/K8s/Nomad.
 *
 * Verifies that:
 *   1. The shared `buildSingleFileTar` helper produces a USTAR archive with
 *      the right header, content, and trailer.
 *   2. K8s `AgentSandboxInstance.writeFile` calls the SDK's `execStream` with
 *      `tar xf - -C <dir>` and feeds the archive over stdin (NOT in argv).
 *   3. Nomad `NomadSandboxInstance.writeFile` calls the SDK's `execStream`
 *      with the same shape and feeds the archive over the WritableStream
 *      stdin (NOT in argv).
 *   4. Neither implementation puts the credential content into the command
 *      arguments — content lives only in stdin.
 */

import { PassThrough, type Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../logging/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock SDK packages used by the providers
vi.mock('@agentpane/agent-sandbox-sdk', () => ({
  AgentSandboxClient: vi.fn(),
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('@agentpane/nomad-sandbox-sdk', () => ({
  ConnectionError: class ConnectionError extends Error {},
  ExecError: class ExecError extends Error {
    exitCode: number;
    stderr: string;
    constructor(exitCode: number, message: string, stderr = '') {
      super(message);
      this.exitCode = exitCode;
      this.stderr = stderr;
    }
  },
  NomadSandboxClient: vi.fn(),
  NotFoundError: class NotFoundError extends Error {},
  TimeoutError: class TimeoutError extends Error {},
}));

vi.mock('../nomad-sandbox-provider.js', () => ({
  mapNomadJobStatus: () => 'running' as const,
}));

// ---------------------------------------------------------------------------
// buildSingleFileTar — shared helper sanity test
// ---------------------------------------------------------------------------
describe('buildSingleFileTar (arch29-W2-I shared helper)', () => {
  it('produces a USTAR archive with the right header layout', async () => {
    const { buildSingleFileTar } = await import('../single-file-tar.js');
    const content = Buffer.from('hello-secret-creds', 'utf8');
    const archive = buildSingleFileTar('.credentials.json', content, 0o600);

    // 512-byte header + content padded to 512 + 1024-byte trailer.
    const expectedSize = 512 + Math.ceil(content.length / 512) * 512 + 1024;
    expect(archive.length).toBe(expectedSize);

    // Name in first 100 bytes
    expect(archive.subarray(0, 16).toString('ascii').replace(/\0+$/, '')).toBe('.credentials.jso');
    // ustar magic at offset 257
    expect(archive.subarray(257, 263).toString('ascii')).toBe('ustar\0');
    // typeflag '0' (regular file)
    expect(archive[156]).toBe('0'.charCodeAt(0));
    // Content immediately after the header
    expect(archive.subarray(512, 512 + content.length).equals(content)).toBe(true);
  });

  it('rejects names longer than the USTAR short-name field (100 bytes)', async () => {
    const { buildSingleFileTar } = await import('../single-file-tar.js');
    const longName = 'a'.repeat(101);
    expect(() => buildSingleFileTar(longName, Buffer.from('x'), 0o600)).toThrow(/name too long/);
  });
});

// ---------------------------------------------------------------------------
// K8s AgentSandboxInstance.writeFile
// ---------------------------------------------------------------------------
describe('K8s AgentSandboxInstance.writeFile (arch29-W2-I F04-06)', () => {
  function makeK8sClient(): {
    client: {
      execStream: ReturnType<typeof vi.fn>;
      exec?: ReturnType<typeof vi.fn>;
      getSandbox?: ReturnType<typeof vi.fn>;
      deleteSandbox?: ReturnType<typeof vi.fn>;
    };
    capturedCommand: string[][];
    capturedStdin: Buffer[];
  } {
    const capturedCommand: string[][] = [];
    const capturedStdin: Buffer[] = [];
    const client = {
      execStream: vi.fn(async (opts: { command: string[]; stdin?: Readable }) => {
        capturedCommand.push([...opts.command]);
        if (opts.stdin) {
          // Drain the stdin into capturedStdin chunks so the test can
          // assert the exact bytes pushed in.
          await new Promise<void>((resolve, reject) => {
            opts.stdin?.on('data', (chunk: Buffer) =>
              capturedStdin.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
            );
            opts.stdin?.on('end', () => resolve());
            opts.stdin?.on('error', reject);
          });
        }
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        // tar xf produces no output on success — close streams immediately.
        stdout.end();
        stderr.end();
        return {
          stdout: stdout as unknown as Readable,
          stderr: stderr as unknown as Readable,
          wait: vi.fn(async () => ({ exitCode: 0 })),
          kill: vi.fn(async () => undefined),
        };
      }),
    };
    return { client, capturedCommand, capturedStdin };
  }

  it('runs `tar xf - -C <dir>` and pipes the archive over stdin (token NOT in argv)', async () => {
    const { AgentSandboxInstance } = await import('../agent-sandbox-instance.js');

    const { client, capturedCommand, capturedStdin } = makeK8sClient();
    const instance = new AgentSandboxInstance(
      'sb-1',
      'sandbox-name-1',
      'cs-1',
      'agentpane-sandboxes',
      client as any
    );

    const SECRET_CREDS = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-supersecret"}}';
    await instance.writeFile('/home/node/.claude/.credentials.json', SECRET_CREDS, 0o600);

    expect(capturedCommand).toHaveLength(1);
    const cmd = capturedCommand[0];
    expect(cmd?.[0]).toBe('tar');
    expect(cmd?.[1]).toBe('xf');
    expect(cmd?.[2]).toBe('-');
    expect(cmd?.[3]).toBe('-C');
    expect(cmd?.[4]).toBe('/home/node/.claude');
    // Critical: the secret never appears in any command argv element.
    for (const arg of cmd ?? []) {
      expect(arg).not.toContain('sk-ant-oat01-supersecret');
      expect(arg).not.toContain('claudeAiOauth');
    }

    // The archive payload was streamed via stdin, not argv.
    expect(capturedStdin.length).toBeGreaterThan(0);
    const fullStdin = Buffer.concat(capturedStdin);
    // The tar archive contains the credentials in its data section.
    expect(fullStdin.toString('utf8')).toContain('sk-ant-oat01-supersecret');
    // USTAR magic confirms it's a tar archive.
    expect(fullStdin.subarray(257, 263).toString('ascii')).toBe('ustar\0');
  });

  it('throws K8sError on non-zero tar exit', async () => {
    const { AgentSandboxInstance } = await import('../agent-sandbox-instance.js');

    const client = {
      execStream: vi.fn(async (opts: { stdin?: Readable }) => {
        if (opts.stdin) {
          // drain stdin
          await new Promise<void>((resolve, reject) => {
            opts.stdin?.on('data', () => undefined);
            opts.stdin?.on('end', () => resolve());
            opts.stdin?.on('error', reject);
          });
        }
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        stderr.write('tar: cannot create directory\n');
        stdout.end();
        stderr.end();
        return {
          stdout: stdout as unknown as Readable,
          stderr: stderr as unknown as Readable,
          wait: vi.fn(async () => ({ exitCode: 2 })),
          kill: vi.fn(async () => undefined),
        };
      }),
    };

    const instance = new AgentSandboxInstance(
      'sb-1',
      'sandbox-name-1',
      'cs-1',
      'ns',
      client as any
    );

    await expect(
      instance.writeFile('/home/node/.claude/.credentials.json', 'whatever', 0o600)
    ).rejects.toMatchObject({ code: expect.stringMatching(/^K8S_/) });
  });
});

// ---------------------------------------------------------------------------
// Nomad NomadSandboxInstance.writeFile
// ---------------------------------------------------------------------------
describe('Nomad NomadSandboxInstance.writeFile (arch29-W2-I F04-06)', () => {
  function makeNomadClient(): {
    client: {
      execStream: ReturnType<typeof vi.fn>;
      stopJob?: ReturnType<typeof vi.fn>;
      getJob?: ReturnType<typeof vi.fn>;
      getJobAllocations?: ReturnType<typeof vi.fn>;
    };
    capturedCommand: string[][];
    capturedStdin: Uint8Array[];
  } {
    const capturedCommand: string[][] = [];
    const capturedStdin: Uint8Array[] = [];
    const client = {
      execStream: vi.fn((opts: { command: string[] }) => {
        capturedCommand.push([...opts.command]);
        const stdoutStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        const stderrStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        const stdinStream = new WritableStream<Uint8Array>({
          write(chunk) {
            capturedStdin.push(new Uint8Array(chunk));
          },
        });
        return {
          stdout: stdoutStream,
          stderr: stderrStream,
          stdin: stdinStream,
          wait: vi.fn(async () => ({ exitCode: 0 })),
          kill: vi.fn(() => undefined),
        };
      }),
    };
    return { client, capturedCommand, capturedStdin };
  }

  it('runs `tar xf - -C <dir>` and pipes the archive over WritableStream stdin', async () => {
    const { NomadSandboxInstance } = await import('../nomad-sandbox-instance.js');

    const { client, capturedCommand, capturedStdin } = makeNomadClient();
    const instance = new NomadSandboxInstance(
      'sb-1',
      'job-1',
      'alloc-1',
      'cs-1',
      'default',
      client as any
    );

    // Force status to 'running' so assertRunning() passes.
    (instance as unknown as { _status: string })._status = 'running';

    const SECRET_CREDS = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-nomad-secret"}}';
    await instance.writeFile('/home/node/.claude/.credentials.json', SECRET_CREDS, 0o600);

    expect(capturedCommand).toHaveLength(1);
    const cmd = capturedCommand[0];
    expect(cmd?.[0]).toBe('tar');
    expect(cmd?.[1]).toBe('xf');
    expect(cmd?.[2]).toBe('-');
    expect(cmd?.[3]).toBe('-C');
    expect(cmd?.[4]).toBe('/home/node/.claude');
    for (const arg of cmd ?? []) {
      expect(arg).not.toContain('sk-ant-oat01-nomad-secret');
      expect(arg).not.toContain('claudeAiOauth');
    }

    // The archive payload was streamed via stdin, not argv.
    expect(capturedStdin.length).toBeGreaterThan(0);
    const fullStdin = Buffer.concat(capturedStdin.map((u8) => Buffer.from(u8)));
    expect(fullStdin.toString('utf8')).toContain('sk-ant-oat01-nomad-secret');
    expect(fullStdin.subarray(257, 263).toString('ascii')).toBe('ustar\0');
  });

  it('throws NomadError on non-zero tar exit', async () => {
    const { NomadSandboxInstance } = await import('../nomad-sandbox-instance.js');

    const client = {
      execStream: vi.fn(() => {
        const stdoutStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        const stderrStream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('tar: cannot create directory\n'));
            controller.close();
          },
        });
        const stdinStream = new WritableStream<Uint8Array>({
          write() {
            /* drop */
          },
        });
        return {
          stdout: stdoutStream,
          stderr: stderrStream,
          stdin: stdinStream,
          wait: vi.fn(async () => ({ exitCode: 2 })),
          kill: vi.fn(() => undefined),
        };
      }),
    };

    const instance = new NomadSandboxInstance(
      'sb-1',
      'job-1',
      'alloc-1',
      'cs-1',
      'default',
      client as any
    );
    (instance as unknown as { _status: string })._status = 'running';

    await expect(
      instance.writeFile('/home/node/.claude/.credentials.json', 'whatever', 0o600)
    ).rejects.toMatchObject({ code: expect.stringMatching(/^NOMAD-/) });
  });

  it('refuses to write when the allocation is not running', async () => {
    const { NomadSandboxInstance } = await import('../nomad-sandbox-instance.js');
    const { client } = makeNomadClient();

    const instance = new NomadSandboxInstance(
      'sb-1',
      'job-1',
      'alloc-1',
      'cs-1',
      'default',
      client as any
    );
    // Default _status is 'creating' — assertRunning() should throw.
    await expect(
      instance.writeFile('/home/node/.claude/.credentials.json', 'x', 0o600)
    ).rejects.toMatchObject({ code: expect.stringMatching(/^NOMAD-/) });
  });
});
