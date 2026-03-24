import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { marketplaces, workflows } from '../../src/db/schema';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Remaining Services: Workflow & Marketplace (IT-225 to IT-226)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    // Clean workflow and marketplace tables
    await db.delete(workflows);
    await db.delete(marketplaces);
  });

  afterEach(async () => {
    await db.delete(workflows);
    await db.delete(marketplaces);
    await clearTestDatabase();
  });

  it('IT-225: insert workflow, list with status filter', async () => {
    const wf1Id = createId();
    const wf2Id = createId();

    await db.insert(workflows).values({
      id: wf1Id,
      name: 'CI Pipeline',
      description: 'Build and test pipeline',
      status: 'published',
      nodes: [
        { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'On Push' } },
        { id: 'n2', type: 'action', position: { x: 200, y: 0 }, data: { label: 'Run Tests' } },
      ] as never,
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }] as never,
    });

    await db.insert(workflows).values({
      id: wf2Id,
      name: 'Draft Workflow',
      description: 'Work in progress',
      status: 'draft',
      nodes: [],
      edges: [],
    });

    // List all
    const all = await db.query.workflows.findMany();
    expect(all.length).toBe(2);

    // Filter by status
    const published = await db.query.workflows.findMany({
      where: eq(workflows.status, 'published'),
    });
    expect(published.length).toBe(1);
    expect(published[0]!.name).toBe('CI Pipeline');

    const drafts = await db.query.workflows.findMany({
      where: eq(workflows.status, 'draft'),
    });
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.name).toBe('Draft Workflow');
  });

  it('IT-226: insert marketplace, list and verify data', async () => {
    const mp1Id = createId();
    const mp2Id = createId();

    await db.insert(marketplaces).values({
      id: mp1Id,
      name: 'Official Plugins',
      githubOwner: 'agentdevsl',
      githubRepo: 'plugins',
      branch: 'main',
      pluginsPath: 'plugins',
      isDefault: true,
      isEnabled: true,
      status: 'active',
      cachedPlugins: [{ id: 'terraform', name: 'Terraform Stack', description: 'IaC generation' }],
    });

    await db.insert(marketplaces).values({
      id: mp2Id,
      name: 'Community Plugins',
      githubOwner: 'community',
      githubRepo: 'marketplace',
      isDefault: false,
      isEnabled: true,
      status: 'active',
    });

    // List
    const all = await db.query.marketplaces.findMany();
    expect(all.length).toBe(2);

    // Verify data
    const official = await db.query.marketplaces.findFirst({
      where: eq(marketplaces.id, mp1Id),
    });
    expect(official!.name).toBe('Official Plugins');
    expect(official!.isDefault).toBe(true);
    expect(official!.cachedPlugins).toHaveLength(1);
    expect((official!.cachedPlugins as Array<{ id: string }>)[0]!.id).toBe('terraform');

    const community = await db.query.marketplaces.findFirst({
      where: eq(marketplaces.id, mp2Id),
    });
    expect(community!.name).toBe('Community Plugins');
    expect(community!.isDefault).toBe(false);
  });
});
