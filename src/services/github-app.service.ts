import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { getRuntimeSchemaTables, type RuntimeSchemaTables } from '../db/schema/runtime-tables.js';
import { decryptToken, encryptToken } from '../lib/crypto/server-encryption.js';
import type { AppError } from '../lib/errors/base.js';
import { EventErrors } from '../lib/errors/event-errors.js';
import { clearAppOctokitCache, getAppOctokit } from '../lib/github/client.js';
import { createLogger } from '../lib/logging/logger.js';
import { errorMessage } from '../lib/utils/error-message.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import { slugify } from '../lib/utils/slugify.js';
import type { Database } from '../types/database.js';
import type { SettingsService } from './settings.service.js';

const log = createLogger('GitHubAppService');

const CREDENTIALS_KEY = 'github.app.credentials';
const { codespaces, eventSources, eventSubscriptions, githubInstallations, teamProjectFolders } =
  getRuntimeSchemaTables();

type GitHubInstallation = RuntimeSchemaTables['githubInstallations']['$inferSelect'];

export interface StoredAppCredentials {
  appId: string;
  appSlug: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
}

export function buildInstallUrl(appSlug: string): string {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
}

export class GitHubAppService {
  private cachedCredentials: StoredAppCredentials | null | undefined = undefined;

  constructor(
    private db: Database,
    private settingsService: SettingsService
  ) {}

  async isConfigured(): Promise<boolean> {
    const creds = await this.getCredentials();
    return creds !== null;
  }

  async getCredentials(): Promise<StoredAppCredentials | null> {
    if (this.cachedCredentials !== undefined) return this.cachedCredentials;

    const result = await this.settingsService.get(CREDENTIALS_KEY);
    if (!result.ok || !result.value) {
      this.cachedCredentials = null;
      return null;
    }

    try {
      const stored = JSON.parse(result.value.value) as Record<string, string>;
      if (!stored.appId || !stored.privateKey) {
        this.cachedCredentials = null;
        return null;
      }

      const creds: StoredAppCredentials = {
        appId: stored.appId,
        appSlug: stored.appSlug ?? '',
        privateKey: decryptToken(stored.privateKey),
        webhookSecret: stored.webhookSecret ? decryptToken(stored.webhookSecret) : '',
        clientId: stored.clientId ?? '',
        clientSecret: stored.clientSecret ? decryptToken(stored.clientSecret) : '',
      };
      this.cachedCredentials = creds;
      return creds;
    } catch (error) {
      log.error('Failed to parse GitHub App credentials from settings', { error });
      this.cachedCredentials = null;
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

    this.invalidateCache();
    log.info('Saved GitHub App credentials', {
      data: { appId: creds.appId, appSlug: creds.appSlug },
    });
    return ok(undefined);
  }

  async deleteCredentials(): Promise<Result<void, AppError>> {
    const result = await this.settingsService.set(CREDENTIALS_KEY, null);
    if (!result.ok) {
      return err(EventErrors.PROCESSING_FAILED('Failed to delete GitHub App credentials'));
    }
    this.invalidateCache();
    return ok(undefined);
  }

  async getAppOctokitFromCredentials(): Promise<ReturnType<typeof getAppOctokit>> {
    const creds = await this.getCredentials();
    if (!creds) {
      throw new Error('GitHub App credentials not configured');
    }
    return getAppOctokit({ appId: creds.appId, privateKey: creds.privateKey });
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

    await Promise.all([
      this.db
        .update(githubInstallations)
        .set({ status: 'removed', updatedAt: now })
        .where(eq(githubInstallations.id, installation.id)),
      this.db
        .update(eventSources)
        .set({ isEnabled: false, status: 'disabled', updatedAt: now })
        .where(eq(eventSources.githubInstallationId, installation.id)),
    ]);

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

    await Promise.all([
      this.db
        .update(eventSources)
        .set({ isEnabled: false, status: 'disabled', githubInstallationId: null, updatedAt: now })
        .where(eq(eventSources.githubInstallationId, id)),
      this.db
        .update(codespaces)
        .set({ githubInstallationId: null, updatedAt: now })
        .where(eq(codespaces.githubInstallationId, id)),
    ]);

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
    try {
      const appOctokit = await this.getAppOctokitFromCredentials();
      const { data } = await appOctokit.rest.apps.createInstallationAccessToken({
        installation_id: installationId,
      });
      return ok(data.token);
    } catch (error) {
      log.error('Failed to get installation token', { data: { installationId }, error });
      return err(
        EventErrors.PROCESSING_FAILED(`Failed to get installation token: ${errorMessage(error)}`)
      );
    }
  }

  private invalidateCache(): void {
    this.cachedCredentials = undefined;
    clearAppOctokitCache();
  }

  private async resolveTeamId(projectFolderId: string): Promise<string | null> {
    const teamFolder = await this.db.query.teamProjectFolders.findFirst({
      where: eq(teamProjectFolders.projectFolderId, projectFolderId),
    });
    return teamFolder?.teamId ?? null;
  }
}
