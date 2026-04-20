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

import { inArray } from 'drizzle-orm';
import type { AgentStatus } from '../../../db/schema/shared/enums.js';
import { agents as agentsSqlite } from '../../../db/schema/sqlite/agents.js';
import { createLogger } from '../../../lib/logging/logger.js';
import type { SandboxProvider } from '../../../lib/sandbox/providers/sandbox-provider.js';
import type { SessionService } from '../../../services/session.service.js';
import type { Database } from '../../../types/database.js';

const log = createLogger('AgentShutdown');

const RUNNING_AGENT_STATUSES: readonly AgentStatus[] = ['running', 'planning', 'starting'] as const;

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
}): Promise<number> {
  const budgetMs = params.budgetMs ?? 10_000;
  const deadline = Date.now() + budgetMs;

  let running: Array<{ id: string; currentSessionId: string | null }> = [];
  try {
    running = await params.db
      .select({
        id: agentsSqlite.id,
        currentSessionId: agentsSqlite.currentSessionId,
      })
      .from(agentsSqlite)
      .where(inArray(agentsSqlite.status, [...RUNNING_AGENT_STATUSES]));
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
  // recovery on next boot knows they were unfinished.
  try {
    await params.db
      .update(agentsSqlite)
      .set({ status: 'paused', updatedAt: new Date().toISOString() })
      .where(
        inArray(
          agentsSqlite.id,
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
      const stopTargets = sandboxes.filter((s) => s.status === 'running');
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
