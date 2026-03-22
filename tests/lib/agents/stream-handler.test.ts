// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Mock Setup
// =============================================================================

const mockSessionCreate = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    send: vi.fn(),
    stream: vi.fn().mockReturnValue(
      (async function* () {
        // empty stream
      })()
    ),
    close: vi.fn(),
  })
);

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: mockSessionCreate,
}));

vi.mock('@/lib/topology/map-agent-role', () => ({
  deriveAgentName: vi.fn((_type?: string, desc?: string) => desc ?? 'Agent'),
  mapAgentRole: vi.fn(() => 'coder'),
}));

// =============================================================================
// Helpers
// =============================================================================

function createMockSession() {
  const session = {
    send: vi.fn(),
    stream: vi.fn().mockReturnValue(
      (async function* () {
        // empty stream by default
      })()
    ),
    close: vi.fn(),
  };
  mockSessionCreate.mockReturnValue(session);
  return session;
}

function createMockSessionService() {
  return {
    publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 1 } }),
  };
}

function createDefaultOptions(
  sessionService: ReturnType<typeof createMockSessionService>,
  overrides: Record<string, unknown> = {}
) {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    prompt: 'Implement feature X',
    allowedTools: ['read_file', 'bash'],
    maxTurns: 10,
    model: 'claude-sonnet-4-6',
    cwd: '/workspace/project',
    sessionService,
    ...overrides,
  };
}

async function* yieldMessages(msgs: Record<string, unknown>[]) {
  for (const msg of msgs) {
    yield msg;
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function findPublishedEvent(
  sessionService: ReturnType<typeof createMockSessionService>,
  type: string
) {
  return sessionService.publish.mock.calls.find(
    (call) => (call[1] as { type: string }).type === type
  );
}

function findAllPublishedEvents(
  sessionService: ReturnType<typeof createMockSessionService>,
  type: string
) {
  return sessionService.publish.mock.calls.filter(
    (call) => (call[1] as { type: string }).type === type
  );
}

// =============================================================================
// runAgentPlanning Tests
// =============================================================================

describe('runAgentPlanning', () => {
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = createMockSession();
  });

  it('creates session with plan permissionMode', async () => {
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));

    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: 'plan',
        model: 'claude-sonnet-4-6',
      })
    );
  });

  it('passes --add-dir with cwd as executableArgs', async () => {
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService, { cwd: '/my/project' }));

    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        executableArgs: ['--add-dir', '/my/project'],
      })
    );
  });

  it('sends the prompt to the session', async () => {
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService, { prompt: 'Plan a refactor' }));

    expect(mockSession.send).toHaveBeenCalledWith('Plan a refactor');
  });

  it('publishes agent:planning event at start', async () => {
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));

    const call = findPublishedEvent(sessionService, 'agent:planning');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.agentId).toBe('agent-1');
    expect(event.data.model).toBe('claude-sonnet-4-6');
  });

  it('publishes agent:plan_ready event on completion', async () => {
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));

    const call = findPublishedEvent(sessionService, 'agent:plan_ready');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.agentId).toBe('agent-1');
  });

  it('returns planning status on success', async () => {
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const result = await runAgentPlanning(createDefaultOptions(sessionService));

    expect(result.status).toBe('planning');
    expect(result.runId).toBeDefined();
    expect(result.turnCount).toBe(0);
  });

  it('accumulates text from stream_event content_block_delta', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'First chunk ' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'second chunk' },
          },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const result = await runAgentPlanning(createDefaultOptions(sessionService));

    // Plan should contain accumulated text
    expect(result.plan).toContain('First chunk');
    expect(result.plan).toContain('second chunk');
  });

  it('publishes chunk events for text deltas', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'hello' },
          },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));

    const call = findPublishedEvent(sessionService, 'chunk');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.text).toBe('hello');
    expect(event.data.phase).toBe('planning');
  });

  it('increments turn count on assistant messages', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Turn 1 response' }] },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Turn 2 response' }] },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const result = await runAgentPlanning(createDefaultOptions(sessionService));

    expect(result.turnCount).toBe(2);
  });

  it('publishes agent:turn events for each assistant message', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Msg 1' }] },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Msg 2' }] },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));

    const turns = findAllPublishedEvents(sessionService, 'agent:turn');
    expect(turns.length).toBe(2);
    expect((turns[0][1] as { data: { turn: number } }).data.turn).toBe(1);
    expect((turns[1][1] as { data: { turn: number } }).data.turn).toBe(2);
  });

  it('captures ExitPlanMode options via canUseTool', async () => {
    // The canUseTool is passed to the SDK, so we capture it from the mock and invoke it
    let capturedCanUseTool: ((...args: unknown[]) => unknown) | null = null;
    mockSessionCreate.mockImplementation((opts: Record<string, unknown>) => {
      capturedCanUseTool = opts.canUseTool as (...args: unknown[]) => unknown;
      return mockSession;
    });
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'tool_use_summary',
          summary: 'Plan completed',
          preceding_tool_use_ids: ['tu-exit'],
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const promise = runAgentPlanning(createDefaultOptions(sessionService));

    // Wait a tick then invoke canUseTool like the SDK would
    await Promise.resolve();
    if (capturedCanUseTool) {
      await capturedCanUseTool('ExitPlanMode', { allowedPrompts: [] }, { toolUseID: 'tu-exit' });
    }

    const result = await promise;
    expect(result.planOptions).toBeDefined();
  });

  it('publishes tool:start via canUseTool callback', async () => {
    let capturedCanUseTool: ((...args: unknown[]) => unknown) | null = null;
    mockSessionCreate.mockImplementation((opts: Record<string, unknown>) => {
      capturedCanUseTool = opts.canUseTool as (...args: unknown[]) => unknown;
      return mockSession;
    });
    mockSession.stream.mockReturnValue(yieldMessages([]));
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const promise = runAgentPlanning(createDefaultOptions(sessionService));
    await Promise.resolve();

    if (capturedCanUseTool) {
      await capturedCanUseTool('Read', { file_path: '/a.ts' }, { toolUseID: 'tu-read-1' });
    }

    await promise;

    const call = findPublishedEvent(sessionService, 'tool:start');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.tool).toBe('Read');
    expect(event.data.phase).toBe('planning');
  });

  it('handles tool_use_summary and publishes tool:result events', async () => {
    let capturedCanUseTool: ((...args: unknown[]) => unknown) | null = null;
    mockSessionCreate.mockImplementation((opts: Record<string, unknown>) => {
      capturedCanUseTool = opts.canUseTool as (...args: unknown[]) => unknown;
      return mockSession;
    });

    // Use a manual iterator so we can insert events in sequence
    const messages: Record<string, unknown>[] = [
      {
        type: 'tool_use_summary',
        summary: 'Read file contents',
        preceding_tool_use_ids: ['tu-r1'],
      },
    ];
    mockSession.stream.mockReturnValue(yieldMessages(messages));

    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const promise = runAgentPlanning(createDefaultOptions(sessionService));
    await Promise.resolve();

    if (capturedCanUseTool) {
      await capturedCanUseTool('Read', {}, { toolUseID: 'tu-r1' });
    }

    await promise;

    const call = findPublishedEvent(sessionService, 'tool:result');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.tool).toBe('Read');
    expect(event.data.output).toBe('Read file contents');
  });

  it('handles result message and extracts metrics', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'result',
          total_cost_usd: 0.005,
          duration_ms: 2000,
          duration_api_ms: 1800,
          num_turns: 3,
          stop_reason: 'end_turn',
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const result = await runAgentPlanning(createDefaultOptions(sessionService));

    expect(result.metrics).toBeDefined();
    expect(result.metrics?.totalCostUsd).toBe(0.005);
    expect(result.metrics?.durationMs).toBe(2000);
    expect(result.metrics?.numTurns).toBe(3);
    expect(result.metrics?.stopReason).toBe('end_turn');
  });

  it('closes session on result message', async () => {
    mockSession.stream.mockReturnValue(yieldMessages([{ type: 'result', total_cost_usd: 0 }]));
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));

    expect(mockSession.close).toHaveBeenCalled();
  });

  it('handles errors and returns error status', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        throw new Error('SDK crashed');
      })()
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const result = await runAgentPlanning(createDefaultOptions(sessionService));

    expect(result.status).toBe('error');
    expect(result.error).toBe('SDK crashed');
    expect(result.turnCount).toBe(0);
  });

  it('publishes agent:error event on exception', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        throw new Error('Connection lost');
      })()
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));

    const call = findPublishedEvent(sessionService, 'agent:error');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.error).toBe('Connection lost');
    expect(event.data.phase).toBe('planning');
  });

  it('closes session on error', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        throw new Error('fail');
      })()
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));

    expect(mockSession.close).toHaveBeenCalled();
  });

  it('handles rate_limit_event messages', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'throttled', resetsAt: 1700000000 },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));
    await Promise.resolve();

    const call = findPublishedEvent(sessionService, 'agent:rate_limit');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.status).toBe('throttled');
  });

  it('handles assistant error field and publishes agent:error', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial' }] },
          error: 'Internal SDK error',
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));
    await Promise.resolve();

    const call = findPublishedEvent(sessionService, 'agent:error');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.error).toContain('Internal SDK error');
  });

  it('handles compact_boundary system messages', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 50000 },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));
    await Promise.resolve();

    const call = findPublishedEvent(sessionService, 'agent:compacted');
    expect(call).toBeDefined();
  });

  it('returns "No plan generated" when stream is empty', async () => {
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const result = await runAgentPlanning(createDefaultOptions(sessionService));

    expect(result.plan).toBe('No plan generated');
  });

  it('publishes agent:metrics from result message', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'result',
          total_cost_usd: 0.01,
          duration_ms: 5000,
          num_turns: 2,
          stop_reason: null,
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));
    await Promise.resolve();

    const call = findPublishedEvent(sessionService, 'agent:metrics');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.totalCostUsd).toBe(0.01);
    expect(event.data.stopReason).toBeNull();
  });

  it('ignores stream_events that are not content_block_delta', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'stream_event',
          event: { type: 'message_start', message: { model: 'claude-sonnet-4-6' } },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const result = await runAgentPlanning(createDefaultOptions(sessionService));

    // Should not have published chunk events
    const chunkCall = findPublishedEvent(sessionService, 'chunk');
    expect(chunkCall).toBeUndefined();
    expect(result.plan).toBe('No plan generated');
  });

  it('publishes tool_progress events', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'tool_progress',
          tool_use_id: 'tu-1',
          tool_name: 'Bash',
          elapsed_time_seconds: 3.5,
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService));
    await Promise.resolve();

    const call = findPublishedEvent(sessionService, 'agent:tool_progress');
    expect(call).toBeDefined();
  });

  // ===========================================================================
  // Abort signal tests
  // ===========================================================================

  it('returns paused status when signal is aborted before first message', async () => {
    // Stream yields a message so the for-await body executes, but signal is already aborted
    const controller = new AbortController();
    controller.abort();

    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'should not matter' },
          },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const result = await runAgentPlanning(
      createDefaultOptions(sessionService, { signal: controller.signal })
    );

    expect(result.status).toBe('paused');
    expect(result.result).toBe('Agent stopped by user during planning');
  });

  it('publishes agent:stopped event when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'chunk' },
          },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService, { signal: controller.signal }));

    const call = findPublishedEvent(sessionService, 'agent:stopped');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.agentId).toBe('agent-1');
    expect(event.data.reason).toBe('aborted');
    expect(event.data.phase).toBe('planning');
  });

  it('closes the session when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    await runAgentPlanning(createDefaultOptions(sessionService, { signal: controller.signal }));

    expect(mockSession.close).toHaveBeenCalled();
  });

  it('returns paused status when signal is aborted mid-stream', async () => {
    const controller = new AbortController();

    // Yield one message, abort, then yield another — the second iteration should detect the abort
    mockSession.stream.mockReturnValue(
      (async function* () {
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'first chunk' },
          },
        };
        // Abort between messages
        controller.abort();
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'second chunk' },
          },
        };
      })()
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    const result = await runAgentPlanning(
      createDefaultOptions(sessionService, { signal: controller.signal })
    );

    expect(result.status).toBe('paused');
    expect(result.result).toBe('Agent stopped by user during planning');
    // First chunk should have been published before abort
    const chunks = findAllPublishedEvents(sessionService, 'chunk');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('works normally when no signal is provided', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Plan complete' }] },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

    // No signal option
    const result = await runAgentPlanning(createDefaultOptions(sessionService));

    expect(result.status).toBe('planning');
    expect(result.turnCount).toBe(1);
  });
});

// =============================================================================
// runAgentExecution Tests
// =============================================================================

describe('runAgentExecution', () => {
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = createMockSession();
  });

  it('creates session with acceptEdits permissionMode', async () => {
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService));

    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: 'acceptEdits',
        allowedTools: ['read_file', 'bash'],
      })
    );
  });

  it('publishes agent:started event at beginning', async () => {
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService));

    const call = findPublishedEvent(sessionService, 'agent:started');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.agentId).toBe('agent-1');
    expect(event.data.maxTurns).toBe(10);
    expect(event.data.phase).toBe('execution');
  });

  it('emits root topology:agent_spawned at start', async () => {
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService));

    const call = findPublishedEvent(sessionService, 'topology:agent_spawned');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.role).toBe('orchestrator');
    expect(event.data.parentId).toBeNull();
  });

  it('publishes agent:completed on successful completion', async () => {
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    const result = await runAgentExecution(createDefaultOptions(sessionService));

    expect(result.status).toBe('completed');
    const call = findPublishedEvent(sessionService, 'agent:completed');
    expect(call).toBeDefined();
  });

  it('returns result text from accumulated content', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Done implementing feature' }] },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    const result = await runAgentExecution(createDefaultOptions(sessionService));

    expect(result.result).toBe('Done implementing feature');
  });

  it('returns default result text when no content', async () => {
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    const result = await runAgentExecution(createDefaultOptions(sessionService));

    expect(result.result).toBe('Task completed successfully');
  });

  it('enforces turn limit and returns turn_limit status', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Turn 1' }] },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Turn 2' }] },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Turn 3' }] },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    const result = await runAgentExecution(createDefaultOptions(sessionService, { maxTurns: 3 }));

    expect(result.status).toBe('turn_limit');
    expect(result.turnCount).toBe(3);
  });

  it('publishes agent:turn_limit event when limit reached', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Work' }] },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService, { maxTurns: 1 }));

    const call = findPublishedEvent(sessionService, 'agent:turn_limit');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.maxTurns).toBe(1);
  });

  it('closes session when turn limit reached', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Work' }] },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService, { maxTurns: 1 }));

    expect(mockSession.close).toHaveBeenCalled();
  });

  it('publishes agent:turn with remaining count', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Step 1' }],
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService, { maxTurns: 5 }));

    const call = findPublishedEvent(sessionService, 'agent:turn');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.turn).toBe(1);
    expect(event.data.remaining).toBe(4);
    expect(event.data.maxTurns).toBe(5);
  });

  it('handles result message with metrics and closes session first', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'result',
          total_cost_usd: 0.02,
          duration_ms: 10000,
          duration_api_ms: 9000,
          num_turns: 5,
          stop_reason: 'end_turn',
          usage: { input_tokens: 500, output_tokens: 200 },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    const result = await runAgentExecution(createDefaultOptions(sessionService));

    expect(mockSession.close).toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.metrics?.totalCostUsd).toBe(0.02);
    expect(result.metrics?.durationApiMs).toBe(9000);
  });

  it('publishes topology:agent_completed on result', async () => {
    mockSession.stream.mockReturnValue(yieldMessages([{ type: 'result', total_cost_usd: 0 }]));
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService));

    const call = findPublishedEvent(sessionService, 'topology:agent_completed');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.status).toBe('completed');
  });

  it('handles errors and returns error status', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        throw new Error('Execution failed');
      })()
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    const result = await runAgentExecution(createDefaultOptions(sessionService));

    expect(result.status).toBe('error');
    expect(result.error).toBe('Execution failed');
  });

  it('publishes agent:error event on exception', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        throw new Error('Network timeout');
      })()
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService));

    const call = findPublishedEvent(sessionService, 'agent:error');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.error).toBe('Network timeout');
  });

  it('handles subagent task_started system messages', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'sdk-task-1',
          description: 'Review code changes',
          task_type: 'code-reviewer',
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService));

    // Should have emitted two topology:agent_spawned (root + subagent)
    // Root is emitted at start, subagent via task_started handler
    // But root is already emitted at the top of runAgentExecution, so
    // the system handler doesn't re-emit the root
    const spawned = findAllPublishedEvents(sessionService, 'topology:agent_spawned');
    // 1 root (at start) + 1 subagent
    expect(spawned.length).toBe(2);
  });

  it('handles subagent task_notification system messages', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'sdk-task-2',
          description: 'Test feature',
        },
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'sdk-task-2',
          status: 'completed',
          summary: 'All tests passed',
          usage: { total_tokens: 1000, tool_uses: 5, duration_ms: 3000 },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService));

    const completed = findAllPublishedEvents(sessionService, 'topology:agent_completed');
    expect(completed.length).toBeGreaterThanOrEqual(1);
  });

  it('handles assistant error field during execution', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial' }] },
          error: 'Token limit exceeded',
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService, { maxTurns: 5 }));
    await Promise.resolve();

    const call = findPublishedEvent(sessionService, 'agent:error');
    expect(call).toBeDefined();
  });

  it('handles rate_limit_event during execution', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'limited', resetsAt: 1700001000 },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService));
    await Promise.resolve();

    const call = findPublishedEvent(sessionService, 'agent:rate_limit');
    expect(call).toBeDefined();
  });

  it('handles compact_boundary during execution', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'manual', pre_tokens: 80000 },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService));
    await Promise.resolve();

    const call = findPublishedEvent(sessionService, 'agent:compacted');
    expect(call).toBeDefined();
  });

  it('handles tool_use_summary in execution phase', async () => {
    // In execution mode, canUseTool is called by the SDK before tool execution.
    // We need to pre-register the tool in activeTools by calling canUseTool
    // before the tool_use_summary message arrives.
    let capturedCanUseTool: ((...args: unknown[]) => unknown) | null = null;
    mockSessionCreate.mockImplementation((opts: Record<string, unknown>) => {
      capturedCanUseTool = opts.canUseTool as (...args: unknown[]) => unknown;
      return mockSession;
    });

    // Create a stream that yields messages after we've had a chance to call canUseTool
    let resolveReady: () => void;
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });

    mockSession.stream.mockReturnValue(
      (async function* () {
        // Wait for canUseTool to be called before yielding the summary
        await ready;
        yield {
          type: 'tool_use_summary',
          summary: 'File edited successfully',
          preceding_tool_use_ids: ['tu-edit-1'],
        };
      })()
    );

    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    const promise = runAgentExecution(createDefaultOptions(sessionService));

    // Wait for session creation and canUseTool to be available
    await flushPromises();

    if (capturedCanUseTool) {
      await capturedCanUseTool('Edit', { file: '/a.ts' }, { toolUseID: 'tu-edit-1' });
    }

    // Now let the stream proceed
    resolveReady!();

    await promise;

    const call = findPublishedEvent(sessionService, 'tool:result');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.tool).toBe('Edit');
  });

  // ===========================================================================
  // Abort signal tests
  // ===========================================================================

  it('returns paused status when signal is aborted before first message', async () => {
    const controller = new AbortController();
    controller.abort();

    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'should be ignored' },
          },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    const result = await runAgentExecution(
      createDefaultOptions(sessionService, { signal: controller.signal })
    );

    expect(result.status).toBe('paused');
    expect(result.result).toBe('Agent stopped by user during execution');
  });

  it('publishes agent:stopped event when signal is aborted during execution', async () => {
    const controller = new AbortController();
    controller.abort();

    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'data' },
          },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService, { signal: controller.signal }));

    const call = findPublishedEvent(sessionService, 'agent:stopped');
    expect(call).toBeDefined();
    const event = call![1] as { data: Record<string, unknown> };
    expect(event.data.agentId).toBe('agent-1');
    expect(event.data.reason).toBe('aborted');
    expect(event.data.phase).toBe('execution');
  });

  it('closes the session when signal is aborted during execution', async () => {
    const controller = new AbortController();
    controller.abort();

    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    await runAgentExecution(createDefaultOptions(sessionService, { signal: controller.signal }));

    expect(mockSession.close).toHaveBeenCalled();
  });

  it('returns paused status when signal is aborted mid-stream during execution', async () => {
    const controller = new AbortController();

    mockSession.stream.mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Turn 1 work' }] },
        };
        // Abort after the first assistant message
        controller.abort();
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Turn 2 work' }] },
        };
      })()
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    const result = await runAgentExecution(
      createDefaultOptions(sessionService, { signal: controller.signal })
    );

    expect(result.status).toBe('paused');
    expect(result.result).toBe('Agent stopped by user during execution');
    // Should have completed one turn before abort was detected
    expect(result.turnCount).toBe(1);
  });

  it('preserves turn count at point of abort', async () => {
    const controller = new AbortController();

    mockSession.stream.mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Turn 1' }] },
        };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Turn 2' }] },
        };
        controller.abort();
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Turn 3 - should not count' }] },
        };
      })()
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    const result = await runAgentExecution(
      createDefaultOptions(sessionService, { signal: controller.signal, maxTurns: 10 })
    );

    expect(result.status).toBe('paused');
    expect(result.turnCount).toBe(2);
  });

  it('works normally during execution when no signal is provided', async () => {
    mockSession.stream.mockReturnValue(
      yieldMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Implementation done' }] },
        },
        {
          type: 'result',
          total_cost_usd: 0.01,
          duration_ms: 3000,
          num_turns: 1,
          stop_reason: 'end_turn',
        },
      ])
    );
    const sessionService = createMockSessionService();
    const { runAgentExecution } = await import('@/lib/agents/stream-handler');

    // No signal option
    const result = await runAgentExecution(createDefaultOptions(sessionService));

    expect(result.status).toBe('completed');
    expect(result.turnCount).toBe(1);
    expect(result.result).toBe('Implementation done');
  });
});

// executeToolWithHooks tests removed (AE-006: dead code deleted)
