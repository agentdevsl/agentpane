/**
 * Tests for ContainerAgentService.handleAgentError error suppression logic.
 *
 * Verifies that:
 * - Expected post-plan errors (Operation aborted, EPIPE, etc.) are suppressed when plan exists
 * - Unexpected errors are NOT suppressed even when plan exists
 * - DB is updated for non-suppressed errors
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, tasks } from '../../src/db/schema';
import { ContainerAgentService } from '../../src/services/container-agent.service';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function createMockStreams(): DurableStreamsService {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    createStream: vi.fn().mockResolvedValue(undefined),
    getStream: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as DurableStreamsService;
}

function createMockProvider() {
  return {
    get: vi.fn().mockResolvedValue(null),
    getById: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
  } as any;
}

function createMockApiKeyService() {
  return {
    getDecryptedKey: vi.fn().mockResolvedValue('sk-ant-oat-test'),
    saveKey: vi.fn(),
    deleteKey: vi.fn(),
  } as any;
}

describe('ContainerAgentService.handleAgentError suppression', () => {
  let service: ContainerAgentService;
  let streams: DurableStreamsService;

  beforeEach(async () => {
    await setupTestDatabase();
    streams = createMockStreams();
    service = new ContainerAgentService(
      getTestDb() as any,
      createMockProvider(),
      streams,
      createMockApiKeyService()
    );
  });

  afterEach(async () => {
    service.dispose();
    await clearTestDatabase();
  });

  /**
   * Helper: create a project + task, then update the task with plan/status fields,
   * and insert an agent record. Returns the task.
   */
  async function setupTaskWithAgent(opts: {
    column: 'in_progress' | 'waiting_approval';
    plan?: string;
    lastAgentStatus?: string | null;
  }) {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, {
      column: opts.column,
    });

    // Update plan and lastAgentStatus directly (not handled by factory)
    await db
      .update(tasks)
      .set({
        plan: opts.plan ?? null,
        lastAgentStatus: (opts.lastAgentStatus as any) ?? null,
      })
      .where(eq(tasks.id, task.id));

    // Create agent record
    await db.insert(agents).values({
      id: `agent-${task.id}`,
      projectId: project.id,
      name: 'Test Agent',
      type: 'task',
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return { db, project, task };
  }

  it('suppresses "Operation aborted" error when plan exists', async () => {
    const { db, task } = await setupTaskWithAgent({
      column: 'waiting_approval',
      plan: 'Test plan content',
      lastAgentStatus: 'planning',
    });

    const handleError = (service as any).handleAgentError.bind(service);
    await handleError(task.id, 'Operation aborted', 3);

    // Task should NOT be updated to error state — suppressed
    const updatedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(updatedTask?.plan).toBe('Test plan content');
    expect(updatedTask?.lastAgentStatus).toBe('planning');
  });

  it('suppresses "EPIPE" error when plan exists', async () => {
    const { db, task } = await setupTaskWithAgent({
      column: 'waiting_approval',
      plan: 'Test plan',
      lastAgentStatus: 'planning',
    });

    const handleError = (service as any).handleAgentError.bind(service);
    await handleError(task.id, 'write EPIPE', 2);

    const updatedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(updatedTask?.plan).toBe('Test plan');
    expect(updatedTask?.lastAgentStatus).toBe('planning');
  });

  it('does NOT suppress "Out of memory" error even when plan exists', async () => {
    const { db, task } = await setupTaskWithAgent({
      column: 'waiting_approval',
      plan: 'Test plan',
      lastAgentStatus: 'planning',
    });

    const handleError = (service as any).handleAgentError.bind(service);
    await handleError(task.id, 'Out of memory', 5);

    // Task should be updated to error status for unexpected errors
    const updatedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(updatedTask?.lastAgentStatus).toBe('error');
    expect(updatedTask?.agentId).toBeNull();
  });

  it('updates DB for errors when no plan exists', async () => {
    const { db, task } = await setupTaskWithAgent({
      column: 'in_progress',
      lastAgentStatus: null,
    });

    const handleError = (service as any).handleAgentError.bind(service);
    await handleError(task.id, 'Some random error', 1);

    const updatedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(updatedTask?.lastAgentStatus).toBe('error');
    expect(updatedTask?.agentId).toBeNull();
  });
});
