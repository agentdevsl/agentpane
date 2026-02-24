import { describe, expect, it, vi } from 'vitest';
import { TemplateErrors } from '../../lib/errors/template-errors.js';
import { TemplateService } from '../template.service.js';

// Mock the GitHub modules
vi.mock('../../lib/github/template-sync.js', () => ({
  parseGitHubUrl: vi.fn((url: string) => {
    const match = url.match(/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/);
    if (match?.[1] && match[2]) {
      return { ok: true, value: { owner: match[1], repo: match[2].replace(/\.git$/, '') } };
    }
    // Simple owner/repo format
    const simpleMatch = url.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (simpleMatch?.[1] && simpleMatch[2]) {
      return { ok: true, value: { owner: simpleMatch[1], repo: simpleMatch[2] } };
    }
    return { ok: false, error: TemplateErrors.INVALID_REPO_URL(url) };
  }),
  syncTemplateFromGitHub: vi.fn(),
}));

vi.mock('../../lib/github/client.js', () => ({
  getInstallationOctokit: vi.fn(),
  createOctokitFromToken: vi.fn(),
}));

vi.mock('../../server/crypto.js', () => ({
  decryptToken: vi.fn(),
}));

const createDbMock = () => ({
  query: {
    templates: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    templateProjects: {
      findMany: vi.fn(),
    },
    githubInstallations: {
      findFirst: vi.fn(),
    },
    githubTokens: {
      findFirst: vi.fn(),
    },
  },
  insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn() })) })) })),
  delete: vi.fn(() => ({ where: vi.fn() })),
});

const sampleTemplate = {
  id: 'tpl-1',
  name: 'Test Template',
  description: 'A test template',
  scope: 'org' as const,
  githubOwner: 'testorg',
  githubRepo: 'template-repo',
  branch: 'main',
  configPath: '.claude',
  projectId: null,
  status: 'active' as const,
  lastSyncSha: null,
  lastSyncedAt: null,
  syncError: null,
  cachedSkills: null,
  cachedCommands: null,
  cachedAgents: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('TemplateService', () => {
  describe('create', () => {
    it('creates an org-scoped template', async () => {
      const db = createDbMock();
      db.query.templates.findFirst.mockResolvedValue(null); // No duplicate

      const newTemplate = { ...sampleTemplate };
      const returning = vi.fn().mockResolvedValue([newTemplate]);
      const values = vi.fn(() => ({ returning }));
      db.insert.mockReturnValue({ values });

      const service = new TemplateService(db as never);
      const result = await service.create({
        name: 'Test Template',
        description: 'A test template',
        scope: 'org',
        githubUrl: 'https://github.com/testorg/template-repo',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Test Template');
        expect(result.value.scope).toBe('org');
        expect(result.value.projectIds).toEqual([]);
      }
    });

    it('creates a project-scoped template with projectId', async () => {
      const db = createDbMock();
      db.query.templates.findFirst.mockResolvedValue(null); // No duplicate

      const projectTemplate = {
        ...sampleTemplate,
        scope: 'project' as const,
        projectId: 'proj-1',
      };
      const returning = vi.fn().mockResolvedValue([projectTemplate]);
      const values = vi.fn(() => ({ returning }));
      db.insert.mockReturnValue({ values });

      const service = new TemplateService(db as never);
      const result = await service.create({
        name: 'Project Template',
        scope: 'project',
        githubUrl: 'testorg/template-repo',
        projectIds: ['proj-1'],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.scope).toBe('project');
        expect(result.value.projectIds).toEqual(['proj-1']);
      }
    });

    it('returns error for duplicate template', async () => {
      const db = createDbMock();
      db.query.templates.findFirst.mockResolvedValue(sampleTemplate); // Duplicate exists

      const service = new TemplateService(db as never);
      const result = await service.create({
        name: 'Test Template',
        scope: 'org',
        githubUrl: 'https://github.com/testorg/template-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TemplateErrors.ALREADY_EXISTS);
      }
    });

    it('returns error for invalid GitHub URL', async () => {
      const db = createDbMock();

      const service = new TemplateService(db as never);
      const result = await service.create({
        name: 'Test Template',
        scope: 'org',
        githubUrl: 'invalid-url',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_INVALID_REPO_URL');
      }
    });

    it('returns error for project-scoped template without projectId', async () => {
      const db = createDbMock();

      const service = new TemplateService(db as never);
      const result = await service.create({
        name: 'Project Template',
        scope: 'project',
        githubUrl: 'testorg/template-repo',
        // No projectIds
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TemplateErrors.PROJECT_REQUIRED);
      }
    });
  });

  describe('getById', () => {
    it('returns template when found', async () => {
      const db = createDbMock();
      db.query.templates.findFirst.mockResolvedValue(sampleTemplate);
      db.query.templateProjects.findMany.mockResolvedValue([]);

      const service = new TemplateService(db as never);
      const result = await service.getById('tpl-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('tpl-1');
        expect(result.value.projectIds).toEqual([]);
      }
    });

    it('returns template with associated project IDs', async () => {
      const db = createDbMock();
      db.query.templates.findFirst.mockResolvedValue(sampleTemplate);
      db.query.templateProjects.findMany.mockResolvedValue([
        { templateId: 'tpl-1', projectId: 'proj-1', createdAt: '2026-01-01T00:00:00Z' },
        { templateId: 'tpl-1', projectId: 'proj-2', createdAt: '2026-01-01T00:00:00Z' },
      ]);

      const service = new TemplateService(db as never);
      const result = await service.getById('tpl-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.projectIds).toEqual(['proj-1', 'proj-2']);
      }
    });

    it('returns NOT_FOUND when template does not exist', async () => {
      const db = createDbMock();
      db.query.templates.findFirst.mockResolvedValue(null);

      const service = new TemplateService(db as never);
      const result = await service.getById('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TemplateErrors.NOT_FOUND);
      }
    });
  });

  describe('list', () => {
    it('returns list of templates', async () => {
      const db = createDbMock();
      db.query.templates.findMany.mockResolvedValue([sampleTemplate]);
      db.query.templateProjects.findMany.mockResolvedValue([]);

      const service = new TemplateService(db as never);
      const result = await service.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.id).toBe('tpl-1');
      }
    });

    it('returns empty list when no templates', async () => {
      const db = createDbMock();
      db.query.templates.findMany.mockResolvedValue([]);

      const service = new TemplateService(db as never);
      const result = await service.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('filters by scope', async () => {
      const db = createDbMock();
      db.query.templates.findMany.mockResolvedValue([sampleTemplate]);
      db.query.templateProjects.findMany.mockResolvedValue([]);

      const service = new TemplateService(db as never);
      await service.list({ scope: 'org' });

      expect(db.query.templates.findMany).toHaveBeenCalled();
    });

    it('filters by projectId via junction table', async () => {
      const db = createDbMock();
      db.query.templateProjects.findMany.mockResolvedValue([
        { templateId: 'tpl-1', projectId: 'proj-1', createdAt: '2026-01-01T00:00:00Z' },
      ]);
      db.query.templates.findMany.mockResolvedValue([sampleTemplate]);

      const service = new TemplateService(db as never);
      const result = await service.list({ projectId: 'proj-1' });

      expect(result.ok).toBe(true);
    });
  });

  describe('update', () => {
    it('updates template fields', async () => {
      const db = createDbMock();
      const updatedTemplate = { ...sampleTemplate, name: 'Updated Name' };

      const returning = vi.fn().mockResolvedValue([updatedTemplate]);
      const updateWhere = vi.fn(() => ({ returning }));
      const updateSet = vi.fn(() => ({ where: updateWhere }));
      db.update.mockReturnValue({ set: updateSet });

      db.query.templateProjects.findMany.mockResolvedValue([]);

      const service = new TemplateService(db as never);
      const result = await service.update('tpl-1', { name: 'Updated Name' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Updated Name');
      }
    });

    it('returns NOT_FOUND when template does not exist', async () => {
      const db = createDbMock();

      const returning = vi.fn().mockResolvedValue([]);
      const updateWhere = vi.fn(() => ({ returning }));
      const updateSet = vi.fn(() => ({ where: updateWhere }));
      db.update.mockReturnValue({ set: updateSet });

      const service = new TemplateService(db as never);
      const result = await service.update('nonexistent', { name: 'Updated' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TemplateErrors.NOT_FOUND);
      }
    });

    it('updates project associations', async () => {
      const db = createDbMock();
      const updatedTemplate = { ...sampleTemplate };

      const returning = vi.fn().mockResolvedValue([updatedTemplate]);
      const updateWhere = vi.fn(() => ({ returning }));
      const updateSet = vi.fn(() => ({ where: updateWhere }));
      db.update.mockReturnValue({ set: updateSet });

      const deleteWhere = vi.fn();
      db.delete.mockReturnValue({ where: deleteWhere });

      const insertValues = vi.fn(() => ({ returning: vi.fn() }));
      db.insert.mockReturnValue({ values: insertValues });

      db.query.templateProjects.findMany.mockResolvedValue([
        { templateId: 'tpl-1', projectId: 'proj-new', createdAt: '2026-01-01T00:00:00Z' },
      ]);

      const service = new TemplateService(db as never);
      const result = await service.update('tpl-1', { projectIds: ['proj-new'] });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.projectIds).toEqual(['proj-new']);
      }
    });
  });

  describe('delete', () => {
    it('deletes template when it exists', async () => {
      const db = createDbMock();
      db.query.templates.findFirst.mockResolvedValue(sampleTemplate);

      const deleteWhere = vi.fn();
      db.delete.mockReturnValue({ where: deleteWhere });

      const service = new TemplateService(db as never);
      const result = await service.delete('tpl-1');

      expect(result.ok).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns NOT_FOUND when template does not exist', async () => {
      const db = createDbMock();
      db.query.templates.findFirst.mockResolvedValue(null);

      const service = new TemplateService(db as never);
      const result = await service.delete('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TemplateErrors.NOT_FOUND);
      }
    });
  });

  describe('findByRepo', () => {
    it('finds templates by repository owner and name', async () => {
      const db = createDbMock();
      db.query.templates.findMany.mockResolvedValue([sampleTemplate]);

      const service = new TemplateService(db as never);
      const result = await service.findByRepo('testorg', 'template-repo');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.githubOwner).toBe('testorg');
        expect(result.value[0]?.githubRepo).toBe('template-repo');
      }
    });

    it('returns empty array when no templates match', async () => {
      const db = createDbMock();
      db.query.templates.findMany.mockResolvedValue([]);

      const service = new TemplateService(db as never);
      const result = await service.findByRepo('unknown', 'repo');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });
});
