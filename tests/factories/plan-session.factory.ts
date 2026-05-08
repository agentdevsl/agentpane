import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import type { NewPlanSession, PlanSession, PlanTurnRecord, Task } from '../../src/db/schema';
import { planSessions, tasks } from '../../src/db/schema';
import { getTestDb } from '../helpers/database';

export type PlanSessionFactoryOptions = Partial<Omit<NewPlanSession, 'taskId' | 'codespaceId'>> & {
  turns?: PlanTurnRecord[];
};

export function buildPlanSession(
  taskId: string,
  codespaceId: string,
  options: PlanSessionFactoryOptions = {}
): NewPlanSession {
  return {
    id: options.id ?? createId(),
    taskId,
    codespaceId,
    status: options.status ?? 'active',
    turns: options.turns ?? [],
    githubIssueUrl: options.githubIssueUrl ?? null,
    githubIssueNumber: options.githubIssueNumber ?? null,
    createdAt: options.createdAt ?? new Date().toISOString(),
    completedAt: options.completedAt ?? null,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

export async function createTestPlanSession(
  taskId: string,
  codespaceId: string,
  options: PlanSessionFactoryOptions = {}
): Promise<PlanSession> {
  const db = getTestDb();
  const data = buildPlanSession(taskId, codespaceId, options);
  const [session] = await db.insert(planSessions).values(data).returning();

  if (!session) {
    throw new Error('Failed to create test plan session');
  }

  return session;
}

export async function createTestPendingPlan(
  taskId: string,
  options: {
    plan?: string;
    sdkSessionId?: string;
    planningSandboxId?: string;
    turnCount?: number;
  } = {}
): Promise<Task> {
  const db = getTestDb();
  const [task] = await db
    .update(tasks)
    .set({
      column: 'waiting_approval',
      lastAgentStatus: 'planning',
      plan: options.plan ?? 'Test pending plan',
      planOptions: {
        sdkSessionId: options.sdkSessionId ?? 'sdk-session-test',
        planningSandboxId: options.planningSandboxId,
      },
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.id, taskId))
    .returning();

  if (!task) {
    throw new Error('Failed to create test pending plan');
  }

  return task;
}
