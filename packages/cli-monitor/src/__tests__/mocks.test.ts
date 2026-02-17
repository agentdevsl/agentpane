import { beforeEach, describe, expect, it } from 'vitest';
import { parseJsonlFile } from '../parser.js';
import { SessionStore } from '../session-store.js';
import {
  buildCompletedSessionJsonl,
  buildMultiTurnSessionJsonl,
  buildSimpleSessionJsonl,
  buildToolUseSessionJsonl,
  createConnectedMocks,
  createMockClient,
  createMockStore,
  errorResponse,
  installMockFetch,
  makeAssistantEvent,
  makeEvent,
  makeIdleSession,
  makeRegisterPayload,
  makeSession,
  makeSubagentSession,
  makeSummaryEvent,
  makeToolResultEvent,
  makeToolUseEvent,
  makeUserEvent,
  okResponse,
  resetAllCounters,
  toJsonl,
} from './mocks.js';

beforeEach(() => {
  resetAllCounters();
});

// ── Factory tests: ensure mocks produce valid domain objects ────────

describe('Event factories', () => {
  it('makeEvent produces a parseable JSONL event', () => {
    const event = makeEvent();
    const store = new SessionStore();
    const content = toJsonl(event);
    const consumed = parseJsonlFile('/test/abc/sess-1.jsonl', content, 0, store);
    expect(consumed).toBeGreaterThan(0);
  });

  it('makeUserEvent creates a user message event', () => {
    const event = makeUserEvent('Hello world');
    expect(event.type).toBe('user');
    expect((event.message as Record<string, unknown>).role).toBe('user');
    expect((event.message as Record<string, unknown>).content).toBe('Hello world');
  });

  it('makeAssistantEvent creates an assistant message event', () => {
    const event = makeAssistantEvent('Response text');
    expect(event.type).toBe('assistant');
    expect((event.message as Record<string, unknown>).role).toBe('assistant');
  });

  it('makeAssistantEvent merges message overrides without duplication', () => {
    const event = makeAssistantEvent('Hi', {
      message: {
        role: 'assistant',
        content: 'Hi',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      },
    });
    const msg = event.message as Record<string, unknown>;
    expect(msg.model).toBe('claude-sonnet-4-6');
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.role).toBe('assistant');
  });

  it('makeToolUseEvent produces waiting_for_approval status', () => {
    const event = makeToolUseEvent('Read', 'tool-42');
    const store = new SessionStore();
    parseJsonlFile('/test/abc/sess-1.jsonl', toJsonl(event), 0, store);
    const session = store.getSession('sess-1');
    expect(session!.status).toBe('waiting_for_approval');
    expect(session!.pendingToolUse).toEqual({ toolName: 'Read', toolId: 'tool-42' });
  });

  it('makeToolResultEvent clears pendingToolUse', () => {
    const events = toJsonl(
      makeToolUseEvent('Bash', 'tool-1', { sessionId: 'sess-1' }),
      makeToolResultEvent('tool-1', 'output', { sessionId: 'sess-1' })
    );
    const store = new SessionStore();
    parseJsonlFile('/test/abc/sess-1.jsonl', events, 0, store);
    expect(store.getSession('sess-1')!.pendingToolUse).toBeUndefined();
    expect(store.getSession('sess-1')!.status).toBe('working');
  });

  it('makeSummaryEvent sets session to idle', () => {
    const events = toJsonl(
      makeUserEvent('test', { sessionId: 'sess-1' }),
      makeSummaryEvent('Done', { sessionId: 'sess-1' })
    );
    const store = new SessionStore();
    parseJsonlFile('/test/abc/sess-1.jsonl', events, 0, store);
    expect(store.getSession('sess-1')!.status).toBe('idle');
  });

  it('auto-increments uuid across events', () => {
    const e1 = makeEvent();
    const e2 = makeEvent();
    expect(e1.uuid).not.toBe(e2.uuid);
  });
});

// ── Session factories ───────────────────────────────────────────────

describe('Session factories', () => {
  it('makeSession creates a valid StoredSession', () => {
    const session = makeSession();
    expect(session.sessionId).toBeDefined();
    expect(session.status).toBe('working');
    expect(session.tokenUsage.inputTokens).toBe(100);
  });

  it('makeIdleSession creates an idle session with old timestamp', () => {
    const session = makeIdleSession();
    expect(session.status).toBe('idle');
    expect(session.lastActivityAt).toBeLessThan(Date.now() - 30 * 60 * 1000);
  });

  it('makeSubagentSession creates a subagent session', () => {
    const session = makeSubagentSession();
    expect(session.isSubagent).toBe(true);
    expect(session.parentSessionId).toBeDefined();
    expect(session.filePath).toContain('/subagents/');
  });

  it('auto-increments sessionId', () => {
    const s1 = makeSession();
    const s2 = makeSession();
    expect(s1.sessionId).not.toBe(s2.sessionId);
  });
});

// ── Scenario builders: parse through real parser ────────────────────

describe('Scenario builders with real parser', () => {
  const filePath = '/home/user/.claude/projects/abc123/sess-test.jsonl';

  it('buildSimpleSessionJsonl creates a valid 2-message session', () => {
    const content = buildSimpleSessionJsonl({ sessionId: 'sess-1' });
    const store = new SessionStore();
    parseJsonlFile(filePath, content, 0, store);
    const session = store.getSession('sess-1');
    expect(session).toBeDefined();
    expect(session!.messageCount).toBe(2);
    expect(session!.goal).toBe('Fix the login bug');
  });

  it('buildToolUseSessionJsonl walks through tool approval cycle', () => {
    const content = buildToolUseSessionJsonl({ sessionId: 'sess-1' });
    const store = new SessionStore();
    parseJsonlFile(filePath, content, 0, store);
    const session = store.getSession('sess-1');
    expect(session).toBeDefined();
    // After full cycle: tool requested → approved → assistant replied
    expect(session!.pendingToolUse).toBeUndefined();
    expect(session!.messageCount).toBe(4);
  });

  it('buildMultiTurnSessionJsonl accumulates tokens across turns', () => {
    const content = buildMultiTurnSessionJsonl({ sessionId: 'sess-1', turns: 3 });
    const store = new SessionStore();
    parseJsonlFile(filePath, content, 0, store);
    const session = store.getSession('sess-1');
    expect(session).toBeDefined();
    expect(session!.turnCount).toBe(3);
    expect(session!.messageCount).toBe(6);
    // Token accumulation: sum of 100*(1+2+3) = 600 input tokens
    expect(session!.tokenUsage.inputTokens).toBe(600);
  });

  it('buildCompletedSessionJsonl ends in idle status', () => {
    const content = buildCompletedSessionJsonl({ sessionId: 'sess-1' });
    const store = new SessionStore();
    parseJsonlFile(filePath, content, 0, store);
    expect(store.getSession('sess-1')!.status).toBe('idle');
  });
});

// ── Mock component tests: verify mock interfaces match real ones ────

describe('Mock components', () => {
  describe('MockAgentPaneClient', () => {
    it('all methods resolve by default', async () => {
      const client = createMockClient();
      await expect(client.register(makeRegisterPayload())).resolves.toBeUndefined();
      await expect(client.heartbeat('dm_1', 5)).resolves.toBeUndefined();
      await expect(client.ingest('dm_1', [], [])).resolves.toBeUndefined();
      await expect(client.deregister('dm_1')).resolves.toBeUndefined();
    });

    it('tracks call arguments', async () => {
      const client = createMockClient();
      const payload = makeRegisterPayload({ daemonId: 'dm_abc' });
      await client.register(payload);
      expect(client.register).toHaveBeenCalledWith(payload);
    });

    it('can be configured to reject', async () => {
      const client = createMockClient();
      client.ingest.mockRejectedValueOnce(new Error('network error'));
      await expect(client.ingest('dm_1', [], [])).rejects.toThrow('network error');
    });
  });

  describe('MockSessionStore', () => {
    it('tracks sessions via get/set', () => {
      const store = createMockStore();
      const session = makeSession({ sessionId: 'test-1' });
      store.setSession('test-1', session);
      expect(store.getSession('test-1')).toEqual(session);
    });

    it('can be preloaded with sessions', () => {
      const sessions = [makeSession({ sessionId: 'a' }), makeSession({ sessionId: 'b' })];
      const store = createMockStore(sessions);
      expect(store.getSession('a')).toBeDefined();
      expect(store.getSession('b')).toBeDefined();
      expect(store.getSessionCount()).toBe(2);
    });
  });

  describe('installMockFetch', () => {
    it('replaces and restores global fetch', () => {
      const original = globalThis.fetch;
      const { mockFetch, restore } = installMockFetch();

      expect(globalThis.fetch).toBe(mockFetch);
      mockFetch.mockResolvedValueOnce(okResponse());

      restore();
      expect(globalThis.fetch).toBe(original);
    });
  });

  describe('Response helpers', () => {
    it('okResponse returns ok: true', () => {
      const res = okResponse({ data: 'test' });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
    });

    it('errorResponse returns ok: false', () => {
      const res = errorResponse(503, 'Service Unavailable');
      expect(res.ok).toBe(false);
      expect(res.status).toBe(503);
    });
  });

  describe('createConnectedMocks', () => {
    it('returns all system components wired together', () => {
      const mocks = createConnectedMocks();
      expect(mocks.client).toBeDefined();
      expect(mocks.store).toBeDefined();
      expect(mocks.watcher).toBeDefined();
      expect(mocks.display).toBeDefined();
      expect(mocks.logger).toBeDefined();
    });

    it('preloads sessions into store and first flush', () => {
      const sessions = [makeSession({ sessionId: 'pre-1' })];
      const mocks = createConnectedMocks(sessions);

      // Store has the preloaded session
      expect(mocks.store.getSession('pre-1')).toBeDefined();

      // First flush returns the preloaded sessions
      const { updated } = mocks.store.flushChanges();
      expect(updated).toHaveLength(1);
      expect(updated[0].sessionId).toBe('pre-1');
    });
  });
});
