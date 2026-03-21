import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createMockExecResult,
  createMockExecStreamResult,
  createMockReadableStream,
  createMockSandbox,
  createMockSandboxConfig,
  createMockSandboxInfo,
  createMockSandboxProvider,
  createMockSandboxWithEvents,
} from './mock-sandbox.js';

describe('Mock Sandbox Utilities', () => {
  describe('createMockReadableStream', () => {
    it('creates an empty stream that ends immediately', async () => {
      const stream = createMockReadableStream();
      expect(stream).toBeInstanceOf(Readable);

      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));

      await new Promise<void>((resolve) => {
        stream.on('end', resolve);
      });

      expect(chunks).toHaveLength(0);
    });

    it('emits provided data lines then ends', async () => {
      const stream = createMockReadableStream(['line 1', 'line 2']);

      const chunks: string[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

      await new Promise<void>((resolve) => {
        stream.on('end', resolve);
      });

      expect(chunks).toEqual(['line 1\n', 'line 2\n']);
    });
  });

  describe('createMockExecStreamResult', () => {
    it('creates result with working streams', async () => {
      const result = createMockExecStreamResult();

      expect(result.stdout).toBeInstanceOf(Readable);
      expect(result.stderr).toBeInstanceOf(Readable);
      expect(result.wait).toBeDefined();
      expect(result.kill).toBeDefined();

      const { exitCode } = await result.wait();
      expect(exitCode).toBe(0);
    });

    it('allows overriding stdout and stderr', async () => {
      const stdout = createMockReadableStream(['output']);
      const stderr = createMockReadableStream(['error']);

      const result = createMockExecStreamResult({ stdout, stderr });

      const stdoutChunks: string[] = [];
      result.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk.toString()));

      await new Promise<void>((resolve) => {
        result.stdout.on('end', resolve);
      });

      expect(stdoutChunks).toEqual(['output\n']);
    });

    it('allows overriding wait and kill', async () => {
      const wait = vi.fn().mockResolvedValue({ exitCode: 1 });
      const kill = vi.fn().mockResolvedValue(undefined);

      const result = createMockExecStreamResult({ wait, kill });

      const { exitCode } = await result.wait();
      expect(exitCode).toBe(1);

      await result.kill();
      expect(kill).toHaveBeenCalled();
    });
  });

  describe('createMockSandbox', () => {
    it('creates sandbox with all required methods', () => {
      const sandbox = createMockSandbox();

      expect(sandbox.id).toBe('mock-sandbox-123');
      expect(sandbox.codespaceId).toBe('mock-project-123');
      expect(sandbox.containerId).toBe('mock-container-abc');
      expect(sandbox.status).toBe('running');
      expect(sandbox.exec).toBeDefined();
      expect(sandbox.execAsRoot).toBeDefined();
      expect(sandbox.execStream).toBeDefined();
      expect(sandbox.createTmuxSession).toBeDefined();
      expect(sandbox.listTmuxSessions).toBeDefined();
      expect(sandbox.killTmuxSession).toBeDefined();
      expect(sandbox.sendKeysToTmux).toBeDefined();
      expect(sandbox.captureTmuxPane).toBeDefined();
      expect(sandbox.stop).toBeDefined();
      expect(sandbox.getMetrics).toBeDefined();
      expect(sandbox.touch).toBeDefined();
      expect(sandbox.getLastActivity).toBeDefined();
    });

    it('exec returns success by default', async () => {
      const sandbox = createMockSandbox();
      const result = await sandbox.exec('echo', ['hello']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('allows overriding exec behavior', async () => {
      const exec = vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: 'output',
        stderr: 'error',
      });

      const sandbox = createMockSandbox({ exec });
      const result = await sandbox.exec('failing-command');

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('output');
      expect(result.stderr).toBe('error');
    });

    it('execStream returns working stream result', async () => {
      const sandbox = createMockSandbox();
      const result = await sandbox.execStream?.({ cmd: 'test', env: {} });

      expect(result).toBeDefined();
      expect(result?.stdout).toBeInstanceOf(Readable);
      expect(result?.stderr).toBeInstanceOf(Readable);
    });

    it('getMetrics returns default metrics', async () => {
      const sandbox = createMockSandbox();
      const metrics = await sandbox.getMetrics();

      expect(metrics.cpuUsagePercent).toBe(10);
      expect(metrics.memoryUsageMb).toBe(512);
      expect(metrics.memoryLimitMb).toBe(4096);
    });
  });

  describe('createMockSandboxProvider', () => {
    it('creates provider with all required methods', () => {
      const provider = createMockSandboxProvider();

      expect(provider.name).toBe('mock-provider');
      expect(provider.create).toBeDefined();
      expect(provider.get).toBeDefined();
      expect(provider.getById).toBeDefined();
      expect(provider.list).toBeDefined();
      expect(provider.pullImage).toBeDefined();
      expect(provider.isImageAvailable).toBeDefined();
      expect(provider.healthCheck).toBeDefined();
      expect(provider.cleanup).toBeDefined();
    });

    it('returns provided sandbox from get/getById', async () => {
      const mockSandbox = createMockSandbox({ id: 'test-123' });
      const provider = createMockSandboxProvider(mockSandbox);

      const result1 = await provider.get('project-123');
      const result2 = await provider.getById('test-123');

      expect(result1?.id).toBe('test-123');
      expect(result2?.id).toBe('test-123');
    });

    it('returns null when no sandbox provided', async () => {
      const provider = createMockSandboxProvider(null);

      const result = await provider.get('project-123');
      expect(result).toBeNull();
    });

    it('healthCheck returns healthy by default', async () => {
      const provider = createMockSandboxProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
    });
  });

  describe('createMockSandboxWithEvents', () => {
    it('emits JSON events via stdout', async () => {
      const events = [
        { type: 'agent:started', data: { agentId: 'agent-123' } },
        { type: 'agent:completed', data: { success: true } },
      ];

      const sandbox = createMockSandboxWithEvents(events);
      const streamResult = await sandbox.execStream?.({ cmd: 'agent-runner', env: {} });

      expect(streamResult).toBeDefined();

      const chunks: string[] = [];
      streamResult?.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk.toString());
      });

      await new Promise<void>((resolve) => {
        streamResult?.stdout.on('end', resolve);
      });

      expect(chunks).toHaveLength(2);
      const event1 = JSON.parse(chunks[0] ?? '{}');
      const event2 = JSON.parse(chunks[1] ?? '{}');

      expect(event1.type).toBe('agent:started');
      expect(event2.type).toBe('agent:completed');
    });
  });

  describe('createMockSandboxConfig', () => {
    it('creates config with sensible defaults', () => {
      const config = createMockSandboxConfig();

      expect(config.codespaceId).toBe('mock-project-123');
      expect(config.projectPath).toBe('/tmp/mock-project');
      expect(config.image).toBe('node:20');
      expect(config.memoryMb).toBe(512);
      expect(config.cpuCores).toBe(1);
      expect(config.idleTimeoutMinutes).toBe(30);
      expect(config.volumeMounts).toEqual([]);
      expect(config.env).toEqual({});
    });

    it('allows overriding any field', () => {
      const config = createMockSandboxConfig({
        codespaceId: 'custom-project',
        memoryMb: 8192,
        env: { NODE_ENV: 'test' },
      });

      expect(config.codespaceId).toBe('custom-project');
      expect(config.memoryMb).toBe(8192);
      expect(config.env).toEqual({ NODE_ENV: 'test' });
    });
  });

  describe('createMockSandboxInfo', () => {
    it('creates info with sensible defaults', () => {
      const info = createMockSandboxInfo();

      expect(info.id).toBe('mock-sandbox-123');
      expect(info.codespaceId).toBe('mock-project-123');
      expect(info.containerId).toBe('mock-container-abc');
      expect(info.status).toBe('running');
      expect(info.image).toBe('node:20');
      expect(info.memoryMb).toBe(512);
      expect(info.cpuCores).toBe(1);
    });

    it('allows overriding any field', () => {
      const info = createMockSandboxInfo({
        status: 'stopped',
        memoryMb: 2048,
      });

      expect(info.status).toBe('stopped');
      expect(info.memoryMb).toBe(2048);
    });
  });

  describe('createMockExecResult', () => {
    it('creates success result by default', () => {
      const result = createMockExecResult();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('allows overriding any field', () => {
      const result = createMockExecResult({
        exitCode: 1,
        stdout: 'output',
        stderr: 'error message',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('output');
      expect(result.stderr).toBe('error message');
    });
  });
});
