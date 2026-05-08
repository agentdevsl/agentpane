import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { templateCodespaces, templates } from '../../src/db/schema';
import { TemplateService } from '../../src/services/template.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('TemplateService — DB-level integration tests', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    // Clear template tables before each test (not in clearTestDatabase by default)
    const db = getTestDb();
    await db.delete(templateCodespaces);
    await db.delete(templates);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-131: inserts template with githubOwner and githubRepo', async () => {
    const db = getTestDb();
    const now = new Date().toISOString();

    const [template] = await db
      .insert(templates)
      .values({
        id: createId(),
        name: 'My Terraform Template',
        description: 'IaC template for AWS',
        scope: 'org',
        githubOwner: 'my-org',
        githubRepo: 'terraform-modules',
        branch: 'main',
        configPath: '.claude',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    expect(template).toBeTruthy();
    expect(template!.name).toBe('My Terraform Template');
    expect(template!.githubOwner).toBe('my-org');
    expect(template!.githubRepo).toBe('terraform-modules');
    expect(template!.scope).toBe('org');
    expect(template!.status).toBe('active');
  });

  it('IT-132: inserts codespace-scoped template with junction record', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const now = new Date().toISOString();

    const [template] = await db
      .insert(templates)
      .values({
        id: createId(),
        name: 'Project Template',
        scope: 'codespace',
        githubOwner: 'team-org',
        githubRepo: 'project-template',
        codespaceId: project.id,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    expect(template).toBeTruthy();

    // Insert junction record
    await db.insert(templateCodespaces).values({
      templateId: template!.id,
      codespaceId: project.id,
      createdAt: now,
    });

    const junctions = await db.query.templateCodespaces.findMany({
      where: eq(templateCodespaces.templateId, template!.id),
    });

    expect(junctions).toHaveLength(1);
    expect(junctions[0]?.codespaceId).toBe(project.id);
  });

  it('IT-133: inserts two templates with same owner/repo but different scopes', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const now = new Date().toISOString();

    const [orgTemplate] = await db
      .insert(templates)
      .values({
        id: createId(),
        name: 'Org Template',
        scope: 'org',
        githubOwner: 'shared-org',
        githubRepo: 'base-config',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [csTemplate] = await db
      .insert(templates)
      .values({
        id: createId(),
        name: 'Codespace Template',
        scope: 'codespace',
        githubOwner: 'shared-org',
        githubRepo: 'base-config',
        codespaceId: project.id,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    expect(orgTemplate).toBeTruthy();
    expect(csTemplate).toBeTruthy();
    expect(orgTemplate!.scope).toBe('org');
    expect(csTemplate!.scope).toBe('codespace');

    // Both stored successfully
    const allTemplates = await db.query.templates.findMany({
      where: and(eq(templates.githubOwner, 'shared-org'), eq(templates.githubRepo, 'base-config')),
    });
    expect(allTemplates).toHaveLength(2);
  });

  it('IT-134: queries template with its codespace associations via junction', async () => {
    const db = getTestDb();
    const project1 = await createTestProject({ name: 'Project Alpha' });
    const project2 = await createTestProject({ name: 'Project Beta' });
    const now = new Date().toISOString();

    const [template] = await db
      .insert(templates)
      .values({
        id: createId(),
        name: 'Multi-project Template',
        scope: 'codespace',
        githubOwner: 'org',
        githubRepo: 'multi-template',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await db.insert(templateCodespaces).values([
      { templateId: template!.id, codespaceId: project1.id, createdAt: now },
      { templateId: template!.id, codespaceId: project2.id, createdAt: now },
    ]);

    const associations = await db.query.templateCodespaces.findMany({
      where: eq(templateCodespaces.templateId, template!.id),
    });
    const codespaceIds = associations.map((a) => a.codespaceId);

    expect(codespaceIds).toHaveLength(2);
    expect(codespaceIds).toContain(project1.id);
    expect(codespaceIds).toContain(project2.id);
  });

  it('IT-135: filters templates by scope', async () => {
    const db = getTestDb();
    const now = new Date().toISOString();

    await db.insert(templates).values([
      {
        id: createId(),
        name: 'Org 1',
        scope: 'org',
        githubOwner: 'o1',
        githubRepo: 'r1',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: createId(),
        name: 'Org 2',
        scope: 'org',
        githubOwner: 'o2',
        githubRepo: 'r2',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: createId(),
        name: 'CS 1',
        scope: 'codespace',
        githubOwner: 'c1',
        githubRepo: 'r3',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const orgTemplates = await db.query.templates.findMany({
      where: eq(templates.scope, 'org'),
    });
    expect(orgTemplates).toHaveLength(2);

    const csTemplates = await db.query.templates.findMany({
      where: eq(templates.scope, 'codespace'),
    });
    expect(csTemplates).toHaveLength(1);
    expect(csTemplates[0]?.name).toBe('CS 1');
  });

  it('IT-136: queries templates by codespaceId via junction table', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const otherProject = await createTestProject({ name: 'Other' });
    const now = new Date().toISOString();

    const [template1] = await db
      .insert(templates)
      .values({
        id: createId(),
        name: 'Template for project',
        scope: 'codespace',
        githubOwner: 'org',
        githubRepo: 'tmpl1',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [template2] = await db
      .insert(templates)
      .values({
        id: createId(),
        name: 'Template for other',
        scope: 'codespace',
        githubOwner: 'org',
        githubRepo: 'tmpl2',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await db.insert(templateCodespaces).values([
      { templateId: template1!.id, codespaceId: project.id, createdAt: now },
      { templateId: template2!.id, codespaceId: otherProject.id, createdAt: now },
    ]);

    // Query by codespaceId
    const junctions = await db.query.templateCodespaces.findMany({
      where: eq(templateCodespaces.codespaceId, project.id),
    });

    expect(junctions).toHaveLength(1);
    expect(junctions[0]?.templateId).toBe(template1!.id);
  });

  it('IT-137: replaces junction entries (delete old, insert new)', async () => {
    const db = getTestDb();
    const project1 = await createTestProject({ name: 'P1' });
    const project2 = await createTestProject({ name: 'P2' });
    const project3 = await createTestProject({ name: 'P3' });
    const now = new Date().toISOString();

    const [template] = await db
      .insert(templates)
      .values({
        id: createId(),
        name: 'Updateable Template',
        scope: 'codespace',
        githubOwner: 'org',
        githubRepo: 'tmpl-update',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Initial associations
    await db.insert(templateCodespaces).values([
      { templateId: template!.id, codespaceId: project1.id, createdAt: now },
      { templateId: template!.id, codespaceId: project2.id, createdAt: now },
    ]);

    let associations = await db.query.templateCodespaces.findMany({
      where: eq(templateCodespaces.templateId, template!.id),
    });
    expect(associations).toHaveLength(2);

    // Replace: delete old, insert new
    await db.delete(templateCodespaces).where(eq(templateCodespaces.templateId, template!.id));
    await db.insert(templateCodespaces).values([
      { templateId: template!.id, codespaceId: project2.id, createdAt: now },
      { templateId: template!.id, codespaceId: project3.id, createdAt: now },
    ]);

    associations = await db.query.templateCodespaces.findMany({
      where: eq(templateCodespaces.templateId, template!.id),
    });
    expect(associations).toHaveLength(2);
    const ids = associations.map((a) => a.codespaceId);
    expect(ids).toContain(project2.id);
    expect(ids).toContain(project3.id);
    expect(ids).not.toContain(project1.id);
  });

  it('IT-138: updates template syncStatus through lifecycle', async () => {
    const db = getTestDb();
    const now = new Date().toISOString();

    const [template] = await db
      .insert(templates)
      .values({
        id: createId(),
        name: 'Syncing Template',
        scope: 'org',
        githubOwner: 'org',
        githubRepo: 'sync-test',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    expect(template!.status).toBe('active');

    // Transition: active → syncing
    await db.update(templates).set({ status: 'syncing' }).where(eq(templates.id, template!.id));

    let dbTemplate = await db.query.templates.findFirst({ where: eq(templates.id, template!.id) });
    expect(dbTemplate?.status).toBe('syncing');

    // Transition: syncing → active (successful sync)
    await db
      .update(templates)
      .set({
        status: 'active',
        lastSyncSha: 'abc123def',
        lastSyncedAt: now,
        syncError: null,
      })
      .where(eq(templates.id, template!.id));

    dbTemplate = await db.query.templates.findFirst({ where: eq(templates.id, template!.id) });
    expect(dbTemplate?.status).toBe('active');
    expect(dbTemplate?.lastSyncSha).toBe('abc123def');
    expect(dbTemplate?.syncError).toBeNull();

    // Transition: active → syncing → error
    await db.update(templates).set({ status: 'syncing' }).where(eq(templates.id, template!.id));

    await db
      .update(templates)
      .set({
        status: 'error',
        syncError: 'GitHub rate limit exceeded',
      })
      .where(eq(templates.id, template!.id));

    dbTemplate = await db.query.templates.findFirst({ where: eq(templates.id, template!.id) });
    expect(dbTemplate?.status).toBe('error');
    expect(dbTemplate?.syncError).toBe('GitHub rate limit exceeded');
  });

  it('IT-139: parallel template status tracking is independent', async () => {
    const db = getTestDb();
    const now = new Date().toISOString();

    const templateIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [t] = await db
        .insert(templates)
        .values({
          id: createId(),
          name: `Template ${i}`,
          scope: 'org',
          githubOwner: 'org',
          githubRepo: `repo-${i}`,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      templateIds.push(t!.id);
    }

    // Simulate parallel sync: set all to syncing
    for (const id of templateIds) {
      await db.update(templates).set({ status: 'syncing' }).where(eq(templates.id, id));
    }

    // Template 0: success, Template 1: error, Template 2: success
    await db
      .update(templates)
      .set({ status: 'active', lastSyncSha: 'sha-0' })
      .where(eq(templates.id, templateIds[0]!));

    await db
      .update(templates)
      .set({ status: 'error', syncError: 'Repo not found' })
      .where(eq(templates.id, templateIds[1]!));

    await db
      .update(templates)
      .set({ status: 'active', lastSyncSha: 'sha-2' })
      .where(eq(templates.id, templateIds[2]!));

    const t0 = await db.query.templates.findFirst({ where: eq(templates.id, templateIds[0]!) });
    const t1 = await db.query.templates.findFirst({ where: eq(templates.id, templateIds[1]!) });
    const t2 = await db.query.templates.findFirst({ where: eq(templates.id, templateIds[2]!) });

    expect(t0?.status).toBe('active');
    expect(t0?.lastSyncSha).toBe('sha-0');
    expect(t1?.status).toBe('error');
    expect(t1?.syncError).toBe('Repo not found');
    expect(t2?.status).toBe('active');
    expect(t2?.lastSyncSha).toBe('sha-2');
  });

  it('IT-140: org and codespace template merge precedence at data level', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const now = new Date().toISOString();

    // Create org template with cached skills
    await db
      .insert(templates)
      .values({
        id: createId(),
        name: 'Org Base',
        scope: 'org',
        githubOwner: 'org',
        githubRepo: 'org-base',
        status: 'active',
        cachedSkills: [{ id: 'skill-1', name: 'Terraform', content: 'tf content' }],
        cachedCommands: [{ name: 'deploy', content: 'deploy cmd' }],
        cachedAgents: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Create codespace template with overlapping skill
    const [csTemplate] = await db
      .insert(templates)
      .values({
        id: createId(),
        name: 'Project Override',
        scope: 'codespace',
        githubOwner: 'org',
        githubRepo: 'project-override',
        codespaceId: project.id,
        status: 'active',
        cachedSkills: [{ id: 'skill-1', name: 'Terraform', content: 'overridden tf content' }],
        cachedCommands: [],
        cachedAgents: [{ name: 'test-agent', content: 'agent content' }],
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await db.insert(templateCodespaces).values({
      templateId: csTemplate!.id,
      codespaceId: project.id,
      createdAt: now,
    });

    // Retrieve both scopes
    const orgTemplates = await db.query.templates.findMany({
      where: and(eq(templates.scope, 'org'), eq(templates.status, 'active')),
    });
    const projectTemplates = await db.query.templates.findMany({
      where: and(
        eq(templates.scope, 'codespace'),
        eq(templates.codespaceId, project.id),
        eq(templates.status, 'active')
      ),
    });

    expect(orgTemplates).toHaveLength(1);
    expect(projectTemplates).toHaveLength(1);

    // Verify codespace template overrides org for same skill ID
    const orgSkills = orgTemplates[0]?.cachedSkills ?? [];
    const csSkills = projectTemplates[0]?.cachedSkills ?? [];

    expect(orgSkills).toHaveLength(1);
    expect(csSkills).toHaveLength(1);
    expect(orgSkills[0]?.id).toBe('skill-1');
    expect(csSkills[0]?.id).toBe('skill-1');
    // Codespace version has different content
    expect(csSkills[0]?.content).toBe('overridden tf content');
    expect(orgSkills[0]?.content).toBe('tf content');

    // Codespace template also has agents that org does not
    const csAgents = projectTemplates[0]?.cachedAgents ?? [];
    expect(csAgents).toHaveLength(1);
    expect(csAgents[0]?.name).toBe('test-agent');
  });
  describe('TemplateService real service integration', () => {
    it('IT-143: creates, lists, updates, and deletes codespace associations through TemplateService', async () => {
      const db = getTestDb();
      const service = new TemplateService(db as any);
      const project1 = await createTestProject({ name: 'Template Service One' });
      const project2 = await createTestProject({ name: 'Template Service Two' });
      const project3 = await createTestProject({ name: 'Template Service Three' });

      const created = await service.create({
        name: 'Service-backed Template',
        scope: 'codespace',
        githubUrl: 'acme/service-template',
        codespaceIds: [project1.id, project2.id],
        syncIntervalMinutes: 10,
      });

      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.codespaceIds).toEqual([project1.id, project2.id]);
      expect(created.value.codespaceId).toBe(project1.id);
      expect(created.value.nextSyncAt).toBeTruthy();

      const listedForProject1 = await service.list({ codespaceId: project1.id });
      expect(listedForProject1.ok).toBe(true);
      if (!listedForProject1.ok) return;
      expect(listedForProject1.value.map((template) => template.id)).toContain(created.value.id);

      const updated = await service.update(created.value.id, {
        name: 'Service-backed Template Updated',
        branch: 'develop',
        codespaceIds: [project3.id],
        syncIntervalMinutes: null,
      });

      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value.name).toBe('Service-backed Template Updated');
      expect(updated.value.branch).toBe('develop');
      expect(updated.value.codespaceIds).toEqual([project3.id]);
      expect(updated.value.nextSyncAt).toBeNull();

      const listedForProject2 = await service.list({ codespaceId: project2.id });
      expect(listedForProject2.ok).toBe(true);
      if (!listedForProject2.ok) return;
      expect(listedForProject2.value.map((template) => template.id)).not.toContain(
        created.value.id
      );

      const deleteResult = await service.delete(created.value.id);
      expect(deleteResult.ok).toBe(true);
      const afterDelete = await service.getById(created.value.id);
      expect(afterDelete.ok).toBe(false);
    });

    it('IT-144: rejects duplicate repos per scope while allowing the same repo in another scope', async () => {
      const db = getTestDb();
      const service = new TemplateService(db as any);
      const project = await createTestProject({ name: 'Duplicate Scope Project' });

      const orgTemplate = await service.create({
        name: 'Org Duplicate Base',
        scope: 'org',
        githubUrl: 'shared-org/shared-template',
      });
      expect(orgTemplate.ok).toBe(true);

      const duplicateOrg = await service.create({
        name: 'Org Duplicate',
        scope: 'org',
        githubUrl: 'shared-org/shared-template',
      });
      expect(duplicateOrg.ok).toBe(false);
      if (!duplicateOrg.ok) {
        expect(duplicateOrg.error.code).toBe('TEMPLATE_ALREADY_EXISTS');
      }

      const codespaceTemplate = await service.create({
        name: 'Codespace Duplicate Allowed',
        scope: 'codespace',
        githubUrl: 'shared-org/shared-template',
        codespaceIds: [project.id],
      });
      expect(codespaceTemplate.ok).toBe(true);

      const byRepo = await service.findByRepo('shared-org', 'shared-template');
      expect(byRepo.ok).toBe(true);
      if (!byRepo.ok) return;
      expect(byRepo.value.map((template) => template.scope).sort()).toEqual(['codespace', 'org']);
    });

    it('IT-145: merges org, codespace, and local config with TemplateService precedence', async () => {
      const db = getTestDb();
      const service = new TemplateService(db as any);
      const project = await createTestProject({ name: 'Merge Precedence Project' });
      const now = new Date().toISOString();

      await db.insert(templates).values([
        {
          id: createId(),
          name: 'Org Merge Template',
          scope: 'org',
          githubOwner: 'org',
          githubRepo: 'merge-org',
          status: 'active',
          cachedSkills: [{ id: 'skill-shared', name: 'Shared', content: 'org content' }],
          cachedCommands: [{ name: 'deploy', content: 'org deploy' }],
          cachedAgents: [{ name: 'reviewer', content: 'org reviewer' }],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: createId(),
          name: 'Codespace Merge Template',
          scope: 'codespace',
          githubOwner: 'org',
          githubRepo: 'merge-project',
          codespaceId: project.id,
          status: 'active',
          cachedSkills: [{ id: 'skill-shared', name: 'Shared', content: 'project content' }],
          cachedCommands: [{ name: 'plan', content: 'project plan' }],
          cachedAgents: [{ name: 'reviewer', content: 'project reviewer' }],
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const merged = await service.getMergedConfig(project.id, {
        skills: [{ id: 'skill-local', name: 'Local', content: 'local content' }],
        commands: [{ name: 'deploy', content: 'local deploy' }],
        agents: [{ name: 'local-agent', content: 'local agent' }],
      });

      expect(merged.ok).toBe(true);
      if (!merged.ok) return;
      expect(merged.value.skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'skill-shared',
            content: 'project content',
            sourceType: 'project',
          }),
          expect.objectContaining({
            id: 'skill-local',
            content: 'local content',
            sourceType: 'local',
          }),
        ])
      );
      expect(merged.value.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'deploy', content: 'local deploy', sourceType: 'local' }),
          expect.objectContaining({ name: 'plan', content: 'project plan', sourceType: 'project' }),
        ])
      );
      expect(merged.value.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'reviewer',
            content: 'project reviewer',
            sourceType: 'project',
          }),
          expect.objectContaining({
            name: 'local-agent',
            content: 'local agent',
            sourceType: 'local',
          }),
        ])
      );
    });
  });
});
