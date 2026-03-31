import type { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecError, TimeoutError } from '../src/errors.js';

const { mockExec, mockGetNamespacedCustomObject } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockGetNamespacedCustomObject: vi.fn(),
}));

vi.mock('@kubernetes/client-node', () => ({
  Exec: class MockExec {
    exec = mockExec;
  },
  CustomObjectsApi: class MockCustomObjectsApi {
    getNamespacedCustomObject = mockGetNamespacedCustomObject;
  },
  KubeConfig: class MockKubeConfig {
    makeApiClient() {
      return { getNamespacedCustomObject: mockGetNamespacedCustomObject };
    }
  },
  V1Status: class MockV1Status {},
}));

import { KubeConfig } from '@kubernetes/client-node';
import { execInSandbox, execStreamInSandbox } from '../src/operations/exec.js';

function makeMockKc() {
  return new KubeConfig();
}

describe('execInSandbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: pod name resolved from sandbox status
    mockGetNamespacedCustomObject.mockResolvedValue({
      status: { podName: 'test-pod' },
    });
  });

  it('executes a command and returns stdout/stderr', async () => {
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        stdout: any,
        stderr: any,
        _stdin: any,
        _tty: boolean,
        callback: any
      ) => {
        stdout.write(Buffer.from('hello world'));
        stderr.write(Buffer.from('some warning'));
        callback({ status: 'Success' });
        return Promise.resolve();
      }
    );

    const kc = makeMockKc();
    const result = await execInSandbox(kc, {
      sandboxName: 'my-sandbox',
      namespace: 'default',
      command: ['echo', 'hello'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('some warning');
  });

  it('trims whitespace from stdout and stderr', async () => {
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        stdout: any,
        stderr: any,
        _stdin: any,
        _tty: boolean,
        callback: any
      ) => {
        stdout.write(Buffer.from('  padded output  \n'));
        stderr.write(Buffer.from('  padded warning  \n'));
        callback({ status: 'Success' });
        return Promise.resolve();
      }
    );

    const kc = makeMockKc();
    const result = await execInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      command: ['echo', 'padded'],
    });

    expect(result.stdout).toBe('padded output');
    expect(result.stderr).toBe('padded warning');
  });

  it('parses exit code from V1Status causes', async () => {
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: any,
        _stderr: any,
        _stdin: any,
        _tty: boolean,
        callback: any
      ) => {
        callback({
          status: 'Failure',
          details: {
            causes: [{ reason: 'ExitCode', message: '42' }],
          },
        });
        return Promise.resolve();
      }
    );

    const kc = makeMockKc();
    const result = await execInSandbox(kc, {
      sandboxName: 'my-sandbox',
      namespace: 'default',
      command: ['exit', '42'],
    });

    expect(result.exitCode).toBe(42);
  });

  it('returns exit code 1 when causes exist but no ExitCode reason', async () => {
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: any,
        _stderr: any,
        _stdin: any,
        _tty: boolean,
        callback: any
      ) => {
        callback({
          status: 'Failure',
          details: {
            causes: [{ reason: 'OtherReason', message: 'something' }],
          },
        });
        return Promise.resolve();
      }
    );

    const kc = makeMockKc();
    const result = await execInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      command: ['fail'],
    });

    expect(result.exitCode).toBe(1);
  });

  it('returns exit code 1 for failure without causes', async () => {
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: any,
        _stderr: any,
        _stdin: any,
        _tty: boolean,
        callback: any
      ) => {
        callback({ status: 'Failure' });
        return Promise.resolve();
      }
    );

    const kc = makeMockKc();
    const result = await execInSandbox(kc, {
      sandboxName: 'my-sandbox',
      namespace: 'default',
      command: ['false'],
    });

    expect(result.exitCode).toBe(1);
  });

  it('defaults container to "sandbox" when not specified', async () => {
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: any,
        _stderr: any,
        _stdin: any,
        _tty: boolean,
        callback: any
      ) => {
        callback({ status: 'Success' });
        return Promise.resolve();
      }
    );

    const kc = makeMockKc();
    await execInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      command: ['ls'],
    });

    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'sandbox',
      expect.any(Array),
      expect.any(Object),
      expect.any(Object),
      null,
      false,
      expect.any(Function)
    );
  });

  it('uses custom container name when specified', async () => {
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: any,
        _stderr: any,
        _stdin: any,
        _tty: boolean,
        callback: any
      ) => {
        callback({ status: 'Success' });
        return Promise.resolve();
      }
    );

    const kc = makeMockKc();
    await execInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      container: 'my-container',
      command: ['ls'],
    });

    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'my-container',
      expect.any(Array),
      expect.any(Object),
      expect.any(Object),
      null,
      false,
      expect.any(Function)
    );
  });

  it('throws ExecError when exec fails', async () => {
    mockExec.mockRejectedValue(new Error('connection refused'));

    const kc = makeMockKc();
    await expect(
      execInSandbox(kc, {
        sandboxName: 'my-sandbox',
        namespace: 'default',
        command: ['echo'],
      })
    ).rejects.toThrow(ExecError);
  });

  it('ExecError includes command in message', async () => {
    mockExec.mockRejectedValue(new Error('ws failed'));

    const kc = makeMockKc();
    try {
      await execInSandbox(kc, {
        sandboxName: 'test',
        namespace: 'default',
        command: ['my-cmd', '--flag'],
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ExecError);
      expect((err as ExecError).message).toContain('my-cmd --flag');
    }
  });

  it('times out when timeoutMs is exceeded', async () => {
    mockExec.mockImplementation(() => {
      // Never calls callback - simulates hanging
      return Promise.resolve();
    });

    const kc = makeMockKc();
    await expect(
      execInSandbox(kc, {
        sandboxName: 'my-sandbox',
        namespace: 'default',
        command: ['sleep', '100'],
        timeoutMs: 50,
      })
    ).rejects.toThrow(TimeoutError);
  });

  it('completes normally without timeout when timeoutMs not set', async () => {
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: any,
        _stderr: any,
        _stdin: any,
        _tty: boolean,
        callback: any
      ) => {
        callback({ status: 'Success' });
        return Promise.resolve();
      }
    );

    const kc = makeMockKc();
    const result = await execInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      command: ['echo'],
    });

    expect(result.exitCode).toBe(0);
  });

  it('falls back to sandbox name when pod resolution gets 404', async () => {
    const notFoundError = Object.assign(new Error('not found'), {
      response: { statusCode: 404 },
    });
    mockGetNamespacedCustomObject.mockRejectedValue(notFoundError);

    mockExec.mockImplementation(
      (
        _ns: string,
        podName: string,
        _container: string,
        _cmd: string[],
        stdout: any,
        _stderr: any,
        _stdin: any,
        _tty: boolean,
        callback: any
      ) => {
        stdout.write(Buffer.from(podName));
        callback({ status: 'Success' });
        return Promise.resolve();
      }
    );

    const kc = makeMockKc();
    const result = await execInSandbox(kc, {
      sandboxName: 'fallback-name',
      namespace: 'default',
      command: ['hostname'],
    });

    expect(result.stdout).toBe('fallback-name');
  });

  it('propagates non-404 errors from pod resolution', async () => {
    const authError = Object.assign(new Error('Unauthorized'), {
      response: { statusCode: 401 },
    });
    mockGetNamespacedCustomObject.mockRejectedValue(authError);

    const kc = makeMockKc();
    await expect(
      execInSandbox(kc, {
        sandboxName: 'my-sandbox',
        namespace: 'default',
        command: ['echo', 'hello'],
      })
    ).rejects.toThrow('Unauthorized');
  });

  it('propagates errors without a status code from pod resolution', async () => {
    mockGetNamespacedCustomObject.mockRejectedValue(new Error('network error'));

    const kc = makeMockKc();
    await expect(
      execInSandbox(kc, {
        sandboxName: 'my-sandbox',
        namespace: 'default',
        command: ['echo', 'hello'],
      })
    ).rejects.toThrow('network error');
  });

  it('uses podName from sandbox annotation when available', async () => {
    mockGetNamespacedCustomObject.mockResolvedValue({
      metadata: { annotations: { 'agents.x-k8s.io/pod-name': 'resolved-pod' } },
    });

    mockExec.mockImplementation(
      (
        _ns: string,
        podName: string,
        _container: string,
        _cmd: string[],
        stdout: any,
        _stderr: any,
        _stdin: any,
        _tty: boolean,
        callback: any
      ) => {
        stdout.write(Buffer.from(podName));
        callback({ status: 'Success' });
        return Promise.resolve();
      }
    );

    const kc = makeMockKc();
    const result = await execInSandbox(kc, {
      sandboxName: 'my-sandbox',
      namespace: 'default',
      command: ['hostname'],
    });

    expect(result.stdout).toBe('resolved-pod');
  });

  it('falls back to sandbox name when annotation has no pod-name', async () => {
    mockGetNamespacedCustomObject.mockResolvedValue({
      metadata: {},
    });

    mockExec.mockImplementation(
      (
        _ns: string,
        podName: string,
        _container: string,
        _cmd: string[],
        stdout: any,
        _stderr: any,
        _stdin: any,
        _tty: boolean,
        callback: any
      ) => {
        stdout.write(Buffer.from(podName));
        callback({ status: 'Success' });
        return Promise.resolve();
      }
    );

    const kc = makeMockKc();
    const result = await execInSandbox(kc, {
      sandboxName: 'my-sandbox',
      namespace: 'default',
      command: ['hostname'],
    });

    expect(result.stdout).toBe('my-sandbox');
  });
});

describe('execStreamInSandbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const notFoundError = Object.assign(new Error('not found'), {
      response: { statusCode: 404 },
    });
    mockGetNamespacedCustomObject.mockRejectedValue(notFoundError);
  });

  it('returns stdout and stderr streams plus wait and kill', async () => {
    const mockWs = { close: vi.fn() };
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        stdout.write('stream data');
        setTimeout(() => statusCb({ status: 'Success' }), 10);
        return Promise.resolve(mockWs);
      }
    );

    const kc = makeMockKc();
    const stream = await execStreamInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      command: ['tail', '-f', '/var/log/app.log'],
    });

    expect(stream.stdout).toBeDefined();
    expect(stream.stderr).toBeDefined();
    expect(typeof stream.wait).toBe('function');
    expect(typeof stream.kill).toBe('function');

    const result = await stream.wait();
    expect(result.exitCode).toBe(0);
  });

  it('kill() closes the websocket and destroys streams', async () => {
    const mockWs = { close: vi.fn() };
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        _statusCb: any
      ) => {
        return Promise.resolve(mockWs);
      }
    );

    const kc = makeMockKc();
    const stream = await execStreamInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      command: ['sleep', '999'],
    });

    stream.kill();

    expect(mockWs.close).toHaveBeenCalled();
    expect(stream.stdout.destroyed).toBe(true);
    expect(stream.stderr.destroyed).toBe(true);
  });

  it('parses non-zero exit code in streaming mode', async () => {
    const mockWs = { close: vi.fn() };
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        setTimeout(
          () =>
            statusCb({
              status: 'Failure',
              details: {
                causes: [{ reason: 'ExitCode', message: '127' }],
              },
            }),
          10
        );
        return Promise.resolve(mockWs);
      }
    );

    const kc = makeMockKc();
    const stream = await execStreamInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      command: ['nonexistent-cmd'],
    });

    const result = await stream.wait();
    expect(result.exitCode).toBe(127);
  });

  it('ends stdout/stderr streams when process completes', async () => {
    const mockWs = { close: vi.fn() };
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        setTimeout(() => statusCb({ status: 'Success' }), 10);
        return Promise.resolve(mockWs);
      }
    );

    const kc = makeMockKc();
    const stream = await execStreamInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      command: ['ls'],
    });

    await stream.wait();
    expect(stream.stdout.writableEnded).toBe(true);
    expect(stream.stderr.writableEnded).toBe(true);
  });

  it('destroys streams and rejects wait when exec throws', async () => {
    mockExec.mockRejectedValue(new Error('connection refused'));

    const kc = makeMockKc();
    const stream = await execStreamInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      command: ['ls'],
    });

    expect(stream.stdout.destroyed).toBe(true);
    expect(stream.stderr.destroyed).toBe(true);
    await expect(stream.wait()).rejects.toThrow(ExecError);
  });

  it('defaults exit code 1 for failure without details in streaming mode', async () => {
    const mockWs = { close: vi.fn() };
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        setTimeout(() => statusCb({ status: 'Failure' }), 10);
        return Promise.resolve(mockWs);
      }
    );

    const kc = makeMockKc();
    const stream = await execStreamInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      command: ['fail'],
    });

    const result = await stream.wait();
    expect(result.exitCode).toBe(1);
  });

  it('kill() is safe when wsConnection has no close method', async () => {
    // Return an object without a close method
    const mockWsNoClose = {};
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        _statusCb: any
      ) => {
        return Promise.resolve(mockWsNoClose);
      }
    );

    const kc = makeMockKc();
    const stream = await execStreamInSandbox(kc, {
      sandboxName: 'test',
      namespace: 'default',
      command: ['sleep', '999'],
    });

    // Should not throw even without close method
    stream.kill();
    expect(stream.stdout.destroyed).toBe(true);
    expect(stream.stderr.destroyed).toBe(true);
  });
});
