import { createId } from '@paralleldrive/cuid2';
import type { NewSession, Session } from '../../src/db/schema';
import { sessions } from '../../src/db/schema';
import { getTestDb } from '../helpers/database';

type SessionStatus = 'idle' | 'initializing' | 'active' | 'paused' | 'closing' | 'closed' | 'error';

export type SessionFactoryOptions = Partial<Omit<NewSession, 'codespaceId'>> & {
  codespaceId?: string;
  status?: SessionStatus;
  taskId?: string | null;
  agentId?: string | null;
};

export function buildSession(codespaceId: string, options: SessionFactoryOptions = {}): NewSession {
  const id = options.id ?? createId();

  return {
    id,
    codespaceId,
    taskId: options.taskId ?? null,
    agentId: options.agentId ?? null,
    status: options.status ?? 'active',
    title: options.title ?? `Test Session ${id.slice(0, 6)}`,
    url: options.url ?? `http://localhost:3000/sessions/${id}`,
    closedAt: options.closedAt ?? null,
  };
}

export async function createTestSession(
  codespaceId: string,
  options: SessionFactoryOptions = {}
): Promise<Session> {
  const db = getTestDb();
  const data = buildSession(codespaceId, options);

  const [session] = await db.insert(sessions).values(data).returning();

  if (!session) {
    throw new Error('Failed to create test session');
  }

  return session;
}

export async function createTestSessions(
  codespaceId: string,
  count: number,
  options: SessionFactoryOptions = {}
): Promise<Session[]> {
  const createdSessions: Session[] = [];

  for (let i = 0; i < count; i++) {
    const session = await createTestSession(codespaceId, {
      ...options,
      title: options.title ?? `Test Session ${i + 1}`,
    });
    createdSessions.push(session);
  }

  return createdSessions;
}

export async function createActiveSession(
  codespaceId: string,
  taskId: string,
  agentId: string,
  options: SessionFactoryOptions = {}
): Promise<Session> {
  return createTestSession(codespaceId, {
    ...options,
    taskId,
    agentId,
    status: 'active',
  });
}

export async function createClosedSession(
  codespaceId: string,
  options: SessionFactoryOptions = {}
): Promise<Session> {
  return createTestSession(codespaceId, {
    ...options,
    status: 'closed',
    closedAt: options.closedAt ?? new Date(),
  });
}
