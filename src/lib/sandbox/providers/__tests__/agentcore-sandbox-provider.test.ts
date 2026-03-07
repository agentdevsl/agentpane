import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '../../types.js';

// --- Mock AWS SDK clients ---

const mockControlClientSend = vi.fn();
const mockDataClientSend = vi.fn();
const mockEcrClientSend = vi.fn();
const mockStsClientSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => {
  class MockCreateAgentRuntimeCommand {
    _type = 'CreateAgentRuntime';
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class MockDeleteAgentRuntimeCommand {
    _type = 'DeleteAgentRuntime';
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class MockGetAgentRuntimeCommand {
    _type = 'GetAgentRuntime';
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class MockListAgentRuntimesCommand {
    _type = 'ListAgentRuntimes';
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    BedrockAgentCoreControlClient: class {
      send = mockControlClientSend;
    },
    CreateAgentRuntimeCommand: MockCreateAgentRuntimeCommand,
    DeleteAgentRuntimeCommand: MockDeleteAgentRuntimeCommand,
    GetAgentRuntimeCommand: MockGetAgentRuntimeCommand,
    ListAgentRuntimesCommand: MockListAgentRuntimesCommand,
  };
});

vi.mock('@aws-sdk/client-bedrock-agentcore', () => {
  class MockInvokeAgentRuntimeCommand {
    _type = 'InvokeAgentRuntime';
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    BedrockAgentCoreClient: class {
      send = mockDataClientSend;
    },
    InvokeAgentRuntimeCommand: MockInvokeAgentRuntimeCommand,
  };
});

vi.mock('@aws-sdk/client-ecr', () => {
  class MockDescribeImagesCommand {
    _type = 'DescribeImages';
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class MockGetAuthorizationTokenCommand {
    _type = 'GetAuthorizationToken';
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    ECRClient: class {
      send = mockEcrClientSend;
    },
    DescribeImagesCommand: MockDescribeImagesCommand,
    GetAuthorizationTokenCommand: MockGetAuthorizationTokenCommand,
  };
});

vi.mock('@aws-sdk/client-sts', () => {
  class MockGetCallerIdentityCommand {
    _type = 'GetCallerIdentity';
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    STSClient: class {
      send = mockStsClientSend;
    },
    GetCallerIdentityCommand: MockGetCallerIdentityCommand,
  };
});

// Mock cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid-12345678'),
}));

// Import after mocks
import { AgentCoreSandboxInstance, mapAgentCoreStatus } from '../agentcore-sandbox-instance.js';
import {
  AgentCoreSandboxProvider,
  createAgentCoreSandboxProvider,
} from '../agentcore-sandbox-provider.js';

describe('AgentCoreSandboxProvider', () => {
  const sampleConfig: SandboxConfig = {
    projectId: 'proj-123',
    projectPath: '/home/user/project',
    image: 'srlynch1/agent-sandbox:latest',
    memoryMb: 4096,
    cpuCores: 2,
    idleTimeoutMinutes: 30,
    volumeMounts: [],
    env: { NODE_ENV: 'development' },
  };

  const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-abc123';
  const _runtimeId = 'rt-abc123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock: CreateAgentRuntime returns an ARN
    mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'CreateAgentRuntime') {
        return Promise.resolve({ agentRuntimeArn: runtimeArn });
      }
      if (cmd._type === 'GetAgentRuntime') {
        return Promise.resolve({ status: 'READY' });
      }
      if (cmd._type === 'ListAgentRuntimes') {
        return Promise.resolve({ agentRuntimes: [] });
      }
      if (cmd._type === 'DeleteAgentRuntime') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createProvider = (options: Record<string, unknown> = {}) => {
    return new AgentCoreSandboxProvider({
      roleArn: 'arn:aws:iam::123456789012:role/test-role',
      ...options,
    });
  };

  describe('constructor', () => {
    it('creates provider with default options', () => {
      const provider = createProvider();
      expect(provider.name).toBe('agentcore');
    });

    it('creates provider with custom credentials and region', () => {
      const provider = createProvider({
        awsAccessKeyId: 'AKIA_TEST',
        awsSecretAccessKey: 'secret-key',
        awsRegion: 'us-west-2',
      });
      expect(provider.name).toBe('agentcore');
    });

    it('creates provider via factory function', () => {
      const provider = createAgentCoreSandboxProvider({
        awsRegion: 'eu-west-1',
      });
      expect(provider.name).toBe('agentcore');
    });
  });

  describe('create', () => {
    it('creates sandbox, polls until READY, returns AgentCoreSandboxInstance', async () => {
      const provider = createProvider();

      const sandbox = await provider.create(sampleConfig);

      expect(sandbox).toBeInstanceOf(AgentCoreSandboxInstance);
      expect(sandbox.id).toBeDefined();
      expect(sandbox.projectId).toBe('proj-123');
      expect(sandbox.status).toBe('running');
    });

    it('calls CreateAgentRuntimeCommand and GetAgentRuntimeCommand', async () => {
      const provider = createProvider();

      await provider.create(sampleConfig);

      const createCalls = mockControlClientSend.mock.calls.filter(
        ([cmd]: [{ _type?: string }]) => cmd._type === 'CreateAgentRuntime'
      );
      expect(createCalls.length).toBe(1);

      // GetAgentRuntime is called for polling + verify + refreshStatus
      const getCalls = mockControlClientSend.mock.calls.filter(
        ([cmd]: [{ _type?: string }]) => cmd._type === 'GetAgentRuntime'
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('throws RUNTIME_ALREADY_EXISTS when sandbox already exists for project', async () => {
      const provider = createProvider();

      await provider.create(sampleConfig);

      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'AGENTCORE-105',
      });
    });

    it('throws RUNTIME_CREATION_FAILED when no ARN is returned', async () => {
      const provider = createProvider();

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'CreateAgentRuntime') {
          return Promise.resolve({ agentRuntimeArn: undefined });
        }
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({ agentRuntimes: [] });
        }
        return Promise.resolve({});
      });

      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'AGENTCORE-101',
      });
    });

    it('throws RUNTIME_CREATION_FAILED when runtime reaches CREATE_FAILED state', async () => {
      const provider = createProvider();
      let callCount = 0;

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'CreateAgentRuntime') {
          return Promise.resolve({ agentRuntimeArn: runtimeArn });
        }
        if (cmd._type === 'GetAgentRuntime') {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              status: 'CREATE_FAILED',
              failureReason: 'Insufficient capacity',
            });
          }
          return Promise.resolve({ status: 'CREATE_FAILED' });
        }
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({ agentRuntimes: [] });
        }
        if (cmd._type === 'DeleteAgentRuntime') {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'AGENTCORE-101',
      });
    });

    it('emits sandbox:creating, sandbox:created, and sandbox:started events', async () => {
      const provider = createProvider();
      const events: { type: string }[] = [];

      provider.on((event) => {
        events.push(event);
      });

      await provider.create(sampleConfig);

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('sandbox:creating');
      expect(eventTypes).toContain('sandbox:created');
      expect(eventTypes).toContain('sandbox:started');
    });

    it('emits sandbox:error on failure', async () => {
      const provider = createProvider();
      const events: { type: string }[] = [];

      provider.on((event) => {
        events.push(event);
      });

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'CreateAgentRuntime') {
          return Promise.reject(new Error('API error'));
        }
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({ agentRuntimes: [] });
        }
        return Promise.resolve({});
      });

      await expect(provider.create(sampleConfig)).rejects.toThrow();

      expect(events.map((e) => e.type)).toContain('sandbox:error');
    });

    it('handles registration failure gracefully', async () => {
      const provider = createProvider();

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'CreateAgentRuntime') {
          return Promise.reject(new Error('AgentCore API error'));
        }
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({ agentRuntimes: [] });
        }
        return Promise.resolve({});
      });

      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'AGENTCORE-101',
      });
    });

    it('throws RUNTIME_STARTUP_TIMEOUT when runtime never reaches READY', async () => {
      const provider = new AgentCoreSandboxProvider({
        roleArn: 'arn:aws:iam::123456789012:role/test-role',
        readyTimeoutSeconds: 0, // immediate timeout
      });

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'CreateAgentRuntime') {
          return Promise.resolve({ agentRuntimeArn: runtimeArn });
        }
        if (cmd._type === 'GetAgentRuntime') {
          return Promise.resolve({ status: 'CREATING' }); // never becomes READY
        }
        if (cmd._type === 'DeleteAgentRuntime') return Promise.resolve({});
        if (cmd._type === 'ListAgentRuntimes') return Promise.resolve({ agentRuntimes: [] });
        return Promise.resolve({});
      });

      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'AGENTCORE-102',
      });
    });

    it('throws RUNTIME_CREATION_FAILED when roleArn is not provided', async () => {
      const provider = new AgentCoreSandboxProvider({}); // no roleArn
      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'AGENTCORE-101',
        message: expect.stringContaining('roleArn'),
      });
    });

    it('throws RUNTIME_CREATION_FAILED when roleArn is empty string', async () => {
      const provider = new AgentCoreSandboxProvider({ roleArn: '  ' });
      await expect(provider.create(sampleConfig)).rejects.toMatchObject({
        code: 'AGENTCORE-101',
        message: expect.stringContaining('roleArn'),
      });
    });
  });

  describe('get', () => {
    it('returns cached sandbox for existing project', async () => {
      const provider = createProvider();

      const created = await provider.create(sampleConfig);
      const retrieved = await provider.get(sampleConfig.projectId);

      expect(retrieved).toBe(created);
    });

    it('returns null when no sandbox exists for project', async () => {
      const provider = createProvider();

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({ agentRuntimes: [] });
        }
        return Promise.resolve({});
      });

      const result = await provider.get('nonexistent');
      expect(result).toBeNull();
    });

    it('falls back to API query when not cached', async () => {
      const provider = createProvider();

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({
            agentRuntimes: [
              {
                agentRuntimeName: 'agentpane-proj-456-abcdef',
                agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-456',
                agentRuntimeId: 'rt-456',
                status: 'READY',
                lastUpdatedAt: new Date(),
              },
            ],
          });
        }
        if (cmd._type === 'GetAgentRuntime') {
          return Promise.resolve({ status: 'READY' });
        }
        return Promise.resolve({});
      });

      const result = await provider.get('proj-456');
      expect(result).toBeInstanceOf(AgentCoreSandboxInstance);
    });

    it('returns null on ResourceNotFoundException', async () => {
      const provider = createProvider();
      const notFoundErr = new Error('Runtime not found');
      notFoundErr.name = 'ResourceNotFoundException';

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.reject(notFoundErr);
        }
        return Promise.resolve({});
      });

      const result = await provider.get('proj-456');
      expect(result).toBeNull();
    });

    it('throws on non-NotFound API errors', async () => {
      const provider = createProvider();

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.reject(new Error('network error'));
        }
        return Promise.resolve({});
      });

      await expect(provider.get('proj-456')).rejects.toThrow('network error');
    });

    it('follows pagination tokens when querying API', async () => {
      const provider = createProvider();
      let listCallCount = 0;

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'ListAgentRuntimes') {
          listCallCount++;
          if (listCallCount === 1) {
            return Promise.resolve({
              agentRuntimes: [{ agentRuntimeName: 'unrelated-runtime', status: 'READY' }],
              nextToken: 'page-2-token',
            });
          }
          return Promise.resolve({
            agentRuntimes: [
              {
                agentRuntimeName: 'agentpane-proj-paged-abcdef12',
                agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-paged',
                agentRuntimeId: 'rt-paged',
                status: 'READY',
              },
            ],
          });
        }
        if (cmd._type === 'GetAgentRuntime') return Promise.resolve({ status: 'READY' });
        return Promise.resolve({});
      });

      const result = await provider.get('proj-paged');
      expect(result).toBeInstanceOf(AgentCoreSandboxInstance);
      expect(listCallCount).toBe(2);
    });
  });

  describe('getById', () => {
    it('returns null for nonexistent sandbox', async () => {
      const provider = createProvider();
      const result = await provider.getById('nonexistent');
      expect(result).toBeNull();
    });

    it('returns sandbox by id', async () => {
      const provider = createProvider();

      const created = await provider.create(sampleConfig);
      const retrieved = await provider.getById(created.id);

      expect(retrieved).toBe(created);
    });

    it('returns null when sandbox status becomes stopped after refresh', async () => {
      const provider = createProvider();

      const created = await provider.create(sampleConfig);

      // Simulate runtime becoming not found
      const notFoundErr = new Error('not found');
      notFoundErr.name = 'ResourceNotFoundException';
      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'GetAgentRuntime') {
          return Promise.reject(notFoundErr);
        }
        return Promise.resolve({});
      });

      const retrieved = await provider.getById(created.id);
      expect(retrieved).toBeNull();
    });
  });

  describe('list', () => {
    it('returns empty list when no sandboxes', async () => {
      const provider = createProvider();

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({ agentRuntimes: [] });
        }
        return Promise.resolve({});
      });

      const list = await provider.list();
      expect(list).toEqual([]);
    });

    it('returns mapped sandbox info from AgentCore runtimes', async () => {
      const provider = createProvider();

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({
            agentRuntimes: [
              {
                agentRuntimeName: 'agentpane-proj-1-abc',
                agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1',
                agentRuntimeId: 'rt-1',
                status: 'READY',
                lastUpdatedAt: new Date('2026-01-01T00:00:00Z'),
              },
              {
                agentRuntimeName: 'agentpane-proj-2-def',
                agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-2',
                agentRuntimeId: 'rt-2',
                status: 'CREATING',
                lastUpdatedAt: new Date('2026-01-02T00:00:00Z'),
              },
              {
                agentRuntimeName: 'agentpane-proj-3-ghi',
                agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-3',
                agentRuntimeId: 'rt-3',
                status: 'CREATE_FAILED',
                lastUpdatedAt: new Date('2026-01-03T00:00:00Z'),
              },
            ],
          });
        }
        return Promise.resolve({});
      });

      const list = await provider.list();

      expect(list).toHaveLength(3);
      expect(list[0]).toMatchObject({
        status: 'running',
      });
      expect(list[1]).toMatchObject({
        status: 'creating',
      });
      expect(list[2]).toMatchObject({
        status: 'error',
      });
    });

    it('filters out runtimes without agentpane- prefix', async () => {
      const provider = createProvider();

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({
            agentRuntimes: [
              {
                agentRuntimeName: 'agentpane-proj-1-abc',
                agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1',
                agentRuntimeId: 'rt-1',
                status: 'READY',
                lastUpdatedAt: new Date(),
              },
              {
                agentRuntimeName: 'unrelated-runtime',
                agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-other',
                agentRuntimeId: 'rt-other',
                status: 'READY',
                lastUpdatedAt: new Date(),
              },
            ],
          });
        }
        return Promise.resolve({});
      });

      const list = await provider.list();
      expect(list).toHaveLength(1);
    });

    it('throws on API error', async () => {
      const provider = createProvider();

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.reject(new Error('API error'));
        }
        return Promise.resolve({});
      });

      await expect(provider.list()).rejects.toThrow('API error');
    });
  });

  describe('healthCheck', () => {
    it('returns healthy when AWS credentials and AgentCore API are accessible', async () => {
      const provider = createProvider();

      mockStsClientSend.mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      });

      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({ agentRuntimes: [] });
        }
        return Promise.resolve({});
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.details?.provider).toBe('agentcore');
      expect(health.details?.accountId).toBe('123456789012');
      expect(health.details?.apiAccessible).toBe(true);
    });

    it('returns unhealthy when STS call fails with AccessDeniedException', async () => {
      const provider = createProvider();
      const accessDenied = new Error('Access denied');
      accessDenied.name = 'AccessDeniedException';
      mockStsClientSend.mockRejectedValue(accessDenied);

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('Access denied');
      expect(health.details?.errorName).toBe('AccessDeniedException');
    });

    it('returns unhealthy when credentials are expired', async () => {
      const provider = createProvider();
      const expired = new Error('Token expired');
      expired.name = 'ExpiredTokenException';
      mockStsClientSend.mockRejectedValue(expired);

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('Token expired');
    });

    it('returns unhealthy on networking error', async () => {
      const provider = createProvider();
      const networkErr = new Error('Network timeout');
      networkErr.name = 'NetworkingError';
      mockStsClientSend.mockRejectedValue(networkErr);

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('Network timeout');
    });

    it('throws on unknown errors (programming errors)', async () => {
      const provider = createProvider();
      mockStsClientSend.mockRejectedValue(new TypeError('Cannot read properties of null'));

      await expect(provider.healthCheck()).rejects.toThrow('Cannot read properties of null');
    });
  });

  describe('cleanup', () => {
    it('returns 0 when nothing to clean', async () => {
      const provider = createProvider();
      const cleaned = await provider.cleanup();
      expect(cleaned).toBe(0);
    });

    it('cleans up stopped sandboxes', async () => {
      const provider = createProvider();

      const sandbox = await provider.create(sampleConfig);

      // Stop the sandbox via data client
      mockDataClientSend.mockResolvedValue({});
      await sandbox.stop();

      const cleaned = await provider.cleanup();
      expect(cleaned).toBe(1);
    });

    it('respects olderThan filter', async () => {
      const provider = createProvider();

      const sandbox = await provider.create(sampleConfig);
      mockDataClientSend.mockResolvedValue({});
      await sandbox.stop();

      // Future date should match
      const futureDate = new Date(Date.now() + 10000);
      const cleaned = await provider.cleanup({ olderThan: futureDate });
      expect(cleaned).toBe(1);
    });
  });

  describe('events', () => {
    it('on() adds listener and returns unsubscribe function', () => {
      const provider = createProvider();
      const listener = vi.fn();

      const unsubscribe = provider.on(listener);
      expect(typeof unsubscribe).toBe('function');

      unsubscribe();
    });

    it('off() removes listener', async () => {
      const provider = createProvider();
      const listener = vi.fn();

      provider.on(listener);
      provider.off(listener);

      await provider.create(sampleConfig);

      expect(listener).not.toHaveBeenCalled();
    });

    it('handles listener errors gracefully', async () => {
      const provider = createProvider();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      provider.on(() => {
        throw new Error('listener error');
      });

      // Should not throw despite listener error
      await provider.create(sampleConfig);

      errorSpy.mockRestore();
    });
  });

  describe('validateSandboxes', () => {
    it('evicts sandboxes that become stopped after status refresh', async () => {
      const provider = createProvider();
      await provider.create(sampleConfig);

      // Simulate the runtime being deleted — refreshStatus will set status to 'stopped'
      const notFoundErr = new Error('not found');
      notFoundErr.name = 'ResourceNotFoundException';
      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'GetAgentRuntime') {
          return Promise.reject(notFoundErr);
        }
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({ agentRuntimes: [] });
        }
        return Promise.resolve({});
      });

      await provider.validateSandboxes();

      // Reset mocks for a fresh create
      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'CreateAgentRuntime') {
          return Promise.resolve({ agentRuntimeArn: runtimeArn });
        }
        if (cmd._type === 'GetAgentRuntime') {
          return Promise.resolve({ status: 'READY' });
        }
        if (cmd._type === 'ListAgentRuntimes') {
          return Promise.resolve({ agentRuntimes: [] });
        }
        return Promise.resolve({});
      });

      // This should not throw RUNTIME_ALREADY_EXISTS
      await expect(provider.create(sampleConfig)).resolves.toBeDefined();
    });
  });
});

describe('AgentCoreSandboxInstance', () => {
  let instance: AgentCoreSandboxInstance;

  const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-abc123';
  const runtimeId = 'rt-abc123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: GetAgentRuntime returns READY
    mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'GetAgentRuntime') {
        return Promise.resolve({ status: 'READY' });
      }
      return Promise.resolve({});
    });

    instance = new AgentCoreSandboxInstance(
      'sandbox-id-1',
      runtimeArn,
      runtimeId,
      'proj-123',
      { send: mockControlClientSend } as never,
      { send: mockDataClientSend } as never
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Helper to transition instance to 'running' via refreshStatus */
  async function setRunning() {
    mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'GetAgentRuntime') {
        return Promise.resolve({ status: 'READY' });
      }
      return Promise.resolve({});
    });
    await instance.refreshStatus();
  }

  describe('properties', () => {
    it('has correct id', () => {
      expect(instance.id).toBe('sandbox-id-1');
    });

    it('has correct projectId', () => {
      expect(instance.projectId).toBe('proj-123');
    });

    it('containerId returns runtimeArn', () => {
      expect(instance.containerId).toBe(runtimeArn);
    });

    it('initial status is creating', () => {
      expect(instance.status).toBe('creating');
    });
  });

  describe('exec', () => {
    it('invokes runtime with exec payload and returns result', async () => {
      await setRunning();

      mockDataClientSend.mockResolvedValue({
        response: {
          transformToByteArray: () =>
            Promise.resolve(
              new TextEncoder().encode(
                JSON.stringify({
                  exitCode: 0,
                  stdout: 'hello world\n',
                  stderr: '',
                })
              )
            ),
        },
      });

      const result = await instance.exec('echo', ['hello', 'world']);

      expect(result).toEqual({
        exitCode: 0,
        stdout: 'hello world',
        stderr: '',
      });

      expect(mockDataClientSend).toHaveBeenCalledTimes(1);
    });

    it('throws when sandbox not in running state (assertRunning)', async () => {
      // Instance is in 'creating' state by default
      await expect(instance.exec('ls')).rejects.toMatchObject({
        code: 'AGENTCORE-104',
      });
    });

    it('throws INVOCATION_FAILED on API error', async () => {
      await setRunning();
      mockDataClientSend.mockRejectedValue(new Error('connection reset'));

      await expect(instance.exec('ls')).rejects.toMatchObject({
        code: 'AGENTCORE-300',
      });
    });

    it('throws INVOCATION_THROTTLED on ThrottlingException', async () => {
      await setRunning();
      const throttleErr = new Error('Too many requests');
      throttleErr.name = 'ThrottlingException';
      mockDataClientSend.mockRejectedValue(throttleErr);

      await expect(instance.exec('ls')).rejects.toMatchObject({
        code: 'AGENTCORE-302',
      });
    });

    it('trims stdout and stderr', async () => {
      await setRunning();
      mockDataClientSend.mockResolvedValue({
        response: {
          transformToByteArray: () =>
            Promise.resolve(
              new TextEncoder().encode(
                JSON.stringify({
                  exitCode: 0,
                  stdout: '  trimmed  \n',
                  stderr: '  warn  \n',
                })
              )
            ),
        },
      });

      const result = await instance.exec('test');
      expect(result.stdout).toBe('trimmed');
      expect(result.stderr).toBe('warn');
    });
  });

  describe('execAsRoot', () => {
    it('throws INVOCATION_FAILED because root execution is not supported', async () => {
      await expect(instance.execAsRoot('apt', ['install', '-y', 'curl'])).rejects.toMatchObject({
        code: 'AGENTCORE-300',
        message: expect.stringContaining('Root execution is not supported'),
      });

      expect(mockDataClientSend).not.toHaveBeenCalled();
    });
  });

  describe('getStatus / refreshStatus', () => {
    it('returns mapped status from runtime state', async () => {
      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'GetAgentRuntime') {
          return Promise.resolve({ status: 'READY' });
        }
        return Promise.resolve({});
      });

      await instance.refreshStatus();
      expect(instance.status).toBe('running');
    });

    it('updates internal status from AgentCore runtime state', async () => {
      // First refresh: READY -> running
      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'GetAgentRuntime') {
          return Promise.resolve({ status: 'READY' });
        }
        return Promise.resolve({});
      });
      await instance.refreshStatus();
      expect(instance.status).toBe('running');

      // Second refresh: CREATING -> creating
      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'GetAgentRuntime') {
          return Promise.resolve({ status: 'CREATING' });
        }
        return Promise.resolve({});
      });
      await instance.refreshStatus();
      expect(instance.status).toBe('creating');
    });

    it('sets status to error on API error', async () => {
      mockControlClientSend.mockRejectedValue(new Error('API timeout'));

      await instance.refreshStatus();
      expect(instance.status).toBe('error');
    });

    it('sets status to stopped when runtime not found (ResourceNotFoundException)', async () => {
      const notFound = new Error('not found');
      notFound.name = 'ResourceNotFoundException';
      mockControlClientSend.mockRejectedValue(notFound);

      await instance.refreshStatus();
      expect(instance.status).toBe('stopped');
    });

    it('maps CREATE_FAILED to error', async () => {
      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'GetAgentRuntime') {
          return Promise.resolve({ status: 'CREATE_FAILED' });
        }
        return Promise.resolve({});
      });

      await instance.refreshStatus();
      expect(instance.status).toBe('error');
    });

    it('maps DELETING to stopping', async () => {
      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'GetAgentRuntime') {
          return Promise.resolve({ status: 'DELETING' });
        }
        return Promise.resolve({});
      });

      await instance.refreshStatus();
      expect(instance.status).toBe('stopping');
    });
  });

  describe('getMetrics', () => {
    it('returns metrics with uptime', async () => {
      mockControlClientSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'GetAgentRuntime') {
          return Promise.resolve({ status: 'READY' });
        }
        return Promise.resolve({});
      });

      const metrics = await instance.getMetrics();

      expect(metrics).toHaveProperty('cpuUsagePercent');
      expect(metrics).toHaveProperty('memoryUsageMb');
      expect(metrics).toHaveProperty('uptime');
      expect(metrics.cpuUsagePercent).toBe(0);
      expect(metrics.memoryUsageMb).toBe(0);
    });

    it('throws INTERNAL_ERROR on API error', async () => {
      mockControlClientSend.mockRejectedValue(new Error('not found'));

      await expect(instance.getMetrics()).rejects.toMatchObject({
        code: 'AGENTCORE-701',
      });
    });
  });

  describe('stop', () => {
    it('stops the sandbox via data plane invocation', async () => {
      mockDataClientSend.mockResolvedValue({});

      await instance.stop();

      expect(instance.status).toBe('stopped');
      expect(mockDataClientSend).toHaveBeenCalledTimes(1);
    });

    it('sets status to error on failure', async () => {
      mockDataClientSend.mockRejectedValue(new Error('stop failed'));

      await expect(instance.stop()).rejects.toMatchObject({
        code: 'AGENTCORE-300',
      });
      expect(instance.status).toBe('error');
    });
  });

  describe('activity tracking', () => {
    it('touch updates last activity time', async () => {
      const before = instance.getLastActivity();
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.touch();
      const after = instance.getLastActivity();

      expect(after.getTime()).toBeGreaterThan(before.getTime());
    });

    it('getLastActivity returns Date', () => {
      expect(instance.getLastActivity()).toBeInstanceOf(Date);
    });
  });

  describe('tmux session methods', () => {
    /** Helper to mock exec calls via the data client */
    function mockExec(response: { exitCode: number; stdout: string; stderr: string }) {
      mockDataClientSend.mockResolvedValue({
        response: {
          transformToByteArray: () =>
            Promise.resolve(new TextEncoder().encode(JSON.stringify(response))),
        },
      });
    }

    /** Helper to mock exec to throw with a specific message */
    function mockExecThrow(message: string) {
      mockDataClientSend.mockRejectedValue(new Error(message));
    }

    describe('createTmuxSession', () => {
      it('creates a tmux session (happy path)', async () => {
        await setRunning();

        // First call: list-sessions (no existing sessions)
        // Second call: new-session (success)
        let callCount = 0;
        mockDataClientSend.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // list-sessions returns empty
            return Promise.resolve({
              response: {
                transformToByteArray: () =>
                  Promise.resolve(
                    new TextEncoder().encode(
                      JSON.stringify({
                        exitCode: 0,
                        stdout: '',
                        stderr: '',
                      })
                    )
                  ),
              },
            });
          }
          // new-session succeeds
          return Promise.resolve({
            response: {
              transformToByteArray: () =>
                Promise.resolve(
                  new TextEncoder().encode(
                    JSON.stringify({
                      exitCode: 0,
                      stdout: '',
                      stderr: '',
                    })
                  )
                ),
            },
          });
        });

        const session = await instance.createTmuxSession('my-session', 'task-1');

        expect(session.name).toBe('my-session');
        expect(session.sandboxId).toBe('sandbox-id-1');
        expect(session.taskId).toBe('task-1');
        expect(session.windowCount).toBe(1);
        expect(session.attached).toBe(false);
      });

      it('throws when session already exists', async () => {
        await setRunning();

        // list-sessions returns the session name
        mockExec({ exitCode: 0, stdout: 'my-session', stderr: '' });

        await expect(instance.createTmuxSession('my-session')).rejects.toMatchObject({
          code: 'AGENTCORE-300',
        });
      });

      it('handles "no server running" gracefully and creates session', async () => {
        await setRunning();

        let callCount = 0;
        mockDataClientSend.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // list-sessions throws "no server running"
            return Promise.reject(
              new Error('exec tmux: no server running on /tmp/tmux-1000/default')
            );
          }
          // new-session succeeds
          return Promise.resolve({
            response: {
              transformToByteArray: () =>
                Promise.resolve(
                  new TextEncoder().encode(
                    JSON.stringify({
                      exitCode: 0,
                      stdout: '',
                      stderr: '',
                    })
                  )
                ),
            },
          });
        });

        const session = await instance.createTmuxSession('new-session');
        expect(session.name).toBe('new-session');
      });

      it('throws on non-zero exit code from new-session', async () => {
        await setRunning();

        let callCount = 0;
        mockDataClientSend.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // list-sessions: no sessions
            return Promise.resolve({
              response: {
                transformToByteArray: () =>
                  Promise.resolve(
                    new TextEncoder().encode(
                      JSON.stringify({
                        exitCode: 0,
                        stdout: '',
                        stderr: '',
                      })
                    )
                  ),
              },
            });
          }
          // new-session fails
          return Promise.resolve({
            response: {
              transformToByteArray: () =>
                Promise.resolve(
                  new TextEncoder().encode(
                    JSON.stringify({
                      exitCode: 1,
                      stdout: '',
                      stderr: 'duplicate session: my-session',
                    })
                  )
                ),
            },
          });
        });

        await expect(instance.createTmuxSession('my-session')).rejects.toMatchObject({
          code: 'AGENTCORE-300',
        });
      });
    });

    describe('listTmuxSessions', () => {
      it('parses tmux output correctly', async () => {
        await setRunning();
        mockExec({ exitCode: 0, stdout: 'session1:3:1\nsession2:1:0', stderr: '' });

        const sessions = await instance.listTmuxSessions();

        expect(sessions).toHaveLength(2);
        expect(sessions[0]).toMatchObject({
          name: 'session1',
          sandboxId: 'sandbox-id-1',
          windowCount: 3,
          attached: true,
        });
        expect(sessions[1]).toMatchObject({
          name: 'session2',
          windowCount: 1,
          attached: false,
        });
      });

      it('returns empty array when "no server running" error is thrown', async () => {
        await setRunning();
        mockExecThrow('exec tmux: no server running on /tmp/tmux-1000/default');

        const sessions = await instance.listTmuxSessions();
        expect(sessions).toEqual([]);
      });

      it('returns empty array when "no sessions" error is thrown', async () => {
        await setRunning();
        mockExecThrow('exec tmux: no sessions');

        const sessions = await instance.listTmuxSessions();
        expect(sessions).toEqual([]);
      });

      it('returns empty array when stderr contains "no server running"', async () => {
        await setRunning();
        mockExec({
          exitCode: 1,
          stdout: '',
          stderr: 'no server running on /tmp/tmux-1000/default',
        });

        const sessions = await instance.listTmuxSessions();
        expect(sessions).toEqual([]);
      });

      it('throws on non-zero exit code with other errors', async () => {
        await setRunning();
        mockExec({ exitCode: 1, stdout: '', stderr: 'some unexpected error' });

        await expect(instance.listTmuxSessions()).rejects.toMatchObject({
          code: 'AGENTCORE-300',
        });
      });
    });

    describe('killTmuxSession', () => {
      it('kills session successfully (happy path)', async () => {
        await setRunning();
        mockExec({ exitCode: 0, stdout: '', stderr: '' });

        await expect(instance.killTmuxSession('my-session')).resolves.toBeUndefined();
      });

      it('succeeds silently when session not found', async () => {
        await setRunning();
        mockExec({ exitCode: 1, stdout: '', stderr: "can't find session: my-session" });

        await expect(instance.killTmuxSession('my-session')).resolves.toBeUndefined();
      });

      it('succeeds silently when "session not found" in stderr', async () => {
        await setRunning();
        mockExec({ exitCode: 1, stdout: '', stderr: 'session not found: my-session' });

        await expect(instance.killTmuxSession('my-session')).resolves.toBeUndefined();
      });

      it('throws on other errors', async () => {
        await setRunning();
        mockExec({ exitCode: 1, stdout: '', stderr: 'server exited unexpectedly' });

        await expect(instance.killTmuxSession('my-session')).rejects.toMatchObject({
          code: 'AGENTCORE-300',
        });
      });
    });

    describe('sendKeysToTmux', () => {
      it('sends keys successfully (happy path)', async () => {
        await setRunning();
        mockExec({ exitCode: 0, stdout: '', stderr: '' });

        await expect(instance.sendKeysToTmux('my-session', 'ls -la')).resolves.toBeUndefined();
      });

      it('throws on non-zero exit code', async () => {
        await setRunning();
        mockExec({ exitCode: 1, stdout: '', stderr: "can't find session: my-session" });

        await expect(instance.sendKeysToTmux('my-session', 'ls')).rejects.toMatchObject({
          code: 'AGENTCORE-300',
        });
      });
    });

    describe('captureTmuxPane', () => {
      it('returns captured stdout', async () => {
        await setRunning();
        mockExec({ exitCode: 0, stdout: '$ ls\nfile1.txt\nfile2.txt', stderr: '' });

        const output = await instance.captureTmuxPane('my-session');
        expect(output).toBe('$ ls\nfile1.txt\nfile2.txt');
      });

      it('throws on non-zero exit code', async () => {
        await setRunning();
        mockExec({ exitCode: 1, stdout: '', stderr: "can't find session: my-session" });

        await expect(instance.captureTmuxPane('my-session')).rejects.toMatchObject({
          code: 'AGENTCORE-300',
        });
      });
    });
  });

  describe('exec edge cases', () => {
    it('handles null/empty response (no response field)', async () => {
      await setRunning();

      // No response field at all — responseBody defaults to '{}'
      mockDataClientSend.mockResolvedValue({});

      const result = await instance.exec('echo', ['hello']);

      // Parsed from '{}' — exitCode defaults to 0, stdout/stderr default to ''
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('throws INVOCATION_FAILED when response body is not valid JSON', async () => {
      await setRunning();

      mockDataClientSend.mockResolvedValue({
        response: {
          transformToByteArray: () =>
            Promise.resolve(new TextEncoder().encode('this is not json <html>error</html>')),
        },
      });

      await expect(instance.exec('bad-cmd')).rejects.toMatchObject({
        code: 'AGENTCORE-300',
        message: expect.stringContaining('not valid JSON'),
      });
    });

    it('defaults exitCode to 0 when missing from response', async () => {
      await setRunning();

      mockDataClientSend.mockResolvedValue({
        response: {
          transformToByteArray: () =>
            Promise.resolve(
              new TextEncoder().encode(
                JSON.stringify({
                  stdout: 'some output',
                  stderr: '',
                })
              )
            ),
        },
      });

      const result = await instance.exec('cmd-no-exit');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('some output');
    });
  });

  describe('constructor validation', () => {
    it('throws when id is empty', () => {
      expect(
        () =>
          new AgentCoreSandboxInstance(
            '',
            runtimeArn,
            runtimeId,
            'proj-123',
            { send: mockControlClientSend } as never,
            { send: mockDataClientSend } as never
          )
      ).toThrow('non-empty id');
    });

    it('throws when runtimeArn is empty', () => {
      expect(
        () =>
          new AgentCoreSandboxInstance(
            'sandbox-1',
            '',
            runtimeId,
            'proj-123',
            { send: mockControlClientSend } as never,
            { send: mockDataClientSend } as never
          )
      ).toThrow('non-empty runtimeArn');
    });

    it('throws when runtimeId is empty', () => {
      expect(
        () =>
          new AgentCoreSandboxInstance(
            'sandbox-1',
            runtimeArn,
            '',
            'proj-123',
            { send: mockControlClientSend } as never,
            { send: mockDataClientSend } as never
          )
      ).toThrow('non-empty runtimeId');
    });
  });
});

describe('mapAgentCoreStatus', () => {
  it('maps READY to running', () => {
    expect(mapAgentCoreStatus('READY')).toBe('running');
  });

  it('maps CREATING to creating', () => {
    expect(mapAgentCoreStatus('CREATING')).toBe('creating');
  });

  it('maps UPDATING to creating', () => {
    expect(mapAgentCoreStatus('UPDATING')).toBe('creating');
  });

  it('maps CREATE_FAILED to error', () => {
    expect(mapAgentCoreStatus('CREATE_FAILED')).toBe('error');
  });

  it('maps UPDATE_FAILED to error', () => {
    expect(mapAgentCoreStatus('UPDATE_FAILED')).toBe('error');
  });

  it('maps DELETING to stopping', () => {
    expect(mapAgentCoreStatus('DELETING')).toBe('stopping');
  });

  it('maps DELETED to stopped', () => {
    expect(mapAgentCoreStatus('DELETED')).toBe('stopped');
  });

  it('maps undefined to stopped', () => {
    expect(mapAgentCoreStatus(undefined)).toBe('stopped');
  });

  it('maps empty string to stopped', () => {
    expect(mapAgentCoreStatus('')).toBe('stopped');
  });

  it('maps unknown string to error', () => {
    expect(mapAgentCoreStatus('SOMETHING_UNKNOWN')).toBe('error');
  });
});

describe('AgentCoreSandboxProvider - pullImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockControlClientSend.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws on empty string image', async () => {
    const provider = new AgentCoreSandboxProvider();
    await expect(provider.pullImage('')).rejects.toMatchObject({
      code: 'AGENTCORE-402',
    });
  });

  it('throws on whitespace-only image', async () => {
    const provider = new AgentCoreSandboxProvider();
    await expect(provider.pullImage('   ')).rejects.toMatchObject({
      code: 'AGENTCORE-402',
    });
  });

  it('succeeds when ECR auth and image check pass (no ECR repo configured)', async () => {
    // Without ecrRepositoryUri, isImageAvailable returns true
    const provider = new AgentCoreSandboxProvider();
    mockEcrClientSend.mockResolvedValue({ authorizationData: [] });

    await expect(provider.pullImage('my-image:latest')).resolves.toBeUndefined();
  });

  it('throws ECR_IMAGE_NOT_FOUND when image is not available', async () => {
    const provider = new AgentCoreSandboxProvider({
      ecrRepositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo',
    });
    mockEcrClientSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'GetAuthorizationToken') {
        return Promise.resolve({ authorizationData: [] });
      }
      if (cmd._type === 'DescribeImages') {
        const err = new Error('Image not found');
        err.name = 'ImageNotFoundException';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    await expect(provider.pullImage('my-image:latest')).rejects.toMatchObject({
      code: 'AGENTCORE-402',
    });
  });

  it('throws ECR_AUTH_FAILED when ECR authorization fails', async () => {
    const provider = new AgentCoreSandboxProvider();
    mockEcrClientSend.mockRejectedValue(new Error('ECR access denied'));

    await expect(provider.pullImage('my-image:latest')).rejects.toMatchObject({
      code: 'AGENTCORE-400',
    });
  });
});

describe('AgentCoreSandboxProvider - isImageAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockControlClientSend.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false for empty string', async () => {
    const provider = new AgentCoreSandboxProvider();
    const result = await provider.isImageAvailable('');
    expect(result).toBe(false);
  });

  it('returns true when no ECR repo configured', async () => {
    const provider = new AgentCoreSandboxProvider();
    const result = await provider.isImageAvailable('some-image:latest');
    expect(result).toBe(true);
  });

  it('returns true when image is found in ECR', async () => {
    const provider = new AgentCoreSandboxProvider({
      ecrRepositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo',
    });
    mockEcrClientSend.mockResolvedValue({ imageDetails: [{ imageDigest: 'sha256:abc' }] });

    const result = await provider.isImageAvailable('my-image:latest');
    expect(result).toBe(true);
  });

  it('returns false on ImageNotFoundException', async () => {
    const provider = new AgentCoreSandboxProvider({
      ecrRepositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo',
    });
    const err = new Error('Image not found');
    err.name = 'ImageNotFoundException';
    mockEcrClientSend.mockRejectedValue(err);

    const result = await provider.isImageAvailable('my-image:latest');
    expect(result).toBe(false);
  });

  it('returns false on RepositoryNotFoundException', async () => {
    const provider = new AgentCoreSandboxProvider({
      ecrRepositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo',
    });
    const err = new Error('Repository not found');
    err.name = 'RepositoryNotFoundException';
    mockEcrClientSend.mockRejectedValue(err);

    const result = await provider.isImageAvailable('my-image:latest');
    expect(result).toBe(false);
  });

  it('throws on infrastructure errors (not returns false)', async () => {
    const provider = new AgentCoreSandboxProvider({
      ecrRepositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo',
    });
    mockEcrClientSend.mockRejectedValue(new Error('Network timeout'));

    await expect(provider.isImageAvailable('my-image:latest')).rejects.toMatchObject({
      code: 'AGENTCORE-400',
    });
  });
});
