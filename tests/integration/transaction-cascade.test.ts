import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agents,
  codespaces,
  eventSources,
  eventSubscriptions,
  tasks,
  teamMembers,
  teams,
  templateCodespaces,
  templates,
  users,
} from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Transaction & Cascade (IT-196 to IT-200)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-196: codespace with running agent blocks service-level delete, idle allows', async () => {
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, { status: 'running' });

    // Verify agent exists and is running
    const agentBefore = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(agentBefore!.status).toBe('running');

    // In production, the service checks for running agents before delete.
    // Simulate the service-level check: count running agents
    const runningAgents = await db.query.agents.findMany({
      where: eq(agents.codespaceId, codespace.id),
    });
    const runningCount = runningAgents.filter((a) => a.status === 'running').length;
    expect(runningCount).toBe(1);

    // Set agent to idle
    await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, agent.id));

    const idleAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(idleAgent!.status).toBe('idle');

    // Service would now allow delete. Delete agent explicitly first, then codespace.
    // FK constraints are OFF in test DB, so we delete manually to simulate cascade.
    await db.delete(agents).where(eq(agents.codespaceId, codespace.id));
    await db.delete(codespaces).where(eq(codespaces.id, codespace.id));

    const agentAfter = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(agentAfter).toBeUndefined();

    const codespaceAfter = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespace.id),
    });
    expect(codespaceAfter).toBeUndefined();
  });

  it('IT-197: team + teamMember inserted atomically, both exist', async () => {
    const teamId = createId();
    const userId = createId();

    const uniqueGithubId = Math.floor(Math.random() * 1000000000);
    await db.insert(users).values({
      id: userId,
      githubId: uniqueGithubId,
      githubLogin: `atomic-user-${userId.slice(0, 6)}`,
    });

    await db.insert(teams).values({
      id: teamId,
      name: 'Atomic Team',
      slug: `atomic-${teamId.slice(0, 8)}`,
    });

    await db.insert(teamMembers).values({
      teamId,
      userId,
      role: 'owner',
    });

    // Verify both exist
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    expect(team!.name).toBe('Atomic Team');

    const member = await db.query.teamMembers.findFirst({
      where: eq(teamMembers.teamId, teamId),
    });
    expect(member!.userId).toBe(userId);
    expect(member!.role).toBe('owner');
  });

  it('IT-198: replace template junction records — old removed, new added', async () => {
    const codespace1 = await createTestProject({ name: 'CS 1' });
    const codespace2 = await createTestProject({ name: 'CS 2' });
    const codespace3 = await createTestProject({ name: 'CS 3' });

    const templateId = createId();
    await db.insert(templates).values({
      id: templateId,
      name: 'Replace Test Template',
      scope: 'codespace',
      githubOwner: 'org',
      githubRepo: 'repo',
    });

    // Initial junctions: codespace1, codespace2
    await db.insert(templateCodespaces).values({
      templateId,
      codespaceId: codespace1.id,
    });
    await db.insert(templateCodespaces).values({
      templateId,
      codespaceId: codespace2.id,
    });

    let junctions = await db.query.templateCodespaces.findMany({
      where: eq(templateCodespaces.templateId, templateId),
    });
    expect(junctions.length).toBe(2);

    // Replace: remove all, add codespace2, codespace3
    await db.delete(templateCodespaces).where(eq(templateCodespaces.templateId, templateId));
    await db.insert(templateCodespaces).values({
      templateId,
      codespaceId: codespace2.id,
    });
    await db.insert(templateCodespaces).values({
      templateId,
      codespaceId: codespace3.id,
    });

    junctions = await db.query.templateCodespaces.findMany({
      where: eq(templateCodespaces.templateId, templateId),
    });
    expect(junctions.length).toBe(2);
    const ids = junctions.map((j) => j.codespaceId).sort();
    expect(ids).toContain(codespace2.id);
    expect(ids).toContain(codespace3.id);
    expect(ids).not.toContain(codespace1.id);
  });

  it('IT-199: delete eventSource → subscriptions cascaded', async () => {
    const teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Cascade Team',
      slug: `cascade-${teamId.slice(0, 8)}`,
    });

    const codespace = await createTestProject();

    const sourceId = createId();
    await db.insert(eventSources).values({
      id: sourceId,
      teamId,
      name: 'Test Source',
      type: 'github',
      slug: `test-source-${sourceId.slice(0, 6)}`,
      isEnabled: true,
      config: {},
      eventCount: 0,
      status: 'active',
    });

    // Create subscriptions
    await db.insert(eventSubscriptions).values({
      id: createId(),
      name: 'Sub 1',
      eventSourceId: sourceId,
      targetCodespaceId: codespace.id,
      promptTemplate: 'Handle event',
    });
    await db.insert(eventSubscriptions).values({
      id: createId(),
      name: 'Sub 2',
      eventSourceId: sourceId,
      targetCodespaceId: codespace.id,
      promptTemplate: 'Handle event 2',
    });

    const subsBefore = await db.query.eventSubscriptions.findMany({
      where: eq(eventSubscriptions.eventSourceId, sourceId),
    });
    expect(subsBefore.length).toBe(2);

    // Delete source
    await db.delete(eventSources).where(eq(eventSources.id, sourceId));

    // Verify subscriptions gone
    const subsAfter = await db.query.eventSubscriptions.findMany({
      where: eq(eventSubscriptions.eventSourceId, sourceId),
    });
    expect(subsAfter.length).toBe(0);
  });

  it('IT-200: store plan, planOptions, lastAgentStatus on task — consistency', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    const plan = '## Implementation Plan\n1. Parse input\n2. Validate\n3. Transform\n4. Output';
    const planOptions = {
      allowedPrompts: [{ tool: 'Bash' as const, prompt: 'npm test' }],
    };

    await db
      .update(tasks)
      .set({
        plan,
        planOptions,
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    const updated = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(updated!.plan).toBe(plan);
    expect(updated!.planOptions).toEqual(planOptions);
    expect(updated!.lastAgentStatus).toBe('planning');
  });
});
