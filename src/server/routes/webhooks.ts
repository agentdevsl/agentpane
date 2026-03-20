/**
 * Webhook routes
 */

import { Hono } from 'hono';
import { GitHubErrors } from '../../lib/errors/github-errors.js';
import { parseWebhookEvent, verifyWebhookSignature } from '../../lib/github/webhooks.js';
import type { TemplateService } from '../../services/template.service.js';
import { json } from '../shared.js';

interface WebhooksDeps {
  templateService: TemplateService;
}

export function createWebhooksRoutes({ templateService }: WebhooksDeps) {
  const app = new Hono();

  // POST /api/webhooks/github
  app.post('/github', async (c) => {
    let rawBody: string;
    try {
      rawBody = await c.req.text();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
    // AR-027: In production, webhook signature verification is mandatory.
    // Reject unsigned webhooks to prevent spoofed payloads from triggering template syncs.
    if (!secret && process.env.NODE_ENV === 'production') {
      return json(
        {
          ok: false,
          error: {
            code: 'CONFIG_ERROR',
            message:
              'GITHUB_WEBHOOK_SECRET is not configured. Webhook signature verification is required in production.',
          },
        },
        401
      );
    }
    if (secret) {
      const signature = c.req.header('x-hub-signature-256') ?? null;
      const verifyResult = await verifyWebhookSignature({
        payload: rawBody,
        signature,
        secret,
      });

      if (!verifyResult.ok) {
        return json({ ok: false, error: GitHubErrors.WEBHOOK_INVALID }, 401);
      }
    }

    const eventResult = parseWebhookEvent(c.req.raw.headers, rawBody);
    if (!eventResult.ok) {
      return json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400);
    }

    const event = eventResult.value.event;
    const deliveryId = eventResult.value.deliveryId;
    const action = eventResult.value.action;
    const payload = eventResult.value.payload;

    if (event === 'push') {
      const repo = payload.repository;
      if (repo?.owner?.login && repo?.name) {
        const templatesResult = await templateService.findByRepo(repo.owner.login, repo.name);
        if (templatesResult.ok) {
          await Promise.allSettled(
            templatesResult.value.map((template) => templateService.sync(template.id))
          );
        }
      }
    }

    return json({ ok: true, data: { received: true, event, deliveryId, action } });
  });

  return app;
}
