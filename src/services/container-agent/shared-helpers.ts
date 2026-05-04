/**
 * Shared helper functions for the container-agent sub-services.
 *
 * Deduplicates common patterns used across container-exec and agentcore-bridge services:
 * - Task status updates on agent completion
 * - Task status updates on agent error
 * - OAuth token resolution
 * - Sandbox mode resolution + multi-tenant gate (F06-NEW-02 / arch29-W1-E)
 */

import { and, eq } from 'drizzle-orm';

import { agents, settings, tasks } from '../../db/schema';
import { SandboxErrors } from '../../lib/errors/sandbox-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import { softInvariant } from '../../lib/utils/invariant.js';
import { isMultiTenantEnabled } from '../../server/bootstrap/server-config.js';
import type { Database } from '../../types/database.js';
import type { ApiKeyService } from '../api-key.service.js';
import type { DurableStreamsService } from '../durable-streams.service.js';
import type { SkillTrackingService } from '../memory/skill-tracking.service.js';

const log = createLogger('ContainerAgentHelpers');

import type { AgentCompleteMetrics } from './types.js';

export type { AgentCompleteMetrics } from './types.js';

/**
 * Update task status when an agent completes successfully or is cancelled.
 *
 * Returns true if the DB write succeeded, false otherwise.
 */
export async function updateTaskOnAgentComplete(
  db: Database,
  taskId: string,
  status: 'completed' | 'turn_limit' | 'cancelled' | 'error',
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
    } else if (status === 'error') {
      // Agent encountered an error — move to waiting_approval so user can see what happened.
      // Keep sessionId so the error details are visible in the session/topology views.
      const [updated] = await db
        .update(tasks)
        .set({
          column: 'waiting_approval',
          agentId: null,
          lastAgentStatus: 'error',
          completedAt: new Date().toISOString(),
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.column, 'in_progress')))
        .returning();
      if (!updated) {
        log.warn('Task not updated on agent error — task may have been moved by user', {
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
          const trackingStatus =
            status === 'completed' ? 'success' : status === 'error' ? 'failed' : 'turn_limit';
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
              log.error('Failed to record container agent skill execution', {
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
    // Preserve sessionId so the UI can display error context and session events,
    // but move out of in_progress so a failed agent is not shown as still
    // running. The column guard prevents overwriting a user cancellation.
    const [updated] = await db
      .update(tasks)
      .set({
        column: 'waiting_approval',
        agentId: null,
        lastAgentStatus: 'error',
        completedAt: new Date().toISOString(),
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
 * theme-03 F11: Resolve the persisted OAuth token expiry in ms since epoch.
 *
 * Reads `expiresAt` from the `api_keys` row for the `anthropic` service (stored
 * as an ISO-8601 string per F06-09). Returns null when the row is missing or
 * the column is null (legacy rows), in which case the agent-runner falls back
 * to a far-future sentinel rather than fabricating a 24h expiry.
 */
export async function resolveOAuthExpiresAtMs(db: Database): Promise<number | null> {
  try {
    const { apiKeys } = await import('../../db/schema');
    const row = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.service, 'anthropic'),
    });
    if (!row?.expiresAt) return null;
    const ms = Date.parse(row.expiresAt);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return ms;
  } catch (err) {
    log.info('Failed to resolve OAuth expiresAt from database', {
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
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

/**
 * F06-NEW-02 / arch29-W1-E — Sandbox mode resolution.
 *
 * Reads the `sandbox.mode` setting from the database. The default is
 * `'shared'` to match the historical behaviour and the `sandbox.mode`
 * defaults defined in the UI (`-sandbox-page.tsx:257`) and read sites
 * (`sandbox-status.ts:210, :395`).
 *
 * Returns `'shared'` when:
 *   - the setting row is missing
 *   - the setting value is malformed JSON
 *   - the setting value is not one of `'shared' | 'per-project'`
 *
 * Callers that need the multi-tenant gate enforced should call
 * `assertSharedSandboxAllowed()` instead — this helper just reports the
 * resolved value.
 */
export async function resolveSandboxMode(db: Database): Promise<'shared' | 'per-project'> {
  try {
    const row = await db.query.settings.findFirst({
      where: eq(settings.key, 'sandbox.mode'),
    });
    if (!row?.value) return 'shared';
    const parsed = JSON.parse(row.value) as unknown;
    if (parsed === 'per-project') return 'per-project';
    if (parsed === 'shared') return 'shared';
    log.warn('Unexpected sandbox.mode value, defaulting to shared', {
      data: { raw: row.value },
    });
    return 'shared';
  } catch (resolveErr) {
    log.warn('Failed to read sandbox.mode setting, defaulting to shared', {
      data: { error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr) },
    });
    return 'shared';
  }
}

async function hasMultipleTenantBoundaries(db: Database): Promise<boolean> {
  try {
    const [teamRows, userRows] = await Promise.all([
      db.query.teams.findMany({ limit: 2 }),
      db.query.users.findMany({ limit: 2 }),
    ]);
    return teamRows.length > 1 || userRows.length > 1;
  } catch (readErr) {
    log.warn(
      'Failed to infer tenant boundary count; assuming single-tenant unless MULTI_TENANT=true',
      {
        data: { error: readErr instanceof Error ? readErr.message : String(readErr) },
      }
    );
    return false;
  }
}

async function shouldEnforcePerProjectSandbox(
  db: Database,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  if (isMultiTenantEnabled(env)) return true;
  return hasMultipleTenantBoundaries(db);
}

/**
 * F06-NEW-02 / arch29-W1-E — Multi-tenant gate enforcement.
 *
 * Throws `MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX` when:
 *   - `MULTI_TENANT=true` is set in the environment OR the local database
 *     already contains multiple team/user boundaries, AND
 *   - the resolved sandbox mode is `'shared'`.
 *
 * In shared mode every codespace shares one Docker container with a single
 * Anthropic OAuth credentials file at `~/.claude/.credentials.json`. A
 * hostile tenant agent can read another tenant's token. The full multi-
 * tenant FS/UID isolation rebuild is L-effort and tracked as a follow-up;
 * this gate is the fail-safe so accidental shared-mode usage in a multi-
 * tenant deployment is rejected at the chokepoint instead of silently
 * leaking credentials.
 *
 * No-op when `MULTI_TENANT` is unset/false and the database still looks like
 * a single-team install.
 *
 * @throws an `AppError` with code `MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX`
 *   when the gate is violated. The caller is expected to surface this as
 *   a typed error via `Result<_, SandboxError>`.
 */
export async function assertSharedSandboxAllowed(
  db: Database,
  codespaceId?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!(await shouldEnforcePerProjectSandbox(db, env))) return;
  const mode = await resolveSandboxMode(db);
  if (mode === 'shared') {
    const errorObj = SandboxErrors.MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX(codespaceId);
    log.error('Multi-tenant gate violated: shared sandbox mode forbidden', {
      data: { codespaceId, mode, code: errorObj.code },
    });
    // Throw the AppError (extends Error) so the caller can wrap into a
    // typed Result<_, SandboxError> via the existing err()/result patterns.
    throw errorObj;
  }
}
