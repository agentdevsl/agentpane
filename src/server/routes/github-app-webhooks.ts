import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { eventSources, githubInstallations } from '../../db/schema/index.js';
import { publishEventToStream } from '../../lib/events/event-bus.js';
import { verifyWebhookSignature } from '../../lib/github/webhooks.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { EventProcessingService } from '../../services/event-processing.service.js';
import type { GitHubAppService } from '../../services/github-app.service.js';
import type { Database } from '../../types/database.js';
import { json } from '../shared.js';

const log = createLogger('GitHubAppWebhooks');

interface GitHubAppWebhooksDeps {
  githubAppService: GitHubAppService;
  eventProcessingService: EventProcessingService;
  db: Database;
}

export function createGitHubAppWebhooksRoutes({
  githubAppService,
  eventProcessingService,
  db,
}: GitHubAppWebhooksDeps) {
  const app = new Hono();

  // POST / — mounted at /hooks/github-app
  app.post('/', async (c) => {
    let rawBody: string;
    try {
      rawBody = await c.req.text();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_BODY', message: 'Failed to read request body' } },
        400
      );
    }

    // Verify webhook signature
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
    if (!secret && process.env.NODE_ENV === 'production') {
      return json(
        {
          ok: false,
          error: {
            code: 'CONFIG_ERROR',
            message: 'GITHUB_WEBHOOK_SECRET is not configured',
          },
        },
        401
      );
    }

    if (secret) {
      const signature = c.req.header('x-hub-signature-256') ?? null;
      const verifyResult = await verifyWebhookSignature({ payload: rawBody, signature, secret });
      if (!verifyResult.ok) {
        return json(
          { ok: false, error: { code: 'SIGNATURE_INVALID', message: 'Invalid webhook signature' } },
          401
        );
      }
    }

    const eventType = c.req.header('x-github-event');
    const deliveryId = c.req.header('x-github-delivery');

    if (!eventType) {
      return json(
        { ok: false, error: { code: 'MISSING_HEADER', message: 'Missing x-github-event header' } },
        400
      );
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } },
        400
      );
    }

    // Handle ping events
    if (eventType === 'ping') {
      log.info('Received GitHub App ping', { data: { deliveryId } });
      return json({ ok: true, data: { event: 'ping', deliveryId } });
    }

    // Handle installation events
    if (eventType === 'installation') {
      const action = (payload.action as string) ?? '';
      const inst = payload.installation as
        | { id?: number; account?: { login?: string; type?: string } }
        | undefined;
      const numericId = inst?.id;
      const accountLogin = inst?.account?.login ?? '';
      const accountType = inst?.account?.type ?? 'User';

      if (!numericId) {
        return json(
          { ok: false, error: { code: 'INVALID_PAYLOAD', message: 'Missing installation.id' } },
          400
        );
      }

      if (action === 'created') {
        // Store installation without teamId — user associates it via setup UI
        await githubAppService.handleInstallation(numericId, accountLogin, accountType);
        log.info('GitHub App installed', { data: { installationId: numericId, accountLogin } });
      } else if (action === 'deleted') {
        await githubAppService.handleUninstall(numericId);
        log.info('GitHub App uninstalled', { data: { installationId: numericId, accountLogin } });
      }

      return json({ ok: true, data: { event: 'installation', action, deliveryId } });
    }

    // Handle installation_repositories events
    if (eventType === 'installation_repositories') {
      const action = (payload.action as string) ?? '';
      log.info('GitHub App repositories event', { data: { action, deliveryId } });
      return json({ ok: true, data: { event: 'installation_repositories', action, deliveryId } });
    }

    // Route all other events through the event processing pipeline
    const inst = payload.installation as { id?: number } | undefined;
    const numericInstallationId = inst?.id;

    if (!numericInstallationId) {
      log.info('Webhook without installation context', { data: { eventType, deliveryId } });
      return json({ ok: true, data: { event: eventType, note: 'no installation context' } });
    }

    // Find installation record
    const installation = await db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.installationId, String(numericInstallationId)),
    });

    if (!installation) {
      log.warn('No installation record for webhook', {
        data: { installationId: numericInstallationId },
      });
      return json({ ok: true, data: { event: eventType, note: 'unknown installation' } });
    }

    // Find linked event source
    const source = await db.query.eventSources.findFirst({
      where: eq(eventSources.githubInstallationId, installation.id),
    });

    if (!source) {
      log.warn('No event source linked to installation', {
        data: { installationId: installation.id },
      });
      return json({ ok: true, data: { event: eventType, note: 'no event source configured' } });
    }

    // Process through existing pipeline
    const result = await eventProcessingService.processIncomingEvent(
      source.slug,
      c.req.raw.headers,
      rawBody
    );

    if (!result.ok) {
      log.error('Event processing failed', {
        data: { sourceSlug: source.slug, eventType },
        error: result.error.message,
      });
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        (result.error.status ?? 500) as 400 | 401 | 403 | 404 | 500
      );
    }

    // Publish to SSE for real-time UI
    const eventData = result.value;
    queueMicrotask(() => publishEventToStream({ type: 'event:processed', data: eventData }));

    return json({ ok: true, data: result.value });
  });

  return app;
}
