import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('../../../logging/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-sts (used by healthCheck via dynamic import)
// ---------------------------------------------------------------------------

const { mockStsSend } = vi.hoisted(() => ({
  mockStsSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => {
  class MockSTSClient {
    send = mockStsSend;
  }
  return {
    STSClient: MockSTSClient,
    GetCallerIdentityCommand: class MockGetCallerIdentityCommand {},
  };
});

import { AgentCoreSandboxInstance } from '../agentcore-sandbox-instance.js';
// Import after mocks
import type { AgentCoreProviderConfig } from '../agentcore-sandbox-provider.js';
import {
  AgentCoreSandboxProvider,
  createAgentCoreProvider,
} from '../agentcore-sandbox-provider.js';

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const testConfig: AgentCoreProviderConfig = {
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/test-runtime',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentCoreSandboxProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console.log noise from info/debug logs
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

  // -------------------------------------------------------------------------
  // Constructor and factory
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('should have provider name "agentcore"', () => {
      const provider = createProvider();
      expect(provider.name).toBe('agentcore');
    });

    it('should be creatable via factory function', () => {
      const provider = createAgentCoreProvider(testConfig);
      expect(provider).toBeInstanceOf(AgentCoreSandboxProvider);
      expect(provider.name).toBe('agentcore');
    });
  });

  // -------------------------------------------------------------------------
  // Instance creation
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('should create instances for projects', () => {
      const provider = createProvider();
      const instance = provider.create('proj-001', 'sandbox-001');

      expect(instance).toBeInstanceOf(AgentCoreSandboxInstance);
      expect(instance.projectId).toBe('proj-001');
      expect(instance.sandboxId).toBe('sandbox-001');
      expect(instance.runtimeArn).toBe(testConfig.runtimeArn);
    });

    it('should return existing instance if one already exists for project', () => {
      const provider = createProvider();
      const instance1 = provider.create('proj-001', 'sandbox-001');
      const instance2 = provider.create('proj-001', 'sandbox-002');

      // Same instance returned (not a new one)
      expect(instance2).toBe(instance1);
      expect(instance2.sandboxId).toBe('sandbox-001'); // original sandboxId preserved
    });

    it('should create new instance if existing one is stopped', async () => {
      const provider = createProvider();
      const instance1 = provider.create('proj-001', 'sandbox-001');
      await instance1.stop();

      const instance2 = provider.create('proj-001', 'sandbox-002');

      expect(instance2).not.toBe(instance1);
      expect(instance2.sandboxId).toBe('sandbox-002');
    });

    it('should create separate instances for different projects', () => {
      const provider = createProvider();
      const instance1 = provider.create('proj-001', 'sandbox-001');
      const instance2 = provider.create('proj-002', 'sandbox-002');

      expect(instance1).not.toBe(instance2);
      expect(instance1.projectId).toBe('proj-001');
      expect(instance2.projectId).toBe('proj-002');
    });
  });

  // -------------------------------------------------------------------------
  // Instance retrieval
  // -------------------------------------------------------------------------

  describe('get', () => {
    it('should retrieve existing instances', () => {
      const provider = createProvider();
      const created = provider.create('proj-001', 'sandbox-001');
      const retrieved = provider.get('proj-001');

      expect(retrieved).toBe(created);
    });

    it('should return null for nonexistent project', () => {
      const provider = createProvider();
      const result = provider.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should return null for stopped instances', async () => {
      const provider = createProvider();
      const instance = provider.create('proj-001', 'sandbox-001');
      await instance.stop();

      const result = provider.get('proj-001');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  describe('getOrCreateSession', () => {
    it('should create unique session IDs per task', () => {
      const provider = createProvider();
      const session1 = provider.getOrCreateSession('proj-001', 'task-001');
      const session2 = provider.getOrCreateSession('proj-001', 'task-002');

      expect(session1).not.toBe(session2);
      expect(session1).toContain('proj-001');
      expect(session1).toContain('task-001');
      expect(session2).toContain('task-002');
    });

    it('should reuse existing session for same task', () => {
      const provider = createProvider();
      const session1 = provider.getOrCreateSession('proj-001', 'task-001');
      const session2 = provider.getOrCreateSession('proj-001', 'task-001');

      expect(session2).toBe(session1);
    });

    it('should format session ID as projectId:taskId:timestamp', () => {
      const provider = createProvider();
      const session = provider.getOrCreateSession('proj-001', 'task-001');

      // Format: {projectId}:{taskId}:{timestamp}
      const parts = session.split(':');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('proj-001');
      expect(parts[1]).toBe('task-001');
      expect(Number(parts[2])).toBeGreaterThan(0);
    });
  });

  describe('getSession', () => {
    it('should return session for existing task', () => {
      const provider = createProvider();
      const created = provider.getOrCreateSession('proj-001', 'task-001');
      const retrieved = provider.getSession('task-001');

      expect(retrieved).toBe(created);
    });

    it('should return null for nonexistent task', () => {
      const provider = createProvider();
      expect(provider.getSession('nonexistent')).toBeNull();
    });
  });

  describe('removeSession', () => {
    it('should remove existing session and return true', () => {
      const provider = createProvider();
      provider.getOrCreateSession('proj-001', 'task-001');

      const result = provider.removeSession('task-001');
      expect(result).toBe(true);
      expect(provider.getSession('task-001')).toBeNull();
    });

    it('should return false for nonexistent session', () => {
      const provider = createProvider();
      const result = provider.removeSession('nonexistent');
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------------

  describe('healthCheck', () => {
    it('should return healthy when STS succeeds', async () => {
      mockStsSend.mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/testuser',
      });

      const provider = createProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.details?.provider).toBe('agentcore');
      expect(health.details?.region).toBe('us-east-1');
      expect(health.details?.runtimeArn).toBe(testConfig.runtimeArn);
      expect(health.details?.awsAccount).toBe('123456789012');
    });

    it('should return unhealthy on STS failure', async () => {
      mockStsSend.mockRejectedValue(new Error('STS service unavailable'));

      const provider = createProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('STS');
    });

    it('should detect expired credentials', async () => {
      const expiredError = new Error('Token has expired');
      Object.defineProperty(expiredError, 'name', {
        value: 'ExpiredTokenException',
        writable: true,
        enumerable: true,
        configurable: true,
      });

      mockStsSend.mockRejectedValue(expiredError);

      const provider = createProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('expired');
      expect(health.details?.errorType).toBe('expired_credentials');
    });

    it('should detect invalid credentials', async () => {
      const invalidError = new Error('The security token is not valid');
      Object.defineProperty(invalidError, 'name', {
        value: 'InvalidClientTokenId',
        writable: true,
        enumerable: true,
        configurable: true,
      });

      mockStsSend.mockRejectedValue(invalidError);

      const provider = createProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('invalid');
      expect(health.details?.errorType).toBe('invalid_credentials');
    });

    it('should include active instance and session counts in details', async () => {
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

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe('cleanup', () => {
    it('should clean up all instances', async () => {
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

    it('should return 0 when nothing to clean', async () => {
      const provider = createProvider();
      const cleaned = await provider.cleanup();
      expect(cleaned).toBe(0);
    });

    it('should stop each instance during cleanup', async () => {
      const provider = createProvider();
      const instance = provider.create('proj-001', 'sandbox-001');

      await provider.cleanup();

      expect(instance.status).toBe('stopped');
    });
  });

  // -------------------------------------------------------------------------
  // List instances
  // -------------------------------------------------------------------------

  describe('list', () => {
    it('should return empty list when no instances', () => {
      const provider = createProvider();
      const list = provider.list();
      expect(list).toEqual([]);
    });

    it('should list all managed instances', () => {
      const provider = createProvider();
      provider.create('proj-001', 'sandbox-001');
      provider.create('proj-002', 'sandbox-002');

      const list = provider.list();

      expect(list).toHaveLength(2);
      expect(list.map((i) => i.projectId).sort()).toEqual(['proj-001', 'proj-002']);
    });

    it('should include correct info for each instance', () => {
      const provider = createProvider();
      provider.create('proj-001', 'sandbox-001');

      const list = provider.list();

      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        sandboxId: 'sandbox-001',
        projectId: 'proj-001',
        runtimeArn: testConfig.runtimeArn,
        status: 'running',
      });
      expect(list[0]!.createdAt).toBeDefined();
      expect(typeof list[0]!.activeSessions).toBe('number');
    });

    it('should count active sessions for each instance', () => {
      const provider = createProvider();
      provider.create('proj-001', 'sandbox-001');
      provider.getOrCreateSession('proj-001', 'task-001');
      provider.getOrCreateSession('proj-001', 'task-002');

      const list = provider.list();

      expect(list).toHaveLength(1);
      expect(list[0]!.activeSessions).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // invokeForTask
  // -------------------------------------------------------------------------

  describe('invokeForTask', () => {
    it('should create instance and session if they do not exist', async () => {
      // Mock fetch for the invoke call
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          text: vi.fn(),
        })
      );

      const provider = createProvider();

      // Consume the generator
      const events = [];
      for await (const event of provider.invokeForTask('proj-001', 'task-001', 'sandbox-001', {
        prompt: 'test',
      })) {
        events.push(event);
      }

      // Should have created instance and session
      expect(provider.get('proj-001')).not.toBeNull();
      expect(provider.getSession('task-001')).not.toBeNull();

      vi.unstubAllGlobals();
    });

    it('should reuse existing instance for same project', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          text: vi.fn(),
        })
      );

      const provider = createProvider();
      const existingInstance = provider.create('proj-001', 'sandbox-001');

      for await (const _event of provider.invokeForTask('proj-001', 'task-001', 'sandbox-new', {
        prompt: 'test',
      })) {
        // no-op
      }

      // Should have reused the existing instance
      const retrieved = provider.get('proj-001');
      expect(retrieved).toBe(existingInstance);

      vi.unstubAllGlobals();
    });
  });
});
