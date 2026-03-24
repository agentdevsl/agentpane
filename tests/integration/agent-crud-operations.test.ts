import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents } from '../../src/db/schema';
import { AgentCrudService } from '../../src/services/agent/agent-crud.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Agent CRUD Operations (IT-071 to IT-076)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-071: agent config inherits codespace defaults when not explicitly set', async () => {
    const codespace = await createTestProject({
      config: {
        allowedTools: ['Read', 'Write', 'Bash'],
        maxTurns: 75,
        defaultBranch: 'main',
        worktreeRoot: '.worktrees',
      },
    });

    const service = new AgentCrudService(db as any);
    const result = await service.create({
      codespaceId: codespace.id,
      name: 'Inheriting Agent',
      type: 'task',
      status: 'idle',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.config?.allowedTools).toEqual(['Read', 'Write', 'Bash']);
    expect(result.value.config?.maxTurns).toBe(75);
  });

  it('IT-072: creating agent with nonexistent codespace returns validation error', async () => {
    const service = new AgentCrudService(db as any);
    const result = await service.create({
      codespaceId: 'nonexistent-codespace-id',
      name: 'Orphan Agent',
      type: 'task',
      status: 'idle',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_ID');
  });

  it('IT-073: list agents ordered by updatedAt DESC', async () => {
    const codespace = await createTestProject();

    // Create 3 agents with staggered timestamps via direct DB updates
    const agent1 = await createTestAgent(codespace.id, { name: 'Agent Alpha' });
    const agent2 = await createTestAgent(codespace.id, { name: 'Agent Beta' });
    const agent3 = await createTestAgent(codespace.id, { name: 'Agent Gamma' });

    // Set specific updatedAt values to control ordering
    await db
      .update(agents)
      .set({ updatedAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(agents.id, agent1.id));
    await db
      .update(agents)
      .set({ updatedAt: '2026-01-03T00:00:00.000Z' })
      .where(eq(agents.id, agent2.id));
    await db
      .update(agents)
      .set({ updatedAt: '2026-01-02T00:00:00.000Z' })
      .where(eq(agents.id, agent3.id));

    const service = new AgentCrudService(db as any);
    const result = await service.list(codespace.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(3);
    // Most recently updated first
    expect(result.value[0].id).toBe(agent2.id);
    expect(result.value[1].id).toBe(agent3.id);
    expect(result.value[2].id).toBe(agent1.id);
  });

  it('IT-074: count running agents by status filter', async () => {
    const codespace = await createTestProject();

    await createTestAgent(codespace.id, { status: 'idle', name: 'Idle Agent' });
    await createTestAgent(codespace.id, { status: 'running', name: 'Running Agent 1' });
    await createTestAgent(codespace.id, { status: 'running', name: 'Running Agent 2' });
    await createTestAgent(codespace.id, { status: 'error', name: 'Error Agent' });
    await createTestAgent(codespace.id, { status: 'completed', name: 'Completed Agent' });

    const service = new AgentCrudService(db as any);
    const result = await service.getRunningCount(codespace.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBe(2);

    // Also verify total agents
    const listResult = await service.list(codespace.id);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    expect(listResult.value).toHaveLength(5);
  });

  it('IT-075: update agent config merges with existing values', async () => {
    const codespace = await createTestProject();
    const service = new AgentCrudService(db as any);

    const createResult = await service.create({
      codespaceId: codespace.id,
      name: 'Configurable Agent',
      type: 'task',
      status: 'idle',
      config: {
        allowedTools: ['Read', 'Write'],
        maxTurns: 30,
        systemPrompt: 'Original prompt',
      },
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Partial update: only change maxTurns, leave allowedTools and systemPrompt
    const updateResult = await service.update(createResult.value.id, {
      maxTurns: 100,
    });

    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;

    // allowedTools should be preserved from original
    expect(updateResult.value.config?.allowedTools).toEqual(['Read', 'Write']);
    // maxTurns should be updated
    expect(updateResult.value.config?.maxTurns).toBe(100);
    // systemPrompt should be preserved
    expect(updateResult.value.config?.systemPrompt).toBe('Original prompt');
  });

  it('IT-076: deleting nonexistent agent returns NOT_FOUND error', async () => {
    const service = new AgentCrudService(db as any);
    const result = await service.delete('nonexistent-agent-id');

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('AGENT_NOT_FOUND');
  });
});
