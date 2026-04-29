import { Readable } from 'node:stream';
import { vi } from 'vitest';
import type {
  ExecStreamOptions,
  ExecStreamResult,
  Sandbox,
  SandboxProvider,
} from '../../src/lib/sandbox/providers/sandbox-provider.js';
import type {
  ExecResult,
  SandboxConfig,
  SandboxInfo,
  SandboxMetrics,
  TmuxSession,
} from '../../src/lib/sandbox/types.js';

/**
 * Creates a mock Node.js Readable stream that optionally emits data lines then ends.
 *
 * @param data - Optional array of strings to emit as separate data chunks. Each string is treated as a line.
 * @returns A Node.js Readable stream that emits the data lines then ends immediately.
 *
 * @example
 * ```typescript
 * const stdout = createMockReadableStream(['line 1', 'line 2']);
 * stdout.on('data', (chunk) => console.log(chunk.toString()));
 * stdout.on('end', () => console.log('Stream ended'));
 * ```
 */
export function createMockReadableStream(data?: string[]): Readable {
  const stream = new Readable({
    read() {
      // Emit data if provided
      if (data && data.length > 0) {
        for (const line of data) {
          this.push(`${line}\n`);
        }
      }
      // Signal end of stream
      this.push(null);
    },
  });

  return stream;
}

/**
 * Creates a mock ExecStreamResult with working mock streams.
 *
 * @param overrides - Optional overrides for stdout, stderr, wait, or kill functions
 * @returns A mock ExecStreamResult with readable streams that end immediately
 *
 * @example
 * ```typescript
 * const result = createMockExecStreamResult({
 *   stdout: createMockReadableStream(['output line 1']),
 *   stderr: createMockReadableStream(['error line 1']),
 * });
 *
 * result.stdout.on('data', (chunk) => console.log('stdout:', chunk.toString()));
 * const { exitCode } = await result.wait();
 * ```
 */
export function createMockExecStreamResult(
  overrides: Partial<ExecStreamResult> = {}
): ExecStreamResult {
  return {
    stdout: createMockReadableStream(),
    stderr: createMockReadableStream(),
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
    kill: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Creates a mock Sandbox instance with all methods mocked.
 *
 * @param overrides - Optional overrides for any sandbox properties or methods
 * @returns A fully mocked Sandbox instance
 *
 * @example
 * ```typescript
 * const sandbox = createMockSandbox({
 *   id: 'test-sandbox',
 *   status: 'running',
 *   exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'success', stderr: '' }),
 * });
 *
 * const result = await sandbox.exec('echo', ['hello']);
 * expect(result.exitCode).toBe(0);
 * ```
 */
export function createMockSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: 'mock-sandbox-123',
    codespaceId: 'mock-project-123',
    containerId: 'mock-container-abc',
    status: 'running',
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    execAsRoot: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    createTmuxSession: vi.fn().mockResolvedValue({
      name: 'mock-session',
      sandboxId: 'mock-sandbox-123',
      createdAt: new Date().toISOString(),
      windowCount: 1,
      attached: false,
    } as TmuxSession),
    listTmuxSessions: vi.fn().mockResolvedValue([]),
    killTmuxSession: vi.fn().mockResolvedValue(undefined),
    sendKeysToTmux: vi.fn().mockResolvedValue(undefined),
    captureTmuxPane: vi.fn().mockResolvedValue(''),
    stop: vi.fn().mockResolvedValue(undefined),
    getMetrics: vi.fn().mockResolvedValue({
      cpuUsagePercent: 10,
      memoryUsageMb: 512,
      memoryLimitMb: 4096,
      diskUsageMb: 0,
      networkRxBytes: 1024,
      networkTxBytes: 2048,
      uptime: 3600000,
    } as SandboxMetrics),
    touch: vi.fn(),
    getLastActivity: vi.fn().mockReturnValue(new Date()),
    execStream: vi.fn().mockResolvedValue(createMockExecStreamResult()),
    // arch29-W2-I (F04-06): every provider implements writeFile so credentials
    // can be injected out-of-band (no token in argv).
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Creates a mock SandboxProvider with all methods mocked.
 *
 * @param sandbox - Optional sandbox instance to return from get/getById calls
 * @returns A fully mocked SandboxProvider
 *
 * @example
 * ```typescript
 * const mockSandbox = createMockSandbox({ id: 'test-123' });
 * const provider = createMockSandboxProvider(mockSandbox);
 *
 * const result = await provider.get('project-123');
 * expect(result?.id).toBe('test-123');
 * ```
 */
export function createMockSandboxProvider(sandbox?: Sandbox | null): SandboxProvider {
  return {
    name: 'mock-provider',
    create: vi.fn().mockResolvedValue(sandbox ?? createMockSandbox()),
    get: vi.fn().mockResolvedValue(sandbox ?? null),
    getById: vi.fn().mockResolvedValue(sandbox ?? null),
    list: vi.fn().mockResolvedValue([]),
    pullImage: vi.fn().mockResolvedValue(undefined),
    isImageAvailable: vi.fn().mockResolvedValue(true),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    cleanup: vi.fn().mockResolvedValue(0),
  };
}

/**
 * Creates a mock sandbox that emits structured JSON events via execStream.
 * Useful for testing container bridge event parsing.
 *
 * @param events - Array of event objects to emit as JSON lines
 * @returns A mock Sandbox with execStream configured to emit the events
 *
 * @example
 * ```typescript
 * const events = [
 *   { type: 'agent:started', data: { agentId: 'agent-123' } },
 *   { type: 'agent:completed', data: { success: true } },
 * ];
 *
 * const sandbox = createMockSandboxWithEvents(events);
 * const streamResult = await sandbox.execStream?.({ cmd: 'agent-runner', env: {} });
 *
 * streamResult?.stdout.on('data', (chunk) => {
 *   const event = JSON.parse(chunk.toString());
 *   console.log('Event:', event.type);
 * });
 * ```
 */
export function createMockSandboxWithEvents(events: Array<Record<string, unknown>>): Sandbox {
  // Convert events to JSON lines
  const jsonLines = events.map((event) => JSON.stringify(event));

  const execStream = vi.fn().mockImplementation((_options: ExecStreamOptions) => {
    const stdout = createMockReadableStream(jsonLines);
    const stderr = createMockReadableStream();

    return Promise.resolve({
      stdout,
      stderr,
      wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
      kill: vi.fn().mockResolvedValue(undefined),
    } as ExecStreamResult);
  });

  return createMockSandbox({ execStream });
}

/**
 * Creates a default sandbox configuration matching the database schema.
 *
 * @param overrides - Optional overrides for any configuration fields
 * @returns A SandboxConfig with sensible defaults
 *
 * @example
 * ```typescript
 * const config = createMockSandboxConfig({
 *   codespaceId: 'my-project',
 *   memoryMb: 8192,
 * });
 *
 * const sandbox = await sandboxProvider.create(config);
 * ```
 */
export function createMockSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    codespaceId: 'mock-project-123',
    projectPath: '/tmp/mock-project',
    image: 'node:20',
    memoryMb: 512,
    cpuCores: 1,
    idleTimeoutMinutes: 30,
    volumeMounts: [],
    env: {},
    ...overrides,
  };
}

/**
 * Creates a mock SandboxInfo instance.
 *
 * @param overrides - Optional overrides for any info fields
 * @returns A SandboxInfo with sensible defaults
 *
 * @example
 * ```typescript
 * const info = createMockSandboxInfo({
 *   status: 'running',
 *   codespaceId: 'my-project',
 * });
 * ```
 */
export function createMockSandboxInfo(overrides: Partial<SandboxInfo> = {}): SandboxInfo {
  return {
    id: 'mock-sandbox-123',
    codespaceId: 'mock-project-123',
    containerId: 'mock-container-abc',
    status: 'running',
    image: 'node:20',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    memoryMb: 512,
    cpuCores: 1,
    ...overrides,
  };
}

/**
 * Creates a mock ExecResult.
 *
 * @param overrides - Optional overrides for exitCode, stdout, or stderr
 * @returns An ExecResult with sensible defaults (successful execution)
 *
 * @example
 * ```typescript
 * const result = createMockExecResult({
 *   exitCode: 1,
 *   stderr: 'Command not found',
 * });
 * ```
 */
export function createMockExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}
