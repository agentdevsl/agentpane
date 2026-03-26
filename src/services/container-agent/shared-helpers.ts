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

const log = createLogger('ContainerAgentHelpers');

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
  sessionId?: string
): Promise<boolean> {
  try {
    if (status === 'completed') {
      // Only update if task is still in_progress (prevents reverting user cancellation)
      const [updated] = await db
        .update(tasks)
        .set({
          column: 'waiting_approval',
          agentId: null,
          sessionId: null,
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
          sessionId: null,
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
      const [updated] = await db
        .update(tasks)
        .set({
          agentId: null,
          sessionId: null,
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
    const [updated] = await db
      .update(tasks)
      .set({
        agentId: null,
        sessionId: null,
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
