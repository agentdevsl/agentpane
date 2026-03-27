import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../../lib/api/auth-middleware.js';
import { getAppOctokit } from '../../lib/github/client.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { GitHubAppService } from '../../services/github-app.service.js';
import { isValidId, json } from '../shared.js';
import { parseJsonBody } from '../validation.js';

const log = createLogger('GitHubAppRoutes');

interface GitHubAppRoutesDeps {
  githubAppService: GitHubAppService;
}

const registerInstallationSchema = z.object({
  installationId: z.number().int().positive(),
  teamId: z.string().min(1),
});

const configureCodespaceSchema = z.object({
  codespaceId: z.string().min(1),
});

export function createGitHubAppRoutes({ githubAppService }: GitHubAppRoutesDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /status — check if GitHub App is configured
  app.get('/status', (_c) => {
    const configured = githubAppService.isConfigured();
    const installUrl = githubAppService.getInstallUrl();
    return json({ ok: true, data: { configured, installUrl } });
  });

  // GET /installations — list GitHub App installations
  app.get('/installations', async (c) => {
    const teamId = c.req.query('teamId');

    const result = await githubAppService.listInstallations(teamId || undefined);
    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        500
      );
    }

    return json({ ok: true, data: { items: result.value } });
  });

  // POST /installations — register an installation after user completes GitHub App install
  app.post('/installations', async (c) => {
    const parsed = await parseJsonBody(c, registerInstallationSchema);
    if (!parsed.ok) {
      return parsed.response;
    }

    const { installationId, teamId } = parsed.data;

    // Fetch installation details from GitHub
    let accountLogin: string;
    let accountType: string;
    try {
      const appOctokit = getAppOctokit();
      const { data: ghInstallation } = await appOctokit.rest.apps.getInstallation({
        installation_id: installationId,
      });
      accountLogin = ghInstallation.account?.login ?? `installation-${installationId}`;
      accountType = ghInstallation.account?.type ?? 'User';
    } catch (error) {
      log.error('Failed to fetch installation from GitHub', { data: { installationId }, error });
      return json(
        {
          ok: false,
          error: {
            code: 'GITHUB_APP_ERROR',
            message: githubAppService.isConfigured()
              ? `Failed to fetch installation details: ${error instanceof Error ? error.message : String(error)}`
              : 'GitHub App is not configured. Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY environment variables.',
          },
        },
        githubAppService.isConfigured() ? 502 : 503
      );
    }

    const result = await githubAppService.handleInstallation(
      installationId,
      accountLogin,
      accountType,
      teamId
    );

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        500
      );
    }

    return json({ ok: true, data: result.value }, 201);
  });

  // DELETE /installations/:id — remove an installation record
  app.delete('/installations/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid installation ID' } },
        400
      );
    }

    const result = await githubAppService.removeInstallation(id);
    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        404
      );
    }

    return json({ ok: true, data: { deleted: true } });
  });

  // POST /installations/:id/configure-codespace — auto-configure events for a codespace
  app.post('/installations/:id/configure-codespace', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid installation ID' } },
        400
      );
    }

    const parsed = await parseJsonBody(c, configureCodespaceSchema);
    if (!parsed.ok) {
      return parsed.response;
    }

    const { codespaceId } = parsed.data;
    const result = await githubAppService.autoConfigureEventsForCodespace(codespaceId);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        500
      );
    }

    return json({ ok: true, data: result.value });
  });

  return app;
}
