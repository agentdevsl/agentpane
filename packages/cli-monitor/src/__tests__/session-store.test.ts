import { describe, expect, it } from 'vitest';
import { SessionStore, type StoredSession } from '../session-store.js';

// ── Helpers ──

function makeSession(overrides?: Partial<StoredSession>): StoredSession {
  return {
    sessionId: 'sess-1',
    filePath: '/home/user/.claude/projects/abc123/sess-1.jsonl',
    cwd: '/home/user/my-project',
    projectName: 'my-project',
    projectHash: 'abc123',
    status: 'working',
    messageCount: 3,
    turnCount: 1,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    startedAt: Date.now() - 60000,
    lastActivityAt: Date.now(),
    lastReadOffset: 0,
    isSubagent: false,
    ...overrides,
  };
}

// ── Tests ──

describe('SessionStore', () => {
  // ── setSession / getSession ──

  describe('setSession / getSession', () => {
    it('stores and retrieves a session', () => {
      const store = new SessionStore();
      const session = makeSession({ sessionId: 'sess-a' });

      store.setSession('sess-a', session);
      const retrieved = store.getSession('sess-a');

      expect(retrieved).toBeDefined();
      expect(retrieved!.sessionId).toBe('sess-a');
      expect(retrieved!.cwd).toBe('/home/user/my-project');
    });

    it('returns undefined for unknown session', () => {
      const store = new SessionStore();
      expect(store.getSession('nonexistent')).toBeUndefined();
    });

    it('overwrites existing session with same ID', () => {
      const store = new SessionStore();
      store.setSession('sess-1', makeSession({ status: 'working' }));
      store.setSession('sess-1', makeSession({ status: 'idle' }));

      const session = store.getSession('sess-1');
      expect(session!.status).toBe('idle');
    });
  });

  // ── removeSession ──

  describe('removeSession', () => {
    it('deletes a session', () => {
      const store = new SessionStore();
      store.setSession('sess-1', makeSession());

      store.removeSession('sess-1');
      expect(store.getSession('sess-1')).toBeUndefined();
    });

    it('tracks removal for flushing', () => {
      const store = new SessionStore();
      store.setSession('sess-1', makeSession());
      // Flush to clear the "set" change
      store.flushChanges();

      store.removeSession('sess-1');
      const { removed } = store.flushChanges();
      expect(removed).toContain('sess-1');
    });

    it('removes session from changed tracking (set then remove)', () => {
      const store = new SessionStore();
      store.setSession('sess-1', makeSession());
      store.removeSession('sess-1');

      const { updated, removed } = store.flushChanges();
      // Should not appear in updated since it was removed
      expect(updated.find((s) => s.sessionId === 'sess-1')).toBeUndefined();
      expect(removed).toContain('sess-1');
    });

    it('clears the read offset for the session file path', () => {
      const store = new SessionStore();
      const fp = '/home/user/.claude/projects/abc123/sess-1.jsonl';
      store.setSession('sess-1', makeSession({ filePath: fp }));
      store.setReadOffset(fp, 4096);

      store.removeSession('sess-1');

      expect(store.getReadOffset(fp)).toBe(0);
    });
  });

  // ── removeByFilePath ──

  describe('removeByFilePath', () => {
    it('removes all sessions matching a file path', () => {
      const store = new SessionStore();
      const fp = '/home/user/.claude/projects/abc/file.jsonl';
      store.setSession('sess-1', makeSession({ sessionId: 'sess-1', filePath: fp }));
      store.setSession('sess-2', makeSession({ sessionId: 'sess-2', filePath: fp }));
      store.setSession(
        'sess-3',
        makeSession({ sessionId: 'sess-3', filePath: '/other/path.jsonl' })
      );

      store.removeByFilePath(fp);

      expect(store.getSession('sess-1')).toBeUndefined();
      expect(store.getSession('sess-2')).toBeUndefined();
      expect(store.getSession('sess-3')).toBeDefined();
    });

    it('clears the read offset for the file path', () => {
      const store = new SessionStore();
      const fp = '/home/user/.claude/projects/abc/file.jsonl';
      store.setReadOffset(fp, 4096);

      store.removeByFilePath(fp);

      expect(store.getReadOffset(fp)).toBe(0);
    });
  });

  // ── getSessionCount ──

  describe('getSessionCount', () => {
    it('returns 0 for empty store', () => {
      const store = new SessionStore();
      expect(store.getSessionCount()).toBe(0);
    });

    it('returns correct count', () => {
      const store = new SessionStore();
      store.setSession('sess-1', makeSession({ sessionId: 'sess-1' }));
      store.setSession('sess-2', makeSession({ sessionId: 'sess-2' }));
      store.setSession('sess-3', makeSession({ sessionId: 'sess-3' }));

      expect(store.getSessionCount()).toBe(3);
    });

    it('decreases when sessions are removed', () => {
      const store = new SessionStore();
      store.setSession('sess-1', makeSession({ sessionId: 'sess-1' }));
      store.setSession('sess-2', makeSession({ sessionId: 'sess-2' }));
      store.removeSession('sess-1');

      expect(store.getSessionCount()).toBe(1);
    });
  });

  // ── Read Offsets ──

  describe('read offsets', () => {
    it('returns 0 for unknown file path', () => {
      const store = new SessionStore();
      expect(store.getReadOffset('/unknown/path.jsonl')).toBe(0);
    });

    it('stores and retrieves read offset', () => {
      const store = new SessionStore();
      store.setReadOffset('/home/user/file.jsonl', 8192);
      expect(store.getReadOffset('/home/user/file.jsonl')).toBe(8192);
    });

    it('updates read offset for same file', () => {
      const store = new SessionStore();
      store.setReadOffset('/file.jsonl', 100);
      store.setReadOffset('/file.jsonl', 200);
      expect(store.getReadOffset('/file.jsonl')).toBe(200);
    });
  });

  // ── flushChanges ──

  describe('flushChanges', () => {
    it('returns changed sessions and removed IDs', () => {
      const store = new SessionStore();
      store.setSession('sess-1', makeSession({ sessionId: 'sess-1' }));
      store.setSession('sess-2', makeSession({ sessionId: 'sess-2' }));

      const { updated, removed } = store.flushChanges();
      expect(updated).toHaveLength(2);
      expect(updated.map((s) => s.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
      expect(removed).toEqual([]);
    });

    it('returns removed IDs', () => {
      const store = new SessionStore();
      store.setSession('sess-1', makeSession({ sessionId: 'sess-1' }));
      store.flushChanges(); // clear

      store.removeSession('sess-1');
      const { updated, removed } = store.flushChanges();
      expect(updated).toHaveLength(0);
      expect(removed).toContain('sess-1');
    });

    it('clears tracking after flush', () => {
      const store = new SessionStore();
      store.setSession('sess-1', makeSession({ sessionId: 'sess-1' }));

      store.flushChanges();

      // Second flush should be empty
      const { updated, removed } = store.flushChanges();
      expect(updated).toHaveLength(0);
      expect(removed).toHaveLength(0);
    });

    it('returns empty arrays when nothing changed', () => {
      const store = new SessionStore();

      const { updated, removed } = store.flushChanges();
      expect(updated).toEqual([]);
      expect(removed).toEqual([]);
    });

    it('returns copies of sessions (not references)', () => {
      const store = new SessionStore();
      const session = makeSession({ sessionId: 'sess-1', status: 'working' });
      store.setSession('sess-1', session);

      const { updated } = store.flushChanges();

      // Mutate the original in store
      const storeSession = store.getSession('sess-1');
      if (storeSession) storeSession.status = 'idle';

      // Flushed copy should still show 'working'
      expect(updated[0].status).toBe('working');
    });

    it('changes only appear in one flush', () => {
      const store = new SessionStore();
      store.setSession('sess-1', makeSession({ sessionId: 'sess-1' }));

      const first = store.flushChanges();
      expect(first.updated).toHaveLength(1);

      // Change sess-2 only
      store.setSession('sess-2', makeSession({ sessionId: 'sess-2' }));
      const second = store.flushChanges();
      expect(second.updated).toHaveLength(1);
      expect(second.updated[0].sessionId).toBe('sess-2');

      // Third flush should be empty
      const third = store.flushChanges();
      expect(third.updated).toHaveLength(0);
    });
  });

  // ── markIdleSessions ──

  describe('markIdleSessions', () => {
    it('transitions old non-idle sessions to idle', () => {
      const store = new SessionStore();
      const oldTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      store.setSession(
        'sess-1',
        makeSession({ sessionId: 'sess-1', status: 'working', lastActivityAt: oldTime })
      );
      store.setSession(
        'sess-2',
        makeSession({
          sessionId: 'sess-2',
          status: 'waiting_for_approval',
          lastActivityAt: oldTime,
        })
      );
      store.flushChanges(); // clear

      store.markIdleSessions(5 * 60 * 1000); // 5 minute timeout

      expect(store.getSession('sess-1')!.status).toBe('idle');
      expect(store.getSession('sess-2')!.status).toBe('idle');

      // Should be tracked as changed
      const { updated } = store.flushChanges();
      expect(updated).toHaveLength(2);
    });

    it('does not transition already-idle sessions', () => {
      const store = new SessionStore();
      const oldTime = Date.now() - 10 * 60 * 1000;
      store.setSession(
        'sess-1',
        makeSession({ sessionId: 'sess-1', status: 'idle', lastActivityAt: oldTime })
      );
      store.flushChanges(); // clear

      store.markIdleSessions(5 * 60 * 1000);

      // Should NOT be in changed set since it was already idle
      const { updated } = store.flushChanges();
      expect(updated).toHaveLength(0);
    });

    it('does not transition recent sessions', () => {
      const store = new SessionStore();
      store.setSession(
        'sess-1',
        makeSession({ sessionId: 'sess-1', status: 'working', lastActivityAt: Date.now() })
      );
      store.flushChanges(); // clear

      store.markIdleSessions(5 * 60 * 1000);

      expect(store.getSession('sess-1')!.status).toBe('working');
      const { updated } = store.flushChanges();
      expect(updated).toHaveLength(0);
    });
  });

  // ── evictIdleSessions ──

  describe('evictIdleSessions', () => {
    it('removes sessions idle longer than threshold', () => {
      const store = new SessionStore();
      const oldTime = Date.now() - 60 * 60 * 1000; // 1 hour ago
      store.setSession(
        'sess-1',
        makeSession({ sessionId: 'sess-1', status: 'idle', lastActivityAt: oldTime })
      );
      store.setSession(
        'sess-2',
        makeSession({ sessionId: 'sess-2', status: 'idle', lastActivityAt: oldTime })
      );
      store.flushChanges(); // clear

      const evicted = store.evictIdleSessions(30 * 60 * 1000); // 30 min threshold

      expect(evicted).toBe(2);
      expect(store.getSession('sess-1')).toBeUndefined();
      expect(store.getSession('sess-2')).toBeUndefined();
      expect(store.getSessionCount()).toBe(0);
    });

    it('does not evict non-idle sessions', () => {
      const store = new SessionStore();
      const oldTime = Date.now() - 60 * 60 * 1000;
      store.setSession(
        'sess-1',
        makeSession({ sessionId: 'sess-1', status: 'working', lastActivityAt: oldTime })
      );
      store.flushChanges();

      const evicted = store.evictIdleSessions(30 * 60 * 1000);

      expect(evicted).toBe(0);
      expect(store.getSession('sess-1')).toBeDefined();
    });

    it('does not evict recently idle sessions', () => {
      const store = new SessionStore();
      store.setSession(
        'sess-1',
        makeSession({ sessionId: 'sess-1', status: 'idle', lastActivityAt: Date.now() })
      );
      store.flushChanges();

      const evicted = store.evictIdleSessions(30 * 60 * 1000);

      expect(evicted).toBe(0);
      expect(store.getSession('sess-1')).toBeDefined();
    });

    it('tracks evicted sessions as removed for flushing', () => {
      const store = new SessionStore();
      const oldTime = Date.now() - 60 * 60 * 1000;
      store.setSession(
        'sess-1',
        makeSession({ sessionId: 'sess-1', status: 'idle', lastActivityAt: oldTime })
      );
      store.flushChanges(); // clear

      store.evictIdleSessions(30 * 60 * 1000);

      const { removed } = store.flushChanges();
      expect(removed).toContain('sess-1');
    });
  });

  // ── session count limit ──

  describe('session count limit', () => {
    it('evicts oldest session when exceeding MAX_SESSIONS (1000)', () => {
      const store = new SessionStore();
      const now = Date.now();

      // Add 1001 sessions — oldest should be evicted
      for (let i = 0; i < 1001; i++) {
        store.setSession(
          `sess-${i}`,
          makeSession({
            sessionId: `sess-${i}`,
            lastActivityAt: now + i, // each newer than the last
          })
        );
      }

      // Should be capped at 1000
      expect(store.getSessionCount()).toBe(1000);
      // Oldest (sess-0) should have been evicted
      expect(store.getSession('sess-0')).toBeUndefined();
      // Newest should still exist
      expect(store.getSession('sess-1000')).toBeDefined();
    });

    it('does not evict when at or below limit', () => {
      const store = new SessionStore();

      for (let i = 0; i < 1000; i++) {
        store.setSession(
          `sess-${i}`,
          makeSession({ sessionId: `sess-${i}`, lastActivityAt: Date.now() + i })
        );
      }

      expect(store.getSessionCount()).toBe(1000);
      // All should still exist
      expect(store.getSession('sess-0')).toBeDefined();
      expect(store.getSession('sess-999')).toBeDefined();
    });
  });

  // ── markPendingRetry ──

  describe('markPendingRetry', () => {
    it('re-adds changes for retry on next flush', () => {
      const store = new SessionStore();
      const session = makeSession({ sessionId: 'sess-1' });
      store.setSession('sess-1', session);

      // Flush (simulating a send attempt)
      const { updated, removed } = store.flushChanges();
      expect(updated).toHaveLength(1);

      // Mark as failed — should reappear in next flush
      store.markPendingRetry(updated, removed);

      const retry = store.flushChanges();
      expect(retry.updated).toHaveLength(1);
      expect(retry.updated[0].sessionId).toBe('sess-1');
    });

    it('re-adds removed IDs for retry', () => {
      const store = new SessionStore();
      store.setSession('sess-1', makeSession({ sessionId: 'sess-1' }));
      store.flushChanges(); // clear

      store.removeSession('sess-1');
      const { updated, removed } = store.flushChanges();

      store.markPendingRetry(updated, removed);

      const retry = store.flushChanges();
      expect(retry.removed).toContain('sess-1');
    });

    it('does not duplicate entries when called with already-tracked items', () => {
      const store = new SessionStore();
      const session = makeSession({ sessionId: 'sess-1' });
      store.setSession('sess-1', session);

      // markPendingRetry while change is already tracked should not create duplicates
      store.markPendingRetry([session], []);

      const { updated } = store.flushChanges();
      expect(updated).toHaveLength(1);
    });
  });

  // ── child index ──

  describe('child index', () => {
    it('returns empty array for session with no children', () => {
      const store = new SessionStore();
      store.setSession('parent', makeSession({ sessionId: 'parent' }));
      expect(store.getChildSessionIds('parent')).toEqual([]);
    });

    it('tracks children when sessions have parentSessionId', () => {
      const store = new SessionStore();
      store.setSession('parent', makeSession({ sessionId: 'parent' }));
      store.setSession(
        'child-1',
        makeSession({ sessionId: 'child-1', isSubagent: true, parentSessionId: 'parent' })
      );
      store.setSession(
        'child-2',
        makeSession({ sessionId: 'child-2', isSubagent: true, parentSessionId: 'parent' })
      );

      const children = store.getChildSessionIds('parent');
      expect(children).toHaveLength(2);
      expect(children).toContain('child-1');
      expect(children).toContain('child-2');
    });

    it('removes child from index when child session is removed', () => {
      const store = new SessionStore();
      store.setSession('parent', makeSession({ sessionId: 'parent' }));
      store.setSession(
        'child-1',
        makeSession({ sessionId: 'child-1', isSubagent: true, parentSessionId: 'parent' })
      );
      store.setSession(
        'child-2',
        makeSession({ sessionId: 'child-2', isSubagent: true, parentSessionId: 'parent' })
      );

      store.removeSession('child-1');

      const children = store.getChildSessionIds('parent');
      expect(children).toHaveLength(1);
      expect(children).toContain('child-2');
    });

    it('cleans up empty parent entry when last child is removed', () => {
      const store = new SessionStore();
      store.setSession('parent', makeSession({ sessionId: 'parent' }));
      store.setSession(
        'child-1',
        makeSession({ sessionId: 'child-1', isSubagent: true, parentSessionId: 'parent' })
      );

      store.removeSession('child-1');

      expect(store.getChildSessionIds('parent')).toEqual([]);
    });

    it('returns empty array for unknown parent ID', () => {
      const store = new SessionStore();
      expect(store.getChildSessionIds('nonexistent')).toEqual([]);
    });
  });

  // ── getTopologyGraph ──

  describe('getTopologyGraph', () => {
    it('returns single node for root-only session', () => {
      const store = new SessionStore();
      store.setSession('root', makeSession({ sessionId: 'root', turnCount: 5 }));

      const graph = store.getTopologyGraph('root');
      expect(graph).toHaveLength(1);
      expect(graph[0].sessionId).toBe('root');
      expect(graph[0].depth).toBe(0);
      expect(graph[0].turnCount).toBe(5);
    });

    it('returns empty array for nonexistent root', () => {
      const store = new SessionStore();
      const graph = store.getTopologyGraph('nonexistent');
      expect(graph).toEqual([]);
    });

    it('builds one-level topology (parent + children)', () => {
      const store = new SessionStore();
      store.setSession('root', makeSession({ sessionId: 'root' }));
      store.setSession(
        'child-a',
        makeSession({ sessionId: 'child-a', isSubagent: true, parentSessionId: 'root' })
      );
      store.setSession(
        'child-b',
        makeSession({ sessionId: 'child-b', isSubagent: true, parentSessionId: 'root' })
      );

      const graph = store.getTopologyGraph('root');
      expect(graph).toHaveLength(3);

      const root = graph.find((n) => n.sessionId === 'root');
      expect(root).toBeDefined();
      expect(root!.depth).toBe(0);
      expect(root!.childSessionIds).toContain('child-a');
      expect(root!.childSessionIds).toContain('child-b');

      const childA = graph.find((n) => n.sessionId === 'child-a');
      expect(childA).toBeDefined();
      expect(childA!.depth).toBe(1);
    });

    it('builds multi-level topology (3 deep)', () => {
      const store = new SessionStore();
      store.setSession('root', makeSession({ sessionId: 'root' }));
      store.setSession(
        'level1',
        makeSession({ sessionId: 'level1', isSubagent: true, parentSessionId: 'root' })
      );
      store.setSession(
        'level2',
        makeSession({ sessionId: 'level2', isSubagent: true, parentSessionId: 'level1' })
      );

      const graph = store.getTopologyGraph('root');
      expect(graph).toHaveLength(3);

      const level2 = graph.find((n) => n.sessionId === 'level2');
      expect(level2).toBeDefined();
      expect(level2!.depth).toBe(2);
    });

    it('handles circular references safely', () => {
      const store = new SessionStore();
      // Create a cycle: A → B → A (shouldn't happen but guard against it)
      store.setSession(
        'sess-a',
        makeSession({ sessionId: 'sess-a', isSubagent: true, parentSessionId: 'sess-b' })
      );
      store.setSession(
        'sess-b',
        makeSession({ sessionId: 'sess-b', isSubagent: true, parentSessionId: 'sess-a' })
      );

      // Should not infinite loop — visited set prevents it
      const graph = store.getTopologyGraph('sess-a');
      expect(graph.length).toBeLessThanOrEqual(2);
    });

    it('uses topology data from session when available', () => {
      const store = new SessionStore();
      store.setSession(
        'root',
        makeSession({
          sessionId: 'root',
          topology: {
            sessionId: 'root',
            agentType: 'orchestrator',
            childSessionIds: [],
            depth: 0,
            status: 'working',
            tokenUsage: {
              inputTokens: 500,
              outputTokens: 200,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
            turnCount: 10,
            messageCount: 20,
          },
        })
      );

      const graph = store.getTopologyGraph('root');
      expect(graph).toHaveLength(1);
      expect(graph[0].agentType).toBe('orchestrator');
      expect(graph[0].turnCount).toBe(10);
    });
  });
});
