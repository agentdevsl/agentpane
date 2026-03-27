import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import {
  codespaces,
  eventSources,
  eventSubscriptions,
  githubInstallations,
  projectFolders,
} from '../db/schema/index.js';
import type { GitHubInstallation } from '../db/schema/sqlite/github.js';
import { decryptToken, encryptToken } from '../lib/crypto/server-encryption.js';
import type { AppError } from '../lib/errors/base.js';
import { EventErrors } from '../lib/errors/event-errors.js';
import { clearAppOctokitCache, getAppOctokit } from '../lib/github/client.js';
import { createLogger } from '../lib/logging/logger.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import { slugify } from '../lib/utils/slugify.js';
import type { Database } from '../types/database.js';
import type { SettingsService } from './settings.service.js';

const log = createLogger('GitHubAppService');

const CREDENTIALS_KEY = 'github.app.credentials';

export interface StoredAppCredentials {
  appId: string;
  appSlug: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
}

export class GitHubAppService {
  constructor(
    private db: Database,
    private settingsService: SettingsService
  ) {}

  isConfigured(): boolean {
    return !!(process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY);
  }

  async isConfiguredAsync(): Promise<boolean> {
    if (this.isConfigured()) return true;
    const creds = await this.getCredentials();
    return creds !== null;
  }

  async getCredentials(): Promise<StoredAppCredentials | null> {
    // 1. Check env vars first (backward compat)
    if (process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY) {
      return {
        appId: process.env.GITHUB_APP_ID,
        appSlug: process.env.GITHUB_APP_NAME ?? '',
        privateKey: process.env.GITHUB_PRIVATE_KEY,
        webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
        clientId: process.env.GITHUB_CLIENT_ID ?? '',
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
      };
    }

    // 2. Check settings table
    const result = await this.settingsService.get(CREDENTIALS_KEY);
    if (!result.ok || !result.value) return null;

    try {
      const stored = JSON.parse(result.value.value) as Record<string, string>;
      if (!stored.appId || !stored.privateKey) return null;

      return {
        appId: stored.appId,
        appSlug: stored.appSlug ?? '',
        privateKey: decryptToken(stored.privateKey),
        webhookSecret: stored.webhookSecret ? decryptToken(stored.webhookSecret) : '',
        clientId: stored.clientId ?? '',
        clientSecret: stored.clientSecret ? decryptToken(stored.clientSecret) : '',
      };
    } catch (error) {
      log.error('Failed to parse GitHub App credentials from settings', { error });
      return null;
    }
  }

  async saveCredentials(creds: StoredAppCredentials): Promise<Result<void, AppError>> {
    const encrypted = {
      appId: creds.appId,
      appSlug: creds.appSlug,
      privateKey: encryptToken(creds.privateKey),
      webhookSecret: creds.webhookSecret ? encryptToken(creds.webhookSecret) : '',
      clientId: creds.clientId,
      clientSecret: creds.clientSecret ? encryptToken(creds.clientSecret) : '',
    };

    const result = await this.settingsService.set(CREDENTIALS_KEY, encrypted);
    if (!result.ok) {
      return err(EventErrors.PROCESSING_FAILED('Failed to save GitHub App credentials'));
    }

    // Clear cached Octokit so it picks up new credentials
    clearAppOctokitCache();

    log.info('Saved GitHub App credentials', {
      data: { appId: creds.appId, appSlug: creds.appSlug },
    });
    return ok(undefined);
  }

  async deleteCredentials(): Promise<Result<void, AppError>> {
    // Set to null to clear credentials (SettingsService has no delete method)
    const result = await this.settingsService.set(CREDENTIALS_KEY, null);
    if (!result.ok) {
      return err(EventErrors.PROCESSING_FAILED('Failed to delete GitHub App credentials'));
    }
    clearAppOctokitCache();
    return ok(undefined);
  }

  async getAppOctokitFromCredentials(): Promise<ReturnType<typeof getAppOctokit>> {
    const creds = await this.getCredentials();
    if (!creds) {
      throw new Error('GitHub App credentials not configured');
    }
    return getAppOctokit({ appId: creds.appId, privateKey: creds.privateKey });
  }

  getInstallUrl(): string | null {
    const appName = process.env.GITHUB_APP_NAME;
    if (!appName) return null;
    return `https://github.com/apps/${encodeURIComponent(appName)}/installations/new`;
  }

  async getInstallUrlAsync(): Promise<string | null> {
    // Check env var first
    const envName = process.env.GITHUB_APP_NAME;
    if (envName) return `https://github.com/apps/${encodeURIComponent(envName)}/installations/new`;

    // Check DB credentials
    const creds = await this.getCredentials();
    if (creds?.appSlug) {
      return `https://github.com/apps/${encodeURIComponent(creds.appSlug)}/installations/new`;
    }
    return null;
  }

  async handleInstallation(
    installationId: number,
    accountLogin: string,
    accountType: string,
    teamId?: string
  ): Promise<Result<GitHubInstallation, AppError>> {
    const installationIdStr = String(installationId);
    const now = new Date().toISOString();

    const existing = await this.db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.installationId, installationIdStr),
    });

    if (existing) {
      const [updated] = await this.db
        .update(githubInstallations)
        .set({
          accountLogin,
          accountType,
          status: 'active',
          ...(teamId ? { teamId } : {}),
          updatedAt: now,
        })
        .where(eq(githubInstallations.id, existing.id))
        .returning();

      if (!updated) {
        return err(EventErrors.PROCESSING_FAILED('Failed to update installation'));
      }

      log.info('Updated GitHub App installation', {
        data: { installationId, accountLogin, id: updated.id },
      });
      return ok(updated);
    }

    const [created] = await this.db
      .insert(githubInstallations)
      .values({
        id: createId(),
        installationId: installationIdStr,
        accountLogin,
        accountType,
        teamId: teamId ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!created) {
      return err(EventErrors.PROCESSING_FAILED('Failed to create installation record'));
    }

    log.info('Stored GitHub App installation', {
      data: { installationId, accountLogin, id: created.id },
    });
    return ok(created);
  }

  async handleUninstall(installationId: number): Promise<Result<void, AppError>> {
    const installationIdStr = String(installationId);
    const now = new Date().toISOString();

    const installation = await this.db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.installationId, installationIdStr),
    });

    if (!installation) {
      log.warn('Uninstall event for unknown installation', { data: { installationId } });
      return ok(undefined);
    }

    await this.db
      .update(githubInstallations)
      .set({ status: 'removed', updatedAt: now })
      .where(eq(githubInstallations.id, installation.id));

    await this.db
      .update(eventSources)
      .set({ isEnabled: false, status: 'disabled', updatedAt: now })
      .where(eq(eventSources.githubInstallationId, installation.id));

    log.info('Handled GitHub App uninstall', {
      data: { installationId, id: installation.id },
    });
    return ok(undefined);
  }

  async listInstallations(teamId?: string): Promise<Result<GitHubInstallation[], AppError>> {
    const whereClause = teamId
      ? and(eq(githubInstallations.teamId, teamId), eq(githubInstallations.status, 'active'))
      : eq(githubInstallations.status, 'active');

    const items = await this.db.query.githubInstallations.findMany({
      where: whereClause,
    });
    return ok(items);
  }

  async getInstallationByAccount(
    accountLogin: string
  ): Promise<Result<GitHubInstallation | null, AppError>> {
    const installation = await this.db.query.githubInstallations.findFirst({
      where: and(
        eq(githubInstallations.accountLogin, accountLogin),
        eq(githubInstallations.status, 'active')
      ),
    });
    return ok(installation ?? null);
  }

  async autoConfigureEventsForCodespace(codespaceId: string): Promise<
    Result<
      {
        eventSourceId: string | null;
        subscriptionId: string | null;
        installationId: string | null;
      },
      AppError
    >
  > {
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespaceId),
    });

    if (!codespace) {
      return err(EventErrors.PROCESSING_FAILED('Codespace not found'));
    }

    if (!codespace.githubOwner) {
      return ok({ eventSourceId: null, subscriptionId: null, installationId: null });
    }

    const installation = await this.db.query.githubInstallations.findFirst({
      where: and(
        eq(githubInstallations.accountLogin, codespace.githubOwner),
        eq(githubInstallations.status, 'active')
      ),
    });

    if (!installation) {
      return ok({ eventSourceId: null, subscriptionId: null, installationId: null });
    }

    const teamId = installation.teamId ?? (await this.resolveTeamId(codespace.projectFolderId));
    if (!teamId) {
      log.warn('Cannot determine teamId for auto-configure', {
        data: { codespaceId, installationId: installation.id },
      });
      return ok({ eventSourceId: null, subscriptionId: null, installationId: installation.id });
    }

    // Find or create event source
    let source = await this.db.query.eventSources.findFirst({
      where: and(
        eq(eventSources.githubInstallationId, installation.id),
        eq(eventSources.teamId, teamId)
      ),
    });

    if (!source) {
      const name = `GitHub (${installation.accountLogin})`;
      const slug = `${slugify(name)}-${createId().slice(0, 6)}`;
      const now = new Date().toISOString();

      const [created] = await this.db
        .insert(eventSources)
        .values({
          id: createId(),
          teamId,
          name,
          type: 'github',
          slug,
          webhookSecret: null,
          isEnabled: true,
          config: { installationId: Number(installation.installationId) },
          eventCount: 0,
          githubInstallationId: installation.id,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!created) {
        return err(EventErrors.PROCESSING_FAILED('Failed to create event source'));
      }
      source = created;
      log.info('Auto-created event source', {
        data: { sourceId: source.id, accountLogin: installation.accountLogin },
      });
    }

    // Find or create subscription
    const existingSub = await this.db.query.eventSubscriptions.findFirst({
      where: and(
        eq(eventSubscriptions.eventSourceId, source.id),
        eq(eventSubscriptions.targetCodespaceId, codespaceId)
      ),
    });

    let subscriptionId: string | null = existingSub?.id ?? null;

    if (!existingSub) {
      const repoName = codespace.githubRepo
        ? `${codespace.githubOwner}/${codespace.githubRepo}`
        : codespace.githubOwner;
      const now = new Date().toISOString();

      const [sub] = await this.db
        .insert(eventSubscriptions)
        .values({
          id: createId(),
          name: `Auto: ${codespace.name}`,
          eventSourceId: source.id,
          targetCodespaceId: codespaceId,
          isEnabled: true,
          eventTypes: ['issues', 'pull_request', 'push'],
          filters: codespace.githubRepo
            ? [{ field: 'repo' as const, operator: 'equals' as const, value: repoName }]
            : [],
          promptTemplate:
            '{{event.type}} {{event.action}} on {{repo.full_name}}: {{data.title}}\n\n{{data.body}}',
          autoStartAgent: false,
          taskColumn: 'backlog',
          taskPriority: 'medium',
          taskLabels: [],
          matchedCount: 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (sub) {
        subscriptionId = sub.id;
        log.info('Auto-created subscription', {
          data: { subscriptionId: sub.id, codespaceId, sourceId: source.id },
        });
      }
    }

    if (codespace.githubInstallationId !== installation.id) {
      await this.db
        .update(codespaces)
        .set({ githubInstallationId: installation.id, updatedAt: new Date().toISOString() })
        .where(eq(codespaces.id, codespaceId));
    }

    return ok({ eventSourceId: source.id, subscriptionId, installationId: installation.id });
  }

  async removeInstallation(id: string): Promise<Result<void, AppError>> {
    const now = new Date().toISOString();

    // Disable linked event sources before deleting (prevents orphaned references)
    await this.db
      .update(eventSources)
      .set({ isEnabled: false, status: 'disabled', githubInstallationId: null, updatedAt: now })
      .where(eq(eventSources.githubInstallationId, id));

    // Clear codespace references
    await this.db
      .update(codespaces)
      .set({ githubInstallationId: null, updatedAt: now })
      .where(eq(codespaces.githubInstallationId, id));

    const [deleted] = await this.db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, id))
      .returning({ id: githubInstallations.id });

    if (!deleted) {
      return err(EventErrors.SOURCE_NOT_FOUND());
    }

    log.info('Removed GitHub App installation', { data: { id } });
    return ok(undefined);
  }

  async getInstallationToken(installationId: number): Promise<Result<string, AppError>> {
    const configured = await this.isConfiguredAsync();
    if (!configured) {
      return err(EventErrors.PROCESSING_FAILED('GitHub App credentials not configured'));
    }

    try {
      const appOctokit = await this.getAppOctokitFromCredentials();
      const { data } = await appOctokit.rest.apps.createInstallationAccessToken({
        installation_id: installationId,
      });
      return ok(data.token);
    } catch (error) {
      log.error('Failed to get installation token', { data: { installationId }, error });
      return err(
        EventErrors.PROCESSING_FAILED(
          `Failed to get installation token: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  private async resolveTeamId(projectFolderId: string): Promise<string | null> {
    const folder = await this.db.query.projectFolders.findFirst({
      where: eq(projectFolders.id, projectFolderId),
    });
    return folder?.teamId ?? null;
  }
}
