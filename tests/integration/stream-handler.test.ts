/**
 * Integration tests for stream-handler.ts — runAgentPlanning() and runAgentExecution().
 *
 * Uses the pre-built simulate-agent-stream helpers to mock the Claude Agent SDK.
 * Tests verify event publishing sequences, ExitPlanMode detection, abort handling,
 * turn limit enforcement, and error cleanup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createExecutionStream,
  createPlanningStream,
  createPlanningStreamWithAssistantAfterExit,
} from '../helpers/simulate-agent-stream';

// ── SDK Mock ──────────────────────────────────────────────────────────────────
// Must be declared before importing the module under test.

const mockSessionSend = vi.fn().mockResolvedValue(undefined);
const mockSessionClose = vi.fn();
let mockStreamFactory: () => AsyncIterable<unknown>;
let mockCanUseToolCapture:
  | ((
      toolName: string,
      input: unknown,
      opts: { toolUseID: string }
    ) => Promise<{ behavior: 'allow'; toolUseID: string }>)
  | null = null;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn((opts: { canUseTool?: typeof mockCanUseToolCapture }) => {
    // Capture the canUseTool callback so we can invoke it from tests
    if (opts?.canUseTool) {
      mockCanUseToolCapture = opts.canUseTool as typeof mockCanUseToolCapture;
    }
    return {
      send: mockSessionSend,
      stream: () => mockStreamFactory(),
      close: mockSessionClose,
    };
  }),
}));

// Mock createId for deterministic IDs
let idCounter = 0;
vi.mock('@paralleldrive/cuid2', () => ({
  createId: () => `test-id-${++idCounter}`,
}));

// Suppress logger output
vi.mock('../../src/lib/logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import type { StreamHandlerOptions } from '../../src/lib/agents/stream-handler';
// Import AFTER mocks are set up
import { runAgentExecution, runAgentPlanning } from '../../src/lib/agents/stream-handler';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface PublishCall {
  sessionId: string;
  event: { id: string; type: string; timestamp: number; data: Record<string, unknown> };
}

function createMockSessionService() {
  const publishCalls: PublishCall[] = [];
  return {
    service: {
      publish: vi.fn(async (sessionId: string, event: PublishCall['event']) => {
        publishCalls.push({ sessionId, event });
        return { ok: true };
      }),
      persistOnly: vi.fn(async (_sessionId: string, _event: PublishCall['event']) => {
        return { ok: true };
      }),
      publishRealtimeOnly: vi.fn(async () => 0),
    },
    publishCalls,
  };
}

function makeOptions(overrides: Partial<StreamHandlerOptions> = {}): StreamHandlerOptions {
  const { service } = createMockSessionService();
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    prompt: 'Build a feature',
    allowedTools: [],
    maxTurns: 50,
    model: 'claude-sonnet-4-6',
    cwd: '/workspace',
    sessionService: service,
    ...overrides,
  };
}

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe('Stream Handler (IT-1700 to IT-1701)', () => {
  beforeEach(() => {
    idCounter = 0;
    mockCanUseToolCapture = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── runAgentPlanning ──────────────────────────────────────────────────────

  describe('runAgentPlanning', () => {
    it('IT-1700: happy path — detects ExitPlanMode, publishes plan_ready, returns planning status', async () => {
      const planText = 'Step 1: Refactor module\nStep 2: Add tests';
      mockStreamFactory = () => createPlanningStream(planText);

      const { service, publishCalls } = createMockSessionService();
      const opts = makeOptions({ sessionService: service });

      // Trigger canUseTool for ExitPlanMode BEFORE the stream processes tool_use_summary.
      // The stream handler registers canUseTool via SDK session creation. We need to
      // invoke it after the session is created but it happens internally.
      // Since our mock captures canUseTool, we'll verify it via the events.

      const result = await runAgentPlanning(opts);

      expect(result.status).toBe('planning');
      expect(result.runId).toBeDefined();
      expect(result.turnCount).toBeGreaterThanOrEqual(0);
      // Plan should contain accumulated text
      expect(result.plan).toBeDefined();
      expect(result.plan!.length).toBeGreaterThan(0);

      // Verify event sequence includes key events
      const eventTypes = publishCalls.map((c) => c.event.type);

      // Must start with planning event
      expect(eventTypes[0]).toBe('agent:planning');

      // Must end with plan_ready
      expect(eventTypes[eventTypes.length - 1]).toBe('agent:plan_ready');

      // Session should have been closed
      expect(mockSessionClose).toHaveBeenCalled();
    });

    it('IT-1702: planning with assistant message after ExitPlanMode — still captures plan', async () => {
      const planText = 'My detailed plan';
      mockStreamFactory = () => createPlanningStreamWithAssistantAfterExit(planText);

      const { service, publishCalls } = createMockSessionService();
      const opts = makeOptions({ sessionService: service });

      const result = await runAgentPlanning(opts);

      expect(result.status).toBe('planning');
      expect(result.plan).toBeDefined();
      // Plan should be captured from accumulated text
      expect(result.plan!.length).toBeGreaterThan(0);

      // Should publish agent:plan_ready
      const planReadyEvents = publishCalls.filter((c) => c.event.type === 'agent:plan_ready');
      expect(planReadyEvents.length).toBe(1);
    });

    it('IT-1703: abort signal mid-stream returns paused status', async () => {
      const abortController = new AbortController();

      // Create a stream that yields one event then hangs until abort
      mockStreamFactory = () => ({
        [Symbol.asyncIterator]() {
          let yielded = false;
          return {
            async next() {
              if (!yielded) {
                yielded = true;
                return {
                  value: { type: 'stream_event', event: { type: 'message_start' } },
                  done: false,
                };
              }
              // Abort after first yield
              abortController.abort();
              return {
                value: {
                  type: 'stream_event',
                  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
                },
                done: false,
              };
            },
            async return() {
              return { value: undefined, done: true };
            },
          };
        },
      });

      const { service, publishCalls } = createMockSessionService();
      const opts = makeOptions({
        sessionService: service,
        signal: abortController.signal,
      });

      const result = await runAgentPlanning(opts);

      expect(result.status).toBe('paused');
      expect(result.result).toContain('stopped by user');

      // Should have published agent:stopped
      const stoppedEvents = publishCalls.filter((c) => c.event.type === 'agent:stopped');
      expect(stoppedEvents.length).toBe(1);
      expect((stoppedEvents[0].event.data as Record<string, unknown>).reason).toBe('aborted');
    });

    it('IT-1704: error during stream publishes agent:error and cleans up', async () => {
      // Stream that throws an error
      mockStreamFactory = () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              throw new Error('SDK connection lost');
            },
            async return() {
              return { value: undefined, done: true };
            },
          };
        },
      });

      const { service, publishCalls } = createMockSessionService();
      const opts = makeOptions({ sessionService: service });

      const result = await runAgentPlanning(opts);

      expect(result.status).toBe('error');
      expect(result.error).toContain('SDK connection lost');

      // Should have published agent:error
      const errorEvents = publishCalls.filter((c) => c.event.type === 'agent:error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);

      // Session should be closed even on error
      expect(mockSessionClose).toHaveBeenCalled();
    });

    it('IT-1705: event sequence order — planning, then tool events, then plan_ready', async () => {
      mockStreamFactory = () => createPlanningStream('Plan text here');

      const { service, publishCalls } = createMockSessionService();
      const opts = makeOptions({ sessionService: service });

      await runAgentPlanning(opts);

      const eventTypes = publishCalls.map((c) => c.event.type);

      // First event must be planning
      expect(eventTypes[0]).toBe('agent:planning');

      // Last event must be plan_ready
      expect(eventTypes[eventTypes.length - 1]).toBe('agent:plan_ready');

      // planning must come before plan_ready
      const planningIdx = eventTypes.indexOf('agent:planning');
      const planReadyIdx = eventTypes.lastIndexOf('agent:plan_ready');
      expect(planningIdx).toBeLessThan(planReadyIdx);
    });
  });

  // ── runAgentExecution ─────────────────────────────────────────────────────

  describe('runAgentExecution', () => {
    it('IT-1706: happy path — publishes started, topology, completed events', async () => {
      mockStreamFactory = () => createExecutionStream('Feature implemented');

      const { service, publishCalls } = createMockSessionService();
      const opts = makeOptions({ sessionService: service });

      const result = await runAgentExecution(opts);

      expect(result.status).toBe('completed');
      expect(result.turnCount).toBeGreaterThanOrEqual(0);
      expect(result.result).toBeDefined();

      const eventTypes = publishCalls.map((c) => c.event.type);

      // Must start with agent:started
      expect(eventTypes[0]).toBe('agent:started');

      // Must include topology root node
      expect(eventTypes).toContain('topology:agent_spawned');

      // Must include agent:completed
      expect(eventTypes).toContain('agent:completed');

      // Must include topology:agent_completed
      expect(eventTypes).toContain('topology:agent_completed');

      expect(mockSessionClose).toHaveBeenCalled();
    });

    it('IT-1707: turn limit enforcement — publishes turn_limit when maxTurns reached', async () => {
      // Create a stream that produces multiple assistant turns
      mockStreamFactory = () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<unknown>> {
              step++;
              if (step === 1) {
                return {
                  value: { type: 'system', subtype: 'init', session_id: 'sdk-session-turn' },
                  done: false,
                };
              }
              if (step === 2) {
                return {
                  value: { type: 'stream_event', event: { type: 'message_start' } },
                  done: false,
                };
              }
              if (step === 3) {
                // Assistant message triggers turn counter
                return {
                  value: {
                    type: 'assistant',
                    message: {
                      content: [{ type: 'text', text: 'Completed first turn work' }],
                    },
                  },
                  done: false,
                };
              }
              // Stream ends after first turn (turn limit hit)
              return { value: undefined, done: true };
            },
            async return() {
              return { value: undefined, done: true };
            },
          };
        },
      });

      const { service, publishCalls } = createMockSessionService();
      // maxTurns=1 so first assistant message hits the limit
      const opts = makeOptions({ sessionService: service, maxTurns: 1 });

      const result = await runAgentExecution(opts);

      expect(result.status).toBe('turn_limit');
      expect(result.turnCount).toBe(1);

      const eventTypes = publishCalls.map((c) => c.event.type);
      expect(eventTypes).toContain('agent:turn_limit');
    });

    it('IT-1708: abort during execution returns paused status', async () => {
      const abortController = new AbortController();

      mockStreamFactory = () => ({
        [Symbol.asyncIterator]() {
          let yielded = false;
          return {
            async next() {
              if (!yielded) {
                yielded = true;
                return {
                  value: { type: 'stream_event', event: { type: 'message_start' } },
                  done: false,
                };
              }
              abortController.abort();
              return {
                value: {
                  type: 'stream_event',
                  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
                },
                done: false,
              };
            },
            async return() {
              return { value: undefined, done: true };
            },
          };
        },
      });

      const { service, publishCalls } = createMockSessionService();
      const opts = makeOptions({
        sessionService: service,
        signal: abortController.signal,
      });

      const result = await runAgentExecution(opts);

      expect(result.status).toBe('paused');
      expect(result.result).toContain('stopped by user');

      const stoppedEvents = publishCalls.filter((c) => c.event.type === 'agent:stopped');
      expect(stoppedEvents.length).toBe(1);
    });

    it('IT-1709: error during execution publishes error event and topology failure', async () => {
      mockStreamFactory = () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              throw new Error('Execution crashed');
            },
            async return() {
              return { value: undefined, done: true };
            },
          };
        },
      });

      const { service, publishCalls } = createMockSessionService();
      const opts = makeOptions({ sessionService: service });

      const result = await runAgentExecution(opts);

      expect(result.status).toBe('error');
      expect(result.error).toContain('Execution crashed');

      const eventTypes = publishCalls.map((c) => c.event.type);

      // Must publish topology:agent_completed with failed status for root
      const topologyCompleted = publishCalls.filter(
        (c) => c.event.type === 'topology:agent_completed'
      );
      expect(topologyCompleted.length).toBeGreaterThanOrEqual(1);
      const rootCompleted = topologyCompleted.find(
        (c) => (c.event.data as Record<string, unknown>).status === 'failed'
      );
      expect(rootCompleted).toBeDefined();

      // Must publish agent:error
      expect(eventTypes).toContain('agent:error');
    });

    it('IT-1710: execution with text streaming accumulates content correctly', async () => {
      const resultText = 'Implementation complete with all tests passing';
      mockStreamFactory = () => createExecutionStream(resultText);

      const { service } = createMockSessionService();
      const opts = makeOptions({ sessionService: service });

      const result = await runAgentExecution(opts);

      expect(result.status).toBe('completed');
      // The accumulated text should contain the streamed content
      expect(result.result).toBeDefined();
      expect(result.result!.length).toBeGreaterThan(0);
    });

    it('IT-1711: execution publishes agent:turn on each assistant message', async () => {
      // Stream with two assistant messages then result
      mockStreamFactory = () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<unknown>> {
              step++;
              if (step === 1) {
                return {
                  value: { type: 'system', subtype: 'init', session_id: 'sdk-multi-turn' },
                  done: false,
                };
              }
              if (step === 2) {
                return {
                  value: {
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'Turn 1 output' }] },
                  },
                  done: false,
                };
              }
              if (step === 3) {
                return {
                  value: {
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'Turn 2 output' }] },
                  },
                  done: false,
                };
              }
              if (step === 4) {
                return {
                  value: {
                    type: 'result',
                    subtype: 'success',
                    is_error: false,
                    result: 'Done',
                  },
                  done: false,
                };
              }
              return { value: undefined, done: true };
            },
            async return() {
              return { value: undefined, done: true };
            },
          };
        },
      });

      const { service, publishCalls } = createMockSessionService();
      const opts = makeOptions({ sessionService: service, maxTurns: 10 });

      const result = await runAgentExecution(opts);

      expect(result.status).toBe('completed');
      expect(result.turnCount).toBe(2);

      const turnEvents = publishCalls.filter((c) => c.event.type === 'agent:turn');
      expect(turnEvents.length).toBe(2);

      // Verify turn numbers
      expect((turnEvents[0].event.data as Record<string, unknown>).turn).toBe(1);
      expect((turnEvents[1].event.data as Record<string, unknown>).turn).toBe(2);
    });

    it('IT-1701: onMessage callback fires for user prompt and assistant turns', async () => {
      mockStreamFactory = () => createExecutionStream('Done');

      const onMessageCalls: Array<{
        role: string;
        content: string;
        turn: number;
        metadata?: Record<string, unknown>;
      }> = [];

      const { service } = createMockSessionService();
      const opts = makeOptions({
        sessionService: service,
        onMessage: async (params) => {
          onMessageCalls.push(params);
        },
      });

      await runAgentExecution(opts);

      // Should have captured at least the user prompt
      const userMessages = onMessageCalls.filter((m) => m.role === 'user');
      expect(userMessages.length).toBe(1);
      expect(userMessages[0].content).toBe('Build a feature');
    });
  });
});
