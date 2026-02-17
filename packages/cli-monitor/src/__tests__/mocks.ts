/**
 * Centralized test mocks for cli-monitor.
 *
 * Architecture overview (dependency flow):
 *
 *   index.ts (CLI entry)
 *     └─ daemon.ts (lifecycle orchestrator)
 *          ├─ AgentPaneClient  (HTTP + circuit breaker)
 *          ├─ FileWatcher      (fs.watch → processFile → parser)
 *          │    └─ parser.ts   (JSONL → SessionStore mutations)
 *          ├─ SessionStore     (in-memory state + change tracking)
 *          ├─ display.ts       (CLI output)
 *          ├─ logger.ts        (structured JSON logging)
 *          └─ version.ts / utils.ts
 *
 * This module provides:
 *  - Factory functions for all domain objects
 *  - Mock constructors for each module boundary
 *  - Helpers for wiring connected mocks together
 */

import { vi } from 'vitest';
import type { SessionStatus, StoredSession } from '../session-store.js';

// ── Raw Event Factories (parser input) ──────────────────────────────

export interface RawEventOverrides {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  agentId?: string;
  message?: Record<string, unknown>;
  summary?: string;
  [key: string]: unknown;
}

let _eventCounter = 0;

export function makeEvent(overrides: RawEventOverrides = {}): Record<string, unknown> {
  _eventCounter++;
  return {
    type: 'user',
    uuid: `uuid-${_eventCounter}`,
    timestamp: '2025-01-15T12:00:00.000Z',
    sessionId: 'sess-1',
    cwd: '/home/user/my-project',
    parentUuid: null,
    ...overrides,
  };
}

export function makeUserEvent(
  content: string | Record<string, unknown>[],
  overrides: RawEventOverrides = {}
): Record<string, unknown> {
  return makeEvent({
    type: 'user',
    message: { role: 'user', content },
    ...overrides,
  });
}

export function makeAssistantEvent(
  content: string | Record<string, unknown>[],
  overrides: RawEventOverrides = {}
): Record<string, unknown> {
  const { message: msgOverrides, ...rest } = overrides;
  return makeEvent({
    type: 'assistant',
    ...rest,
    message: {
      role: 'assistant',
      content,
      ...(msgOverrides as Record<string, unknown> | undefined),
    },
  });
}

export function makeToolUseEvent(
  toolName = 'Bash',
  toolId = 'tool-1',
  overrides: RawEventOverrides = {}
): Record<string, unknown> {
  return makeAssistantEvent(
    [{ type: 'tool_use', id: toolId, name: toolName, input: {} }],
    overrides
  );
}

export function makeToolResultEvent(
  toolUseId = 'tool-1',
  result = 'ok',
  overrides: RawEventOverrides = {}
): Record<string, unknown> {
  return makeUserEvent(
    [{ type: 'tool_result', tool_use_id: toolUseId, content: result }],
    overrides
  );
}

export function makeSummaryEvent(
  summary = 'Session completed.',
  overrides: RawEventOverrides = {}
): Record<string, unknown> {
  return makeEvent({ type: 'summary', summary, ...overrides });
}

/** Convert events to newline-delimited JSON (JSONL format) */
export function toJsonl(...events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

/** Reset the auto-incrementing event counter (call in beforeEach) */
export function resetEventCounter(): void {
  _eventCounter = 0;
}

// ── Stored Session Factory (session-store domain) ───────────────────

let _sessionCounter = 0;

export function makeSession(overrides?: Partial<StoredSession>): StoredSession {
  _sessionCounter++;
  const id = overrides?.sessionId ?? `sess-${_sessionCounter}`;
  return {
    sessionId: id,
    filePath: `/home/user/.claude/projects/abc123/${id}.jsonl`,
    cwd: '/home/user/my-project',
    projectName: 'my-project',
    projectHash: 'abc123',
    status: 'working' as SessionStatus,
    messageCount: 3,
    turnCount: 1,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    startedAt: Date.now() - 60_000,
    lastActivityAt: Date.now(),
    lastReadOffset: 0,
    isSubagent: false,
    ...overrides,
  };
}

export function makeIdleSession(overrides?: Partial<StoredSession>): StoredSession {
  return makeSession({
    status: 'idle',
    lastActivityAt: Date.now() - 60 * 60 * 1000, // 1 hour ago
    ...overrides,
  });
}

export function makeSubagentSession(overrides?: Partial<StoredSession>): StoredSession {
  const parentId = overrides?.parentSessionId ?? 'parent-sess-1';
  return makeSession({
    isSubagent: true,
    parentSessionId: parentId,
    filePath: `/home/user/.claude/sessions/${parentId}/subagents/child.jsonl`,
    ...overrides,
  });
}

export function resetSessionCounter(): void {
  _sessionCounter = 0;
}

// ── AgentPaneClient Mock ────────────────────────────────────────────

export interface MockAgentPaneClient {
  register: ReturnType<typeof vi.fn>;
  heartbeat: ReturnType<typeof vi.fn>;
  ingest: ReturnType<typeof vi.fn>;
  deregister: ReturnType<typeof vi.fn>;
  getCircuitState: ReturnType<typeof vi.fn>;
}

export function createMockClient(defaults?: {
  circuitState?: 'closed' | 'open' | 'half-open';
}): MockAgentPaneClient {
  return {
    register: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    ingest: vi.fn().mockResolvedValue(undefined),
    deregister: vi.fn().mockResolvedValue(undefined),
    getCircuitState: vi.fn().mockReturnValue(defaults?.circuitState ?? 'closed'),
  };
}

// ── Fetch Mock (for AgentPaneClient tests) ──────────────────────────

export interface MockFetchSetup {
  mockFetch: ReturnType<typeof vi.fn>;
  /** Restore the original global fetch */
  restore: () => void;
}

/**
 * Install a mock `globalThis.fetch` and return the mock + restore fn.
 * Call `restore()` in afterAll/afterEach.
 */
export function installMockFetch(): MockFetchSetup {
  const original = globalThis.fetch;
  const mockFetch = vi.fn();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  return {
    mockFetch,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Create a minimal successful Response mock */
export function okResponse(body?: Record<string, unknown>): {
  ok: true;
  status: 200;
  json: () => Promise<unknown>;
} {
  return {
    ok: true as const,
    status: 200,
    json: () => Promise.resolve(body ?? {}),
  };
}

/** Create a minimal failed Response mock */
export function errorResponse(
  status: number,
  statusText = 'Error'
): { ok: false; status: number; statusText: string } {
  return { ok: false as const, status, statusText };
}

// ── FileWatcher Mock ────────────────────────────────────────────────

export interface MockFileWatcher {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

export function createMockWatcher(): MockFileWatcher {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

// ── SessionStore Mock (for daemon/watcher integration tests) ────────

export interface MockSessionStore {
  getSession: ReturnType<typeof vi.fn>;
  setSession: ReturnType<typeof vi.fn>;
  removeSession: ReturnType<typeof vi.fn>;
  removeByFilePath: ReturnType<typeof vi.fn>;
  getSessionCount: ReturnType<typeof vi.fn>;
  getReadOffset: ReturnType<typeof vi.fn>;
  setReadOffset: ReturnType<typeof vi.fn>;
  flushChanges: ReturnType<typeof vi.fn>;
  markPendingRetry: ReturnType<typeof vi.fn>;
  markIdleSessions: ReturnType<typeof vi.fn>;
  evictIdleSessions: ReturnType<typeof vi.fn>;
}

export function createMockStore(preloadedSessions?: StoredSession[]): MockSessionStore {
  const sessions = new Map<string, StoredSession>();
  if (preloadedSessions) {
    for (const s of preloadedSessions) sessions.set(s.sessionId, s);
  }

  return {
    getSession: vi.fn((id: string) => sessions.get(id)),
    setSession: vi.fn((id: string, session: StoredSession) => {
      sessions.set(id, session);
    }),
    removeSession: vi.fn((id: string) => {
      sessions.delete(id);
    }),
    removeByFilePath: vi.fn(),
    getSessionCount: vi.fn(() => sessions.size),
    getReadOffset: vi.fn().mockReturnValue(0),
    setReadOffset: vi.fn(),
    flushChanges: vi.fn().mockReturnValue({ updated: [], removed: [] }),
    markPendingRetry: vi.fn(),
    markIdleSessions: vi.fn(),
    evictIdleSessions: vi.fn().mockReturnValue(0),
  };
}

// ── Display Mock ────────────────────────────────────────────────────

export interface MockDisplay {
  printStatusBox: ReturnType<typeof vi.fn>;
  printError: ReturnType<typeof vi.fn>;
  printInfo: ReturnType<typeof vi.fn>;
}

export function createMockDisplay(): MockDisplay {
  return {
    printStatusBox: vi.fn(),
    printError: vi.fn(),
    printInfo: vi.fn(),
  };
}

// ── Logger Mock ─────────────────────────────────────────────────────

export interface MockLogger {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

export function createMockLogger(): MockLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ── Queue / Duration / Microcompact Event Factories ─────────────────

export function makeQueueOperationEvent(
  operation: string,
  content?: string,
  overrides: RawEventOverrides = {}
): Record<string, unknown> {
  return makeEvent({
    type: 'queue-operation',
    operation,
    ...(content != null ? { message: { role: 'user', content } } : {}),
    ...overrides,
  });
}

export function makeTurnDurationEvent(
  durationMs: number,
  overrides: RawEventOverrides = {}
): Record<string, unknown> {
  return makeEvent({
    type: 'system',
    subtype: 'turn_duration',
    durationMs,
    ...overrides,
  } as RawEventOverrides);
}

export function makeMicrocompactWithToolIds(
  toolIds: string[],
  overrides: RawEventOverrides = {}
): Record<string, unknown> {
  return makeEvent({
    type: 'system',
    subtype: 'microcompact_boundary',
    microcompactMetadata: {
      trigger: 'auto',
      preTokens: 50000,
      tokensSaved: 10000,
      compactedToolIds: toolIds,
    },
    ...overrides,
  } as RawEventOverrides);
}

// ── Register Payload Factory ────────────────────────────────────────

export function makeRegisterPayload(
  overrides?: Partial<{
    daemonId: string;
    pid: number;
    version: string;
    watchPath: string;
    capabilities: string[];
    startedAt: number;
  }>
): {
  daemonId: string;
  pid: number;
  version: string;
  watchPath: string;
  capabilities: string[];
  startedAt: number;
} {
  return {
    daemonId: 'dm_test123',
    pid: 12345,
    version: '0.1.0',
    watchPath: '/home/user/.claude/projects',
    capabilities: ['watch', 'parse', 'subagents'],
    startedAt: Date.now(),
    ...overrides,
  };
}

// ── JSONL File Scenario Builders ────────────────────────────────────
//
// These build realistic multi-event JSONL content representing
// complete session scenarios (matching the data flow through the system).

/**
 * Build a complete "happy path" session: user asks → assistant responds → done.
 * Returns JSONL content string.
 */
export function buildSimpleSessionJsonl(opts?: {
  sessionId?: string;
  goal?: string;
  model?: string;
}): string {
  const sessionId = opts?.sessionId ?? 'sess-simple';
  const goal = opts?.goal ?? 'Fix the login bug';
  const model = opts?.model ?? 'claude-sonnet-4-20250514';

  return toJsonl(
    makeUserEvent(goal, { sessionId }),
    makeAssistantEvent('I will fix that now.', {
      sessionId,
      message: {
        role: 'assistant',
        content: 'I will fix that now.',
        model,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        stop_reason: 'end_turn',
      },
    })
  );
}

/**
 * Build a tool-use session: user asks → assistant uses tool → user approves → assistant replies.
 * Returns JSONL content string.
 */
export function buildToolUseSessionJsonl(opts?: { sessionId?: string; toolName?: string }): string {
  const sessionId = opts?.sessionId ?? 'sess-tooluse';
  const toolName = opts?.toolName ?? 'Bash';

  return toJsonl(
    makeUserEvent('Run the tests', { sessionId }),
    makeToolUseEvent(toolName, 'tool-1', { sessionId }),
    makeToolResultEvent('tool-1', 'All tests passed', { sessionId }),
    makeAssistantEvent('All tests passed successfully.', {
      sessionId,
      message: {
        role: 'assistant',
        content: 'All tests passed successfully.',
        stop_reason: 'end_turn',
      },
    })
  );
}

/**
 * Build a multi-turn conversation with token accumulation.
 */
export function buildMultiTurnSessionJsonl(opts?: { sessionId?: string; turns?: number }): string {
  const sessionId = opts?.sessionId ?? 'sess-multiturn';
  const turns = opts?.turns ?? 3;
  const events: Record<string, unknown>[] = [];

  for (let i = 0; i < turns; i++) {
    events.push(
      makeUserEvent(`Turn ${i + 1} question`, {
        sessionId,
        timestamp: new Date(Date.parse('2025-01-15T12:00:00.000Z') + i * 60_000).toISOString(),
      }),
      makeAssistantEvent(`Turn ${i + 1} answer`, {
        sessionId,
        timestamp: new Date(
          Date.parse('2025-01-15T12:00:00.000Z') + i * 60_000 + 30_000
        ).toISOString(),
        message: {
          role: 'assistant',
          content: `Turn ${i + 1} answer`,
          usage: {
            input_tokens: 100 * (i + 1),
            output_tokens: 50 * (i + 1),
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20 * (i + 1),
          },
          stop_reason: 'end_turn',
        },
      })
    );
  }

  return toJsonl(...events);
}

/**
 * Build a session that ends with a summary event (idle).
 */
export function buildCompletedSessionJsonl(opts?: { sessionId?: string }): string {
  const sessionId = opts?.sessionId ?? 'sess-completed';

  return toJsonl(
    makeUserEvent('Refactor the auth module', { sessionId }),
    makeAssistantEvent('Done. I refactored the module.', {
      sessionId,
      message: {
        role: 'assistant',
        content: 'Done. I refactored the module.',
        stop_reason: 'end_turn',
      },
    }),
    makeSummaryEvent('Refactored auth module successfully.', { sessionId })
  );
}

// ── Connected System Mock (daemon-level integration) ────────────────
//
// Wires together mock client, store, watcher, and display to simulate
// the full daemon orchestration without real I/O.

export interface ConnectedSystemMocks {
  client: MockAgentPaneClient;
  store: MockSessionStore;
  watcher: MockFileWatcher;
  display: MockDisplay;
  logger: MockLogger;
}

export function createConnectedMocks(preloadedSessions?: StoredSession[]): ConnectedSystemMocks {
  const store = createMockStore(preloadedSessions);
  const client = createMockClient();
  const watcher = createMockWatcher();
  const display = createMockDisplay();
  const mockLogger = createMockLogger();

  // Wire: flushChanges returns preloaded sessions as "updated"
  if (preloadedSessions?.length) {
    store.flushChanges.mockReturnValueOnce({
      updated: preloadedSessions.map((s) => ({ ...s })),
      removed: [],
    });
  }

  return { client, store, watcher, display, logger: mockLogger };
}

// ── Reset all counters (call in beforeEach) ─────────────────────────

export function resetAllCounters(): void {
  resetEventCounter();
  resetSessionCounter();
}
