import * as crypto from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../../lib/api/auth-middleware.js';
import { createLogger } from '../../lib/logging/logger.js';
import { errorMessage } from '../../lib/utils/error-message.js';
import { buildInstallUrl, type GitHubAppService } from '../../services/github-app.service.js';
import { errorResponse, json, validateIdParam } from '../shared.js';
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

const manifestRequestSchema = z.object({
  externalUrl: z.string().url(),
  appName: z.string().min(1).max(100).optional(),
});

const setupCallbackSchema = z.object({
  code: z.string().min(1),
});

export function createGitHubAppRoutes({ githubAppService }: GitHubAppRoutesDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  app.get('/status', async (_c) => {
    const creds = await githubAppService.getCredentials();
    return json({
      ok: true,
      data: {
        configured: creds !== null,
        installUrl: creds?.appSlug ? buildInstallUrl(creds.appSlug) : null,
        appSlug: creds?.appSlug ?? null,
        appId: creds?.appId ?? null,
      },
    });
  });

  app.post('/manifest', async (c) => {
    const parsed = await parseJsonBody(c, manifestRequestSchema);
    if (!parsed.ok) return parsed.response;

    const { externalUrl, appName } = parsed.data;
    const name = appName ?? 'AgentPane';
    const state = crypto.randomBytes(16).toString('hex');

    c.header(
      'Set-Cookie',
      `github_app_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600; Secure`
    );

    const manifest = {
      name,
      url: externalUrl,
      hook_attributes: {
        url: `${externalUrl}/hooks/github-app`,
        active: true,
      },
      redirect_url: `${externalUrl}/settings/github`,
      setup_url: `${externalUrl}/settings/github`,
      callback_urls: [`${externalUrl}/api/auth/github/callback`],
      public: false,
      default_permissions: {
        contents: 'write',
        pull_requests: 'write',
        issues: 'write',
        metadata: 'read',
      },
      default_events: [
        'push',
        'pull_request',
        'issues',
        'installation',
        'installation_repositories',
      ],
    };

    return json({
      ok: true,
      data: {
        manifest: JSON.stringify(manifest),
        state,
        githubUrl: `https://github.com/settings/apps/new?state=${state}`,
      },
    });
  });

  app.post('/setup-callback', async (c) => {
    const parsed = await parseJsonBody(c, setupCallbackSchema);
    if (!parsed.ok) return parsed.response;

    const { code } = parsed.data;

    let conversionData: {
      id: number;
      slug: string;
      pem: string;
      webhook_secret: string;
      client_id: string;
      client_secret: string;
    };

    try {
      const response = await fetch(
        `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'AgentPane',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        log.error('GitHub manifest conversion failed', {
          data: { status: response.status, body: errorBody },
        });
        return json(
          {
            ok: false,
            error: {
              code: 'GITHUB_CONVERSION_FAILED',
              message: `GitHub returned ${response.status}: ${errorBody}`,
            },
          },
          502
        );
      }

      conversionData = (await response.json()) as typeof conversionData;
    } catch (error) {
      log.error('Failed to exchange code for GitHub App credentials', { error });
      return json(
        {
          ok: false,
          error: {
            code: 'GITHUB_CONVERSION_ERROR',
            message: `Failed to contact GitHub: ${errorMessage(error)}`,
          },
        },
        502
      );
    }

    const saveResult = await githubAppService.saveCredentials({
      appId: String(conversionData.id),
      appSlug: conversionData.slug,
      privateKey: conversionData.pem,
      webhookSecret: conversionData.webhook_secret,
      clientId: conversionData.client_id,
      clientSecret: conversionData.client_secret,
    });

    if (!saveResult.ok) return errorResponse(saveResult);

    log.info('GitHub App created via manifest flow', {
      data: { appId: conversionData.id, appSlug: conversionData.slug },
    });

    return json({
      ok: true,
      data: {
        appId: String(conversionData.id),
        appSlug: conversionData.slug,
        installUrl: buildInstallUrl(conversionData.slug),
      },
    });
  });

  app.get('/installations', async (c) => {
    const teamId = c.req.query('teamId');
    const result = await githubAppService.listInstallations(teamId || undefined);
    if (!result.ok) return errorResponse(result);
    return json({ ok: true, data: { items: result.value } });
  });

  app.post('/installations', async (c) => {
    const parsed = await parseJsonBody(c, registerInstallationSchema);
    if (!parsed.ok) return parsed.response;

    const { installationId, teamId } = parsed.data;

    let accountLogin: string;
    let accountType: string;
    try {
      const appOctokit = await githubAppService.getAppOctokitFromCredentials();
      const { data: ghInstallation } = await appOctokit.rest.apps.getInstallation({
        installation_id: installationId,
      });
      const account = ghInstallation.account;
      accountLogin =
        account && 'login' in account ? account.login : `installation-${installationId}`;
      accountType = account && 'type' in account ? account.type : 'User';
    } catch (error) {
      log.error('Failed to fetch installation from GitHub', { data: { installationId }, error });
      const configured = await githubAppService.isConfigured();
      return json(
        {
          ok: false,
          error: {
            code: 'GITHUB_APP_ERROR',
            message: configured
              ? `Failed to fetch installation details: ${errorMessage(error)}`
              : 'GitHub App is not configured. Create the app first via Settings > GitHub.',
          },
        },
        configured ? 502 : 503
      );
    }

    const result = await githubAppService.handleInstallation(
      installationId,
      accountLogin,
      accountType,
      teamId
    );

    if (!result.ok) return errorResponse(result);
    return json({ ok: true, data: result.value }, 201);
  });

  app.delete('/installations/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await githubAppService.removeInstallation(id);
    if (!result.ok) return errorResponse(result);
    return json({ ok: true, data: { deleted: true } });
  });

  app.post('/installations/:id/configure-codespace', async (c) => {
    const { id: _id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const parsed = await parseJsonBody(c, configureCodespaceSchema);
    if (!parsed.ok) return parsed.response;

    const { codespaceId } = parsed.data;
    const result = await githubAppService.autoConfigureEventsForCodespace(codespaceId);
    if (!result.ok) return errorResponse(result);
    return json({ ok: true, data: result.value });
  });

  app.delete('/credentials', async (_c) => {
    const result = await githubAppService.deleteCredentials();
    if (!result.ok) return errorResponse(result);
    return json({ ok: true, data: { deleted: true } });
  });

  return app;
}
