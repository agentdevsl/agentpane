import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectFolders } from '../../src/db/schema';
import { DEFAULT_CODESPACE_CONFIG } from '../../src/lib/config/types';
import type { CommandRunner } from '../../src/services/codespace.service';
import { CodespaceService } from '../../src/services/codespace.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('CodespaceService extended', () => {
  let service: CodespaceService;
  let mockRunner: { exec: ReturnType<typeof vi.fn> };
  let mockWorktreeService: { prune: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();

    mockRunner = {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    };

    mockWorktreeService = {
      prune: vi.fn().mockResolvedValue({ ok: true, value: { pruned: 0, failed: [] } }),
    };

    service = new CodespaceService(db as any, mockWorktreeService, mockRunner as CommandRunner);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-374: Create codespace with config overrides merges with DEFAULT_CODESPACE_CONFIG', async () => {
    const configOverrides = {
      maxTurns: 100,
      model: 'claude-sonnet-4-20250514',
    };

    const result = await service.create({
      projectFolderId: 'default-folder',
      path: '/tmp/test-config-merge',
      config: configOverrides,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const config = result.value.config as Record<string, unknown>;
    // Overridden values
    expect(config.maxTurns).toBe(100);
    expect(config.model).toBe('claude-sonnet-4-20250514');
    // Default values preserved
    expect(config.worktreeRoot).toBe(DEFAULT_CODESPACE_CONFIG.worktreeRoot);
    expect(config.defaultBranch).toBe(DEFAULT_CODESPACE_CONFIG.defaultBranch);
    expect(config.allowedTools).toEqual(DEFAULT_CODESPACE_CONFIG.allowedTools);
  });

  it('IT-375: Create codespace with path that runner.exec rejects returns error', async () => {
    // Make the git rev-parse check fail (validatePath calls runner.exec with git rev-parse)
    mockRunner.exec.mockRejectedValueOnce(new Error('not a git repository'));

    const result = await service.create({
      projectFolderId: 'default-folder',
      path: '/tmp/not-a-repo',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('CODESPACE_NOT_A_GIT_REPO');
  });

  it('IT-376: Update codespace config deep merge preserves existing fields', async () => {
    // Create a codespace with initial config
    const createResult = await service.create({
      projectFolderId: 'default-folder',
      path: '/tmp/test-update-config',
      config: {
        maxTurns: 50,
        allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
      },
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const codespaceId = createResult.value.id;

    // Update only maxTurns via the update method
    const updateResult = await service.update(codespaceId, {
      config: { maxTurns: 200 },
    });

    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;

    const updatedConfig = updateResult.value.config as Record<string, unknown>;
    // Updated value
    expect(updatedConfig.maxTurns).toBe(200);
    // Existing fields from creation should be preserved (shallow merge in update)
    expect(updatedConfig.allowedTools).toEqual(['Read', 'Edit', 'Bash', 'Glob', 'Grep']);
    expect(updatedConfig.worktreeRoot).toBe(DEFAULT_CODESPACE_CONFIG.worktreeRoot);
    expect(updatedConfig.defaultBranch).toBe(DEFAULT_CODESPACE_CONFIG.defaultBranch);
  });

  it('IT-377: List codespaces with projectFolderId filter returns only that folder', async () => {
    const db = getTestDb();

    // Create a second project folder
    await db.insert(projectFolders).values({
      id: 'folder-a',
      name: 'Folder A',
      slug: 'folder-a',
      description: 'Test folder A',
    });

    await db.insert(projectFolders).values({
      id: 'folder-b',
      name: 'Folder B',
      slug: 'folder-b',
      description: 'Test folder B',
    });

    // Create codespaces in different folders
    await service.create({
      projectFolderId: 'folder-a',
      path: '/tmp/folder-a-project-1',
    });
    await service.create({
      projectFolderId: 'folder-a',
      path: '/tmp/folder-a-project-2',
    });
    await service.create({
      projectFolderId: 'folder-b',
      path: '/tmp/folder-b-project-1',
    });

    // List only folder-a codespaces
    const result = await service.list({ projectFolderId: 'folder-a' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    for (const cs of result.value) {
      expect(cs.projectFolderId).toBe('folder-a');
    }
  });

  it('IT-378: Get codespace summary returns correct task counts and agent status', async () => {
    // Create a codespace via factory (bypasses validatePath)
    const codespace = await createTestProject({
      path: '/tmp/test-summary-project',
    });

    // Create tasks in various columns
    await createTestTask(codespace.id, { column: 'backlog', title: 'Backlog 1' });
    await createTestTask(codespace.id, { column: 'backlog', title: 'Backlog 2' });
    await createTestTask(codespace.id, { column: 'in_progress', title: 'In Progress 1' });
    await createTestTask(codespace.id, {
      column: 'waiting_approval',
      title: 'Waiting 1',
    });
    await createTestTask(codespace.id, { column: 'verified', title: 'Verified 1' });
    await createTestTask(codespace.id, { column: 'verified', title: 'Verified 2' });
    await createTestTask(codespace.id, { column: 'verified', title: 'Verified 3' });

    // Create a running agent
    await createTestAgent(codespace.id, {
      name: 'Running Agent',
      status: 'running',
      currentTaskId: null,
    });

    // Use listWithSummaries to get summary (no standalone getSummary)
    const result = await service.listWithSummaries();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const summary = result.value.find((s) => s.codespace.id === codespace.id);
    expect(summary).toBeDefined();
    if (!summary) return;

    expect(summary.taskCounts.backlog).toBe(2);
    expect(summary.taskCounts.inProgress).toBe(1);
    expect(summary.taskCounts.waitingApproval).toBe(1);
    expect(summary.taskCounts.verified).toBe(3);
    expect(summary.taskCounts.total).toBe(7);

    expect(summary.runningAgents).toHaveLength(1);
    expect(summary.runningAgents[0].name).toBe('Running Agent');
    expect(summary.status).toBe('running');
  });

  it('IT-379: Delete codespace then getById returns NOT_FOUND', async () => {
    const createResult = await service.create({
      projectFolderId: 'default-folder',
      path: '/tmp/test-delete-codespace',
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const codespaceId = createResult.value.id;

    const deleteResult = await service.delete(codespaceId);
    expect(deleteResult.ok).toBe(true);

    const getResult = await service.getById(codespaceId);
    expect(getResult.ok).toBe(false);
    if (getResult.ok) return;

    expect(getResult.error.code).toBe('CODESPACE_NOT_FOUND');
  });

  it('IT-380: Create codespace with duplicate path returns PATH_EXISTS error', async () => {
    const sharedPath = '/tmp/test-duplicate-path';

    const first = await service.create({
      projectFolderId: 'default-folder',
      path: sharedPath,
    });
    expect(first.ok).toBe(true);

    const second = await service.create({
      projectFolderId: 'default-folder',
      path: sharedPath,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;

    expect(second.error.code).toBe('CODESPACE_PATH_EXISTS');
  });

  it('IT-381: List with orderBy and direction returns results ordered correctly', async () => {
    // Create codespaces with known names for alphabetic ordering
    await service.create({
      projectFolderId: 'default-folder',
      path: '/tmp/test-order-charlie',
    });
    await service.create({
      projectFolderId: 'default-folder',
      path: '/tmp/test-order-alpha',
    });
    await service.create({
      projectFolderId: 'default-folder',
      path: '/tmp/test-order-bravo',
    });

    // List ordered by name ascending
    const ascResult = await service.list({ orderBy: 'name', orderDirection: 'asc' });
    expect(ascResult.ok).toBe(true);
    if (!ascResult.ok) return;

    const ascNames = ascResult.value.map((cs) => cs.name);
    const sortedAsc = [...ascNames].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
    expect(ascNames).toEqual(sortedAsc);

    // List ordered by name descending
    const descResult = await service.list({ orderBy: 'name', orderDirection: 'desc' });
    expect(descResult.ok).toBe(true);
    if (!descResult.ok) return;

    const descNames = descResult.value.map((cs) => cs.name);
    const sortedDesc = [...descNames].sort((a, b) => (b ?? '').localeCompare(a ?? ''));
    expect(descNames).toEqual(sortedDesc);
  });
});
