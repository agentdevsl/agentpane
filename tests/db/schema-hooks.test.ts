import { isCuid } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { createTestAgent } from '../factories/agent.factory';

// Factory helpers
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import {
  clearTestDatabase,
  closeTestDatabase,
  getTestDb,
  setupTestDatabase,
} from '../helpers/database';

/**
 * Helper function to check if a datetime string is valid
 * SQLite stores datetime as strings in format: YYYY-MM-DD HH:MM:SS
 */
function isValidDatetimeString(dateStr: string): boolean {
  // SQLite datetime format: YYYY-MM-DD HH:MM:SS
  const sqliteDateRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  return sqliteDateRegex.test(dateStr);
}

/**
 * Helper function to check if datetime was set (not null and valid format)
 * We check format validity since SQLite's datetime('now') produces valid format
 */
function isRecentDatetime(dateStr: string): boolean {
  // For SQLite datetime strings, we just verify the format is correct
  // and that it represents a valid date in the expected range
  if (!isValidDatetimeString(dateStr)) {
    return false;
  }
  // Parse the SQLite datetime string (assumes UTC)
  const [datePart, timePart] = dateStr.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);
  const date = Date.UTC(year, month - 1, day, hour, minute, second);

  const now = Date.now();
  const fiveMinutesAgo = now - 5 * 60_000;
  const fiveMinutesFromNow = now + 5 * 60_000;

  return date >= fiveMinutesAgo && date <= fiveMinutesFromNow;
}

describe('Schema Hooks', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  describe('codespaces table', () => {
    describe('$defaultFn for id', () => {
      it('generates a valid cuid2 id when not provided', async () => {
        const db = getTestDb();

        const [project] = await db
          .insert(schema.codespaces)
          .values({
            name: 'Test Project',
            projectFolderId: 'default-folder',
            path: '/tmp/test-project-1',
          })
          .returning();

        expect(project.id).toBeDefined();
        expect(typeof project.id).toBe('string');
        expect(isCuid(project.id)).toBe(true);
      });

      it('uses provided id when explicitly set', async () => {
        const customId = 'custom-project-id-123';
        const db = getTestDb();

        const [project] = await db
          .insert(schema.codespaces)
          .values({
            id: customId,
            name: 'Test Project',
            projectFolderId: 'default-folder',
            path: '/tmp/test-project-2',
          })
          .returning();

        expect(project.id).toBe(customId);
      });

      it('generates unique ids for multiple inserts', async () => {
        const db = getTestDb();
        const ids = new Set<string>();

        for (let i = 0; i < 10; i++) {
          const [project] = await db
            .insert(schema.codespaces)
            .values({
              name: `Test Project ${i}`,
              projectFolderId: 'default-folder',
              path: `/tmp/test-project-${i + 10}`,
            })
            .returning();
          ids.add(project.id);
        }

        expect(ids.size).toBe(10);
      });
    });

    describe('SQL default for timestamps', () => {
      it('sets createdAt to current datetime when not provided', async () => {
        const db = getTestDb();

        const [project] = await db
          .insert(schema.codespaces)
          .values({
            name: 'Test Project',
            projectFolderId: 'default-folder',
            path: '/tmp/test-project-timestamp',
          })
          .returning();

        expect(project.createdAt).toBeDefined();
        expect(isValidDatetimeString(project.createdAt)).toBe(true);
        expect(isRecentDatetime(project.createdAt)).toBe(true);
      });

      it('sets updatedAt to current datetime when not provided', async () => {
        const db = getTestDb();

        const [project] = await db
          .insert(schema.codespaces)
          .values({
            name: 'Test Project',
            projectFolderId: 'default-folder',
            path: '/tmp/test-project-updated',
          })
          .returning();

        expect(project.updatedAt).toBeDefined();
        expect(project.updatedAt).toBe(project.createdAt);
      });
    });

    describe('table definition constraints', () => {
      it('enforces unique path constraint', async () => {
        const db = getTestDb();

        await db
          .insert(schema.codespaces)
          .values({
            name: 'First Project',
            projectFolderId: 'default-folder',
            path: '/tmp/unique-path',
          })
          .returning();

        await expect(
          db.insert(schema.codespaces).values({
            name: 'Second Project',
            projectFolderId: 'default-folder',
            path: '/tmp/unique-path',
          })
        ).rejects.toThrow();
      });

      it('requires name to be not null', async () => {
        const db = getTestDb();

        await expect(
          db.insert(schema.codespaces).values({
            name: null as unknown as string,
            path: '/tmp/test-project-null-name',
            projectFolderId: 'default-folder',
          })
        ).rejects.toThrow();
      });

      it('requires path to be not null', async () => {
        const db = getTestDb();

        await expect(
          db.insert(schema.codespaces).values({
            name: 'Test Project',
            projectFolderId: 'default-folder',
            path: null as unknown as string,
          })
        ).rejects.toThrow();
      });
    });
  });

  describe('agents table', () => {
    describe('$defaultFn for id', () => {
      it('generates a valid cuid2 id when not provided', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [agent] = await db
          .insert(schema.agents)
          .values({
            codespaceId: project.id,
            name: 'Test Agent',
          })
          .returning();

        expect(agent.id).toBeDefined();
        expect(isCuid(agent.id)).toBe(true);
      });

      it('uses provided id when explicitly set', async () => {
        const project = await createTestProject();
        const customId = 'custom-agent-id-456';
        const db = getTestDb();

        const [agent] = await db
          .insert(schema.agents)
          .values({
            id: customId,
            codespaceId: project.id,
            name: 'Test Agent',
          })
          .returning();

        expect(agent.id).toBe(customId);
      });
    });

    describe('SQL default for timestamps', () => {
      it('sets createdAt to current datetime', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [agent] = await db
          .insert(schema.agents)
          .values({
            codespaceId: project.id,
            name: 'Test Agent',
          })
          .returning();

        expect(agent.createdAt).toBeDefined();
        expect(isValidDatetimeString(agent.createdAt)).toBe(true);
        expect(isRecentDatetime(agent.createdAt)).toBe(true);
      });

      it('sets updatedAt to current datetime', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [agent] = await db
          .insert(schema.agents)
          .values({
            codespaceId: project.id,
            name: 'Test Agent',
          })
          .returning();

        expect(agent.updatedAt).toBeDefined();
        expect(agent.updatedAt).toBe(agent.createdAt);
      });
    });

    describe('default values', () => {
      it('defaults type to task', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [agent] = await db
          .insert(schema.agents)
          .values({
            codespaceId: project.id,
            name: 'Test Agent',
          })
          .returning();

        expect(agent.type).toBe('task');
      });

      it('defaults status to idle', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [agent] = await db
          .insert(schema.agents)
          .values({
            codespaceId: project.id,
            name: 'Test Agent',
          })
          .returning();

        expect(agent.status).toBe('idle');
      });

      it('defaults currentTurn to 0', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [agent] = await db
          .insert(schema.agents)
          .values({
            codespaceId: project.id,
            name: 'Test Agent',
          })
          .returning();

        expect(agent.currentTurn).toBe(0);
      });
    });

    describe('foreign key constraints', () => {
      it('cascades delete when project is deleted', async () => {
        const project = await createTestProject();
        const agent = await createTestAgent(project.id);
        const db = getTestDb();

        await db.delete(schema.codespaces).where(eq(schema.codespaces.id, project.id));

        const deletedAgent = await db.query.agents.findFirst({
          where: eq(schema.agents.id, agent.id),
        });

        expect(deletedAgent).toBeUndefined();
      });
    });
  });

  describe('tasks table', () => {
    describe('$defaultFn for id', () => {
      it('generates a valid cuid2 id when not provided', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [task] = await db
          .insert(schema.tasks)
          .values({
            codespaceId: project.id,
            title: 'Test Task',
          })
          .returning();

        expect(task.id).toBeDefined();
        expect(isCuid(task.id)).toBe(true);
      });
    });

    describe('SQL default for timestamps', () => {
      it('sets createdAt and updatedAt to current datetime', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [task] = await db
          .insert(schema.tasks)
          .values({
            codespaceId: project.id,
            title: 'Test Task',
          })
          .returning();

        expect(task.createdAt).toBeDefined();
        expect(task.updatedAt).toBeDefined();
        expect(task.createdAt).toBe(task.updatedAt);
      });
    });

    describe('default values', () => {
      it('defaults column to backlog', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [task] = await db
          .insert(schema.tasks)
          .values({
            codespaceId: project.id,
            title: 'Test Task',
          })
          .returning();

        expect(task.column).toBe('backlog');
      });

      it('defaults position to 0', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [task] = await db
          .insert(schema.tasks)
          .values({
            codespaceId: project.id,
            title: 'Test Task',
          })
          .returning();

        expect(task.position).toBe(0);
      });

      it('defaults priority to medium', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [task] = await db
          .insert(schema.tasks)
          .values({
            codespaceId: project.id,
            title: 'Test Task',
          })
          .returning();

        expect(task.priority).toBe('medium');
      });

      it('defaults labels to empty array', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [task] = await db
          .insert(schema.tasks)
          .values({
            codespaceId: project.id,
            title: 'Test Task',
          })
          .returning();

        expect(task.labels).toEqual([]);
      });

      it('defaults rejectionCount to 0', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [task] = await db
          .insert(schema.tasks)
          .values({
            codespaceId: project.id,
            title: 'Test Task',
          })
          .returning();

        expect(task.rejectionCount).toBe(0);
      });
    });

    describe('foreign key constraints', () => {
      it('cascades delete when project is deleted', async () => {
        const project = await createTestProject();
        const task = await createTestTask(project.id);
        const db = getTestDb();

        await db.delete(schema.codespaces).where(eq(schema.codespaces.id, project.id));

        const deletedTask = await db.query.tasks.findFirst({
          where: eq(schema.tasks.id, task.id),
        });

        expect(deletedTask).toBeUndefined();
      });

      it('sets agentId to null when agent is deleted', async () => {
        const project = await createTestProject();
        const agent = await createTestAgent(project.id);
        const task = await createTestTask(project.id, { agentId: agent.id });
        const db = getTestDb();

        await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));

        const updatedTask = await db.query.tasks.findFirst({
          where: eq(schema.tasks.id, task.id),
        });

        expect(updatedTask?.agentId).toBeNull();
      });
    });
  });

  describe('sessions table', () => {
    describe('$defaultFn for id', () => {
      it('generates a valid cuid2 id when not provided', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [session] = await db
          .insert(schema.sessions)
          .values({
            codespaceId: project.id,
            url: 'http://localhost:3000/sessions/test',
          })
          .returning();

        expect(session.id).toBeDefined();
        expect(isCuid(session.id)).toBe(true);
      });
    });

    describe('SQL default for timestamps', () => {
      it('sets createdAt and updatedAt to current datetime', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [session] = await db
          .insert(schema.sessions)
          .values({
            codespaceId: project.id,
            url: 'http://localhost:3000/sessions/test',
          })
          .returning();

        expect(session.createdAt).toBeDefined();
        expect(session.updatedAt).toBeDefined();
      });
    });

    describe('default values', () => {
      it('defaults status to idle', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [session] = await db
          .insert(schema.sessions)
          .values({
            codespaceId: project.id,
            url: 'http://localhost:3000/sessions/test',
          })
          .returning();

        expect(session.status).toBe('idle');
      });
    });

    describe('foreign key constraints', () => {
      it('cascades delete when project is deleted', async () => {
        const project = await createTestProject();
        const session = await createTestSession(project.id);
        const db = getTestDb();

        await db.delete(schema.codespaces).where(eq(schema.codespaces.id, project.id));

        const deletedSession = await db.query.sessions.findFirst({
          where: eq(schema.sessions.id, session.id),
        });

        expect(deletedSession).toBeUndefined();
      });
    });
  });

  describe('worktrees table', () => {
    describe('$defaultFn for id', () => {
      it('generates a valid cuid2 id when not provided', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [worktree] = await db
          .insert(schema.worktrees)
          .values({
            codespaceId: project.id,
            branch: 'feature/test-branch',
            path: '/tmp/worktree-test',
          })
          .returning();

        expect(worktree.id).toBeDefined();
        expect(isCuid(worktree.id)).toBe(true);
      });
    });

    describe('SQL default for timestamps', () => {
      it('sets createdAt and updatedAt to current datetime', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [worktree] = await db
          .insert(schema.worktrees)
          .values({
            codespaceId: project.id,
            branch: 'feature/test-branch',
            path: '/tmp/worktree-test-2',
          })
          .returning();

        expect(worktree.createdAt).toBeDefined();
        expect(worktree.updatedAt).toBeDefined();
      });
    });

    describe('default values', () => {
      it('defaults status to creating', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [worktree] = await db
          .insert(schema.worktrees)
          .values({
            codespaceId: project.id,
            branch: 'feature/test-branch',
            path: '/tmp/worktree-test-3',
          })
          .returning();

        expect(worktree.status).toBe('creating');
      });

      it('defaults baseBranch to main', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [worktree] = await db
          .insert(schema.worktrees)
          .values({
            codespaceId: project.id,
            branch: 'feature/test-branch',
            path: '/tmp/worktree-test-4',
          })
          .returning();

        expect(worktree.baseBranch).toBe('main');
      });
    });

    describe('foreign key constraints', () => {
      it('cascades delete when project is deleted', async () => {
        const project = await createTestProject();
        const worktree = await createTestWorktree(project.id);
        const db = getTestDb();

        await db.delete(schema.codespaces).where(eq(schema.codespaces.id, project.id));

        const deletedWorktree = await db.query.worktrees.findFirst({
          where: eq(schema.worktrees.id, worktree.id),
        });

        expect(deletedWorktree).toBeUndefined();
      });
    });
  });

  describe('agentRuns table', () => {
    describe('$defaultFn for id', () => {
      it('generates a valid cuid2 id when not provided', async () => {
        const project = await createTestProject();
        const agent = await createTestAgent(project.id);
        const task = await createTestTask(project.id);
        const db = getTestDb();

        const [agentRun] = await db
          .insert(schema.agentRuns)
          .values({
            agentId: agent.id,
            taskId: task.id,
            codespaceId: project.id,
            status: 'running',
          })
          .returning();

        expect(agentRun.id).toBeDefined();
        expect(isCuid(agentRun.id)).toBe(true);
      });
    });

    describe('SQL default for timestamps', () => {
      it('sets startedAt to current datetime', async () => {
        const project = await createTestProject();
        const agent = await createTestAgent(project.id);
        const task = await createTestTask(project.id);
        const db = getTestDb();

        const [agentRun] = await db
          .insert(schema.agentRuns)
          .values({
            agentId: agent.id,
            taskId: task.id,
            codespaceId: project.id,
            status: 'running',
          })
          .returning();

        expect(agentRun.startedAt).toBeDefined();
        expect(isValidDatetimeString(agentRun.startedAt)).toBe(true);
        expect(isRecentDatetime(agentRun.startedAt)).toBe(true);
      });
    });

    describe('default values', () => {
      it('defaults turnsUsed to 0', async () => {
        const project = await createTestProject();
        const agent = await createTestAgent(project.id);
        const task = await createTestTask(project.id);
        const db = getTestDb();

        const [agentRun] = await db
          .insert(schema.agentRuns)
          .values({
            agentId: agent.id,
            taskId: task.id,
            codespaceId: project.id,
            status: 'running',
          })
          .returning();

        expect(agentRun.turnsUsed).toBe(0);
      });

      it('defaults tokensUsed to 0', async () => {
        const project = await createTestProject();
        const agent = await createTestAgent(project.id);
        const task = await createTestTask(project.id);
        const db = getTestDb();

        const [agentRun] = await db
          .insert(schema.agentRuns)
          .values({
            agentId: agent.id,
            taskId: task.id,
            codespaceId: project.id,
            status: 'running',
          })
          .returning();

        expect(agentRun.tokensUsed).toBe(0);
      });
    });

    describe('foreign key constraints', () => {
      it('cascades delete when agent is deleted', async () => {
        const project = await createTestProject();
        const agent = await createTestAgent(project.id);
        const task = await createTestTask(project.id);
        const db = getTestDb();

        // Insert agent run directly to avoid factory Date binding issues
        const [agentRun] = await db
          .insert(schema.agentRuns)
          .values({
            agentId: agent.id,
            taskId: task.id,
            codespaceId: project.id,
            status: 'running',
          })
          .returning();

        await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));

        const deletedRun = await db.query.agentRuns.findFirst({
          where: eq(schema.agentRuns.id, agentRun.id),
        });

        expect(deletedRun).toBeUndefined();
      });

      it('cascades delete when task is deleted', async () => {
        const project = await createTestProject();
        const agent = await createTestAgent(project.id);
        const task = await createTestTask(project.id);
        const db = getTestDb();

        // Insert agent run directly to avoid factory Date binding issues
        const [agentRun] = await db
          .insert(schema.agentRuns)
          .values({
            agentId: agent.id,
            taskId: task.id,
            codespaceId: project.id,
            status: 'running',
          })
          .returning();

        await db.delete(schema.tasks).where(eq(schema.tasks.id, task.id));

        const deletedRun = await db.query.agentRuns.findFirst({
          where: eq(schema.agentRuns.id, agentRun.id),
        });

        expect(deletedRun).toBeUndefined();
      });

      it('cascades delete when project is deleted', async () => {
        const project = await createTestProject();
        const agent = await createTestAgent(project.id);
        const task = await createTestTask(project.id);
        const db = getTestDb();

        // Insert agent run directly to avoid factory Date binding issues
        const [agentRun] = await db
          .insert(schema.agentRuns)
          .values({
            agentId: agent.id,
            taskId: task.id,
            codespaceId: project.id,
            status: 'running',
          })
          .returning();

        await db.delete(schema.codespaces).where(eq(schema.codespaces.id, project.id));

        const deletedRun = await db.query.agentRuns.findFirst({
          where: eq(schema.agentRuns.id, agentRun.id),
        });

        expect(deletedRun).toBeUndefined();
      });
    });
  });

  describe('auditLogs table', () => {
    describe('$defaultFn for id', () => {
      it('generates a valid cuid2 id when not provided', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [auditLog] = await db
          .insert(schema.auditLogs)
          .values({
            codespaceId: project.id,
            tool: 'Read',
            status: 'complete',
          })
          .returning();

        expect(auditLog.id).toBeDefined();
        expect(isCuid(auditLog.id)).toBe(true);
      });
    });

    describe('SQL default for timestamps', () => {
      it('sets createdAt to current datetime', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [auditLog] = await db
          .insert(schema.auditLogs)
          .values({
            codespaceId: project.id,
            tool: 'Read',
            status: 'complete',
          })
          .returning();

        expect(auditLog.createdAt).toBeDefined();
        expect(isValidDatetimeString(auditLog.createdAt)).toBe(true);
        expect(isRecentDatetime(auditLog.createdAt)).toBe(true);
      });
    });

    describe('foreign key constraints', () => {
      it('cascades delete when project is deleted', async () => {
        const project = await createTestProject();
        const db = getTestDb();

        const [auditLog] = await db
          .insert(schema.auditLogs)
          .values({
            codespaceId: project.id,
            tool: 'Read',
            status: 'complete',
          })
          .returning();

        await db.delete(schema.codespaces).where(eq(schema.codespaces.id, project.id));

        const deletedLog = await db.query.auditLogs.findFirst({
          where: eq(schema.auditLogs.id, auditLog.id),
        });

        expect(deletedLog).toBeUndefined();
      });

      it('sets agentId to null when agent is deleted', async () => {
        const project = await createTestProject();
        const agent = await createTestAgent(project.id);
        const db = getTestDb();

        const [auditLog] = await db
          .insert(schema.auditLogs)
          .values({
            codespaceId: project.id,
            agentId: agent.id,
            tool: 'Read',
            status: 'complete',
          })
          .returning();

        await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));

        const updatedLog = await db.query.auditLogs.findFirst({
          where: eq(schema.auditLogs.id, auditLog.id),
        });

        expect(updatedLog?.agentId).toBeNull();
      });
    });
  });

  // Note: sandboxInstances and sandboxTmuxSessions tables are not included in the
  // main migration SQL (MIGRATION_SQL). Tests for these tables would require
  // updating the migration SQL first.
});
