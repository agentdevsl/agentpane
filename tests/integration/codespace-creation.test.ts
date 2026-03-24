import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codespaces } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-021: Codespace Creation via DB', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('creates a codespace with correct path, config, and projectFolderId', async () => {
    const db = getTestDb();
    const id = createId();

    const [codespace] = await db
      .insert(codespaces)
      .values({
        id,
        projectFolderId: 'default-folder',
        name: 'Test Codespace',
        path: '/tmp/test-project',
        config: { worktreeRoot: '.worktrees', defaultBranch: 'main', maxTurns: 50 },
      })
      .returning();

    expect(codespace).toBeDefined();
    expect(codespace.id).toBe(id);
    expect(codespace.name).toBe('Test Codespace');
    expect(codespace.path).toBe('/tmp/test-project');
    expect(codespace.projectFolderId).toBe('default-folder');
    expect(codespace.config).toEqual({
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      maxTurns: 50,
    });
  });

  it('rejects duplicate path with UNIQUE constraint', async () => {
    const db = getTestDb();
    const sharedPath = `/tmp/unique-path-${createId()}`;

    await db
      .insert(codespaces)
      .values({
        id: createId(),
        projectFolderId: 'default-folder',
        name: 'First Codespace',
        path: sharedPath,
      })
      .returning();

    await expect(
      db
        .insert(codespaces)
        .values({
          id: createId(),
          projectFolderId: 'default-folder',
          name: 'Duplicate Codespace',
          path: sharedPath,
        })
        .returning()
    ).rejects.toThrow(/UNIQUE constraint/);
  });

  it('stores and retrieves config JSON', async () => {
    const codespace = await createTestProject({
      config: {
        worktreeRoot: '.custom-worktrees',
        defaultBranch: 'develop',
        allowedTools: ['Read', 'Write', 'Bash'],
        maxTurns: 100,
      },
    });

    const db = getTestDb();
    const retrieved = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespace.id),
    });

    expect(retrieved).toBeDefined();
    expect(retrieved!.config).toEqual({
      worktreeRoot: '.custom-worktrees',
      defaultBranch: 'develop',
      allowedTools: ['Read', 'Write', 'Bash'],
      maxTurns: 100,
    });
  });

  it('creates codespace without optional fields — uses defaults/null', async () => {
    const db = getTestDb();
    const id = createId();

    const [codespace] = await db
      .insert(codespaces)
      .values({
        id,
        projectFolderId: 'default-folder',
        name: 'Minimal Codespace',
        path: `/tmp/minimal-${id}`,
      })
      .returning();

    expect(codespace).toBeDefined();
    expect(codespace.description).toBeNull();
    expect(codespace.githubOwner).toBeNull();
    expect(codespace.githubRepo).toBeNull();
    expect(codespace.githubInstallationId).toBeNull();
    expect(codespace.maxConcurrentAgents).toBe(3);
    expect(codespace.configPath).toBe('.claude');
  });
});
