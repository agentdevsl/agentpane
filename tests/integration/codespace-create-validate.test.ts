import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codespaces, sandboxConfigs } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-046–050: Codespace Creation & Validation', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-046: creates codespace with valid data and rejects duplicate path', async () => {
    const id = createId();
    const uniquePath = `/tmp/cs-create-${id}`;

    const [created] = await db
      .insert(codespaces)
      .values({
        id,
        projectFolderId: 'default-folder',
        name: 'Valid Codespace',
        path: uniquePath,
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write'],
          maxTurns: 50,
        },
      })
      .returning();

    expect(created).toBeDefined();
    expect(created.id).toBe(id);
    expect(created.name).toBe('Valid Codespace');
    expect(created.path).toBe(uniquePath);

    // Duplicate path must violate UNIQUE constraint
    await expect(
      db
        .insert(codespaces)
        .values({
          id: createId(),
          projectFolderId: 'default-folder',
          name: 'Duplicate Path',
          path: uniquePath,
        })
        .returning()
    ).rejects.toThrow(/UNIQUE constraint/);
  });

  it('IT-047: creates codespace with partial config and verifies defaults merged', async () => {
    const codespace = await createTestProject({
      config: {
        worktreeRoot: '.wt',
        defaultBranch: 'develop',
      },
    });

    const retrieved = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespace.id),
    });

    expect(retrieved).toBeDefined();
    // Partial overrides are applied
    expect(retrieved!.config?.worktreeRoot).toBe('.wt');
    expect(retrieved!.config?.defaultBranch).toBe('develop');
    // Factory fills in remaining defaults
    expect(retrieved!.config?.maxTurns).toBe(50);
    expect(retrieved!.config?.allowedTools).toBeDefined();
    expect(Array.isArray(retrieved!.config?.allowedTools)).toBe(true);
  });

  it('IT-048: creates codespace with sandboxConfigId and verifies storage', async () => {
    // Insert a sandbox config first
    const sandboxId = createId();
    await db.insert(sandboxConfigs).values({
      id: sandboxId,
      name: 'Test Sandbox',
      type: 'docker',
      baseImage: 'node:22-slim',
      memoryMb: 4096,
      cpuCores: 2.0,
      maxProcesses: 256,
      timeoutMinutes: 60,
    });

    const codespace = await createTestProject({
      sandboxConfigId: sandboxId,
    });

    const retrieved = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespace.id),
    });

    expect(retrieved).toBeDefined();
    expect(retrieved!.sandboxConfigId).toBe(sandboxId);
  });

  it('IT-049: different paths produce independent codespaces', async () => {
    const csA = await createTestProject({
      name: 'Project Alpha',
      path: `/tmp/path-alpha-${createId()}`,
    });
    const csB = await createTestProject({
      name: 'Project Beta',
      path: `/tmp/path-beta-${createId()}`,
    });

    expect(csA.id).not.toBe(csB.id);
    expect(csA.path).not.toBe(csB.path);

    const retrievedA = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, csA.id),
    });
    const retrievedB = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, csB.id),
    });

    expect(retrievedA!.name).toBe('Project Alpha');
    expect(retrievedB!.name).toBe('Project Beta');
  });

  it('IT-050: containsSecrets rejects config with secret-bearing keys', async () => {
    // Import the containsSecrets utility directly to test validation
    const { containsSecrets } = await import('../../src/lib/config/validate-secrets');

    // Keys matching BLOCKED_PATTERNS should be detected
    const violations = containsSecrets({
      MY_SECRET: 'value',
      DB_PASSWORD: 'pwd',
      PRIVATE_KEY: 'key-data',
      OAUTH_TOKEN: 'tok',
      CUSTOM_API_KEY: 'api-key',
    });

    expect(violations.length).toBeGreaterThanOrEqual(5);
    expect(violations).toContain('MY_SECRET');
    expect(violations).toContain('DB_PASSWORD');
    expect(violations).toContain('PRIVATE_KEY');
    expect(violations).toContain('OAUTH_TOKEN');
    expect(violations).toContain('CUSTOM_API_KEY');

    // Allowed keys should pass through
    const noViolations = containsSecrets({
      ANTHROPIC_API_KEY: 'allowed',
      GITHUB_TOKEN: 'allowed',
      worktreeRoot: '.worktrees',
    });

    expect(noViolations).toHaveLength(0);
  });
});
