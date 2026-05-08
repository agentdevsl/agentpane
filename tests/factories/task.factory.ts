import { createId } from '@paralleldrive/cuid2';
import type { NewTask, Task, TaskColumn } from '../../src/db/schema';
import { tasks } from '../../src/db/schema';
import type { DiffSummary } from '../../src/lib/types/diff';
import { getTestDb } from '../helpers/database';

export type TaskFactoryOptions = Partial<Omit<NewTask, 'codespaceId'>> & {
  codespaceId?: string;
  column?: TaskColumn;
  labels?: string[];
  diffSummary?: DiffSummary;
};

export function buildTask(codespaceId: string, options: TaskFactoryOptions = {}): NewTask {
  const id = options.id ?? createId();

  return {
    id,
    codespaceId,
    title: options.title ?? `Test Task ${id.slice(0, 6)}`,
    description: options.description ?? null,
    mode: options.mode ?? 'implement',
    column: options.column ?? 'backlog',
    position: options.position ?? 0,
    labels: options.labels ?? [],
    priority: options.priority ?? 'medium',
    agentId: options.agentId ?? null,
    sessionId: options.sessionId ?? null,
    worktreeId: options.worktreeId ?? null,
    branch: options.branch ?? null,
    diffSummary: options.diffSummary ?? null,
    approvedAt: options.approvedAt ?? null,
    approvedBy: options.approvedBy ?? null,
    rejectionCount: options.rejectionCount ?? 0,
    rejectionReason: options.rejectionReason ?? null,
    skillId: options.skillId ?? null,
    skillName: options.skillName ?? null,
    executionSkillId: options.executionSkillId ?? null,
    executionSkillName: options.executionSkillName ?? null,
    modelOverride: options.modelOverride ?? null,
    planOptions: options.planOptions ?? null,
    plan: options.plan ?? null,
    startedAt: options.startedAt ?? null,
    completedAt: options.completedAt ?? null,
    approvalMode: options.approvalMode ?? null,
    agentReviewResult: options.agentReviewResult ?? null,
    agentReviewedAt: options.agentReviewedAt ?? null,
    lastAgentStatus: options.lastAgentStatus ?? null,
  };
}

export async function createApprovedTask(
  codespaceId: string,
  options: TaskFactoryOptions & { approvedBy?: string } = {}
): Promise<Task> {
  return createTestTask(codespaceId, {
    ...options,
    approvedAt: options.approvedAt ?? new Date(),
    approvedBy: options.approvedBy ?? 'test-user',
  });
}

export async function createRejectedTask(
  codespaceId: string,
  options: TaskFactoryOptions & { rejectionReason?: string } = {}
): Promise<Task> {
  return createTestTask(codespaceId, {
    ...options,
    rejectionCount: options.rejectionCount ?? 1,
    rejectionReason: options.rejectionReason ?? 'Test rejection',
  });
}

export async function createTestTask(
  codespaceId: string,
  options: TaskFactoryOptions = {}
): Promise<Task> {
  const db = getTestDb();
  const data = buildTask(codespaceId, options);

  const [task] = await db.insert(tasks).values(data).returning();

  if (!task) {
    throw new Error('Failed to create test task');
  }

  return task;
}

export async function createTestTasks(
  codespaceId: string,
  count: number,
  options: TaskFactoryOptions = {}
): Promise<Task[]> {
  const createdTasks: Task[] = [];

  for (let i = 0; i < count; i++) {
    const task = await createTestTask(codespaceId, {
      ...options,
      title: options.title ?? `Test Task ${i + 1}`,
      position: options.position ?? i,
    });
    createdTasks.push(task);
  }

  return createdTasks;
}

export async function createTasksInColumns(
  codespaceId: string,
  counts: Partial<Record<TaskColumn, number>>
): Promise<Record<TaskColumn, Task[]>> {
  const result: Record<TaskColumn, Task[]> = {
    backlog: [],
    queued: [],
    in_progress: [],
    waiting_approval: [],
    verified: [],
  };

  for (const [column, count] of Object.entries(counts)) {
    if (count && count > 0) {
      const tasks = await createTestTasks(codespaceId, count, {
        column: column as TaskColumn,
      });
      result[column as TaskColumn] = tasks;
    }
  }

  return result;
}
