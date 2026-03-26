import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workflows } from '../../src/db/schema';
import { WorkflowService } from '../../src/services/workflow.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('WorkflowService Lifecycle (IT-332 to IT-338)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: WorkflowService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    await db.delete(workflows);
    service = new WorkflowService(db as any);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-332: Create workflow with nodes/edges/viewport persisted correctly', async () => {
    const nodes = [
      { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Start' } },
      { id: 'n2', type: 'action', position: { x: 200, y: 100 }, data: { label: 'Build' } },
    ];
    const edges = [{ id: 'e1', source: 'n1', target: 'n2' }];
    const viewport = { x: 50, y: 75, zoom: 1.5 };

    const createResult = await service.create({
      name: 'CI Pipeline',
      description: 'Automated build and test',
      nodes,
      edges,
      viewport,
      status: 'draft',
      tags: ['ci', 'automation'],
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const created = createResult.value;
    expect(created.id).toBeDefined();
    expect(created.name).toBe('CI Pipeline');
    expect(created.description).toBe('Automated build and test');
    expect(created.status).toBe('draft');

    // Verify via getById
    const getResult = await service.getById(created.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    const fetched = getResult.value;
    expect(fetched.name).toBe('CI Pipeline');
    expect(fetched.description).toBe('Automated build and test');
    expect(fetched.nodes).toEqual(nodes);
    expect(fetched.edges).toEqual(edges);
    expect(fetched.viewport).toEqual(viewport);
    expect(fetched.status).toBe('draft');
    expect(fetched.tags).toEqual(['ci', 'automation']);
    expect(fetched.createdAt).toBeDefined();
    expect(fetched.updatedAt).toBeDefined();
  });

  it('IT-333: Update workflow status draft → published → archived', async () => {
    const createResult = await service.create({
      name: 'Status Workflow',
      status: 'draft',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    const id = createResult.value.id;

    // draft → published
    const pub = await service.update(id, { status: 'published' });
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;
    expect(pub.value.status).toBe('published');

    // published → archived
    const arch = await service.update(id, { status: 'archived' });
    expect(arch.ok).toBe(true);
    if (!arch.ok) return;
    expect(arch.value.status).toBe('archived');

    // Verify final state
    const final = await service.getById(id);
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    expect(final.value.status).toBe('archived');
  });

  it('IT-334: List with search filter matches name and description', async () => {
    await service.create({ name: 'Deploy Pipeline', description: 'Handles deployments' });
    await service.create({ name: 'Test Suite', description: 'Runs unit tests' });
    await service.create({ name: 'Build Job', description: 'Compiles the deploy artifacts' });

    // Search for "deploy" — should match workflow 1 (name) and workflow 3 (description)
    const result = await service.list({ search: 'deploy' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalCount).toBe(2);
    const names = result.value.items.map((w) => w.name);
    expect(names).toContain('Deploy Pipeline');
    expect(names).toContain('Build Job');
    expect(names).not.toContain('Test Suite');
  });

  it('IT-335: List with status filter returns only matching status', async () => {
    await service.create({ name: 'Draft One', status: 'draft' });
    await service.create({ name: 'Published One', status: 'published' });
    await service.create({ name: 'Draft Two', status: 'draft' });

    const result = await service.list({ status: 'published' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalCount).toBe(1);
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0].name).toBe('Published One');
    expect(result.value.items[0].status).toBe('published');
  });

  it('IT-336: Delete workflow → getById returns NOT_FOUND', async () => {
    const createResult = await service.create({ name: 'Ephemeral Workflow' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    const id = createResult.value.id;

    // Confirm it exists
    const before = await service.getById(id);
    expect(before.ok).toBe(true);

    // Delete
    const deleteResult = await service.delete(id);
    expect(deleteResult.ok).toBe(true);

    // Confirm NOT_FOUND
    const after = await service.getById(id);
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.error.code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('IT-337: Duplicate workflow → new ID, name has " (copy)" suffix, same nodes/edges', async () => {
    const nodes = [
      { id: 'n1', type: 'start', position: { x: 0, y: 0 }, data: {} },
      { id: 'n2', type: 'end', position: { x: 300, y: 0 }, data: {} },
    ];
    const edges = [{ id: 'e1', source: 'n1', target: 'n2' }];

    const createResult = await service.create({
      name: 'Original Workflow',
      description: 'To be duplicated',
      nodes,
      edges,
      status: 'published',
      tags: ['template'],
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    const originalId = createResult.value.id;

    const dupResult = await service.duplicate(originalId);
    expect(dupResult.ok).toBe(true);
    if (!dupResult.ok) return;

    const dup = dupResult.value;
    expect(dup.id).not.toBe(originalId);
    expect(dup.name).toBe('Original Workflow (copy)');
    expect(dup.description).toBe('To be duplicated');
    expect(dup.nodes).toEqual(nodes);
    expect(dup.edges).toEqual(edges);
  });

  it('IT-338: Pagination with limit and offset', async () => {
    // Create 5 workflows
    for (let i = 1; i <= 5; i++) {
      await service.create({ name: `Workflow ${i}` });
    }

    // Page 1: offset=0, limit=2
    const page1 = await service.list({ limit: 2, offset: 0 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.items).toHaveLength(2);
    expect(page1.value.totalCount).toBe(5);
    expect(page1.value.hasMore).toBe(true);
    expect(page1.value.limit).toBe(2);
    expect(page1.value.offset).toBe(0);

    // Page 2: offset=2, limit=2
    const page2 = await service.list({ limit: 2, offset: 2 });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.items).toHaveLength(2);
    expect(page2.value.totalCount).toBe(5);
    expect(page2.value.hasMore).toBe(true);
    expect(page2.value.offset).toBe(2);

    // Page 3: offset=4, limit=2
    const page3 = await service.list({ limit: 2, offset: 4 });
    expect(page3.ok).toBe(true);
    if (!page3.ok) return;
    expect(page3.value.items).toHaveLength(1);
    expect(page3.value.totalCount).toBe(5);
    expect(page3.value.hasMore).toBe(false);
    expect(page3.value.offset).toBe(4);
  });
});
