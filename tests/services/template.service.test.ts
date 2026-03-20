import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { CachedAgent, CachedCommand, CachedSkill } from '../../src/db/schema';
import { templateProjects, templates } from '../../src/db/schema';
import { TemplateService } from '../../src/services/template.service';
import { createTestProject } from '../factories/project.factory';
import { flushPromises } from '../helpers/async';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// Mock GitHub modules
vi.mock('../../src/lib/github/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/github/client.js')>();
  return {
    ...actual,
    getInstallationOctokit: vi.fn(),
    createOctokitFromToken: vi.fn(),
  };
});

vi.mock('../../src/lib/github/template-sync.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/github/template-sync.js')>();
  return {
    ...original,
    syncTemplateFromGitHub: vi.fn(),
  };
});

vi.mock('../../src/lib/crypto/server-encryption.js', () => ({
  decryptToken: vi.fn().mockResolvedValue('decrypted-token'),
}));

import { githubInstallations, githubTokens } from '../../src/db/schema';
import { TemplateErrors } from '../../src/lib/errors/template-errors';
import { createOctokitFromToken, getInstallationOctokit } from '../../src/lib/github/client.js';
import { parseGitHubUrl, syncTemplateFromGitHub } from '../../src/lib/github/template-sync.js';
import { err, ok } from '../../src/lib/utils/result';

describe('TemplateService', () => {
  let templateService: TemplateService;

  // Helper to clear templates and template-projects tables
  async function clearTemplates() {
    const db = getTestDb();
    await db.delete(templateProjects);
    await db.delete(templates);
    await db.delete(githubInstallations);
    await db.delete(githubTokens);
  }

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    templateService = new TemplateService(db);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await clearTemplates();
    await clearTestDatabase();
  });

  // =============================================================================
  // Template CRUD Operations
  // =============================================================================

  describe('Template CRUD Operations', () => {
    it('creates an org-scoped template with valid GitHub URL', async () => {
      const result = await templateService.create({
        name: 'Org Template',
        description: 'An org-wide template',
        scope: 'org',
        githubUrl: 'https://github.com/acme/claude-templates',
        branch: 'main',
        configPath: '.claude',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Org Template');
        expect(result.value.description).toBe('An org-wide template');
        expect(result.value.scope).toBe('org');
        expect(result.value.githubOwner).toBe('acme');
        expect(result.value.githubRepo).toBe('claude-templates');
        expect(result.value.branch).toBe('main');
        expect(result.value.configPath).toBe('.claude');
        expect(result.value.status).toBe('active');
        expect(result.value.projectIds).toEqual([]);
      }
    });

    it('creates a project-scoped template with project association', async () => {
      const project = await createTestProject();

      const result = await templateService.create({
        name: 'Project Template',
        scope: 'project',
        githubUrl: 'owner/repo',
        projectIds: [project.id],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.scope).toBe('project');
        expect(result.value.projectIds).toEqual([project.id]);
        expect(result.value.projectId).toBe(project.id); // Legacy field
      }
    });

    it('creates template with multiple project associations', async () => {
      const project1 = await createTestProject();
      const project2 = await createTestProject();

      const result = await templateService.create({
        name: 'Multi-Project Template',
        scope: 'project',
        githubUrl: 'owner/repo',
        projectIds: [project1.id, project2.id],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.projectIds).toHaveLength(2);
        expect(result.value.projectIds).toContain(project1.id);
        expect(result.value.projectIds).toContain(project2.id);
      }
    });

    it('creates template with sync interval', async () => {
      const result = await templateService.create({
        name: 'Auto-Sync Template',
        scope: 'org',
        githubUrl: 'owner/repo',
        syncIntervalMinutes: 60,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.syncIntervalMinutes).toBe(60);
        expect(result.value.nextSyncAt).toBeTruthy();
        // Verify next sync is approximately 60 minutes in the future
        const nextSync = new Date(result.value.nextSyncAt!);
        const now = new Date();
        const diffMinutes = (nextSync.getTime() - now.getTime()) / 1000 / 60;
        expect(diffMinutes).toBeGreaterThan(58);
        expect(diffMinutes).toBeLessThan(62);
      }
    });

    it('rejects project-scoped template without project IDs', async () => {
      const result = await templateService.create({
        name: 'Invalid Project Template',
        scope: 'project',
        githubUrl: 'owner/repo',
        projectIds: [],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_PROJECT_REQUIRED');
      }
    });

    it('rejects invalid GitHub URL', async () => {
      const result = await templateService.create({
        name: 'Invalid URL Template',
        scope: 'org',
        githubUrl: 'not-a-valid-url',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_INVALID_REPO_URL');
      }
    });

    it('rejects duplicate template (same owner/repo/scope)', async () => {
      await templateService.create({
        name: 'Original Template',
        scope: 'org',
        githubUrl: 'owner/repo',
      });

      const result = await templateService.create({
        name: 'Duplicate Template',
        scope: 'org',
        githubUrl: 'owner/repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_ALREADY_EXISTS');
      }
    });

    it('retrieves a template by ID', async () => {
      const createResult = await templateService.create({
        name: 'Get Test Template',
        scope: 'org',
        githubUrl: 'owner/repo',
      });
      expect(createResult.ok).toBe(true);

      if (createResult.ok) {
        const getResult = await templateService.getById(createResult.value.id);

        expect(getResult.ok).toBe(true);
        if (getResult.ok) {
          expect(getResult.value.id).toBe(createResult.value.id);
          expect(getResult.value.name).toBe('Get Test Template');
          expect(getResult.value.projectIds).toEqual([]);
        }
      }
    });

    it('returns NOT_FOUND for non-existent template', async () => {
      const result = await templateService.getById('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_NOT_FOUND');
        expect(result.error.status).toBe(404);
      }
    });

    it('updates template properties', async () => {
      const createResult = await templateService.create({
        name: 'Original Name',
        scope: 'org',
        githubUrl: 'owner/repo',
        branch: 'main',
      });
      expect(createResult.ok).toBe(true);

      if (createResult.ok) {
        // Flush microtasks before next operation
        await flushPromises();

        const updateResult = await templateService.update(createResult.value.id, {
          name: 'Updated Name',
          description: 'New description',
          branch: 'develop',
          configPath: '.custom-claude',
        });

        expect(updateResult.ok).toBe(true);
        if (updateResult.ok) {
          expect(updateResult.value.name).toBe('Updated Name');
          expect(updateResult.value.description).toBe('New description');
          expect(updateResult.value.branch).toBe('develop');
          expect(updateResult.value.configPath).toBe('.custom-claude');
          // Verify updatedAt is set (may or may not differ depending on timing)
          expect(updateResult.value.updatedAt).toBeTruthy();
        }
      }
    });

    it('updates template project associations', async () => {
      const project1 = await createTestProject();
      const project2 = await createTestProject();

      const createResult = await templateService.create({
        name: 'Template',
        scope: 'project',
        githubUrl: 'owner/repo',
        projectIds: [project1.id],
      });
      expect(createResult.ok).toBe(true);

      if (createResult.ok) {
        const updateResult = await templateService.update(createResult.value.id, {
          projectIds: [project2.id],
        });

        expect(updateResult.ok).toBe(true);
        if (updateResult.ok) {
          expect(updateResult.value.projectIds).toEqual([project2.id]);
        }
      }
    });

    it('updates sync interval settings', async () => {
      const createResult = await templateService.create({
        name: 'Template',
        scope: 'org',
        githubUrl: 'owner/repo',
      });
      expect(createResult.ok).toBe(true);

      if (createResult.ok) {
        const updateResult = await templateService.update(createResult.value.id, {
          syncIntervalMinutes: 30,
        });

        expect(updateResult.ok).toBe(true);
        if (updateResult.ok) {
          expect(updateResult.value.syncIntervalMinutes).toBe(30);
          expect(updateResult.value.nextSyncAt).toBeTruthy();
        }

        // Disable sync interval
        const disableResult = await templateService.update(createResult.value.id, {
          syncIntervalMinutes: null,
        });

        expect(disableResult.ok).toBe(true);
        if (disableResult.ok) {
          expect(disableResult.value.syncIntervalMinutes).toBeNull();
          expect(disableResult.value.nextSyncAt).toBeNull();
        }
      }
    });

    it('returns NOT_FOUND when updating non-existent template', async () => {
      const result = await templateService.update('non-existent-id', {
        name: 'New Name',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_NOT_FOUND');
      }
    });

    it('deletes a template', async () => {
      const createResult = await templateService.create({
        name: 'Delete Me',
        scope: 'org',
        githubUrl: 'owner/repo',
      });
      expect(createResult.ok).toBe(true);

      if (createResult.ok) {
        const deleteResult = await templateService.delete(createResult.value.id);
        expect(deleteResult.ok).toBe(true);

        const getResult = await templateService.getById(createResult.value.id);
        expect(getResult.ok).toBe(false);
      }
    });

    it('returns NOT_FOUND when deleting non-existent template', async () => {
      const result = await templateService.delete('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Template List Operations
  // =============================================================================

  describe('Template List Operations', () => {
    it('lists all templates', async () => {
      await templateService.create({ name: 'Template 1', scope: 'org', githubUrl: 'owner/repo1' });
      await templateService.create({ name: 'Template 2', scope: 'org', githubUrl: 'owner/repo2' });

      const result = await templateService.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
      }
    });

    it('lists templates filtered by scope', async () => {
      const project = await createTestProject();
      await templateService.create({ name: 'Org 1', scope: 'org', githubUrl: 'owner/org1' });
      await templateService.create({
        name: 'Project 1',
        scope: 'project',
        githubUrl: 'owner/proj1',
        projectIds: [project.id],
      });

      const orgResult = await templateService.list({ scope: 'org' });
      expect(orgResult.ok).toBe(true);
      if (orgResult.ok) {
        expect(orgResult.value).toHaveLength(1);
        expect(orgResult.value[0].scope).toBe('org');
      }

      const projectResult = await templateService.list({ scope: 'project' });
      expect(projectResult.ok).toBe(true);
      if (projectResult.ok) {
        expect(projectResult.value).toHaveLength(1);
        expect(projectResult.value[0].scope).toBe('project');
      }
    });

    it('lists templates filtered by project ID via junction table', async () => {
      const project1 = await createTestProject();
      const project2 = await createTestProject();

      await templateService.create({
        name: 'Project 1 Template',
        scope: 'project',
        githubUrl: 'owner/repo1',
        projectIds: [project1.id],
      });
      await templateService.create({
        name: 'Project 2 Template',
        scope: 'project',
        githubUrl: 'owner/repo2',
        projectIds: [project2.id],
      });

      const result = await templateService.list({ projectId: project1.id });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].name).toBe('Project 1 Template');
      }
    });

    it('lists templates with pagination', async () => {
      // Create multiple templates
      for (let i = 0; i < 5; i++) {
        await templateService.create({
          name: `Template ${i}`,
          scope: 'org',
          githubUrl: `owner/repo${i}`,
        });
      }

      const result = await templateService.list({ limit: 2, offset: 1 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
      }
    });

    it('handles list with no templates matching project ID', async () => {
      const project = await createTestProject();

      const result = await templateService.list({ projectId: project.id });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });

    it('lists templates with scope filter when using junction table', async () => {
      const project = await createTestProject();

      // Create both org and project templates associated with the project
      await templateService.create({
        name: 'Project Template',
        scope: 'project',
        githubUrl: 'owner/proj-repo',
        projectIds: [project.id],
      });

      const result = await templateService.list({
        projectId: project.id,
        scope: 'project',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].scope).toBe('project');
      }
    });

    it('lists templates with scope filter using legacy projectId fallback', async () => {
      const project = await createTestProject();
      const db = getTestDb();

      // Create a template directly in the database with legacy projectId but no junction table entry
      await db.insert(templates).values({
        name: 'Legacy Project Template',
        scope: 'project',
        githubOwner: 'legacy',
        githubRepo: 'repo',
        projectId: project.id,
        status: 'active',
      });

      const result = await templateService.list({
        projectId: project.id,
        scope: 'project',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].name).toBe('Legacy Project Template');
      }
    });
  });

  // =============================================================================
  // Template Sync Operations
  // =============================================================================

  describe('Template Sync Operations', () => {
    const mockOctokit = { rest: {} } as ReturnType<typeof createOctokitFromToken>;
    const mockSyncResult = {
      skills: [{ id: 'skill-1', name: 'Test Skill', content: '# Skill' }] as CachedSkill[],
      commands: [{ name: 'test-cmd', content: '# Command' }] as CachedCommand[],
      agents: [{ name: 'test-agent', content: '# Agent' }] as CachedAgent[],
      sha: 'abc123def456',
    };

    it('syncs template using GitHub App installation', async () => {
      const db = getTestDb();

      // Create a GitHub installation
      await db.insert(githubInstallations).values({
        installationId: '12345',
        accountLogin: 'acme',
        accountType: 'Organization',
        status: 'active',
      });

      (getInstallationOctokit as Mock).mockResolvedValue(mockOctokit);
      (syncTemplateFromGitHub as Mock).mockResolvedValue(ok(mockSyncResult));

      const createResult = await templateService.create({
        name: 'Sync Template',
        scope: 'org',
        githubUrl: 'acme/templates',
      });
      expect(createResult.ok).toBe(true);

      if (createResult.ok) {
        const syncResult = await templateService.sync(createResult.value.id);

        expect(syncResult.ok).toBe(true);
        if (syncResult.ok) {
          expect(syncResult.value.skillCount).toBe(1);
          expect(syncResult.value.commandCount).toBe(1);
          expect(syncResult.value.agentCount).toBe(1);
          expect(syncResult.value.sha).toBe('abc123def456');
        }

        expect(getInstallationOctokit).toHaveBeenCalledWith(12345);
      }
    });

    it('syncs template using PAT when no GitHub App installation', async () => {
      const db = getTestDb();

      // Create a GitHub token
      await db.insert(githubTokens).values({
        encryptedToken: 'encrypted-token',
        login: 'test-user',
        isValid: true,
      });

      (createOctokitFromToken as Mock).mockReturnValue(mockOctokit);
      (syncTemplateFromGitHub as Mock).mockResolvedValue(ok(mockSyncResult));

      const createResult = await templateService.create({
        name: 'Sync Template',
        scope: 'org',
        githubUrl: 'owner/repo',
      });
      expect(createResult.ok).toBe(true);

      if (createResult.ok) {
        const syncResult = await templateService.sync(createResult.value.id);

        expect(syncResult.ok).toBe(true);
        expect(createOctokitFromToken).toHaveBeenCalledWith('decrypted-token');
      }
    });

    it('fails sync when no authentication available', async () => {
      const createResult = await templateService.create({
        name: 'Sync Template',
        scope: 'org',
        githubUrl: 'owner/repo',
      });
      expect(createResult.ok).toBe(true);

      if (createResult.ok) {
        const syncResult = await templateService.sync(createResult.value.id);

        expect(syncResult.ok).toBe(false);
        if (!syncResult.ok) {
          expect(syncResult.error.code).toBe('TEMPLATE_SYNC_FAILED');
          expect(syncResult.error.message).toContain('No GitHub authentication');
        }

        // Verify template status is set to error
        const getResult = await templateService.getById(createResult.value.id);
        expect(getResult.ok).toBe(true);
        if (getResult.ok) {
          expect(getResult.value.status).toBe('error');
          expect(getResult.value.syncError).toContain('No GitHub authentication');
        }
      }
    });

    it('handles sync failure from GitHub API', async () => {
      const db = getTestDb();

      await db.insert(githubInstallations).values({
        installationId: '12345',
        accountLogin: 'acme',
        accountType: 'Organization',
        status: 'active',
      });

      (getInstallationOctokit as Mock).mockResolvedValue(mockOctokit);
      (syncTemplateFromGitHub as Mock).mockResolvedValue(
        err(TemplateErrors.FETCH_FAILED('.claude', 'Not found'))
      );

      const createResult = await templateService.create({
        name: 'Sync Template',
        scope: 'org',
        githubUrl: 'owner/repo',
      });
      expect(createResult.ok).toBe(true);

      if (createResult.ok) {
        const syncResult = await templateService.sync(createResult.value.id);

        expect(syncResult.ok).toBe(false);
        if (!syncResult.ok) {
          expect(syncResult.error.code).toBe('TEMPLATE_FETCH_FAILED');
        }

        // Verify template status is set to error
        const getResult = await templateService.getById(createResult.value.id);
        expect(getResult.ok).toBe(true);
        if (getResult.ok) {
          expect(getResult.value.status).toBe('error');
        }
      }
    });

    it('handles exception during sync', async () => {
      const db = getTestDb();

      await db.insert(githubInstallations).values({
        installationId: '12345',
        accountLogin: 'acme',
        accountType: 'Organization',
        status: 'active',
      });

      (getInstallationOctokit as Mock).mockRejectedValue(new Error('Network error'));

      const createResult = await templateService.create({
        name: 'Sync Template',
        scope: 'org',
        githubUrl: 'owner/repo',
      });
      expect(createResult.ok).toBe(true);

      if (createResult.ok) {
        const syncResult = await templateService.sync(createResult.value.id);

        expect(syncResult.ok).toBe(false);
        if (!syncResult.ok) {
          expect(syncResult.error.code).toBe('TEMPLATE_SYNC_FAILED');
          expect(syncResult.error.message).toContain('Network error');
        }
      }
    });

    it('returns NOT_FOUND when syncing non-existent template', async () => {
      const result = await templateService.sync('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_NOT_FOUND');
      }
    });
  });

  // =============================================================================
  // Sync All Templates
  // =============================================================================

  describe('Sync All Templates', () => {
    const mockOctokit = { rest: {} } as ReturnType<typeof createOctokitFromToken>;
    const mockSyncResult = {
      skills: [] as CachedSkill[],
      commands: [] as CachedCommand[],
      agents: [] as CachedAgent[],
      sha: 'abc123',
    };

    it('syncs all templates of a given scope', async () => {
      const db = getTestDb();

      await db.insert(githubInstallations).values({
        installationId: '12345',
        accountLogin: 'acme',
        accountType: 'Organization',
        status: 'active',
      });

      (getInstallationOctokit as Mock).mockResolvedValue(mockOctokit);
      (syncTemplateFromGitHub as Mock).mockResolvedValue(ok(mockSyncResult));

      await templateService.create({ name: 'Org 1', scope: 'org', githubUrl: 'owner/repo1' });
      await templateService.create({ name: 'Org 2', scope: 'org', githubUrl: 'owner/repo2' });

      const result = await templateService.syncAll('org');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.successes).toHaveLength(2);
        expect(result.value.failures).toHaveLength(0);
      }
    });

    it('returns failures for templates that fail to sync', async () => {
      const db = getTestDb();

      await db.insert(githubInstallations).values({
        installationId: '12345',
        accountLogin: 'acme',
        accountType: 'Organization',
        status: 'active',
      });

      (getInstallationOctokit as Mock).mockResolvedValue(mockOctokit);
      // First call succeeds, second fails
      (syncTemplateFromGitHub as Mock)
        .mockResolvedValueOnce(ok(mockSyncResult))
        .mockResolvedValueOnce(err(TemplateErrors.FETCH_FAILED('.claude', 'Not found')));

      await templateService.create({ name: 'Success', scope: 'org', githubUrl: 'owner/repo1' });
      await templateService.create({ name: 'Failure', scope: 'org', githubUrl: 'owner/repo2' });

      const result = await templateService.syncAll('org');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.successes).toHaveLength(1);
        expect(result.value.failures).toHaveLength(1);
        expect(result.value.failures[0].templateName).toBe('Failure');
      }
    });

    it('filters syncAll by project ID', async () => {
      const project = await createTestProject();
      const db = getTestDb();

      await db.insert(githubInstallations).values({
        installationId: '12345',
        accountLogin: 'acme',
        accountType: 'Organization',
        status: 'active',
      });

      (getInstallationOctokit as Mock).mockResolvedValue(mockOctokit);
      (syncTemplateFromGitHub as Mock).mockResolvedValue(ok(mockSyncResult));

      await templateService.create({
        name: 'Project Template',
        scope: 'project',
        githubUrl: 'owner/repo1',
        projectIds: [project.id],
      });

      const result = await templateService.syncAll('project', project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.successes).toHaveLength(1);
      }
    });
  });

  // =============================================================================
  // Merged Configuration
  // =============================================================================

  describe('Merged Configuration', () => {
    it('returns merged config with org and project templates', async () => {
      const project = await createTestProject();
      const db = getTestDb();

      // Create org template with cached content
      const orgCreateResult = await templateService.create({
        name: 'Org Template',
        scope: 'org',
        githubUrl: 'org/templates',
      });
      expect(orgCreateResult.ok).toBe(true);
      if (orgCreateResult.ok) {
        await db
          .update(templates)
          .set({
            cachedSkills: [{ id: 'org-skill', name: 'Org Skill', content: '# Org' }],
            cachedCommands: [{ name: 'org-cmd', content: '# Org Cmd' }],
            cachedAgents: [{ name: 'org-agent', content: '# Org Agent' }],
          })
          .where(eq(templates.id, orgCreateResult.value.id));
      }

      // Create project template with cached content
      const projCreateResult = await templateService.create({
        name: 'Project Template',
        scope: 'project',
        githubUrl: 'proj/templates',
        projectIds: [project.id],
      });
      expect(projCreateResult.ok).toBe(true);
      if (projCreateResult.ok) {
        await db
          .update(templates)
          .set({
            cachedSkills: [{ id: 'proj-skill', name: 'Project Skill', content: '# Proj' }],
            cachedCommands: [],
            cachedAgents: [],
          })
          .where(eq(templates.id, projCreateResult.value.id));
      }

      const result = await templateService.getMergedConfig(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skills).toHaveLength(2);
        expect(result.value.commands).toHaveLength(1);
        expect(result.value.agents).toHaveLength(1);
      }
    });

    it('applies local config with highest precedence', async () => {
      const project = await createTestProject();
      const db = getTestDb();

      // Create org template with cached content
      const orgCreateResult = await templateService.create({
        name: 'Org Template',
        scope: 'org',
        githubUrl: 'org/templates',
      });
      expect(orgCreateResult.ok).toBe(true);
      if (orgCreateResult.ok) {
        await db
          .update(templates)
          .set({
            cachedSkills: [{ id: 'shared-skill', name: 'Org Version', content: '# Org' }],
          })
          .where(eq(templates.id, orgCreateResult.value.id));
      }

      const localConfig = {
        skills: [{ id: 'shared-skill', name: 'Local Version', content: '# Local' }],
        commands: [],
        agents: [],
      };

      const result = await templateService.getMergedConfig(project.id, localConfig);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skills).toHaveLength(1);
        expect(result.value.skills[0].name).toBe('Local Version');
        expect(result.value.skills[0].sourceType).toBe('local');
      }
    });
  });

  // =============================================================================
  // Find by Repository
  // =============================================================================

  describe('Find by Repository', () => {
    it('finds templates by GitHub owner and repo', async () => {
      await templateService.create({
        name: 'Template 1',
        scope: 'org',
        githubUrl: 'acme/templates',
      });
      await templateService.create({
        name: 'Template 2',
        scope: 'org',
        githubUrl: 'other/repo',
      });

      const result = await templateService.findByRepo('acme', 'templates');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].name).toBe('Template 1');
      }
    });

    it('returns empty array when no templates match', async () => {
      const result = await templateService.findByRepo('nonexistent', 'repo');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });
  });

  // =============================================================================
  // Project IDs Support
  // =============================================================================

  describe('Project IDs Support', () => {
    it('supports projectIds array parameter in create', async () => {
      const project = await createTestProject();

      const result = await templateService.create({
        name: 'Template with ProjectIds',
        scope: 'project',
        githubUrl: 'owner/repo',
        projectIds: [project.id],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.projectIds).toEqual([project.id]);
      }
    });
  });

  // =============================================================================
  // URL Parsing (via parseGitHubUrl)
  // =============================================================================

  describe('GitHub URL Parsing', () => {
    it('parses owner/repo format', () => {
      const result = parseGitHubUrl('acme/my-repo');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe('acme');
        expect(result.value.repo).toBe('my-repo');
      }
    });

    it('parses HTTPS URL', () => {
      const result = parseGitHubUrl('https://github.com/acme/my-repo.git');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe('acme');
        expect(result.value.repo).toBe('my-repo');
      }
    });

    it('parses SSH URL', () => {
      const result = parseGitHubUrl('git@github.com:acme/my-repo.git');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe('acme');
        expect(result.value.repo).toBe('my-repo');
      }
    });

    it('rejects invalid URL', () => {
      const result = parseGitHubUrl('not-a-valid-url');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_INVALID_REPO_URL');
      }
    });
  });
});
