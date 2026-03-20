/**
 * Recovery Phase (CQ-001)
 *
 * Recovers stale state from previous server runs:
 * - Resets agents stuck in active states to idle
 * - Moves orphaned in-progress tasks back to backlog
 * - Clears worktree references from orphaned tasks
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import * as sqliteSchema from '../../../db/schema/sqlite/index.js';
import { createLogger } from '../../../lib/logging/logger.js';
import type { Database } from '../../../types/database.js';

const log = createLogger('Recovery');

// Schema tables for type-compatible queries across SQLite/PG
const schemaTables = {
  agents: sqliteSchema.agents,
  tasks: sqliteSchema.tasks,
  settings: sqliteSchema.settings,
  worktrees: sqliteSchema.worktrees,
  sessions: sqliteSchema.sessions,
};

/** Return the number of rows affected by an update/delete, handling both SQLite and PG results. */
function getChangedCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  return (result as { changes?: number })?.changes ?? 0;
}

/**
 * Reset agents stuck in active states ('starting', 'planning', 'running') to 'idle'.
 * After a server restart, no agents can be legitimately running.
 */
export async function resetStaleAgents(db: Database): Promise<void> {
  try {
    const staleStatuses = ['starting', 'planning', 'running'] as const;
    const result = await db
      .update(schemaTables.agents)
      .set({
        status: 'idle',
        currentTaskId: null,
        currentSessionId: null,
      })
      .where(inArray(schemaTables.agents.status, [...staleStatuses]));
    const changes = getChangedCount(result);
    if (changes > 0) {
      log.info(`Reset ${changes} stale agent(s) to idle`);
    }
  } catch (error) {
    log.error('Failed to reset stale agents', {
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Recover tasks stuck in 'in_progress' with a non-null agentId.
 * Moves them back to 'backlog' and clears stale references.
 * Uses direct DB update to avoid triggering agent auto-start.
 */
export async function recoverOrphanedTasks(db: Database): Promise<void> {
  try {
    const result = await db
      .update(schemaTables.tasks)
      .set({
        column: 'backlog',
        agentId: null,
        sessionId: null,
        lastAgentStatus: null,
      })
      .where(
        and(eq(schemaTables.tasks.column, 'in_progress'), isNotNull(schemaTables.tasks.agentId))
      );
    const changes = getChangedCount(result);
    if (changes > 0) {
      log.info(`Recovered ${changes} orphaned task(s) back to backlog`);
    }
  } catch (error) {
    log.error('Failed to recover orphaned tasks', {
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Clear worktree references from tasks whose agents are no longer running.
 * After a server crash, tasks may still reference worktrees that should be cleaned up.
 */
export async function cleanOrphanedWorktrees(db: Database): Promise<void> {
  try {
    const orphanedTasks = await db
      .select({
        id: schemaTables.tasks.id,
        worktreeId: schemaTables.tasks.worktreeId,
        lastAgentStatus: schemaTables.tasks.lastAgentStatus,
      })
      .from(schemaTables.tasks)
      .where(isNotNull(schemaTables.tasks.worktreeId));

    const tasksToClean = orphanedTasks.filter(
      (t) => t.worktreeId && t.lastAgentStatus !== 'planning'
    );

    if (tasksToClean.length > 0) {
      log.info(`Found ${tasksToClean.length} task(s) with orphaned worktrees`);
      for (const t of tasksToClean) {
        try {
          await db
            .update(schemaTables.tasks)
            .set({
              worktreeId: null,
              branch: null,
            })
            .where(eq(schemaTables.tasks.id, t.id));
        } catch (cleanErr) {
          log.error('Failed to clear worktree refs for task', {
            error: cleanErr,
            data: { taskId: t.id },
          });
        }
      }
      log.info(`Cleared worktree references from ${tasksToClean.length} task(s)`);
    }
  } catch (error) {
    log.error('Failed to clean orphaned worktrees', {
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Run all recovery operations in sequence.
 * Safe to call on every server startup.
 * Returns any errors encountered so the bootstrap pipeline can decide how to handle them.
 */
export async function runRecovery(db: Database): Promise<{ errors: Error[] }> {
  const errors: Error[] = [];
  try {
    await resetStaleAgents(db);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    errors.push(err);
    log.error('Failed to reset stale agents', { error: err });
  }
  try {
    await recoverOrphanedTasks(db);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    errors.push(err);
    log.error('Failed to recover orphaned tasks', { error: err });
  }
  try {
    await cleanOrphanedWorktrees(db);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    errors.push(err);
    log.error('Failed to clean orphaned worktrees', { error: err });
  }
  return { errors };
}
