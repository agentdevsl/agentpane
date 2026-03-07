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

const FULL_CREDENTIALS = {
  awsAccessKeyId: 'AKIA_TEST_KEY',
  awsSecretAccessKey: 'encrypted-secret',
  awsRegion: 'us-west-2',
};

const KEY_AND_SECRET = {
  awsAccessKeyId: 'AKIA_TEST_KEY',
  awsSecretAccessKey: 'encrypted-secret',
};

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

  async function requestJson(
    app: ReturnType<typeof createAgentCoreTestApp>,
    path: string,
    init?: RequestInit
  ) {
    const res = await app.request(`/api/sandbox/agentcore${path}`, init);
    const body = await res.json();
    return { res, body };
  }

  describe('POST /validate', () => {
    it('validates credentials successfully when configured', async () => {
      const app = createAgentCoreTestApp(createMockDb(FULL_CREDENTIALS));

      const { res, body } = await requestJson(app, '/validate', { method: 'POST' });

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(true);
      expect(body.data.region).toBe('us-west-2');
    });

    it('returns 400 when no credentials are configured', async () => {
      const app = createAgentCoreTestApp(createMockDb());

      const { res, body } = await requestJson(app, '/validate', { method: 'POST' });

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('AGENTCORE_NOT_CONFIGURED');
      expect(body.error.message).toContain('not configured');
    });

    it('returns 400 when only access key is provided without secret', async () => {
      const app = createAgentCoreTestApp(createMockDb({ awsAccessKeyId: 'AKIA_TEST_KEY' }));

      const { res, body } = await requestJson(app, '/validate', { method: 'POST' });

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('AGENTCORE_NOT_CONFIGURED');
    });

    it('returns 422 when STS rejects credentials', async () => {
      const app = createAgentCoreTestApp(createMockDb(KEY_AND_SECRET));

      const stsError = new Error('The security token included in the request is invalid');
      stsError.name = 'InvalidClientTokenId';
      mockStsSend.mockRejectedValue(stsError);

      const { res, body } = await requestJson(app, '/validate', { method: 'POST' });

      expect(res.status).toBe(422);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('AGENTCORE_VALIDATION_ERROR');
    });

    it('returns 500 when STS call fails with network error', async () => {
      const app = createAgentCoreTestApp(createMockDb(KEY_AND_SECRET));
      mockStsSend.mockRejectedValue(new Error('Network timeout'));

      const { res, body } = await requestJson(app, '/validate', { method: 'POST' });

      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('AGENTCORE_VALIDATION_ERROR');
    });

    it('validates credentials from request body without requiring DB config', async () => {
      const app = createAgentCoreTestApp(createMockDb());

      const { res, body } = await requestJson(app, '/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          awsAccessKeyId: 'AKIA_BODY_KEY',
          awsSecretAccessKey: 'body-secret',
          awsRegion: 'eu-west-1',
        }),
      });

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(true);
      expect(body.data.region).toBe('eu-west-1');
    });

    it('returns 500 when no DB is provided', async () => {
      const app = createAgentCoreTestApp(undefined);

      const { res, body } = await requestJson(app, '/validate', { method: 'POST' });

      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error.message).toContain('Database not available');
    });

    it('decrypts secret access key from database', async () => {
      const app = createAgentCoreTestApp(
        createMockDb({
          awsAccessKeyId: 'AKIA_TEST_KEY',
          awsSecretAccessKey: 'encrypted-secret-value',
          awsRegion: 'us-east-1',
        })
      );

      await app.request('/api/sandbox/agentcore/validate', { method: 'POST' });

      expect(decryptTokenMock).toHaveBeenCalledWith('encrypted-secret-value');
    });

    it('returns AGENTCORE_CONFIG_CORRUPT when stored settings are invalid JSON', async () => {
      const db = {
        query: {
          settings: {
            findFirst: vi.fn().mockResolvedValue({
              key: 'sandbox.agentcore',
              value: '{not valid json!!!',
            }),
          },
        },
      };
      const app = createAgentCoreTestApp(db);

      const { res, body } = await requestJson(app, '/validate', { method: 'POST' });

      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('AGENTCORE_CONFIG_CORRUPT');
    });

    it('handles decryption failure gracefully', async () => {
      decryptTokenMock.mockImplementation(() => {
        throw new Error('Decryption failed: key rotated');
      });

      const app = createAgentCoreTestApp(
        createMockDb({ awsAccessKeyId: 'AKIA_TEST_KEY', awsSecretAccessKey: 'bad-encrypted' })
      );

      const { res, body } = await requestJson(app, '/validate', { method: 'POST' });

      expect(res.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('AGENTCORE_DECRYPTION_FAILED');
    });
  });

  describe('GET /health', () => {
    it('returns healthy when credentials are configured and STS succeeds', async () => {
      const app = createAgentCoreTestApp(createMockDb(FULL_CREDENTIALS));

      const { res, body } = await requestJson(app, '/health');

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(true);
      expect(body.data.region).toBe('us-west-2');
    });

    it('returns unhealthy when no credentials are configured', async () => {
      const app = createAgentCoreTestApp(createMockDb());

      const { res, body } = await requestJson(app, '/health');

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(false);
      expect(body.data.message).toContain('not configured');
    });

    it('returns unhealthy when no DB is provided', async () => {
      const app = createAgentCoreTestApp(undefined);

      const { res, body } = await requestJson(app, '/health');

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(false);
      expect(body.data.message).toContain('Database not available');
    });

    it('returns 200 with healthy:false when STS call fails', async () => {
      const app = createAgentCoreTestApp(createMockDb(KEY_AND_SECRET));
      mockStsSend.mockRejectedValue(new Error('Network timeout'));

      const { res, body } = await requestJson(app, '/health');

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(false);
      expect(body.data.message).toContain('health check failed');
    });

    it('returns unhealthy when decryption fails', async () => {
      decryptTokenMock.mockImplementation(() => {
        throw new Error('Decryption failed: key rotated');
      });

      const app = createAgentCoreTestApp(
        createMockDb({ awsAccessKeyId: 'AKIA_TEST_KEY', awsSecretAccessKey: 'bad-encrypted' })
      );

      const { res, body } = await requestJson(app, '/health');

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.healthy).toBe(false);
      expect(body.data.message).toContain('decrypt');
    });

    it('uses default region us-east-1 when no region is configured', async () => {
      const app = createAgentCoreTestApp(createMockDb(KEY_AND_SECRET));

      const { res, body } = await requestJson(app, '/health');

      expect(res.status).toBe(200);
      expect(body.data.region).toBe('us-east-1');
    });
  });
});
