import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codespaces,
  eventSources,
  eventSubscriptions,
  githubInstallations,
  projectFolders,
  teams,
} from '../../src/db/schema';
import { buildInstallUrl, GitHubAppService } from '../../src/services/github-app.service';
import { SettingsService } from '../../src/services/settings.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('GitHubAppService Integration Tests', () => {
  let db: ReturnType<typeof getTestDb>;
  let settingsService: SettingsService;
  let service: GitHubAppService;
  let teamId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    settingsService = new SettingsService(db as any);
    service = new GitHubAppService(db as any, settingsService);

    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Test Team',
      slug: `test-team-${teamId.slice(0, 6)}`,
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // -------------------------------------------------------------------------
  // Credential management
  // -------------------------------------------------------------------------

  describe('credential management', () => {
    it('returns not configured when no credentials stored', async () => {
      const configured = await service.isConfigured();
      expect(configured).toBe(false);

      const creds = await service.getCredentials();
      expect(creds).toBeNull();
    });

    it('stores and retrieves credentials', async () => {
      const result = await service.saveCredentials({
        appId: '12345',
        appSlug: 'test-app',
        privateKey: 'test-private-key-pem',
        webhookSecret: 'whsec_test123',
        clientId: 'Iv1.abc',
        clientSecret: 'secret_abc',
      });
      expect(result.ok).toBe(true);

      const configured = await service.isConfigured();
      expect(configured).toBe(true);

      const creds = await service.getCredentials();
      expect(creds).not.toBeNull();
      expect(creds!.appId).toBe('12345');
      expect(creds!.appSlug).toBe('test-app');
      expect(creds!.privateKey).toBe('test-private-key-pem');
      expect(creds!.webhookSecret).toBe('whsec_test123');
      expect(creds!.clientId).toBe('Iv1.abc');
      expect(creds!.clientSecret).toBe('secret_abc');
    });

    it('encrypts sensitive fields in settings table', async () => {
      await service.saveCredentials({
        appId: '12345',
        appSlug: 'test-app',
        privateKey: 'test-private-key-pem',
        webhookSecret: 'whsec_test123',
        clientId: 'Iv1.abc',
        clientSecret: 'secret_abc',
      });

      // Read raw from settings table
      const raw = await settingsService.get('github.app.credentials');
      expect(raw.ok).toBe(true);
      const stored = JSON.parse(raw.value!.value) as Record<string, string>;

      // Non-sensitive fields stored as-is
      expect(stored.appId).toBe('12345');
      expect(stored.appSlug).toBe('test-app');
      expect(stored.clientId).toBe('Iv1.abc');

      // Sensitive fields are encrypted (not plaintext)
      expect(stored.privateKey).not.toBe('test-private-key-pem');
      expect(stored.privateKey.length).toBeGreaterThan(20);
      expect(stored.webhookSecret).not.toBe('whsec_test123');
      expect(stored.clientSecret).not.toBe('secret_abc');
    });

    it('caches credentials after first load', async () => {
      await service.saveCredentials({
        appId: '12345',
        appSlug: 'test-app',
        privateKey: 'key1',
        webhookSecret: 'sec1',
        clientId: 'c1',
        clientSecret: 'cs1',
      });

      const creds1 = await service.getCredentials();
      const creds2 = await service.getCredentials();
      // Same reference means cache was used
      expect(creds1).toBe(creds2);
    });

    it('invalidates cache on save', async () => {
      await service.saveCredentials({
        appId: '111',
        appSlug: 'app-v1',
        privateKey: 'key-v1',
        webhookSecret: '',
        clientId: '',
        clientSecret: '',
      });

      const creds1 = await service.getCredentials();
      expect(creds1!.appId).toBe('111');

      await service.saveCredentials({
        appId: '222',
        appSlug: 'app-v2',
        privateKey: 'key-v2',
        webhookSecret: '',
        clientId: '',
        clientSecret: '',
      });

      const creds2 = await service.getCredentials();
      expect(creds2!.appId).toBe('222');
    });

    it('deletes credentials and returns not configured', async () => {
      await service.saveCredentials({
        appId: '12345',
        appSlug: 'test-app',
        privateKey: 'key',
        webhookSecret: '',
        clientId: '',
        clientSecret: '',
      });

      expect(await service.isConfigured()).toBe(true);

      const result = await service.deleteCredentials();
      expect(result.ok).toBe(true);

      expect(await service.isConfigured()).toBe(false);
      expect(await service.getCredentials()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Installation management
  // -------------------------------------------------------------------------

  describe('handleInstallation', () => {
    it('creates a new installation record', async () => {
      const result = await service.handleInstallation(100, 'test-org', 'Organization', teamId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.installationId).toBe('100');
      expect(result.value.accountLogin).toBe('test-org');
      expect(result.value.accountType).toBe('Organization');
      expect(result.value.teamId).toBe(teamId);
      expect(result.value.status).toBe('active');
    });

    it('upserts existing installation (updates on duplicate installationId)', async () => {
      await service.handleInstallation(100, 'old-name', 'User');

      const result = await service.handleInstallation(100, 'new-name', 'Organization', teamId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.accountLogin).toBe('new-name');
      expect(result.value.accountType).toBe('Organization');
      expect(result.value.teamId).toBe(teamId);

      // Only one record should exist
      const all = await db.query.githubInstallations.findMany();
      expect(all.length).toBe(1);
    });

    it('creates installation without teamId when not provided', async () => {
      const result = await service.handleInstallation(200, 'no-team-org', 'Organization');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.teamId).toBeNull();
    });
  });

  describe('handleUninstall', () => {
    it('marks installation as removed and disables event sources', async () => {
      const instResult = await service.handleInstallation(100, 'test-org', 'Organization', teamId);
      expect(instResult.ok).toBe(true);
      if (!instResult.ok) return;
      const installationDbId = instResult.value.id;

      // Create an event source linked to this installation
      await db.insert(eventSources).values({
        id: createId(),
        teamId,
        name: 'Test Source',
        type: 'github',
        slug: `test-source-${createId().slice(0, 6)}`,
        isEnabled: true,
        config: {},
        eventCount: 0,
        githubInstallationId: installationDbId,
        status: 'active',
      });

      const result = await service.handleUninstall(100);
      expect(result.ok).toBe(true);

      // Installation marked as removed
      const inst = await db.query.githubInstallations.findFirst({
        where: eq(githubInstallations.installationId, '100'),
      });
      expect(inst?.status).toBe('removed');

      // Event source disabled
      const sources = await db.query.eventSources.findMany({
        where: eq(eventSources.githubInstallationId, installationDbId),
      });
      expect(sources.length).toBe(1);
      expect(sources[0]!.isEnabled).toBe(false);
      expect(sources[0]!.status).toBe('disabled');
    });

    it('handles uninstall for unknown installation gracefully', async () => {
      const result = await service.handleUninstall(999);
      expect(result.ok).toBe(true);
    });
  });

  describe('listInstallations', () => {
    it('lists active installations for a team', async () => {
      await service.handleInstallation(100, 'org-a', 'Organization', teamId);
      await service.handleInstallation(200, 'org-b', 'Organization', teamId);

      const result = await service.listInstallations(teamId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });

    it('excludes removed installations', async () => {
      await service.handleInstallation(100, 'active-org', 'Organization', teamId);
      await service.handleInstallation(200, 'removed-org', 'Organization', teamId);
      await service.handleUninstall(200);

      const result = await service.listInstallations(teamId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0]!.accountLogin).toBe('active-org');
    });
  });

  // -------------------------------------------------------------------------
  // Auto-configure events for codespace
  // -------------------------------------------------------------------------

  describe('autoConfigureEventsForCodespace', () => {
    it('returns nulls when codespace has no githubOwner', async () => {
      const codespace = await createTestProject({ name: 'No GitHub' });

      const result = await service.autoConfigureEventsForCodespace(codespace.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.eventSourceId).toBeNull();
      expect(result.value.subscriptionId).toBeNull();
    });

    it('returns nulls when no matching installation exists', async () => {
      const codespace = await createTestProject({
        name: 'Unmatched',
        githubOwner: 'unknown-org',
        githubRepo: 'repo',
      });

      const result = await service.autoConfigureEventsForCodespace(codespace.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.eventSourceId).toBeNull();
    });

    it('creates event source and subscription when installation matches', async () => {
      // Ensure the project folder has a team association
      const folderId = 'default-folder';
      try {
        await db.update(projectFolders).set({ teamId }).where(eq(projectFolders.id, folderId));
      } catch {
        // May not have teamId column in test schema
      }

      await service.handleInstallation(100, 'my-org', 'Organization', teamId);

      const codespace = await createTestProject({
        name: 'My Repo',
        githubOwner: 'my-org',
        githubRepo: 'my-repo',
        projectFolderId: folderId,
      });

      const result = await service.autoConfigureEventsForCodespace(codespace.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.eventSourceId).toBeTruthy();
      expect(result.value.subscriptionId).toBeTruthy();
      expect(result.value.installationId).toBeTruthy();

      // Verify event source was created in DB
      const source = await db.query.eventSources.findFirst({
        where: eq(eventSources.id, result.value.eventSourceId!),
      });
      expect(source).toBeTruthy();
      expect(source!.type).toBe('github');
      expect(source!.name).toBe('GitHub (my-org)');
      expect(source!.teamId).toBe(teamId);

      // Verify subscription was created
      const sub = await db.query.eventSubscriptions.findFirst({
        where: eq(eventSubscriptions.id, result.value.subscriptionId!),
      });
      expect(sub).toBeTruthy();
      expect(sub!.targetCodespaceId).toBe(codespace.id);
      expect(sub!.eventTypes).toEqual(['issues', 'pull_request', 'push']);
      expect(sub!.name).toBe('Auto: My Repo');

      // Verify codespace was linked to installation
      const updated = await db.query.codespaces.findFirst({
        where: eq(codespaces.id, codespace.id),
      });
      expect(updated!.githubInstallationId).toBe(result.value.installationId);
    });

    it('reuses existing event source on second call', async () => {
      await service.handleInstallation(100, 'my-org', 'Organization', teamId);

      const codespace1 = await createTestProject({
        name: 'Repo 1',
        githubOwner: 'my-org',
        githubRepo: 'repo-1',
      });
      const codespace2 = await createTestProject({
        name: 'Repo 2',
        githubOwner: 'my-org',
        githubRepo: 'repo-2',
      });

      const result1 = await service.autoConfigureEventsForCodespace(codespace1.id);
      const result2 = await service.autoConfigureEventsForCodespace(codespace2.id);

      expect(result1.ok && result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      // Same event source, different subscriptions
      expect(result1.value.eventSourceId).toBe(result2.value.eventSourceId);
      expect(result1.value.subscriptionId).not.toBe(result2.value.subscriptionId);
    });

    it('is idempotent — does not create duplicates on repeated calls', async () => {
      await service.handleInstallation(100, 'my-org', 'Organization', teamId);
      const codespace = await createTestProject({
        name: 'Idempotent',
        githubOwner: 'my-org',
        githubRepo: 'repo',
      });

      const result1 = await service.autoConfigureEventsForCodespace(codespace.id);
      const result2 = await service.autoConfigureEventsForCodespace(codespace.id);

      expect(result1.ok && result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      expect(result1.value.eventSourceId).toBe(result2.value.eventSourceId);
      expect(result1.value.subscriptionId).toBe(result2.value.subscriptionId);
    });
  });

  // -------------------------------------------------------------------------
  // removeInstallation
  // -------------------------------------------------------------------------

  describe('removeInstallation', () => {
    it('deletes installation and cleans up linked resources', async () => {
      const instResult = await service.handleInstallation(100, 'rm-org', 'Organization', teamId);
      expect(instResult.ok).toBe(true);
      if (!instResult.ok) return;
      const instId = instResult.value.id;

      // Create linked event source
      const sourceId = createId();
      await db.insert(eventSources).values({
        id: sourceId,
        teamId,
        name: 'Linked Source',
        type: 'github',
        slug: `linked-${sourceId.slice(0, 6)}`,
        isEnabled: true,
        config: {},
        eventCount: 0,
        githubInstallationId: instId,
        status: 'active',
      });

      // Create linked codespace
      const codespace = await createTestProject({
        name: 'Linked CS',
        githubInstallationId: instId,
      });

      const result = await service.removeInstallation(instId);
      expect(result.ok).toBe(true);

      // Installation deleted
      const inst = await db.query.githubInstallations.findFirst({
        where: eq(githubInstallations.id, instId),
      });
      expect(inst).toBeUndefined();

      // Event source disabled and unlinked
      const source = await db.query.eventSources.findFirst({
        where: eq(eventSources.id, sourceId),
      });
      expect(source!.isEnabled).toBe(false);
      expect(source!.githubInstallationId).toBeNull();

      // Codespace unlinked
      const cs = await db.query.codespaces.findFirst({
        where: eq(codespaces.id, codespace.id),
      });
      expect(cs!.githubInstallationId).toBeNull();
    });

    it('returns error for non-existent installation', async () => {
      const result = await service.removeInstallation('nonexistent-id');
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // buildInstallUrl helper
  // -------------------------------------------------------------------------

  describe('buildInstallUrl', () => {
    it('builds correct GitHub App install URL', () => {
      expect(buildInstallUrl('my-app')).toBe('https://github.com/apps/my-app/installations/new');
    });

    it('encodes special characters in slug', () => {
      expect(buildInstallUrl('app with spaces')).toBe(
        'https://github.com/apps/app%20with%20spaces/installations/new'
      );
    });
  });
});
