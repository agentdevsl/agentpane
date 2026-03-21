import Database, { type Database as SQLiteDatabase } from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../src/db/schema/sqlite';
import {
  PROJECT_FOLDERS_ALTER_STATEMENTS,
  PROJECT_FOLDERS_MIGRATION_SQL,
} from '../../src/lib/bootstrap/migrations/v19-project-folders';
import {
  EVENT_SYSTEM_MIGRATION_SQL,
  MIGRATION_SQL,
  RBAC_GITHUB_TOKEN_MIGRATION_SQL,
  RBAC_MIGRATION_SQL,
} from '../../src/lib/bootstrap/phases/schema';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';

const DB_MODE = process.env.DB_MODE ?? 'sqlite';

// Use BetterSQLite3Database as the database type for tests
type TestDatabase = BetterSQLite3Database<typeof schema>;

let testSqlite: SQLiteDatabase | null = null;
let testDb: TestDatabase | null = null;
let pgClient: ReturnType<typeof import('postgres').default> | null = null;

export async function setupTestDatabase(): Promise<TestDatabase> {
  if (testDb) {
    return testDb;
  }

  if (DB_MODE === 'postgres') {
    const postgres = (await import('postgres')).default;
    const { drizzle: drizzlePg } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const pgSchema = await import('../../src/db/schema/postgres/index.js');

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required when DB_MODE=postgres');
    }

    pgClient = postgres(connectionString);
    const db = drizzlePg(pgClient, { schema: pgSchema });
    await migrate(db, { migrationsFolder: './src/db/migrations-pg' });

    // Cast for compatibility — services use the union Database type
    testDb = db as unknown as TestDatabase;
    return testDb;
  }

  // Use in-memory SQLite for tests.
  // FK checking is OFF because the v19 migration adds codespace_id columns
  // but can't remove the NOT NULL constraint on legacy project_id columns.
  // Drizzle ORM only writes to codespace_id, causing NOT NULL failures.
  testSqlite = new Database(':memory:');
  testSqlite.pragma('foreign_keys = OFF');

  testDb = drizzle(testSqlite, { schema });

  // Monkey-patch `transaction()` to support async callbacks.
  // better-sqlite3 transactions are synchronous, but the source code uses
  // `async (tx) => { await tx.update(...) }`. Since all Drizzle operations
  // on better-sqlite3 resolve synchronously, we wrap the async callback
  // inside a native synchronous transaction that captures the result.
  const originalTransaction = testDb.transaction.bind(testDb);
  (testDb as any).transaction = (callback: (tx: any) => any) => {
    let result: any;
    const syncWrapper = (tx: any) => {
      result = callback(tx);
      // If it's a promise, better-sqlite3 will throw. Instead, we handle it.
      return result;
    };
    try {
      return originalTransaction(syncWrapper as any);
    } catch (e: any) {
      // If the error is about returning a promise, the callback returned a
      // thenable. Since better-sqlite3 ops resolve sync, the result is
      // already available. Re-run inside a manual BEGIN/COMMIT.
      if (e?.message?.includes('promise') || e?.message?.includes('Promise')) {
        testSqlite!.exec('BEGIN');
        try {
          // Re-invoke callback with a proxy tx that delegates to testDb
          const txResult = callback(testDb as any);
          testSqlite!.exec('COMMIT');
          return txResult;
        } catch (innerErr) {
          testSqlite!.exec('ROLLBACK');
          throw innerErr;
        }
      }
      throw e;
    }
  };

  // Run base migrations.
  // Patch: make project_id nullable in CREATE TABLE statements so that the
  // Drizzle ORM (which only writes to codespace_id) doesn't fail on NOT NULL.
  const patchedMigration = MIGRATION_SQL
    .replace(/"project_id" TEXT NOT NULL/g, '"project_id" TEXT')
    .replace(/"target_project_id" TEXT NOT NULL/g, '"target_project_id" TEXT');
  testSqlite.exec(patchedMigration);

  // Add team_id column to github_tokens before running RBAC migration.
  // RBAC_MIGRATION_SQL creates an index on github_tokens(team_id), so the
  // column must exist first. Ignore errors in case the column already exists.
  try {
    testSqlite.exec(RBAC_GITHUB_TOKEN_MIGRATION_SQL);
  } catch {
    // column may already exist — safe to ignore
  }

  // Run RBAC migrations (creates teams, task_tags, api_tokens, etc.)
  const patchedRbac = RBAC_MIGRATION_SQL
    .replace(/"project_id" TEXT NOT NULL/g, '"project_id" TEXT');
  testSqlite.exec(patchedRbac);

  // Run event system migrations (event_sources, event_subscriptions, event_log)
  const patchedEvents = EVENT_SYSTEM_MIGRATION_SQL
    .replace(/"target_project_id" TEXT NOT NULL/g, '"target_project_id" TEXT');
  testSqlite.exec(patchedEvents);

  // Run v19 project folders + codespace rename migration
  testSqlite.exec(PROJECT_FOLDERS_MIGRATION_SQL);

  // Run v20 ALTER TABLE statements for FK column renames (idempotent)
  for (const stmt of PROJECT_FOLDERS_ALTER_STATEMENTS) {
    try {
      testSqlite.exec(stmt);
    } catch {
      // Idempotent — column may already exist
    }
  }

  return testDb;
}

/**
 * Execute raw SQL on the test database
 * Useful for creating additional tables or running custom migrations
 */
export function execRawSql(sql: string): void {
  if (DB_MODE === 'postgres') {
    throw new Error('execRawSql is not supported in postgres mode — use pgClient directly');
  }
  if (!testSqlite) {
    throw new Error('Test database not initialized');
  }
  testSqlite.exec(sql);
}

export async function clearTestDatabase(): Promise<void> {
  if (!testDb) {
    return;
  }

  if (DB_MODE === 'postgres' && pgClient) {
    // Truncate all tables in FK-safe order
    await pgClient`TRUNCATE TABLE
      audit_logs, agent_runs, session_events, session_summaries,
      sessions, worktrees, tasks, agents,
      template_codespaces, templates,
      repository_configs, github_tokens, github_installations,
      sandbox_configs, sandboxes, volume_mounts,
      terraform_modules, terraform_registries,
      workflows, plan_sessions, cli_sessions,
      event_log, event_subscriptions, event_sources,
      api_keys, settings, marketplaces,
      codespace_members, codespace_tags, folder_members,
      team_project_folders, codespaces, project_folders
    CASCADE`;
    // Re-seed the default project folder so FK constraints are satisfied
    await pgClient`INSERT INTO project_folders (id, name, slug, description, icon, color)
      VALUES ('default-folder', 'Default', 'default', 'Default project folder for tests', 'Folder', '#6B7280')
      ON CONFLICT (id) DO NOTHING`;
    return;
  }

  // Fast batch cleanup for SQLite — single FFI call instead of 27 ORM round-trips
  if (testSqlite) {
    testSqlite.exec(`
      PRAGMA defer_foreign_keys = ON;
      DELETE FROM audit_logs;
      DELETE FROM event_log;
      DELETE FROM event_subscriptions;
      DELETE FROM event_sources;
      DELETE FROM agent_runs;
      DELETE FROM sessions;
      DELETE FROM worktrees;
      DELETE FROM tasks;
      DELETE FROM agents;
      DELETE FROM repository_configs;
      DELETE FROM github_installations;
      DELETE FROM github_tokens;
      DELETE FROM task_tags;
      DELETE FROM codespace_tags;
      DELETE FROM api_tokens;
      DELETE FROM team_invitations;
      DELETE FROM codespace_members;
      DELETE FROM template_codespaces;
      DELETE FROM folder_members;
      DELETE FROM team_project_folders;
      DELETE FROM team_members;
      DELETE FROM tags;
      DELETE FROM teams;
      DELETE FROM codespaces;
      DELETE FROM project_folders;
      DELETE FROM projects;
      DELETE FROM sandbox_configs;
      DELETE FROM marketplaces;
      PRAGMA defer_foreign_keys = OFF;
    `);
    // Re-seed the default project folder so FK constraints are satisfied
    testSqlite.exec(`
      INSERT OR IGNORE INTO project_folders (id, name, slug, description, icon, color)
      VALUES ('default-folder', 'Default', 'default', 'Default project folder for tests', 'Folder', '#6B7280');
    `);
    return;
  }

  // Fallback: Drizzle ORM cleanup (for edge cases where testSqlite is null)
  await testDb.delete(schema.auditLogs);
  await testDb.delete(schema.eventLog);
  await testDb.delete(schema.eventSubscriptions);
  await testDb.delete(schema.eventSources);
  await testDb.delete(schema.agentRuns);
  await testDb.delete(schema.sessions);
  await testDb.delete(schema.worktrees);
  await testDb.delete(schema.tasks);
  await testDb.delete(schema.agents);
  await testDb.delete(schema.repositoryConfigs);
  await testDb.delete(schema.githubInstallations);
  await testDb.delete(schema.githubTokens);
  await testDb.delete(schema.taskTags);
  await testDb.delete(schema.codespaceTags);
  await testDb.delete(schema.apiTokens);
  await testDb.delete(schema.teamInvitations);
  await testDb.delete(schema.codespaceMembers);
  await testDb.delete(schema.templateCodespaces);
  await testDb.delete(schema.folderMembers);
  await testDb.delete(schema.teamProjectFolders);
  await testDb.delete(schema.teamMembers);
  await testDb.delete(schema.tags);
  await testDb.delete(schema.teams);
  await testDb.delete(schema.codespaces);
  await testDb.delete(schema.projectFolders);
  await testDb.delete(schema.sandboxConfigs);
  await testDb.delete(schema.marketplaces);

  // Re-seed the default project folder so FK constraints are satisfied
  await testDb.insert(schema.projectFolders).values({
    id: 'default-folder',
    name: 'Default',
    slug: 'default',
    description: 'Default project folder for tests',
    icon: 'Folder',
    color: '#6B7280',
  });
}

export async function closeTestDatabase(): Promise<void> {
  if (DB_MODE === 'postgres' && pgClient) {
    await pgClient.end();
    pgClient = null;
    testDb = null;
    return;
  }

  if (testSqlite) {
    testSqlite.close();
    testSqlite = null;
    testDb = null;
  }
}

export function getTestDb(): TestDatabase {
  if (!testDb) {
    throw new Error('Test database not initialized');
  }
  return testDb;
}

export type SeedOptions = {
  projects?: number;
  tasksPerProject?: number;
  agentsPerProject?: number;
};

export async function seedTestDatabase(options: SeedOptions = {}): Promise<schema.Codespace[]> {
  const { projects = 1, tasksPerProject = 5, agentsPerProject = 2 } = options;

  const createdProjects: schema.Codespace[] = [];

  for (let projectIndex = 0; projectIndex < projects; projectIndex += 1) {
    const project = await createTestProject({
      name: `Test Project ${projectIndex + 1}`,
    });
    createdProjects.push(project);

    for (let agentIndex = 0; agentIndex < agentsPerProject; agentIndex += 1) {
      await createTestAgent(project.id, { name: `Agent ${agentIndex + 1}` });
    }

    for (let taskIndex = 0; taskIndex < tasksPerProject; taskIndex += 1) {
      await createTestTask(project.id, { title: `Task ${taskIndex + 1}` });
    }
  }

  return createdProjects;
}
