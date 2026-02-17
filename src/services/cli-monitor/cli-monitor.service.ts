import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import { cliSessions, settings } from '../../db/schema';
import type { Database } from '../../types/database.js';
import type { AgentTopologyNode, CliSession, DaemonInfo, DaemonRegisterPayload } from './types.js';
import { DAEMON_TIMEOUT_MS } from './types.js';

// DurableStreamsServer interface (from session.service.ts)
interface StreamsServer {
  publish(id: string, type: string, data: unknown): Promise<number>;
  addRealtimeSubscriber(
    id: string,
    callback: (event: { type: string; data: unknown; offset: number }) => void
  ): () => void;
  getEvents(id: string): Array<{ type: string; data: unknown; offset: number; timestamp: number }>;
}

const CLI_MONITOR_STREAM_ID = 'cli-monitor';

export class CliMonitorService {
  private static readonly MAX_SESSIONS = 10_000;
  private static readonly MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  private static readonly DEFAULT_RETENTION_DAYS = 7;

  private sessions = new Map<string, CliSession>();
  private daemon: DaemonInfo | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private streamsServer: StreamsServer,
    private db?: Database
  ) {
    if (this.db) {
      this.startMaintenance();
    }
  }

  // ── Daemon Registration ──

  registerDaemon(payload: DaemonRegisterPayload): void {
    // If a different daemon was connected, clear it
    if (this.daemon && this.daemon.daemonId !== payload.daemonId) {
      console.log(`[CliMonitor] Replacing daemon ${this.daemon.daemonId} with ${payload.daemonId}`);
      this.sessions.clear();
    }

    this.daemon = {
      daemonId: payload.daemonId,
      pid: payload.pid,
      version: payload.version,
      watchPath: payload.watchPath,
      capabilities: payload.capabilities,
      registeredAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    };

    this.startHeartbeatCheck();
    this.publish('cli-monitor:daemon-connected', { daemon: this.daemon });
    console.log(
      `[CliMonitor] Daemon registered: ${payload.daemonId} (PID ${payload.pid}, v${payload.version})`
    );
  }

  handleHeartbeat(daemonId: string, _sessionCount: number): 'ok' | 'unknown' | 'stale' {
    if (!this.daemon) {
      return 'unknown';
    }
    if (this.daemon.daemonId !== daemonId) {
      return 'stale';
    }
    this.daemon.lastHeartbeatAt = Date.now();
    return 'ok';
  }

  deregisterDaemon(daemonId: string): boolean {
    if (this.daemon?.daemonId !== daemonId) {
      return false;
    }
    const id = this.daemon.daemonId;
    this.daemon = null;
    this.sessions.clear();
    this.stopHeartbeatCheck();
    this.publish('cli-monitor:daemon-disconnected', {});
    console.log(`[CliMonitor] Daemon deregistered: ${id}`);
    return true;
  }

  // ── Session Ingestion (from daemon) ──

  ingestSessions(daemonId: string, sessions: CliSession[], removedIds: string[]): boolean {
    if (this.daemon?.daemonId !== daemonId) {
      return false;
    }

    // Drop sessions older than DEFAULT_RETENTION_DAYS days (stale JSONL files from previous days)
    const cutoffMs = Date.now() - CliMonitorService.DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    sessions = sessions.filter((s) => s.lastActivityAt >= cutoffMs);

    // Evict oldest sessions if adding would exceed limit
    const newSessionCount = sessions.filter((s) => !this.sessions.has(s.sessionId)).length;
    if (this.sessions.size + newSessionCount > CliMonitorService.MAX_SESSIONS) {
      const sorted = Array.from(this.sessions.entries()).sort(
        (a, b) => a[1].lastActivityAt - b[1].lastActivityAt
      );
      const toEvict = this.sessions.size + newSessionCount - CliMonitorService.MAX_SESSIONS;
      for (let i = 0; i < toEvict && i < sorted.length; i++) {
        const entry = sorted[i];
        if (!entry) continue;
        const [id] = entry;
        this.sessions.delete(id);
        this.publish('cli-monitor:session-removed', { sessionId: id });
      }
    }

    for (const session of sessions) {
      const existing = this.sessions.get(session.sessionId);
      const previousStatus = existing?.status;
      this.sessions.set(session.sessionId, session);

      // Publish update
      this.publish('cli-monitor:session-update', {
        session,
        previousStatus,
      });

      // Publish status change event (for alerts)
      if (previousStatus && previousStatus !== session.status) {
        this.publish('cli-monitor:status-change', {
          sessionId: session.sessionId,
          previousStatus,
          newStatus: session.status,
          timestamp: Date.now(),
        });
      }
    }

    for (const id of removedIds) {
      if (this.sessions.has(id)) {
        this.sessions.delete(id);
        this.publish('cli-monitor:session-removed', { sessionId: id });
      }
    }

    // Persist to DB asynchronously (fire-and-forget)
    if (this.db) {
      this.persistSessions(sessions, removedIds).catch((persistErr) => {
        console.error(
          '[CliMonitor] DB persist error:',
          persistErr instanceof Error ? persistErr.message : String(persistErr)
        );
      });
    }

    return true;
  }

  // ── Queries ──

  isDaemonConnected(): boolean {
    return this.daemon !== null;
  }

  getDaemon(): DaemonInfo | null {
    return this.daemon;
  }

  getSessions(): CliSession[] {
    const cutoffMs = Date.now() - CliMonitorService.DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    return Array.from(this.sessions.values()).filter((s) => s.lastActivityAt >= cutoffMs);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  getStatus(): {
    connected: boolean;
    daemon: DaemonInfo | null;
    sessionCount: number;
  } {
    return {
      connected: this.isDaemonConnected(),
      daemon: this.daemon,
      sessionCount: this.sessions.size,
    };
  }

  // ── Historical Queries (from DB) ──

  getHistoricalSessions(opts?: {
    projectHash?: string;
    since?: number;
    limit?: number;
  }): CliSession[] {
    if (!this.db) return [];

    const limit = Math.min(opts?.limit ?? 100, 500);

    try {
      const conditions = [];
      if (opts?.projectHash) {
        conditions.push(eq(cliSessions.projectHash, opts.projectHash));
      }
      if (opts?.since) {
        conditions.push(gt(cliSessions.lastActivityAt, opts.since));
      }

      const rows = this.db
        .select()
        .from(cliSessions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(cliSessions.lastActivityAt))
        .limit(limit)
        .all();

      return rows.map((row) => this.rowToSession(row));
    } catch (err) {
      console.error(
        '[CliMonitor] Historical query error:',
        err instanceof Error ? err.message : String(err)
      );
      throw err; // Let caller handle — returning [] masks DB failures as empty results
    }
  }

  getTopologyGraph(rootSessionId: string): AgentTopologyNode[] | null {
    const sessions = this.getSessions();
    const rootSession = sessions.find((s) => s.sessionId === rootSessionId);
    if (!rootSession) return null;

    // Build parent→children map
    const childMap = new Map<string, string[]>();
    for (const s of sessions) {
      if (s.parentSessionId) {
        const children = childMap.get(s.parentSessionId) ?? [];
        children.push(s.sessionId);
        childMap.set(s.parentSessionId, children);
      }
    }

    // BFS walk from root, tracking depth
    const result: AgentTopologyNode[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: rootSessionId, depth: 0 }];

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item || visited.has(item.id)) continue;
      visited.add(item.id);

      const session = sessions.find((s) => s.sessionId === item.id);
      if (!session) continue;

      const childIds = childMap.get(item.id) ?? [];
      result.push(
        session.topology
          ? { ...session.topology, depth: item.depth }
          : {
              sessionId: item.id,
              agentType: 'unknown',
              parentSessionId: session.parentSessionId,
              childSessionIds: childIds,
              depth: item.depth,
              status: session.status,
              tokenUsage: session.tokenUsage,
              turnCount: session.turnCount,
              messageCount: session.messageCount,
            }
      );

      for (const childId of childIds) {
        if (!visited.has(childId)) queue.push({ id: childId, depth: item.depth + 1 });
      }
    }

    return result;
  }

  // ── SSE Subscription ──

  addRealtimeSubscriber(
    callback: (event: { type: string; data: unknown; offset: number }) => void
  ): () => void {
    return this.streamsServer.addRealtimeSubscriber(CLI_MONITOR_STREAM_ID, callback);
  }

  // ── Maintenance ──

  async runMaintenance(): Promise<number> {
    if (!this.db) return 0;

    try {
      // Read retention from settings, default to DEFAULT_RETENTION_DAYS days
      let retentionDays = CliMonitorService.DEFAULT_RETENTION_DAYS;
      try {
        const setting = this.db.query.settings.findFirst({
          where: eq(settings.key, 'cliMonitor.retentionDays'),
        });
        const row = setting as unknown as { value: string } | undefined;
        if (row?.value) {
          const parsed = Number.parseInt(row.value, 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            retentionDays = parsed;
          }
        }
      } catch {
        // Use default retention
      }

      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const result = await this.db
        .delete(cliSessions)
        .where(lt(cliSessions.lastActivityAt, cutoff));

      const changes = (result as { changes?: number }).changes ?? 0;
      if (changes > 0) {
        console.log(
          `[CliMonitor] Maintenance: deleted ${changes} session(s) older than ${retentionDays} day(s)`
        );
      }
      return changes;
    } catch (err) {
      console.error(
        '[CliMonitor] Maintenance error:',
        err instanceof Error ? err.message : String(err)
      );
      return 0;
    }
  }

  // ── Cleanup ──

  destroy(): void {
    this.stopHeartbeatCheck();
    this.stopMaintenance();
    this.sessions.clear();
    this.daemon = null;
  }

  // ── Internal: DB Persistence ──

  private async persistSessions(sessions: CliSession[], removedIds: string[]): Promise<void> {
    if (!this.db) return;

    for (const session of sessions) {
      const now = new Date().toISOString();
      const values = {
        sessionId: session.sessionId,
        filePath: session.filePath,
        cwd: session.cwd,
        projectName: session.projectName,
        projectHash: session.projectHash || '',
        gitBranch: session.gitBranch ?? null,
        status: session.status,
        messageCount: session.messageCount,
        turnCount: session.turnCount,
        goal: session.goal ?? null,
        recentOutput: session.recentOutput ?? null,
        pendingToolUse: session.pendingToolUse ? JSON.stringify(session.pendingToolUse) : null,
        tokenUsage: session.tokenUsage ? JSON.stringify(session.tokenUsage) : null,
        performanceMetrics: session.performanceMetrics
          ? JSON.stringify(session.performanceMetrics)
          : null,
        model: session.model ?? null,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        isSubagent: session.isSubagent,
        parentSessionId: session.parentSessionId ?? null,
        slug: session.slug ?? null,
        cliVersion: session.version ?? null,
        permissionMode: session.permissionMode ?? null,
        topology: session.topology ? JSON.stringify(session.topology) : null,
        queueOperations: session.queueOperations ? JSON.stringify(session.queueOperations) : null,
        toolInvocations: session.recentToolInvocations
          ? JSON.stringify(session.recentToolInvocations)
          : null,
        updatedAt: now,
      };

      try {
        await this.db
          .insert(cliSessions)
          .values({
            id: createId(),
            ...values,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: cliSessions.sessionId,
            set: values,
          });
      } catch (upsertErr) {
        console.error(
          `[CliMonitor] Upsert error for ${session.sessionId}:`,
          upsertErr instanceof Error ? upsertErr.message : String(upsertErr)
        );
      }
    }

    // Remove deleted sessions from DB
    for (const id of removedIds) {
      try {
        await this.db.delete(cliSessions).where(eq(cliSessions.sessionId, id));
      } catch (deleteErr) {
        console.error(
          `[CliMonitor] Delete error for ${id}:`,
          deleteErr instanceof Error ? deleteErr.message : String(deleteErr)
        );
      }
    }
  }

  private safeJsonParse<T>(
    value: string | null | undefined,
    field: string,
    sessionId: string
  ): T | undefined {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch (err) {
      console.error(
        `[CliMonitor] Corrupt JSON in ${field} for session ${sessionId}:`,
        err instanceof Error ? err.message : String(err)
      );
      return undefined;
    }
  }

  private rowToSession(row: typeof cliSessions.$inferSelect): CliSession {
    return {
      sessionId: row.sessionId,
      filePath: row.filePath,
      cwd: row.cwd,
      projectName: row.projectName,
      projectHash: row.projectHash,
      gitBranch: row.gitBranch ?? undefined,
      status: row.status ?? 'idle',
      messageCount: row.messageCount ?? 0,
      turnCount: row.turnCount ?? 0,
      goal: row.goal ?? undefined,
      recentOutput: row.recentOutput ?? undefined,
      pendingToolUse: this.safeJsonParse(row.pendingToolUse, 'pendingToolUse', row.sessionId),
      tokenUsage: this.safeJsonParse(row.tokenUsage, 'tokenUsage', row.sessionId) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      model: row.model ?? undefined,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
      lastReadOffset: 0,
      isSubagent: row.isSubagent ?? false,
      parentSessionId: row.parentSessionId ?? undefined,
      slug: row.slug ?? undefined,
      version: row.cliVersion ?? undefined,
      permissionMode: row.permissionMode ?? undefined,
      topology: this.safeJsonParse(row.topology, 'topology', row.sessionId),
      queueOperations: this.safeJsonParse(row.queueOperations, 'queueOperations', row.sessionId),
      recentToolInvocations: this.safeJsonParse(
        row.toolInvocations,
        'toolInvocations',
        row.sessionId
      ),
      performanceMetrics: this.safeJsonParse(
        row.performanceMetrics,
        'performanceMetrics',
        row.sessionId
      ),
    };
  }

  // ── Internal: Publishing ──

  private publish(type: string, data: unknown): void {
    this.streamsServer.publish(CLI_MONITOR_STREAM_ID, type, data).catch((publishErr) => {
      console.error(
        `[CliMonitor] Failed to publish ${type}:`,
        publishErr instanceof Error ? publishErr.message : String(publishErr)
      );
    });
  }

  // ── Internal: Heartbeat ──

  private startHeartbeatCheck(): void {
    this.stopHeartbeatCheck();
    this.heartbeatTimer = setInterval(() => {
      if (this.daemon && Date.now() - this.daemon.lastHeartbeatAt > DAEMON_TIMEOUT_MS * 1.5) {
        console.warn(
          `[CliMonitor] Daemon heartbeat timeout (${DAEMON_TIMEOUT_MS * 1.5}ms with grace), marking disconnected`
        );
        this.deregisterDaemon(this.daemon.daemonId);
      }
    }, 15_000);
  }

  private stopHeartbeatCheck(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Internal: Maintenance ──

  private startMaintenance(): void {
    this.stopMaintenance();
    // Run maintenance on startup
    this.runMaintenance().catch((err) => {
      console.error(
        '[CliMonitor] Maintenance failed:',
        err instanceof Error ? err.message : String(err)
      );
    });
    // Then periodically
    this.maintenanceTimer = setInterval(() => {
      this.runMaintenance().catch((err) => {
        console.error(
          '[CliMonitor] Maintenance failed:',
          err instanceof Error ? err.message : String(err)
        );
      });
    }, CliMonitorService.MAINTENANCE_INTERVAL_MS);
  }

  private stopMaintenance(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
  }
}
