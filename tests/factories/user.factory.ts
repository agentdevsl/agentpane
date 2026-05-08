import { createId } from '@paralleldrive/cuid2';
import type { NewUser, User } from '../../src/db/schema';
import { users } from '../../src/db/schema';
import { getTestDb } from '../helpers/database';

export type UserFactoryOptions = Partial<NewUser>;

export function buildUser(options: UserFactoryOptions = {}): NewUser {
  const id = options.id ?? createId();
  const githubLogin = options.githubLogin ?? `test-user-${id.slice(0, 6)}`;

  return {
    id,
    githubId: options.githubId ?? Number.parseInt(id.replace(/\D/g, '').slice(0, 9) || '1', 10),
    githubLogin,
    name: options.name ?? 'Test User',
    email: options.email ?? `${githubLogin}@example.test`,
    githubEmail: options.githubEmail ?? `${githubLogin}@example.test`,
    avatarUrl: options.avatarUrl ?? null,
    createdAt: options.createdAt ?? new Date().toISOString(),
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

export async function createTestUser(options: UserFactoryOptions = {}): Promise<User> {
  const db = getTestDb();
  const data = buildUser(options);
  const [user] = await db.insert(users).values(data).returning();

  if (!user) {
    throw new Error('Failed to create test user');
  }

  return user;
}
