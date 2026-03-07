// @vitest-environment node
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentCoreRoutes } from '../sandbox.js';

// Mock drizzle-orm
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('../../../db/schema/index.js', () => ({
  settings: { key: 'key_column' },
}));

vi.mock('../../../lib/crypto/server-encryption.js', () => ({
  decryptToken: vi.fn(),
}));

// Mock AWS STS client
const mockStsSend = vi.fn();

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
      send = mockStsSend;
    },
    GetCallerIdentityCommand: MockGetCallerIdentityCommand,
  };
});

// -- Mock DB Factory --

function createMockDb(settingsValue?: {
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;
}) {
  return {
    query: {
      settings: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            settingsValue
              ? { key: 'sandbox.agentcore', value: JSON.stringify(settingsValue) }
              : undefined
          ),
      },
    },
  };
}

// -- Hono Test App Factory --

function createAgentCoreTestApp(db?: ReturnType<typeof createMockDb>) {
  const routes = createAgentCoreRoutes(db ? { db: db as never } : undefined);
  const app = new Hono();
  app.route('/api/sandbox/agentcore', routes);
  return app;
}

describe('AgentCore Routes', () => {
  let decryptTokenMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cryptoMod = await import('../../../lib/crypto/server-encryption.js');
    decryptTokenMock = cryptoMod.decryptToken as ReturnType<typeof vi.fn>;
    decryptTokenMock.mockReset();
    decryptTokenMock.mockReturnValue('decrypted-secret-key');

    mockStsSend.mockReset();
    mockStsSend.mockResolvedValue({
      Account: '123456789012',
      Arn: 'arn:aws:iam::123456789012:user/test',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- POST /validate --

  describe('POST /validate', () => {
    it('validates credentials successfully when configured', async () => {
      const db = createMockDb({
        awsAccessKeyId: 'AKIA_TEST_KEY',
        awsSecretAccessKey: 'encrypted-secret',
        awsRegion: 'us-west-2',
      });
      const app = createAgentCoreTestApp(db);

      const res = await app.request('/api/sandbox/agentcore/validate', { method: 'POST' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(true);
      expect(body.data.accountId).toBe('123456789012');
      expect(body.data.region).toBe('us-west-2');
    });

    it('returns 400 when no credentials are configured', async () => {
      const db = createMockDb();
      const app = createAgentCoreTestApp(db);

      const res = await app.request('/api/sandbox/agentcore/validate', { method: 'POST' });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('AGENTCORE_NOT_CONFIGURED');
      expect(body.error.message).toContain('not configured');
    });

    it('returns 400 when only access key is provided without secret', async () => {
      const db = createMockDb({
        awsAccessKeyId: 'AKIA_TEST_KEY',
      });
      const app = createAgentCoreTestApp(db);

      const res = await app.request('/api/sandbox/agentcore/validate', { method: 'POST' });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('AGENTCORE_NOT_CONFIGURED');
    });

    it('returns 500 when STS call fails', async () => {
      const db = createMockDb({
        awsAccessKeyId: 'AKIA_TEST_KEY',
        awsSecretAccessKey: 'encrypted-secret',
      });
      const app = createAgentCoreTestApp(db);

      mockStsSend.mockRejectedValue(
        new Error('InvalidClientTokenId: The security token included in the request is invalid')
      );

      const res = await app.request('/api/sandbox/agentcore/validate', { method: 'POST' });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('AGENTCORE_VALIDATION_ERROR');
      expect(body.error.message).toContain('InvalidClientTokenId');
    });

    it('returns 500 when no DB is provided', async () => {
      const app = createAgentCoreTestApp(undefined);

      const res = await app.request('/api/sandbox/agentcore/validate', { method: 'POST' });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error.message).toContain('Database not available');
    });

    it('decrypts secret access key from database', async () => {
      const db = createMockDb({
        awsAccessKeyId: 'AKIA_TEST_KEY',
        awsSecretAccessKey: 'encrypted-secret-value',
        awsRegion: 'us-east-1',
      });
      const app = createAgentCoreTestApp(db);

      await app.request('/api/sandbox/agentcore/validate', { method: 'POST' });

      expect(decryptTokenMock).toHaveBeenCalledWith('encrypted-secret-value');
    });

    it('handles decryption failure gracefully', async () => {
      decryptTokenMock.mockImplementation(() => {
        throw new Error('Decryption failed: key rotated');
      });

      const db = createMockDb({
        awsAccessKeyId: 'AKIA_TEST_KEY',
        awsSecretAccessKey: 'bad-encrypted',
      });
      const app = createAgentCoreTestApp(db);

      const res = await app.request('/api/sandbox/agentcore/validate', { method: 'POST' });
      const body = await res.json();

      // Decryption failure now returns a distinct error code
      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('AGENTCORE_DECRYPTION_FAILED');
    });
  });

  // -- GET /health --

  describe('GET /health', () => {
    it('returns healthy when credentials are configured and STS succeeds', async () => {
      const db = createMockDb({
        awsAccessKeyId: 'AKIA_TEST_KEY',
        awsSecretAccessKey: 'encrypted-secret',
        awsRegion: 'us-west-2',
      });
      const app = createAgentCoreTestApp(db);

      const res = await app.request('/api/sandbox/agentcore/health', { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(true);
      expect(body.data.accountId).toBe('123456789012');
      expect(body.data.region).toBe('us-west-2');
    });

    it('returns unhealthy when no credentials are configured', async () => {
      const db = createMockDb();
      const app = createAgentCoreTestApp(db);

      const res = await app.request('/api/sandbox/agentcore/health', { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(false);
      expect(body.data.message).toContain('not configured');
    });

    it('returns unhealthy when no DB is provided', async () => {
      const app = createAgentCoreTestApp(undefined);

      const res = await app.request('/api/sandbox/agentcore/health', { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(false);
      expect(body.data.message).toContain('Database not available');
    });

    it('returns 500 when STS call fails', async () => {
      const db = createMockDb({
        awsAccessKeyId: 'AKIA_TEST_KEY',
        awsSecretAccessKey: 'encrypted-secret',
      });
      const app = createAgentCoreTestApp(db);

      mockStsSend.mockRejectedValue(new Error('Network timeout'));

      const res = await app.request('/api/sandbox/agentcore/health', { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('AGENTCORE_HEALTH_ERROR');
      expect(body.error.message).toContain('Network timeout');
    });

    it('uses default region us-east-1 when no region is configured', async () => {
      const db = createMockDb({
        awsAccessKeyId: 'AKIA_TEST_KEY',
        awsSecretAccessKey: 'encrypted-secret',
      });
      const app = createAgentCoreTestApp(db);

      const res = await app.request('/api/sandbox/agentcore/health', { method: 'GET' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.region).toBe('us-east-1');
    });
  });
});
