import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock webhook signature verification
vi.mock('../../src/lib/github/webhooks.js', () => ({
  verifyWebhookSignature: vi.fn(),
  parseWebhookEvent: vi.fn(),
}));

vi.mock('../../src/lib/events/event-bus.js', () => ({
  publishEventToStream: vi.fn(),
}));

import { verifyWebhookSignature } from '../../src/lib/github/webhooks';
import { err } from '../../src/lib/utils/result';
import { createGitHubAppWebhooksRoutes } from '../../src/server/routes/github-app-webhooks';

const mockVerify = vi.mocked(verifyWebhookSignature);

/**
 * Integration tests for GitHub App Webhooks routes.
 *
 * These routes handle incoming webhook events from GitHub App installations.
 * We mock the signature verification and service dependencies.
 */

function createMockDeps() {
  const githubAppService = {
    getCredentials: vi.fn().mockResolvedValue({ webhookSecret: '' }),
    handleInstallation: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    handleUninstall: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };

  const eventProcessingService = {
    processIncomingEvent: vi.fn().mockResolvedValue({ ok: true, value: { id: 'evt-1' } }),
  };

  const db = {
    query: {
      githubInstallations: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      eventSources: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
  };

  return { githubAppService, eventProcessingService, db };
}

describe('GitHub App Webhooks Routes (IT-540)', () => {
  let app: ReturnType<typeof createGitHubAppWebhooksRoutes>;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    app = createGitHubAppWebhooksRoutes({
      githubAppService: deps.githubAppService as any,
      eventProcessingService: deps.eventProcessingService as any,
      db: deps.db as any,
    });
  });

  // ─── POST / (webhook receiver) ────────────────

  describe('POST /', () => {
    it('IT-541: handles ping event', async () => {
      const response = await app.request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'ping',
          'x-github-delivery': 'delivery-1',
        },
        body: JSON.stringify({ zen: 'Test zen' }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.event).toBe('ping');
      expect(body.data.deliveryId).toBe('delivery-1');
    });

    it('IT-542: handles installation created event', async () => {
      const response = await app.request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'installation',
          'x-github-delivery': 'delivery-2',
        },
        body: JSON.stringify({
          action: 'created',
          installation: {
            id: 42,
            account: { login: 'test-org', type: 'Organization' },
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.event).toBe('installation');
      expect(body.data.action).toBe('created');
      expect(deps.githubAppService.handleInstallation).toHaveBeenCalledWith(
        42,
        'test-org',
        'Organization'
      );
    });

    it('IT-543: handles installation deleted event', async () => {
      const response = await app.request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'installation',
          'x-github-delivery': 'delivery-3',
        },
        body: JSON.stringify({
          action: 'deleted',
          installation: {
            id: 42,
            account: { login: 'test-org', type: 'Organization' },
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(deps.githubAppService.handleUninstall).toHaveBeenCalledWith(42);
    });

    it('IT-544: returns 400 for missing x-github-event header', async () => {
      const response = await app.request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-delivery': 'delivery-4',
        },
        body: JSON.stringify({ action: 'test' }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('MISSING_HEADER');
    });

    it('IT-545: returns 400 for invalid JSON body', async () => {
      const response = await app.request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'delivery-5',
        },
        body: 'not valid json',
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_JSON');
    });

    it('IT-546: returns 400 for installation event missing installation.id', async () => {
      const response = await app.request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'installation',
          'x-github-delivery': 'delivery-6',
        },
        body: JSON.stringify({
          action: 'created',
          installation: { account: { login: 'test' } },
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_PAYLOAD');
    });

    it('IT-547: rejects invalid signature when secret is configured', async () => {
      deps.githubAppService.getCredentials.mockResolvedValue({
        webhookSecret: 'super-secret',
      });
      mockVerify.mockResolvedValue(
        err({ code: 'WEBHOOK_INVALID', message: 'Invalid', status: 401 } as any)
      );

      const response = await app.request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'delivery-7',
          'x-hub-signature-256': 'sha256=bad',
        },
        body: JSON.stringify({ action: 'test' }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('SIGNATURE_INVALID');
    });

    it('IT-548: handles installation_repositories event', async () => {
      const response = await app.request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'installation_repositories',
          'x-github-delivery': 'delivery-8',
        },
        body: JSON.stringify({
          action: 'added',
          installation: { id: 42 },
          repositories_added: [{ full_name: 'org/repo' }],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.event).toBe('installation_repositories');
    });

    it('IT-549: handles events without installation context gracefully', async () => {
      const response = await app.request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'delivery-9',
        },
        body: JSON.stringify({
          ref: 'refs/heads/main',
          repository: { name: 'test-repo' },
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.note).toBe('no installation context');
    });

    it('IT-550: returns 401 in production without webhook secret', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      deps.githubAppService.getCredentials.mockResolvedValue({ webhookSecret: '' });

      const response = await app.request('http://localhost/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'delivery-10',
        },
        body: JSON.stringify({ action: 'test' }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('CONFIG_ERROR');

      process.env.NODE_ENV = originalEnv;
    });
  });
});
