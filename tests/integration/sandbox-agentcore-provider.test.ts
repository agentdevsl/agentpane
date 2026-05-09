/**
 * Integration tests for `agentcore-sandbox-provider.ts`.
 *
 * Ported from src/lib/sandbox/providers/__tests__/agentcore-sandbox-provider.test.ts
 * so the lines count toward the combined integration+functional coverage metric.
 * Mocks @aws-sdk/client-sts and the logger; no real AWS or network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/logging/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { mockStsSend } = vi.hoisted(() => ({ mockStsSend: vi.fn() }));

vi.mock('@aws-sdk/client-sts', () => {
  class MockSTSClient {
    send = mockStsSend;
  }
  return {
    STSClient: MockSTSClient,
    GetCallerIdentityCommand: class MockGetCallerIdentityCommand {},
  };
});

import { AgentCoreSandboxInstance } from '../../src/lib/sandbox/providers/agentcore-sandbox-instance';
import type { AgentCoreProviderConfig } from '../../src/lib/sandbox/providers/agentcore-sandbox-provider';
import {
  AgentCoreSandboxProvider,
  createAgentCoreProvider,
} from '../../src/lib/sandbox/providers/agentcore-sandbox-provider';

const testConfig: AgentCoreProviderConfig = {
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/test-runtime',
};

describe('AgentCoreSandboxProvider (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createProvider(
    overrides: Partial<AgentCoreProviderConfig> = {}
  ): AgentCoreSandboxProvider {
    return new AgentCoreSandboxProvider({ ...testConfig, ...overrides });
  }

  describe('constructor', () => {
    it('has provider name "agentcore"', () => {
      expect(createProvider().name).toBe('agentcore');
    });
    it('factory function returns an AgentCoreSandboxProvider', () => {
      const provider = createAgentCoreProvider(testConfig);
      expect(provider).toBeInstanceOf(AgentCoreSandboxProvider);
      expect(provider.name).toBe('agentcore');
    });
  });

  describe('create', () => {
    it('creates instances for projects', () => {
      const provider = createProvider();
      const instance = provider.create('proj-001', 'sandbox-001');
      expect(instance).toBeInstanceOf(AgentCoreSandboxInstance);
      expect(instance.codespaceId).toBe('proj-001');
      expect(instance.sandboxId).toBe('sandbox-001');
      expect(instance.runtimeArn).toBe(testConfig.runtimeArn);
    });

    it('returns existing instance if one already exists for project', () => {
      const provider = createProvider();
      const i1 = provider.create('proj-001', 'sandbox-001');
      const i2 = provider.create('proj-001', 'sandbox-002');
      expect(i2).toBe(i1);
      expect(i2.sandboxId).toBe('sandbox-001');
    });

    it('creates new instance if existing one is stopped', async () => {
      const provider = createProvider();
      const i1 = provider.create('proj-001', 'sandbox-001');
      await i1.stop();
      const i2 = provider.create('proj-001', 'sandbox-002');
      expect(i2).not.toBe(i1);
      expect(i2.sandboxId).toBe('sandbox-002');
    });

    it('creates separate instances for different projects', () => {
      const provider = createProvider();
      const i1 = provider.create('proj-001', 'sandbox-001');
      const i2 = provider.create('proj-002', 'sandbox-002');
      expect(i1).not.toBe(i2);
    });
  });

  describe('get', () => {
    it('retrieves existing instances', () => {
      const provider = createProvider();
      const created = provider.create('proj-001', 'sandbox-001');
      expect(provider.get('proj-001')).toBe(created);
    });
    it('returns null for nonexistent project', () => {
      expect(createProvider().get('nonexistent')).toBeNull();
    });
    it('returns null for stopped instances', async () => {
      const provider = createProvider();
      const instance = provider.create('proj-001', 'sandbox-001');
      await instance.stop();
      expect(provider.get('proj-001')).toBeNull();
    });
  });

  describe('getOrCreateSession', () => {
    it('creates unique session IDs per task', () => {
      const provider = createProvider();
      const s1 = provider.getOrCreateSession('proj-001', 'task-001');
      const s2 = provider.getOrCreateSession('proj-001', 'task-002');
      expect(s1).not.toBe(s2);
      expect(s1).toContain('proj-001');
      expect(s1).toContain('task-001');
      expect(s2).toContain('task-002');
    });
    it('reuses existing session for same task', () => {
      const provider = createProvider();
      const s1 = provider.getOrCreateSession('proj-001', 'task-001');
      const s2 = provider.getOrCreateSession('proj-001', 'task-001');
      expect(s2).toBe(s1);
    });
    it('formats session ID as codespaceId:taskId:timestamp', () => {
      const provider = createProvider();
      const session = provider.getOrCreateSession('proj-001', 'task-001');
      const parts = session.split(':');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('proj-001');
      expect(parts[1]).toBe('task-001');
      expect(Number(parts[2])).toBeGreaterThan(0);
    });
  });

  describe('getSession', () => {
    it('returns session for existing task', () => {
      const provider = createProvider();
      const created = provider.getOrCreateSession('proj-001', 'task-001');
      expect(provider.getSession('task-001')).toBe(created);
    });
    it('returns null for nonexistent task', () => {
      expect(createProvider().getSession('nonexistent')).toBeNull();
    });
  });

  describe('removeSession', () => {
    it('removes existing session and returns true', () => {
      const provider = createProvider();
      provider.getOrCreateSession('proj-001', 'task-001');
      expect(provider.removeSession('task-001')).toBe(true);
      expect(provider.getSession('task-001')).toBeNull();
    });
    it('returns false for nonexistent session', () => {
      expect(createProvider().removeSession('nonexistent')).toBe(false);
    });
  });

  describe('healthCheck', () => {
    it('returns healthy when STS succeeds', async () => {
      mockStsSend.mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/testuser',
      });
      const health = await createProvider().healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.details?.provider).toBe('agentcore');
      expect(health.details?.region).toBe('us-east-1');
      expect(health.details?.runtimeArn).toBe(testConfig.runtimeArn);
      expect(health.details?.awsAccount).toBe('123456789012');
    });

    it('returns unhealthy on STS failure', async () => {
      mockStsSend.mockRejectedValue(new Error('STS service unavailable'));
      const health = await createProvider().healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.message).toContain('STS');
    });

    it('detects expired credentials', async () => {
      const expired = new Error('Token has expired');
      Object.defineProperty(expired, 'name', {
        value: 'ExpiredTokenException',
        writable: true,
        enumerable: true,
        configurable: true,
      });
      mockStsSend.mockRejectedValue(expired);
      const health = await createProvider().healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.message).toContain('expired');
      expect(health.details?.errorType).toBe('expired_credentials');
    });

    it('detects invalid credentials', async () => {
      const invalid = new Error('The security token is not valid');
      Object.defineProperty(invalid, 'name', {
        value: 'InvalidClientTokenId',
        writable: true,
        enumerable: true,
        configurable: true,
      });
      mockStsSend.mockRejectedValue(invalid);
      const health = await createProvider().healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.message).toContain('invalid');
      expect(health.details?.errorType).toBe('invalid_credentials');
    });

    it('includes active instance and session counts in details', async () => {
      mockStsSend.mockResolvedValue({ Account: '111', Arn: 'arn:test' });
      const provider = createProvider();
      provider.create('proj-001', 'sandbox-001');
      provider.getOrCreateSession('proj-001', 'task-001');
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.details?.activeInstances).toBe(1);
      expect(health.details?.activeSessions).toBe(1);
    });
  });

  describe('cleanup', () => {
    it('cleans up all instances', async () => {
      const provider = createProvider();
      provider.create('proj-001', 'sandbox-001');
      provider.create('proj-002', 'sandbox-002');
      provider.getOrCreateSession('proj-001', 'task-001');
      const cleaned = await provider.cleanup();
      expect(cleaned).toBe(2);
      expect(provider.get('proj-001')).toBeNull();
      expect(provider.get('proj-002')).toBeNull();
      expect(provider.getSession('task-001')).toBeNull();
    });

    it('returns 0 when nothing to clean', async () => {
      expect(await createProvider().cleanup()).toBe(0);
    });

    it('stops each instance during cleanup', async () => {
      const provider = createProvider();
      const instance = provider.create('proj-001', 'sandbox-001');
      await provider.cleanup();
      expect(instance.status).toBe('stopped');
    });
  });

  describe('list', () => {
    it('returns empty list when no instances', () => {
      expect(createProvider().list()).toEqual([]);
    });

    it('lists all managed instances', () => {
      const provider = createProvider();
      provider.create('proj-001', 'sandbox-001');
      provider.create('proj-002', 'sandbox-002');
      const list = provider.list();
      expect(list).toHaveLength(2);
      expect(list.map((i) => i.codespaceId).sort()).toEqual(['proj-001', 'proj-002']);
    });

    it('includes correct info for each instance', () => {
      const provider = createProvider();
      provider.create('proj-001', 'sandbox-001');
      const list = provider.list();
      expect(list[0]).toMatchObject({
        sandboxId: 'sandbox-001',
        codespaceId: 'proj-001',
        runtimeArn: testConfig.runtimeArn,
        status: 'running',
      });
      expect(list[0]!.createdAt).toBeDefined();
      expect(typeof list[0]!.activeSessions).toBe('number');
    });

    it('counts active sessions for each instance', () => {
      const provider = createProvider();
      provider.create('proj-001', 'sandbox-001');
      provider.getOrCreateSession('proj-001', 'task-001');
      provider.getOrCreateSession('proj-001', 'task-002');
      const list = provider.list();
      expect(list[0]!.activeSessions).toBe(2);
    });
  });

  describe('invokeForTask', () => {
    it('creates instance and session if they do not exist', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          body: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          text: vi.fn(),
        })
      );
      const provider = createProvider();
      const events = [];
      for await (const event of provider.invokeForTask('proj-001', 'task-001', 'sandbox-001', {
        prompt: 'test',
      })) {
        events.push(event);
      }
      expect(provider.get('proj-001')).not.toBeNull();
      expect(provider.getSession('task-001')).not.toBeNull();
      vi.unstubAllGlobals();
    });

    it('reuses existing instance for same project', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          body: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          text: vi.fn(),
        })
      );
      const provider = createProvider();
      const existing = provider.create('proj-001', 'sandbox-001');
      for await (const _event of provider.invokeForTask('proj-001', 'task-001', 'sandbox-new', {
        prompt: 'test',
      })) {
        // no-op
      }
      expect(provider.get('proj-001')).toBe(existing);
      vi.unstubAllGlobals();
    });
  });
});
