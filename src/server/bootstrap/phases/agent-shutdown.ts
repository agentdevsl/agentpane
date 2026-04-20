/**
 * F11-03: Graceful shutdown for in-flight agent runs.
 *
 * When the API process receives SIGTERM during a rolling upgrade, we have a
 * short window to tell the UI that running agents are being interrupted and to
 * best-effort stop their backing sandbox containers so they don't outlive the
 * pod.
 *
 * Budget: ~10 seconds of the overall 30s `GracefulShutdown` timeout. If the
 * sandbox provider is unreachable or a sandbox is wedged we fall through to
 * the next cleanup — the force-exit safety net in GracefulShutdown catches
 * any runaway.
 */

import { inArray, sql } from 'drizzle-orm';
import * as pgSchema from '../../../db/schema/postgres/index.js';
import type { AgentStatus } from '../../../db/schema/shared/enums.js';
import * as sqliteSchema from '../../../db/schema/sqlite/index.js';
import { createLogger } from '../../../lib/logging/logger.js';
import type { SandboxProvider } from '../../../lib/sandbox/providers/sandbox-provider.js';
import type { SessionService } from '../../../services/session.service.js';
import type { Database } from '../../../types/database.js';
import type { ServerConfig } from '../types.js';

const log = createLogger('AgentShutdown');

const RUNNING_AGENT_STATUSES: readonly AgentStatus[] = ['running', 'planning', 'starting'] as const;

/**
 * Resolve the `agents` table reference for the active DB mode.
 *
 * Mirrors the dispatch pattern in `sandbox-reconciliation.ts` so queries built
 * here target the correct driver schema. Drizzle's runtime SQL is driver-aware
 * — the cast to the SQLite schema type satisfies the canonical `Database`
 * handle (see `src/types/database.ts`) while the actual column metadata used
 * at execution time is the correct dialect's.
 */
function resolveSchemaTables(dbMode: ServerConfig['dbMode'] = 'sqlite') {
  if (dbMode === 'postgres') {
    return {
      agents: pgSchema.agents as unknown as typeof sqliteSchema.agents,
    };
  }
  return { agents: sqliteSchema.agents };
}

/**
 * Flush in-flight agent runs before the process exits.
 *
 * Steps:
 *   1. Snapshot agents currently in a running/planning/starting state.
 *   2. Publish an `agent:interrupted` event on each agent's session stream so
 *      the UI can flip to "restarting" rather than showing a dead-but-alive
 *      agent. Uses `Promise.allSettled` with a per-event timeout — one bad
 *      stream must not block the whole shutdown.
 *   3. Mark each agent `status: 'paused'` in the DB (AgentStatus does not
 *      include `interrupted`; `paused` is the closest semantic match and is
 *      what the recovery phase already knows how to reset on next boot).
 *   4. Best-effort `sandboxProvider.stop()` for any sandbox we can associate
 *      with a running agent.
 *
 * The whole function is bounded by `budgetMs` (default 10_000).
 *
 * Returns the number of agents we interrupted for logging/observability.
 */
export async function flushRunningAgents(params: {
  db: Database;
  sessionService: SessionService;
  getSandboxProvider: () => SandboxProvider | null;
  budgetMs?: number;
  dbMode?: ServerConfig['dbMode'];
}): Promise<number> {
  const budgetMs = params.budgetMs ?? 10_000;
  const deadline = Date.now() + budgetMs;
  const schemaTables = resolveSchemaTables(params.dbMode);

  let running: Array<{ id: string; currentSessionId: string | null }> = [];
  try {
    running = await params.db
      .select({
        id: schemaTables.agents.id,
        currentSessionId: schemaTables.agents.currentSessionId,
      })
      .from(schemaTables.agents)
      .where(inArray(schemaTables.agents.status, [...RUNNING_AGENT_STATUSES]));
  } catch (err) {
    log.warn('Failed to snapshot running agents during shutdown', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return 0;
  }

  if (running.length === 0) {
    log.debug('No running agents to flush');
    return 0;
  }

  log.info(`Flushing ${running.length} running agent(s) for graceful shutdown`);

  // Step 2: publish agent:interrupted to each session in parallel, bounded by
  // the remaining budget so we never wait past the deadline.
  const now = Date.now();
  const remainingForEvents = Math.max(0, Math.min(3_000, deadline - now));
  await Promise.allSettled(
    running.map(async (agent) => {
      if (!agent.currentSessionId) return;
      try {
        const publish = params.sessionService.publish(agent.currentSessionId, {
          type: 'agent:interrupted',
          reason: 'server_shutdown',
          agentId: agent.id,
          timestamp: new Date().toISOString(),
        } as unknown as Parameters<SessionService['publish']>[1]);
        await Promise.race([
          publish,
          new Promise<void>((resolve) => setTimeout(resolve, remainingForEvents)),
        ]);
      } catch (err) {
        log.warn('Failed to publish agent:interrupted event', {
          data: { agentId: agent.id, sessionId: agent.currentSessionId },
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })
  );

  // Step 3: mark each agent paused with a fresh updatedAt timestamp so
  // recovery on next boot knows they were unfinished. Using `CURRENT_TIMESTAMP`
  // lets the DB render the correct dialect-native value — an ISO string would
  // break on Postgres `timestamptz` columns, and a bare `new Date()` requires
  // Drizzle to pick the right conversion per driver.
  try {
    await params.db
      .update(schemaTables.agents)
      .set({ status: 'paused', updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        inArray(
          schemaTables.agents.id,
          running.map((a) => a.id)
        )
      );
    log.info(`Marked ${running.length} agent(s) as paused`);
  } catch (err) {
    log.warn('Failed to mark agents as paused during shutdown', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }

  // Step 4: best-effort stop backing sandboxes. The provider is optional —
  // in tests or when sandbox init has not completed it may be null.
  const provider = params.getSandboxProvider();
  if (provider && Date.now() < deadline) {
    try {
      const sandboxes = await provider.list();
      // Include `creating` (the "starting up" state in the SandboxStatus enum)
      // alongside `running`: an agent booted immediately before SIGTERM may
      // have its sandbox half-provisioned, and leaving such containers orphaned
      // defeats the point of the graceful-shutdown sweep.
      const stopTargets = sandboxes.filter(
        (s) => s.status === 'running' || s.status === 'creating'
      );
      if (stopTargets.length > 0) {
        log.info(`Stopping ${stopTargets.length} sandbox(es) before exit`);
        const remainingBudget = Math.max(0, deadline - Date.now());
        await Promise.race([
          Promise.allSettled(
            stopTargets.map(async (s) => {
              const sandbox = await provider.getById(s.id);
              if (sandbox) {
                await sandbox.stop();
              }
            })
          ),
          new Promise<void>((resolve) => setTimeout(resolve, remainingBudget)),
        ]);
      }
    } catch (err) {
      log.warn('Failed to stop sandboxes during shutdown', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return running.length;
}
