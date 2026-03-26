import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { templates } from '../../src/db/schema';
import { TaskService } from '../../src/services/task.service';
import { TemplateService } from '../../src/services/template.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Cross-service integration tests: TemplateService + TaskService
 *
 * Templates are inserted directly into DB (bypassing TemplateService.create()
 * which requires GitHub API access). TaskService uses real service code.
 */
describe('Template → Task creation cross-service flow', () => {
  const mockWorktreeService = {
    getDiff: vi.fn(),
    merge: vi.fn(),
    remove: vi.fn(),
  };

  let templateService: TemplateService;
  let taskService: TaskService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    // Clear templates (not always in clearTestDatabase)
    await db.delete(templates);
    templateService = new TemplateService(db as any);
    taskService = new TaskService(db as any, mockWorktreeService);
  });

  afterEach(async () => {
    await clearTestDatabase();
    vi.restoreAllMocks();
  });

  it('IT-346: template data read via getById feeds task creation with correct fields', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const now = new Date().toISOString();
    const templateId = createId();

    // Insert template directly into DB
    await db.insert(templates).values({
      id: templateId,
      name: 'Backend API Template',
      description: 'Template for backend API tasks',
      scope: 'org',
      githubOwner: 'test-org',
      githubRepo: 'api-templates',
      branch: 'main',
      configPath: '.claude',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // Read template via TemplateService
    const templateResult = await templateService.getById(templateId);
    expect(templateResult.ok).toBe(true);
    if (!templateResult.ok) return;

    const template = templateResult.value;

    // Create task using template data as defaults
    const taskResult = await taskService.create({
      codespaceId: project.id,
      title: `Task from ${template.name}`,
      description: template.description ?? undefined,
      labels: ['api', 'backend'],
      priority: 'high',
    });

    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;

    const task = taskResult.value;
    expect(task.title).toBe('Task from Backend API Template');
    expect(task.description).toBe('Template for backend API tasks');
    expect(task.labels).toEqual(['api', 'backend']);
    expect(task.priority).toBe('high');
    expect(task.column).toBe('backlog');
    expect(task.codespaceId).toBe(project.id);
  });

  it('IT-347: template with labels and priority → task created with those values', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const now = new Date().toISOString();
    const templateId = createId();

    // Insert template with cached skills that imply labels/priority
    await db.insert(templates).values({
      id: templateId,
      name: 'Infra Template',
      description: 'Infrastructure automation',
      scope: 'org',
      githubOwner: 'test-org',
      githubRepo: 'infra-templates',
      branch: 'main',
      configPath: '.claude',
      status: 'active',
      cachedSkills: JSON.stringify([
        { id: 'deploy', name: 'deploy', description: 'Deploy infra', content: 'deploy steps' },
      ]),
      createdAt: now,
      updatedAt: now,
    });

    const templateResult = await templateService.getById(templateId);
    expect(templateResult.ok).toBe(true);
    if (!templateResult.ok) return;

    // Use template metadata to populate task labels and priority
    const template = templateResult.value;
    const labels = [
      'infrastructure',
      'terraform',
      template.name.toLowerCase().replace(/\s+/g, '-'),
    ];
    const priority = 'high' as const;

    const taskResult = await taskService.create({
      codespaceId: project.id,
      title: 'Deploy staging environment',
      description: template.description ?? undefined,
      labels,
      priority,
    });

    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;

    const task = taskResult.value;
    expect(task.labels).toEqual(['infrastructure', 'terraform', 'infra-template']);
    expect(task.priority).toBe('high');
  });

  it('IT-348: template with prompt text → task description populated from template prompt', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const now = new Date().toISOString();
    const templateId = createId();

    const promptText =
      'Implement a REST API endpoint that handles CRUD operations for user resources. ' +
      'Follow the existing patterns in the codebase for error handling and validation.';

    // Insert template with description acting as prompt text
    await db.insert(templates).values({
      id: templateId,
      name: 'REST API Prompt Template',
      description: promptText,
      scope: 'codespace',
      githubOwner: 'test-org',
      githubRepo: 'prompt-templates',
      branch: 'main',
      configPath: '.claude',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    const templateResult = await templateService.getById(templateId);
    expect(templateResult.ok).toBe(true);
    if (!templateResult.ok) return;

    // Create task with description from template prompt
    const taskResult = await taskService.create({
      codespaceId: project.id,
      title: 'Implement User API',
      description: templateResult.value.description ?? undefined,
    });

    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;

    expect(taskResult.value.description).toBe(promptText);
    expect(taskResult.value.description).toContain('CRUD operations');
    expect(taskResult.value.description).toContain('error handling and validation');
  });

  it('IT-349: update template → new task uses updated values, previous task unchanged', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const now = new Date().toISOString();
    const templateId = createId();

    // Insert initial template
    await db.insert(templates).values({
      id: templateId,
      name: 'Evolving Template',
      description: 'Original description v1',
      scope: 'org',
      githubOwner: 'test-org',
      githubRepo: 'evolving-templates',
      branch: 'main',
      configPath: '.claude',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // Create first task with original template data
    const templateV1 = await templateService.getById(templateId);
    expect(templateV1.ok).toBe(true);
    if (!templateV1.ok) return;

    const task1Result = await taskService.create({
      codespaceId: project.id,
      title: 'Task v1',
      description: templateV1.value.description ?? undefined,
      labels: ['v1'],
      priority: 'low',
    });

    expect(task1Result.ok).toBe(true);
    if (!task1Result.ok) return;
    const task1 = task1Result.value;

    // Update template via TemplateService
    const updateResult = await templateService.update(templateId, {
      name: 'Evolved Template',
      description: 'Updated description v2',
    });
    expect(updateResult.ok).toBe(true);

    // Create second task with updated template data
    const templateV2 = await templateService.getById(templateId);
    expect(templateV2.ok).toBe(true);
    if (!templateV2.ok) return;

    const task2Result = await taskService.create({
      codespaceId: project.id,
      title: 'Task v2',
      description: templateV2.value.description ?? undefined,
      labels: ['v2'],
      priority: 'high',
    });

    expect(task2Result.ok).toBe(true);
    if (!task2Result.ok) return;
    const task2 = task2Result.value;

    // Verify task1 retains original values (no cascade from template update)
    const task1Reloaded = await taskService.getById(task1.id);
    expect(task1Reloaded.ok).toBe(true);
    if (!task1Reloaded.ok) return;
    expect(task1Reloaded.value.description).toBe('Original description v1');
    expect(task1Reloaded.value.labels).toEqual(['v1']);
    expect(task1Reloaded.value.priority).toBe('low');

    // Verify task2 has updated values
    expect(task2.description).toBe('Updated description v2');
    expect(task2.labels).toEqual(['v2']);
    expect(task2.priority).toBe('high');
  });

  it('IT-350: delete template → previously created tasks still exist (no cascade)', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const now = new Date().toISOString();
    const templateId = createId();

    // Insert template
    await db.insert(templates).values({
      id: templateId,
      name: 'Deletable Template',
      description: 'This template will be deleted',
      scope: 'org',
      githubOwner: 'test-org',
      githubRepo: 'deletable-templates',
      branch: 'main',
      configPath: '.claude',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // Create tasks referencing template data
    const task1Result = await taskService.create({
      codespaceId: project.id,
      title: 'Task from deleted template 1',
      description: 'This template will be deleted',
      labels: ['template-task'],
      priority: 'medium',
    });
    expect(task1Result.ok).toBe(true);

    const task2Result = await taskService.create({
      codespaceId: project.id,
      title: 'Task from deleted template 2',
      description: 'This template will be deleted',
      labels: ['template-task'],
      priority: 'low',
    });
    expect(task2Result.ok).toBe(true);

    // Delete the template
    const deleteResult = await templateService.delete(templateId);
    expect(deleteResult.ok).toBe(true);

    // Verify template is gone
    const templateAfterDelete = await templateService.getById(templateId);
    expect(templateAfterDelete.ok).toBe(false);

    // Verify tasks still exist
    if (!task1Result.ok || !task2Result.ok) return;

    const task1After = await taskService.getById(task1Result.value.id);
    expect(task1After.ok).toBe(true);
    if (task1After.ok) {
      expect(task1After.value.title).toBe('Task from deleted template 1');
      expect(task1After.value.description).toBe('This template will be deleted');
      expect(task1After.value.labels).toEqual(['template-task']);
    }

    const task2After = await taskService.getById(task2Result.value.id);
    expect(task2After.ok).toBe(true);
    if (task2After.ok) {
      expect(task2After.value.title).toBe('Task from deleted template 2');
      expect(task2After.value.priority).toBe('low');
    }
  });

  it('IT-351: list templates with scope filter → returns only matching scope', async () => {
    const db = getTestDb();
    const now = new Date().toISOString();

    // Insert org-scoped templates
    await db.insert(templates).values([
      {
        id: createId(),
        name: 'Org Template 1',
        description: 'Org-level template',
        scope: 'org',
        githubOwner: 'test-org',
        githubRepo: 'org-template-1',
        branch: 'main',
        configPath: '.claude',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: createId(),
        name: 'Org Template 2',
        description: 'Another org-level template',
        scope: 'org',
        githubOwner: 'test-org',
        githubRepo: 'org-template-2',
        branch: 'main',
        configPath: '.claude',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // Insert codespace-scoped template
    await db.insert(templates).values({
      id: createId(),
      name: 'Codespace Template',
      description: 'Codespace-level template',
      scope: 'codespace',
      githubOwner: 'test-org',
      githubRepo: 'codespace-template',
      branch: 'main',
      configPath: '.claude',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // List org-scoped only
    const orgResult = await templateService.list({ scope: 'org' });
    expect(orgResult.ok).toBe(true);
    if (!orgResult.ok) return;
    expect(orgResult.value).toHaveLength(2);
    for (const t of orgResult.value) {
      expect(t.scope).toBe('org');
    }

    // List codespace-scoped only
    const csResult = await templateService.list({ scope: 'codespace' });
    expect(csResult.ok).toBe(true);
    if (!csResult.ok) return;
    expect(csResult.value).toHaveLength(1);
    expect(csResult.value[0]!.scope).toBe('codespace');
    expect(csResult.value[0]!.name).toBe('Codespace Template');

    // List all (no filter)
    const allResult = await templateService.list();
    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;
    expect(allResult.value).toHaveLength(3);
  });
});
