import { and, asc, count, eq, lt, sql } from 'drizzle-orm';
import type { Task, TaskColumn } from '../../db/schema';
import { agentRuns, tasks } from '../../db/schema';
import type { AgentError } from '../../lib/errors/agent-errors.js';
import type { ConcurrencyError } from '../../lib/errors/concurrency-errors.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import { canTransition } from '../../services/task-transitions.js';
import type { Database } from '../../types/database.js';
import type { QueuePosition, QueueStats } from './types.js';

/** Number of recent agent runs to consider for average completion time */
const RECENT_RUNS_WINDOW = 20;

/**
 * Build a QueuePosition from a queued task and its position/total.
 */
function buildQueuePosition(
  task: Task,
  position: number,
  totalQueued: number,
  averageCompletionMs: number
): QueuePosition {
  const estimatedWaitMs = position * averageCompletionMs;
  const estimatedWaitMinutes = Math.ceil(estimatedWaitMs / 60_000);
  const estimatedWaitFormatted =
    estimatedWaitMinutes < 1
      ? '< 1 min'
      : estimatedWaitMinutes === 1
        ? '1 min'
        : `${estimatedWaitMinutes} mins`;

  return {
    taskId: task.id,
    position,
    totalQueued,
    estimatedWaitMs,
    estimatedWaitMinutes,
    estimatedWaitFormatted,
  };
}

/**
 * AgentQueueService handles queue management for agents.
 *
 * Responsibilities:
 * - Queue task execution when concurrency limits are reached
 * - Track queue positions and waiting times
 * - Dequeue tasks for agent pickup when agents become available
 * - Provide queue statistics
 */
export class AgentQueueService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Queue a task for execution when agent availability permits.
   * Sets the task column to 'queued' and records the current time as updatedAt
   * (used for FIFO ordering).
   *
   * @returns Queue position info for the newly queued task
   */
  async queueTask(
    projectId: string,
    taskId: string
  ): Promise<Result<QueuePosition, ConcurrencyError>> {
    // Validate task exists and transition is allowed
    const existingTask = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });

    if (!existingTask) {
      return err({
        code: 'QUEUE_ERROR',
        message: 'Task not found',
        status: 404,
      } as ConcurrencyError);
    }

    if (!canTransition(existingTask.column as TaskColumn, 'queued')) {
      return err({
        code: 'QUEUE_ERROR',
        message: `Cannot queue task: invalid transition from '${existingTask.column}' to 'queued'`,
        status: 400,
      } as ConcurrencyError);
    }

    const now = new Date().toISOString();

    // Update task to queued column
    await this.db
      .update(tasks)
      .set({
        column: 'queued',
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId));

    // Count how many tasks are ahead of this one (queued earlier)
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });

    if (!task) {
      // Task disappeared after update — possible data integrity issue
      console.error(`[AgentQueueService] Task ${taskId} not found after update to 'queued'`);
      return err({
        code: 'QUEUE_ERROR',
        message: 'Task not found after queue update — possible data integrity issue',
        status: 500,
      } as ConcurrencyError);
    }

    // Get the total count and position
    const queuedTasks = await this.db.query.tasks.findMany({
      where: and(eq(tasks.projectId, projectId), eq(tasks.column, 'queued')),
      orderBy: asc(tasks.updatedAt),
    });

    const totalQueued = queuedTasks.length;
    const position = queuedTasks.findIndex((t) => t.id === taskId);
    const avgCompletion = await this.getAverageCompletionMs(projectId);

    return ok(buildQueuePosition(task, position, totalQueued, avgCompletion));
  }

  /**
   * Dequeue the next task from the queue (oldest first / FIFO).
   * Returns the task if one is available, or null if the queue is empty.
   *
   * This is called when an agent completes a task and is ready for more work.
   */
  async dequeueNext(projectId: string): Promise<Result<Task | null, never>> {
    // Find the oldest queued task
    const nextTask = await this.db.query.tasks.findFirst({
      where: and(eq(tasks.projectId, projectId), eq(tasks.column, 'queued')),
      orderBy: asc(tasks.updatedAt),
    });

    if (!nextTask) {
      return ok(null);
    }

    // Atomically claim it by moving to backlog (start() accepts backlog tasks).
    // Use a WHERE clause that also checks column='queued' to prevent double-claim.
    const [claimed] = await this.db
      .update(tasks)
      .set({ column: 'backlog', updatedAt: new Date().toISOString() })
      .where(and(eq(tasks.id, nextTask.id), eq(tasks.column, 'queued')))
      .returning();

    if (!claimed) {
      // Another agent already claimed this task — return null (caller can retry)
      return ok(null);
    }

    return ok(claimed);
  }

  /**
   * Get the queue position for a task.
   * Returns null if the task is not in the queued column.
   */
  async getQueuePosition(taskId: string): Promise<Result<QueuePosition | null, AgentError>> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });

    if (!task || task.column !== 'queued') {
      return ok(null);
    }

    // Count tasks queued before this one (earlier updatedAt = higher priority)
    const [result] = await this.db
      .select({ count: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, task.projectId),
          eq(tasks.column, 'queued'),
          lt(tasks.updatedAt, task.updatedAt)
        )
      );

    const position = result?.count ?? 0;

    // Get total queued count
    const [totalResult] = await this.db
      .select({ count: count() })
      .from(tasks)
      .where(and(eq(tasks.projectId, task.projectId), eq(tasks.column, 'queued')));

    const totalQueued = totalResult?.count ?? 0;
    const avgCompletion = await this.getAverageCompletionMs(task.projectId);

    return ok(buildQueuePosition(task, position, totalQueued, avgCompletion));
  }

  /**
   * Get queue statistics for a project.
   * Includes total queued count, average completion time, and recent completion count.
   */
  async getQueueStats(projectId?: string): Promise<Result<QueueStats, never>> {
    // Count queued tasks
    const queuedFilter = projectId
      ? and(eq(tasks.column, 'queued'), eq(tasks.projectId, projectId))
      : eq(tasks.column, 'queued');

    const [queuedResult] = await this.db.select({ count: count() }).from(tasks).where(queuedFilter);

    const totalQueued = queuedResult?.count ?? 0;

    // Get average completion time and recent completions from agent_runs
    const runFilter = projectId
      ? and(eq(agentRuns.projectId, projectId), sql`${agentRuns.completedAt} IS NOT NULL`)
      : sql`${agentRuns.completedAt} IS NOT NULL`;

    const recentRuns = await this.db.query.agentRuns.findMany({
      where: runFilter,
      orderBy: [sql`${agentRuns.completedAt} DESC`],
      limit: RECENT_RUNS_WINDOW,
    });

    let averageCompletionMs = 0;
    const recentCompletions = recentRuns.length;

    if (recentRuns.length > 0) {
      let totalDurationMs = 0;
      let validRuns = 0;

      for (const run of recentRuns) {
        if (run.startedAt && run.completedAt) {
          const startMs = new Date(run.startedAt).getTime();
          const endMs = new Date(run.completedAt).getTime();
          const duration = endMs - startMs;
          if (duration > 0) {
            totalDurationMs += duration;
            validRuns++;
          }
        }
      }

      if (validRuns > 0) {
        averageCompletionMs = Math.round(totalDurationMs / validRuns);
      }
    }

    return ok({
      totalQueued,
      averageCompletionMs,
      recentCompletions,
    });
  }

  /**
   * Get all queued tasks for a project, ordered by queue position (FIFO).
   */
  async getQueuedTasks(projectId?: string): Promise<Result<QueuePosition[], never>> {
    const filter = projectId
      ? and(eq(tasks.column, 'queued'), eq(tasks.projectId, projectId))
      : eq(tasks.column, 'queued');

    const queuedTasks = await this.db.query.tasks.findMany({
      where: filter,
      orderBy: asc(tasks.updatedAt),
    });

    const totalQueued = queuedTasks.length;
    const avgCompletion = projectId
      ? await this.getAverageCompletionMs(projectId)
      : await this.getAverageCompletionMsGlobal();

    const positions: QueuePosition[] = queuedTasks.map((task, index) =>
      buildQueuePosition(task, index, totalQueued, avgCompletion)
    );

    return ok(positions);
  }

  /**
   * Compute the average completion time (ms) from recent agent runs for a project.
   */
  private async getAverageCompletionMs(projectId: string): Promise<number> {
    const recentRuns = await this.db.query.agentRuns.findMany({
      where: and(eq(agentRuns.projectId, projectId), sql`${agentRuns.completedAt} IS NOT NULL`),
      orderBy: [sql`${agentRuns.completedAt} DESC`],
      limit: RECENT_RUNS_WINDOW,
    });

    return this.computeAverageDuration(recentRuns);
  }

  /**
   * Compute the average completion time (ms) from recent agent runs globally.
   */
  private async getAverageCompletionMsGlobal(): Promise<number> {
    const recentRuns = await this.db.query.agentRuns.findMany({
      where: sql`${agentRuns.completedAt} IS NOT NULL`,
      orderBy: [sql`${agentRuns.completedAt} DESC`],
      limit: RECENT_RUNS_WINDOW,
    });

    return this.computeAverageDuration(recentRuns);
  }

  /**
   * Compute average duration from a list of agent runs that have both startedAt and completedAt.
   */
  private computeAverageDuration(
    runs: Array<{ startedAt: string; completedAt: string | null }>
  ): number {
    let totalDurationMs = 0;
    let validRuns = 0;

    for (const run of runs) {
      if (run.startedAt && run.completedAt) {
        const startMs = new Date(run.startedAt).getTime();
        const endMs = new Date(run.completedAt).getTime();
        const duration = endMs - startMs;
        if (duration > 0) {
          totalDurationMs += duration;
          validRuns++;
        }
      }
    }

    return validRuns > 0 ? Math.round(totalDurationMs / validRuns) : 0;
  }
}
