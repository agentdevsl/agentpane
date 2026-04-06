/**
 * Shared helper functions for the container-agent sub-services.
 *
 * Deduplicates common patterns used across container-exec and agentcore-bridge services:
 * - Task status updates on agent completion
 * - Task status updates on agent error
 * - OAuth token resolution
 */

import { and, eq } from 'drizzle-orm';

import { agents, tasks } from '../../db/schema';
import { createLogger } from '../../lib/logging/logger.js';
import { softInvariant } from '../../lib/utils/invariant.js';
import type { Database } from '../../types/database.js';
import type { ApiKeyService } from '../api-key.service.js';
import type { DurableStreamsService } from '../durable-streams.service.js';
import type { SkillTrackingService } from '../memory/skill-tracking.service.js';

const log = createLogger('ContainerAgentHelpers');

/** Enriched completion metrics from the agent-runner. */
export interface AgentCompleteMetrics {
  skillId?: string;
  skillName?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  fileChanges?: { filesModified: number; linesAdded: number; linesRemoved: number };
}

/**
 * Update task status when an agent completes successfully or is cancelled.
 *
 * Returns true if the DB write succeeded, false otherwise.
 */
export async function updateTaskOnAgentComplete(
  db: Database,
  taskId: string,
  status: 'completed' | 'turn_limit' | 'cancelled',
  streams?: DurableStreamsService,
  sessionId?: string,
  skillTrackingService?: SkillTrackingService | null,
  metrics?: AgentCompleteMetrics
): Promise<boolean> {
  try {
    if (status === 'completed') {
      // Only update if task is still in_progress (prevents reverting user cancellation)
      // IMPORTANT: Preserve sessionId so the UI can display session events and topology
      // for review before approval. The session record itself is cleaned up on codespace removal.
      const [updated] = await db
        .update(tasks)
        .set({
          column: 'waiting_approval',
          agentId: null,
          lastAgentStatus: 'completed',
          completedAt: new Date().toISOString(),
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.column, 'in_progress')))
        .returning();
      if (!updated) {
        log.warn('Task not updated on agent complete — task may have been moved by user', {
          data: { taskId, status },
        });
        return false;
      }
    } else if (status === 'turn_limit') {
      // Only update if task is still in_progress (prevents reverting user cancellation)
      const [updated] = await db
        .update(tasks)
        .set({
          column: 'waiting_approval',
          agentId: null,
          lastAgentStatus: 'turn_limit',
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.column, 'in_progress')))
        .returning();
      if (!updated) {
        log.warn('Task not updated on agent turn_limit — task may have been moved by user', {
          data: { taskId, status },
        });
        return false;
      }
    } else {
      // Preserve sessionId on cancel (consistent with completed/turn_limit paths)
      // so the UI can still display session events and topology for cancelled runs.
      const [updated] = await db
        .update(tasks)
        .set({
          agentId: null,
          lastAgentStatus: 'cancelled',
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.column, 'in_progress')))
        .returning();
      if (!updated) {
        log.warn('Task not updated on agent cancel — task may have been moved by user', {
          data: { taskId },
        });
        return false;
      }
    }

    // Record skill execution metrics (fire-and-forget)
    if (skillTrackingService && status !== 'cancelled') {
      try {
        const taskRecord = await db.query.tasks.findFirst({
          where: eq(tasks.id, taskId),
          columns: { skillId: true, skillName: true, codespaceId: true, startedAt: true },
        });
        if (taskRecord?.skillId) {
          const trackingStatus = status === 'completed' ? 'success' : 'turn_limit';
          const now = new Date().toISOString();
          // Compute tokensUsed from enriched usage metrics
          const tokensUsed =
            metrics?.usage?.inputTokens != null || metrics?.usage?.outputTokens != null
              ? (metrics.usage.inputTokens ?? 0) + (metrics.usage.outputTokens ?? 0)
              : null;

          // Compute duration from task startedAt to now
          const durationMs =
            taskRecord.startedAt != null
              ? Date.now() - new Date(taskRecord.startedAt).getTime()
              : null;

          skillTrackingService
            .recordExecution({
              codespaceId: taskRecord.codespaceId,
              skillId: taskRecord.skillId,
              skillName: taskRecord.skillName ?? null,
              taskId,
              agentRunId: null,
              sessionId: sessionId ?? null,
              status: trackingStatus,
              startedAt: taskRecord.startedAt ?? null,
              completedAt: now,
              tokensUsed: tokensUsed ?? undefined,
              durationMs: durationMs ?? undefined,
              filesModified: metrics?.fileChanges?.filesModified ?? undefined,
              linesAdded: metrics?.fileChanges?.linesAdded ?? undefined,
              linesRemoved: metrics?.fileChanges?.linesRemoved ?? undefined,
            })
            .then((result) => {
              if (result.ok) {
                skillTrackingService
                  .refreshMetrics(taskRecord.codespaceId, taskRecord.skillId ?? '')
                  .catch((refreshErr) => {
                    log.warn('Failed to refresh skill metrics', {
                      data: {
                        taskId,
                        error:
                          refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
                      },
                    });
                  });
              }
            })
            .catch((recordErr) => {
              log.warn('Failed to record container agent skill execution', {
                data: {
                  taskId,
                  error: recordErr instanceof Error ? recordErr.message : String(recordErr),
                },
              });
            });
        }
      } catch (lookupErr) {
        log.warn('Failed to look up task for skill tracking', {
          data: {
            taskId,
            error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
          },
        });
      }
    }

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Failed to update task status', { data: { taskId, status, error: errorMessage } });
    if (streams && sessionId) {
      try {
        await streams.publish(sessionId, 'container-agent:task-update-failed', {
          taskId,
          sessionId,
          error: errorMessage,
          attemptedStatus: status,
        });
      } catch (publishErr) {
        log.error('Failed to publish task update error event', {
          data: {
            taskId,
            error: publishErr instanceof Error ? publishErr.message : String(publishErr),
          },
        });
      }
    }
    return false;
  }
}

/**
 * Update task status when an agent encounters an error.
 *
 * Returns true if the DB write succeeded, false otherwise.
 */
export async function updateTaskOnAgentError(
  db: Database,
  taskId: string,
  streams?: DurableStreamsService,
  sessionId?: string
): Promise<boolean> {
  try {
    // Preserve sessionId so the UI can display error context and session events.
    // Note: task stays in in_progress with lastAgentStatus='error'. Moving to
    // backlog here would race with handleAgentComplete since processAgentOutput
    // fires both bridge callbacks and process-exit handlers.
    const [updated] = await db
      .update(tasks)
      .set({
        agentId: null,
        lastAgentStatus: 'error',
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.column, 'in_progress')))
      .returning();

    if (!updated) {
      log.warn('Task not updated on agent error — task may have been moved by user', {
        data: { taskId },
      });
      return false;
    }
    return true;
  } catch (dbErr) {
    const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
    log.error('Failed to update task status on error', {
      data: { taskId, error: errorMessage },
    });
    if (streams && sessionId) {
      try {
        await streams.publish(sessionId, 'container-agent:task-update-failed', {
          taskId,
          sessionId,
          error: errorMessage,
          attemptedStatus: 'error',
        });
      } catch (publishErr) {
        log.warn('Failed to publish task-update-failed event (best-effort)', {
          data: { taskId },
          error: publishErr,
        });
      }
    }
    return false;
  }
}

/**
 * Resolve OAuth token from the API key service, falling back to environment variables.
 *
 * Returns the token string or null if none is available.
 */
export async function resolveOAuthToken(apiKeyService: ApiKeyService): Promise<string | null> {
  let oauthToken: string | null = null;
  try {
    oauthToken = await apiKeyService.getDecryptedKey('anthropic');
    log.info('Retrieved OAuth token from database', {
      data: { hasToken: !!oauthToken, isOAuth: oauthToken?.startsWith('sk-ant-oat') ?? false },
    });
  } catch (keyErr) {
    log.info('Failed to get OAuth token from database', {
      data: { error: keyErr instanceof Error ? keyErr.message : String(keyErr) },
    });
  }

  if (!oauthToken) {
    oauthToken = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? null;
    if (oauthToken) {
      log.info('Using OAuth token from environment variable');
    }
  }

  return oauthToken;
}

/**
 * Update agent record status after completion or error.
 */
export async function updateAgentStatus(
  db: Database,
  taskId: string,
  status: 'completed' | 'error'
): Promise<void> {
  const agentId = `agent-${taskId}`;
  try {
    const [updated] = await db
      .update(agents)
      .set({
        status,
        currentTaskId: null,
        currentSessionId: null,
      })
      .where(eq(agents.id, agentId))
      .returning({ id: agents.id });
    softInvariant(!!updated, 'agent status update expected 1 row', { agentId });
  } catch (dbErr) {
    const errorMessage = dbErr instanceof Error ? dbErr.message : String(dbErr);
    log.error('Failed to update agent status', { data: { agentId, error: errorMessage } });
  }
}
