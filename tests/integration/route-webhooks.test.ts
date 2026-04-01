import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration tests for generic Webhook routes.
 *
 * Tests the /api/webhooks/github endpoint that triggers template syncs.
 */

// Mock webhook verification
vi.mock('../../src/lib/github/webhooks.js', () => ({
  verifyWebhookSignature: vi.fn(),
  parseWebhookEvent: vi.fn(),
}));

import { GitHubErrors } from '../../src/lib/errors/github-errors';
import { parseWebhookEvent, verifyWebhookSignature } from '../../src/lib/github/webhooks';
import { err, ok } from '../../src/lib/utils/result';
import { createWebhooksRoutes } from '../../src/server/routes/webhooks';

const mockVerify = vi.mocked(verifyWebhookSignature);
const mockParseEvent = vi.mocked(parseWebhookEvent);

function createMockTemplateService() {
  return {
    findByRepo: vi.fn().mockResolvedValue(ok([])),
    sync: vi.fn().mockResolvedValue(ok({})),
  };
}

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

describe('Webhooks Routes (IT-630)', () => {
  let app: ReturnType<typeof createWebhooksRoutes>;
  let templateService: ReturnType<typeof createMockTemplateService>;
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'test';
    templateService = createMockTemplateService();
    app = createWebhooksRoutes({ templateService: templateService as any });
  });

  afterAll(() => {
    if (originalSecret !== undefined) {
      process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    }
    process.env.NODE_ENV = originalNodeEnv;
  });

  // ─── POST /github ─────────────────────────────

  describe('POST /github', () => {
    it('IT-631: handles push event and triggers template sync', async () => {
      mockParseEvent.mockReturnValue(
        ok({
          event: 'push',
          deliveryId: 'delivery-1',
          action: undefined,
          payload: {
            repository: {
              owner: { login: 'test-org' },
              name: 'test-repo',
            },
          },
        }) as any
      );

      templateService.findByRepo.mockResolvedValue(ok([{ id: 'tmpl-1' }, { id: 'tmpl-2' }]));

      const response = await app.request(
        jsonRequest(
          'http://localhost/github',
          {
            ref: 'refs/heads/main',
            repository: {
              owner: { login: 'test-org' },
              name: 'test-repo',
            },
          },
          {
            method: 'POST',
            headers: {
              'x-github-event': 'push',
              'x-github-delivery': 'delivery-1',
            },
          }
        )
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.received).toBe(true);
      expect(body.data.event).toBe('push');
      expect(templateService.findByRepo).toHaveBeenCalledWith('test-org', 'test-repo');
      expect(templateService.sync).toHaveBeenCalledTimes(2);
    });

    it('IT-632: handles non-push events without template sync', async () => {
      mockParseEvent.mockReturnValue(
        ok({
          event: 'issues',
          deliveryId: 'delivery-2',
          action: 'opened',
          payload: {},
        }) as any
      );

      const response = await app.request(
        jsonRequest(
          'http://localhost/github',
          { action: 'opened' },
          {
            method: 'POST',
            headers: {
              'x-github-event': 'issues',
              'x-github-delivery': 'delivery-2',
            },
          }
        )
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.event).toBe('issues');
      expect(templateService.findByRepo).not.toHaveBeenCalled();
    });

    it('IT-633: returns 400 for invalid JSON body', async () => {
      // parseWebhookEvent returns an error when the body is not valid JSON
      mockParseEvent.mockReturnValue(
        err({
          code: 'INVALID_JSON',
          message: 'Invalid JSON',
          status: 400,
        }) as any
      );

      const response = await app.request(
        new Request('http://localhost/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-github-event': 'push',
          },
          body: 'not json',
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_JSON');
    });

    it('IT-634: rejects invalid signature when secret is set', async () => {
      process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
      mockVerify.mockResolvedValue(err(GitHubErrors.WEBHOOK_INVALID) as any);

      const response = await app.request(
        new Request('http://localhost/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-github-event': 'push',
            'x-hub-signature-256': 'sha256=invalid',
          },
          body: JSON.stringify({ action: 'test' }),
        })
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('GITHUB_WEBHOOK_INVALID');
    });

    it('IT-635: requires secret in production mode', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.GITHUB_WEBHOOK_SECRET;

      // Recreate app so it picks up env change
      app = createWebhooksRoutes({ templateService: templateService as any });

      const response = await app.request(
        new Request('http://localhost/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-github-event': 'push',
          },
          body: JSON.stringify({ action: 'test' }),
        })
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('CONFIG_ERROR');
    });

    it('IT-636: handles push event for unknown repo gracefully', async () => {
      mockParseEvent.mockReturnValue(
        ok({
          event: 'push',
          deliveryId: 'delivery-3',
          action: undefined,
          payload: {
            repository: {
              owner: { login: 'unknown-org' },
              name: 'unknown-repo',
            },
          },
        }) as any
      );

      templateService.findByRepo.mockResolvedValue(ok([]));

      const response = await app.request(
        jsonRequest(
          'http://localhost/github',
          {
            repository: {
              owner: { login: 'unknown-org' },
              name: 'unknown-repo',
            },
          },
          {
            method: 'POST',
            headers: {
              'x-github-event': 'push',
              'x-github-delivery': 'delivery-3',
            },
          }
        )
      );

      expect(response.status).toBe(200);
      expect(templateService.sync).not.toHaveBeenCalled();
    });
  });
});
