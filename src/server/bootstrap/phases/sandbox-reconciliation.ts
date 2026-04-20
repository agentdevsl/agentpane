/**
 * Sandbox Reconciliation Phase (F01-01)
 *
 * On startup, lists the live sandboxes reported by the configured provider
 * (Docker / K8s / Nomad) and cross-references the `sandbox_instances` DB
 * table. Two reconciliation actions:
 *
 * 1. Orphan sandbox (live in provider, no DB row): inserted into the DB so
 *    the rest of the app can see and manage it. The running agent maps
 *    inside `SandboxStateManager` stay empty — any in-flight agent
 *    execution was aborted by the process restart, and agents will be
 *    re-launched by the normal task-move flow.
 *
 * 2. Orphan DB row (DB says running, provider has no such sandbox):
 *    marked `stopped` so the scheduler and UI do not keep a stale
 *    reference.
 *
 * This complements the {@link runRecovery} phase which resets stale agent
 * status but does NOT look at actual live containers.
 *
 * Runs AFTER {@link initSandboxProvider} completes (so the provider is
 * non-null) and BEFORE the server starts serving meaningful traffic
 * (the `/api/health` readiness gate, F01-03, returns 503 until this
 * phase sets `sandboxState.reconciled = true`).
 */

import { inArray } from 'drizzle-orm';
import * as pgSchema from '../../../db/schema/postgres/index.js';
import * as sqliteSchema from '../../../db/schema/sqlite/index.js';
import { createLogger } from '../../../lib/logging/logger.js';
import type {
  EventEmittingSandboxProvider,
  SandboxProvider,
} from '../../../lib/sandbox/providers/sandbox-provider.js';
import type { SandboxInfo, SandboxStatus } from '../../../lib/sandbox/types.js';
import type { Database } from '../../../types/database.js';
import type { SandboxState, ServerConfig, ServiceContainer } from '../types.js';

const log = createLogger('SandboxReconciliation');

/**
 * Resolve the `sandbox_instances` table reference for the active DB mode.
 *
 * Mirrors the DB-mode dispatch pattern used in `database.ts` so queries
 * built here target the correct driver schema. The Drizzle SQL surface is
 * identical across drivers, and the app's `Database` type is canonicalised
 * to `SqliteDatabase` (see `src/types/database.ts`) — the PG driver is
 * cast into that shape at creation time so the same query builder
 * works across both backends. The cast to `typeof sqliteSchema.xxx`
 * below mirrors that convention: column metadata differs structurally
 * between dialects, but the runtime SQL emitted by Drizzle is
 * driver-aware and uses the correct quoting / parameter binding.
 */
function resolveSchemaTables(dbMode: ServerConfig['dbMode'] = 'sqlite') {
  if (dbMode === 'postgres') {
    return {
      sandboxInstances:
        pgSchema.sandboxInstances as unknown as typeof sqliteSchema.sandboxInstances,
    };
  }
  return { sandboxInstances: sqliteSchema.sandboxInstances };
}

/**
 * Shape returned by the reconciliation step. Exposed for tests so the
 * outcome can be asserted without relying on log scraping.
 */
export interface ReconciliationReport {
  /** Live sandboxes seen from the provider. */
  providerCount: number;
  /** Sandbox rows in the DB with an active status (creating/running/idle/stopping). */
  dbCount: number;
  /** Live sandboxes with no matching DB row — adopted into the DB. */
  adoptedCount: number;
  /** DB rows whose referenced sandbox is gone — marked `stopped`. */
  terminatedCount: number;
  /** Names of adopted sandbox IDs for logging/tests. */
  adopted: string[];
  /** DB row IDs marked terminated for logging/tests. */
  terminated: string[];
}

/**
 * Providers expose a uniform {@link SandboxProvider.list} method (see
 * `src/lib/sandbox/providers/sandbox-provider.ts`). This shape captures
 * just the fields reconciliation needs so the function is easily
 * unit-tested with a mock.
 */
type ListableProvider = Pick<SandboxProvider, 'list' | 'name'>;

/**
 * Reconcile live sandboxes against the `sandbox_instances` table.
 *
 * @param db The app database handle.
 * @param sandboxState Mutable sandbox state from bootstrap — the active
 *   provider is read from `sandboxState.provider`; if unset, the phase
 *   is a no-op so callers never need to guard the call.
 * @param services Unused today but reserved for future use (e.g., if we
 *   decide to adopt orphans into SandboxStateManager). Keeping the
 *   signature lets callers wire it once and forget.
 * @param providerOverride Optional provider to use in tests. Falls back
 *   to `sandboxState.provider`.
 * @param dbMode The active database mode — used to pick the correct
 *   Drizzle schema table objects. Defaults to `'sqlite'` so existing
 *   call sites and tests (which were written against SQLite) continue
 *   to work without changes.
 */
export async function reconcileSandboxes(
  db: Database,
  sandboxState: Pick<SandboxState, 'provider'>,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: reserved for future invariants
  _services?: ServiceContainer,
  providerOverride?: ListableProvider,
  dbMode: ServerConfig['dbMode'] = 'sqlite'
): Promise<ReconciliationReport> {
  const schemaTables = resolveSchemaTables(dbMode);
  const provider: ListableProvider | null =
    providerOverride ?? (sandboxState.provider as EventEmittingSandboxProvider | null);

  if (!provider) {
    log.info('Skipping sandbox reconciliation — no provider available');
    return {
      providerCount: 0,
      dbCount: 0,
      adoptedCount: 0,
      terminatedCount: 0,
      adopted: [],
      terminated: [],
    };
  }

  const report: ReconciliationReport = {
    providerCount: 0,
    dbCount: 0,
    adoptedCount: 0,
    terminatedCount: 0,
    adopted: [],
    terminated: [],
  };

  // Step 1: Enumerate provider state
  let liveSandboxes: SandboxInfo[] = [];
  try {
    liveSandboxes = await provider.list();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn(`Provider '${provider.name}' list() failed — skipping reconciliation`, {
      error,
    });
    return report;
  }
  report.providerCount = liveSandboxes.length;
  const liveById = new Map(liveSandboxes.map((s) => [s.id, s] as const));

  // Step 2: Enumerate DB state — only rows in an active status. Terminal
  // rows (`stopped`, `error`) are historical and don't participate in
  // reconciliation; filtering them at the DB lets the query use the
  // status index and avoids a full table scan on large deployments.
  const activeStatuses: SandboxStatus[] = ['creating', 'running', 'idle', 'stopping'];
  const dbRows = await db
    .select({
      id: schemaTables.sandboxInstances.id,
      codespaceId: schemaTables.sandboxInstances.codespaceId,
      containerId: schemaTables.sandboxInstances.containerId,
      status: schemaTables.sandboxInstances.status,
      image: schemaTables.sandboxInstances.image,
      memoryMb: schemaTables.sandboxInstances.memoryMb,
      cpuCores: schemaTables.sandboxInstances.cpuCores,
      idleTimeoutMinutes: schemaTables.sandboxInstances.idleTimeoutMinutes,
    })
    .from(schemaTables.sandboxInstances)
    .where(inArray(schemaTables.sandboxInstances.status, activeStatuses));
  report.dbCount = dbRows.length;
  const dbById = new Map(dbRows.map((r) => [r.id, r] as const));

  // Step 3: Adopt live sandboxes that have no DB row.
  const toAdopt = liveSandboxes.filter((s) => !dbById.has(s.id));
  for (const live of toAdopt) {
    try {
      await db
        .insert(schemaTables.sandboxInstances)
        .values({
          id: live.id,
          codespaceId: live.codespaceId,
          containerId: live.containerId,
          status: live.status as SandboxStatus,
          image: live.image,
          memoryMb: live.memoryMb,
          cpuCores: live.cpuCores,
          // Providers don't surface idleTimeoutMinutes via list(); use a safe
          // default. The scheduler will correct this as activity arrives.
          idleTimeoutMinutes: 30,
        })
        .onConflictDoNothing();
      report.adoptedCount++;
      report.adopted.push(live.id);
      log.info('Adopted orphan sandbox into DB', {
        data: { sandboxId: live.id, codespaceId: live.codespaceId, status: live.status },
      });
    } catch (err) {
      log.warn('Failed to adopt orphan sandbox', {
        error: err instanceof Error ? err : new Error(String(err)),
        data: { sandboxId: live.id },
      });
    }
  }

  // Step 4: Terminate DB rows whose referenced sandbox is gone from the
  // provider. We only consider the active statuses selected in Step 2 —
  // rows already in `stopped`/`error` states are left as historical
  // records (they were filtered out by the `where(inArray(status, ...))`
  // clause above).
  const orphanDbIds = dbRows.filter((r) => !liveById.has(r.id)).map((r) => r.id);

  if (orphanDbIds.length > 0) {
    try {
      await db
        .update(schemaTables.sandboxInstances)
        .set({
          status: 'stopped',
          errorMessage: 'Marked terminated by sandbox reconciliation on startup',
          stoppedAt: new Date().toISOString(),
        })
        .where(inArray(schemaTables.sandboxInstances.id, orphanDbIds));
      report.terminatedCount = orphanDbIds.length;
      report.terminated.push(...orphanDbIds);
      log.info(`Terminated ${orphanDbIds.length} orphan sandbox DB row(s)`, {
        data: { ids: orphanDbIds },
      });
    } catch (err) {
      log.warn('Failed to terminate orphan DB rows', {
        error: err instanceof Error ? err : new Error(String(err)),
        data: { orphanDbIds },
      });
    }
  }

  log.info('Sandbox reconciliation complete', { data: { ...report } });
  return report;
}
