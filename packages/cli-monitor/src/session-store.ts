export type SessionStatus = 'working' | 'waiting_for_approval' | 'waiting_for_input' | 'idle';

export interface CompactionEvent {
  type: 'compact' | 'microcompact';
  timestamp: number;
  trigger: string;
  preTokens: number;
  tokensSaved?: number;
  compactedToolIds?: string[];
  sessionId: string;
  /** For subagent sessions, the parent session ID */
  parentSessionId?: string;
}

export interface QueueOperation {
  operation: string; // 'enqueue' | 'remove'
  timestamp: number;
  content?: string; // queued prompt text (max 200 chars)
  version?: string; // CLI version
}

export interface ToolInvocation {
  toolName: string;
  toolId: string;
  timestamp: number;
  isError?: boolean;
  durationMs?: number;
  resultNumFiles?: number;
  resultNumLines?: number;
}

/** Agent node type — dynamic string, not a fixed enum. Common values include
 *  'orchestrator', 'planner', 'coder', 'reviewer', 'tester', 'scanner',
 *  'deployer', 'explorer', 'unknown', but any string is valid. */
export type AgentNodeType = string;

export interface AgentTopologyNode {
  sessionId: string;
  agentId?: string;
  agentType: AgentNodeType;
  parentSessionId?: string;
  childSessionIds: string[];
  depth: number;
  spawnedAt?: number;
  completedAt?: number;
  status: SessionStatus | 'completed';
  tokenUsage: StoredSession['tokenUsage'];
  turnCount: number;
  messageCount: number;
}

export interface StoredSession {
  sessionId: string;
  filePath: string;
  cwd: string;
  projectName: string;
  projectHash: string;
  gitBranch?: string;
  status: SessionStatus;
  messageCount: number;
  turnCount: number;
  goal?: string;
  recentOutput?: string;
  pendingToolUse?: { toolName: string; toolId: string };
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    ephemeral5mTokens?: number;
    ephemeral1hTokens?: number;
  };
  model?: string;
  startedAt: number;
  lastActivityAt: number;
  lastReadOffset: number;
  isSubagent: boolean;
  parentSessionId?: string;
  slug?: string;
  version?: string;
  permissionMode?: string;
  maxThinkingTokens?: number;
  isSidechain?: boolean;
  lastTurnDurationMs?: number;
  avgTurnDurationMs?: number;
  queueOperations?: QueueOperation[];
  recentToolInvocations?: ToolInvocation[];
  topology?: AgentTopologyNode;
  performanceMetrics?: {
    compactionCount: number;
    lastCompactionAt: number | null;
    compactionEvents: CompactionEvent[];
    recentTurns: Array<{
      turnNumber: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      timestamp: number;
      durationMs?: number;
    }>;
    cacheHitRatio: number;
    contextWindowUsed: number;
    contextWindowLimit: number;
    contextPressure: number;
    healthStatus: 'healthy' | 'warning' | 'critical';
  };
}

const MAX_SESSIONS = 1000;
const MAX_PENDING_CHANGES = 5000;

export class SessionStore {
  private sessions = new Map<string, StoredSession>();
  private readOffsets = new Map<string, number>(); // filePath -> byte offset
  private changedSessionIds = new Set<string>();
  private removedSessionIds = new Set<string>();
  private childIndex = new Map<string, Set<string>>(); // parentId -> childIds

  getSession(id: string): StoredSession | undefined {
    return this.sessions.get(id);
  }

  setSession(id: string, session: StoredSession): void {
    this.sessions.set(id, session);
    this.changedSessionIds.add(id);
    this.removedSessionIds.delete(id);

    // Maintain child index
    if (session.parentSessionId) {
      let children = this.childIndex.get(session.parentSessionId);
      if (!children) {
        children = new Set();
        this.childIndex.set(session.parentSessionId, children);
      }
      children.add(id);
    }

    // Evict oldest session if over limit (only when adding new sessions)
    if (this.sessions.size > MAX_SESSIONS) {
      this.evictOldest();
    }
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, s] of this.sessions) {
      if (s.lastActivityAt < oldestTime) {
        oldestTime = s.lastActivityAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      const session = this.sessions.get(oldestId);
      if (session) this.readOffsets.delete(session.filePath);
      this.removeSession(oldestId);
    }
  }

  removeSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      this.readOffsets.delete(session.filePath);
      // Clean up child index
      if (session.parentSessionId) {
        const siblings = this.childIndex.get(session.parentSessionId);
        if (siblings) {
          siblings.delete(id);
          if (siblings.size === 0) {
            this.childIndex.delete(session.parentSessionId);
          }
        }
      }
    }
    // Remove any children references for this session
    this.childIndex.delete(id);
    this.sessions.delete(id);
    this.changedSessionIds.delete(id);
    this.removedSessionIds.add(id);
  }

  removeByFilePath(filePath: string): void {
    for (const [id, session] of this.sessions) {
      if (session.filePath === filePath) {
        this.removeSession(id);
      }
    }
    this.readOffsets.delete(filePath);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  getReadOffset(filePath: string): number {
    return this.readOffsets.get(filePath) || 0;
  }

  setReadOffset(filePath: string, offset: number): void {
    this.readOffsets.set(filePath, offset);
  }

  /** Flush pending changes for batched ingest. Returns changed sessions + removed IDs. */
  flushChanges(): { updated: StoredSession[]; removed: string[] } {
    const updated: StoredSession[] = [];
    for (const id of this.changedSessionIds) {
      const session = this.sessions.get(id);
      if (session) updated.push({ ...session });
    }
    const removed = Array.from(this.removedSessionIds);

    this.changedSessionIds.clear();
    this.removedSessionIds.clear();

    return { updated, removed };
  }

  /** Re-add changes that failed to send (for retry on next cycle).
   *  Capped at MAX_PENDING_CHANGES to prevent memory exhaustion when server is down. */
  markPendingRetry(sessions: StoredSession[], removedIds: string[]): void {
    for (const s of sessions) {
      if (this.changedSessionIds.size >= MAX_PENDING_CHANGES) break;
      this.changedSessionIds.add(s.sessionId);
    }
    for (const id of removedIds) {
      if (this.removedSessionIds.size >= MAX_PENDING_CHANGES) break;
      this.removedSessionIds.add(id);
    }
  }

  /** Evict sessions that have been idle longer than maxIdleMs. Returns eviction count. */
  evictIdleSessions(maxIdleMs: number): number {
    const cutoff = Date.now() - maxIdleMs;
    let evicted = 0;
    for (const [id, session] of this.sessions) {
      if (session.status === 'idle' && session.lastActivityAt < cutoff) {
        this.removeSession(id);
        evicted++;
      }
    }
    return evicted;
  }

  /** Touch lastActivityAt to Date.now() for all sessions associated with a file path.
   *  This prevents active sessions (whose files are still being written to) from being
   *  incorrectly marked idle based on stale event timestamps. */
  touchSessionsByFilePath(filePath: string): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.filePath === filePath) {
        session.lastActivityAt = now;
        this.changedSessionIds.add(id);
      }
    }
  }

  /** Mark all sessions as changed so they are included in the next flushChanges().
   *  Used after server re-registration to ensure a full re-sync. */
  markAllChanged(): void {
    for (const id of this.sessions.keys()) {
      this.changedSessionIds.add(id);
    }
  }

  markIdleSessions(timeoutMs: number): void {
    const cutoff = Date.now() - timeoutMs;
    for (const [id, session] of this.sessions) {
      if (session.status !== 'idle' && session.lastActivityAt < cutoff) {
        session.status = 'idle';
        this.changedSessionIds.add(id);
      }
    }
  }

  /** Get child session IDs for a parent session */
  getChildSessionIds(parentId: string): string[] {
    const children = this.childIndex.get(parentId);
    return children ? Array.from(children) : [];
  }

  /** BFS walk to build topology graph from a root session */
  getTopologyGraph(rootSessionId: string): AgentTopologyNode[] {
    const result: AgentTopologyNode[] = [];
    const visited = new Set<string>();
    const queue: string[] = [rootSessionId];

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId || visited.has(currentId)) continue;
      visited.add(currentId);

      const session = this.sessions.get(currentId);
      if (!session) continue;

      const childIds = this.getChildSessionIds(currentId);

      // Calculate depth by walking parent chain
      let depth = 0;
      let parentId = session.parentSessionId;
      const depthVisited = new Set<string>([currentId]);
      while (parentId && !depthVisited.has(parentId)) {
        depthVisited.add(parentId);
        depth++;
        const parentSession = this.sessions.get(parentId);
        parentId = parentSession?.parentSessionId;
      }

      const node: AgentTopologyNode = session.topology
        ? { ...session.topology, childSessionIds: childIds, depth }
        : {
            sessionId: currentId,
            agentType: 'unknown',
            parentSessionId: session.parentSessionId,
            childSessionIds: childIds,
            depth,
            spawnedAt: session.startedAt,
            status: session.status,
            tokenUsage: { ...session.tokenUsage },
            turnCount: session.turnCount,
            messageCount: session.messageCount,
          };

      result.push(node);

      for (const childId of childIds) {
        if (!visited.has(childId)) {
          queue.push(childId);
        }
      }
    }

    return result;
  }
}
