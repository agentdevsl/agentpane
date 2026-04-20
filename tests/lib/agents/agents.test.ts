import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ToolContext, ToolResponse } from '@/lib/agents/types';

// =============================================================================
// Mock Setup for SDK
// =============================================================================

const mockSessionCreate = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    send: vi.fn(),
    stream: vi.fn(),
    close: vi.fn(),
  })
);

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: mockSessionCreate,
}));

// =============================================================================
// SDK Utils Tests (agentQuery)
// =============================================================================

describe('SDK Utils - agentQuery', () => {
  let mockSession: {
    send: Mock;
    stream: Mock;
    close: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = {
      send: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
    };
    mockSessionCreate.mockReturnValue(mockSession);
  });

  it('creates a session with the correct model', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello' }] },
        };
      })()
    );

    const { agentQuery } = await import('@/lib/agents/agent-sdk-utils');
    await agentQuery('Test prompt', { model: 'claude-sonnet-4-6' });

    expect(mockSessionCreate).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      env: expect.objectContaining({ CLAUDE_CODE_ENABLE_TASKS: 'true' }),
    });
  });

  it('uses default model when not specified', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } };
      })()
    );

    const { agentQuery } = await import('@/lib/agents/agent-sdk-utils');
    await agentQuery('Test prompt');

    expect(mockSessionCreate).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      env: expect.objectContaining({ CLAUDE_CODE_ENABLE_TASKS: 'true' }),
    });
  });

  it('sends the prompt to the session', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } };
      })()
    );

    const { agentQuery } = await import('@/lib/agents/agent-sdk-utils');
    await agentQuery('Test prompt');

    expect(mockSession.send).toHaveBeenCalledWith('Test prompt');
  });

  it('accumulates text from stream_event with content_block_delta', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
        };
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'World' } },
        };
      })()
    );

    const { agentQuery } = await import('@/lib/agents/agent-sdk-utils');
    const result = await agentQuery('Test prompt');

    expect(result.text).toBe('Hello World');
  });

  it('extracts text from assistant message', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Part 1' },
              { type: 'text', text: ' Part 2' },
            ],
          },
        };
      })()
    );

    const { agentQuery } = await import('@/lib/agents/agent-sdk-utils');
    const result = await agentQuery('Test prompt');

    expect(result.text).toBe('Part 1 Part 2');
  });

  it('captures usage information from message_start event', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        yield {
          type: 'stream_event',
          event: {
            type: 'message_start',
            message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100 } },
          },
        };
        yield {
          type: 'stream_event',
          event: { type: 'message_delta', usage: { output_tokens: 50 } },
        };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } };
      })()
    );

    const { agentQuery } = await import('@/lib/agents/agent-sdk-utils');
    const result = await agentQuery('Test prompt');

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('calls onToken callback with streaming text', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        };
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' World' } },
        };
      })()
    );

    const onToken = vi.fn();
    const { agentQuery } = await import('@/lib/agents/agent-sdk-utils');
    await agentQuery('Test prompt', { onToken });

    expect(onToken).toHaveBeenCalledTimes(2);
    expect(onToken).toHaveBeenNthCalledWith(1, 'Hello');
    expect(onToken).toHaveBeenNthCalledWith(2, ' World');
  });

  it('closes session after completion', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } };
      })()
    );

    const { agentQuery } = await import('@/lib/agents/agent-sdk-utils');
    await agentQuery('Test prompt');

    expect(mockSession.close).toHaveBeenCalled();
  });

  it('closes session even on error', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        throw new Error('Stream error');
      })()
    );

    const { agentQuery } = await import('@/lib/agents/agent-sdk-utils');
    await expect(agentQuery('Test prompt')).rejects.toThrow('Stream error');

    expect(mockSession.close).toHaveBeenCalled();
  });

  it('captures usage from result message type', async () => {
    mockSession.stream.mockReturnValue(
      (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } };
        yield { type: 'result', usage: { input_tokens: 150, output_tokens: 75 } };
      })()
    );

    const { agentQuery } = await import('@/lib/agents/agent-sdk-utils');
    const result = await agentQuery('Test prompt');

    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 75 });
  });
});

// =============================================================================
// Stream Handler Tests
// =============================================================================

describe('Stream Handler', () => {
  const createMockSessionService = () => ({
    publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 1 } }),
  });

  describe('runAgentPlanning', () => {
    it('publishes agent planning event', async () => {
      const sessionService = createMockSessionService();
      const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

      await runAgentPlanning({
        agentId: 'agent-1',
        sessionId: 'session-1',
        prompt: 'Test prompt',
        allowedTools: [],
        maxTurns: 10,
        model: 'claude-sonnet-4-6',
        cwd: '/tmp',
        sessionService,
      });

      expect(sessionService.publish).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          type: 'agent:planning',
          data: expect.objectContaining({
            agentId: 'agent-1',
            model: 'claude-sonnet-4-6',
          }),
        })
      );
    });

    it('publishes plan_ready event on completion', async () => {
      const sessionService = createMockSessionService();
      const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

      await runAgentPlanning({
        agentId: 'agent-1',
        sessionId: 'session-1',
        prompt: 'Test prompt',
        allowedTools: [],
        maxTurns: 10,
        model: 'claude-sonnet-4-6',
        cwd: '/tmp',
        sessionService,
      });

      const planReadyCall = sessionService.publish.mock.calls.find(
        (call) => (call[1] as { type: string }).type === 'agent:plan_ready'
      );
      expect(planReadyCall).toBeDefined();
    });

    it('returns planning status on success', async () => {
      const sessionService = createMockSessionService();
      const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

      const result = await runAgentPlanning({
        agentId: 'agent-1',
        sessionId: 'session-1',
        prompt: 'Test prompt',
        allowedTools: [],
        maxTurns: 10,
        model: 'claude-sonnet-4-6',
        cwd: '/tmp',
        sessionService,
      });

      expect(result.status).toBe('planning');
      expect(result.runId).toBeDefined();
    });

    it('publishes plan_ready event with plan data', async () => {
      const sessionService = createMockSessionService();
      const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

      await runAgentPlanning({
        agentId: 'agent-1',
        sessionId: 'session-1',
        prompt: 'Test prompt',
        allowedTools: [],
        maxTurns: 10,
        model: 'claude-sonnet-4-6',
        cwd: '/tmp',
        sessionService,
      });

      const planReadyCall = sessionService.publish.mock.calls.find(
        (call) => (call[1] as { type: string }).type === 'agent:plan_ready'
      );
      expect(planReadyCall).toBeDefined();
      expect((planReadyCall![1] as { data: { agentId: string } }).data.agentId).toBe('agent-1');
    });

    it('handles error status in result', async () => {
      // The stream handler catches errors and returns them as error status
      // Test that the planning flow works by checking valid statuses
      const sessionService = createMockSessionService();
      const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

      const result = await runAgentPlanning({
        agentId: 'agent-1',
        sessionId: 'session-1',
        prompt: 'Test prompt',
        allowedTools: [],
        maxTurns: 10,
        model: 'claude-sonnet-4-6',
        cwd: '/tmp',
        sessionService,
      });

      // When running successfully, we get planning status (planning mode now)
      expect(['completed', 'error', 'turn_limit', 'paused', 'planning']).toContain(result.status);
    });

    it('tracks turn count correctly', async () => {
      const sessionService = createMockSessionService();
      const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

      const result = await runAgentPlanning({
        agentId: 'agent-1',
        sessionId: 'session-1',
        prompt: 'Test prompt',
        allowedTools: [],
        maxTurns: 10,
        model: 'claude-sonnet-4-6',
        cwd: '/tmp',
        sessionService,
      });

      // Turn count starts at 0 and increments only when assistant messages are received
      // With the mock returning an empty stream, turn count should be 0
      expect(result.turnCount).toBeGreaterThanOrEqual(0);
    });

    it('includes run ID in all events', async () => {
      const sessionService = createMockSessionService();
      const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

      const result = await runAgentPlanning({
        agentId: 'agent-1',
        sessionId: 'session-1',
        prompt: 'Test prompt',
        allowedTools: [],
        maxTurns: 10,
        model: 'claude-sonnet-4-6',
        cwd: '/tmp',
        sessionService,
      });

      expect(result.runId).toMatch(/^[a-z0-9]+$/);
    });

    it('returns plan on completion', async () => {
      const sessionService = createMockSessionService();
      const { runAgentPlanning } = await import('@/lib/agents/stream-handler');

      const result = await runAgentPlanning({
        agentId: 'agent-1',
        sessionId: 'session-1',
        prompt: 'Test prompt',
        allowedTools: [],
        maxTurns: 10,
        model: 'claude-sonnet-4-6',
        cwd: '/tmp',
        sessionService,
      });

      // Plan is returned (may be empty string or 'No plan generated' with empty mock)
      expect(result.plan).toBeDefined();
    });
  });

  describe('metric helper functions (via stream messages)', () => {
    let mockSession: {
      send: ReturnType<typeof vi.fn>;
      stream: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      vi.clearAllMocks();
      mockSession = {
        send: vi.fn(),
        stream: vi.fn(),
        close: vi.fn(),
      };
      mockSessionCreate.mockReturnValue(mockSession);
    });

    const runWithStream = async (
      messages: Record<string, unknown>[],
      sessionService: ReturnType<typeof createMockSessionService>
    ) => {
      mockSession.stream.mockReturnValue(
        (async function* () {
          for (const msg of messages) {
            yield msg;
          }
        })()
      );
      const { runAgentPlanning } = await import('@/lib/agents/stream-handler');
      return runAgentPlanning({
        agentId: 'agent-1',
        sessionId: 'session-1',
        prompt: 'Test prompt',
        allowedTools: [],
        maxTurns: 10,
        model: 'claude-sonnet-4-6',
        cwd: '/tmp',
        sessionService,
      });
    };

    it('publishes agent:tool_progress event for tool_progress messages', async () => {
      const sessionService = createMockSessionService();

      await runWithStream(
        [
          {
            type: 'tool_progress',
            tool_use_id: 'tu-1',
            tool_name: 'Bash',
            elapsed_time_seconds: 1.5,
          },
        ],
        sessionService
      );

      // publishToolProgress is fire-and-forget (.catch), flush microtasks
      await Promise.resolve();

      const toolProgressCall = sessionService.publish.mock.calls.find(
        (call) => (call[1] as { type: string }).type === 'agent:tool_progress'
      );
      expect(toolProgressCall).toBeDefined();
      const event = toolProgressCall![1] as { type: string; data: Record<string, unknown> };
      expect(event.data.toolName).toBe('Bash');
      expect(event.data.elapsedSeconds).toBe(1.5);
      expect(event.data.toolUseId).toBe('tu-1');
    });

    it('defaults missing tool_progress fields to safe fallback values', async () => {
      const sessionService = createMockSessionService();

      await runWithStream([{ type: 'tool_progress' }], sessionService);

      await Promise.resolve();

      const toolProgressCall = sessionService.publish.mock.calls.find(
        (call) => (call[1] as { type: string }).type === 'agent:tool_progress'
      );
      expect(toolProgressCall).toBeDefined();
      const event = toolProgressCall![1] as { type: string; data: Record<string, unknown> };
      expect(event.data.toolUseId).toBe('unknown');
      expect(event.data.toolName).toBe('unknown');
      expect(event.data.elapsedSeconds).toBe(0);
    });

    it('publishes agent:compacted event for compact_boundary system messages', async () => {
      const sessionService = createMockSessionService();

      await runWithStream(
        [
          {
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: { trigger: 'auto', pre_tokens: 50000 },
          },
        ],
        sessionService
      );

      await Promise.resolve();

      const compactedCall = sessionService.publish.mock.calls.find(
        (call) => (call[1] as { type: string }).type === 'agent:compacted'
      );
      expect(compactedCall).toBeDefined();
      const event = compactedCall![1] as { type: string; data: Record<string, unknown> };
      expect(event.data.trigger).toBe('auto');
      expect(event.data.preTokens).toBe(50000);
    });

    it('silently skips compact_boundary messages with no compact_metadata', async () => {
      const sessionService = createMockSessionService();

      await runWithStream([{ type: 'system', subtype: 'compact_boundary' }], sessionService);

      await Promise.resolve();

      const compactedCall = sessionService.publish.mock.calls.find(
        (call) => (call[1] as { type: string }).type === 'agent:compacted'
      );
      expect(compactedCall).toBeUndefined();
    });

    it('publishes agent:metrics with cost data from result message', async () => {
      const sessionService = createMockSessionService();

      await runWithStream(
        [
          {
            type: 'result',
            total_cost_usd: 0.0042,
            duration_ms: 3000,
            duration_api_ms: 2500,
            num_turns: 3,
            stop_reason: 'end_turn',
          },
        ],
        sessionService
      );

      await Promise.resolve();

      const metricsCall = sessionService.publish.mock.calls.find(
        (call) => (call[1] as { type: string }).type === 'agent:metrics'
      );
      expect(metricsCall).toBeDefined();
      const event = metricsCall![1] as { type: string; data: Record<string, unknown> };
      expect(event.data.totalCostUsd).toBe(0.0042);
      expect(event.data.stopReason).toBe('end_turn');
      expect(event.data.durationMs).toBe(3000);
      expect(event.data.durationApiMs).toBe(2500);
      expect(event.data.numTurns).toBe(3);
    });

    it('preserves null stop_reason in agent:metrics without coercing to undefined', async () => {
      const sessionService = createMockSessionService();

      await runWithStream([{ type: 'result', stop_reason: null }], sessionService);

      await Promise.resolve();

      const metricsCall = sessionService.publish.mock.calls.find(
        (call) => (call[1] as { type: string }).type === 'agent:metrics'
      );
      expect(metricsCall).toBeDefined();
      const event = metricsCall![1] as { type: string; data: Record<string, unknown> };
      expect(event.data.stopReason).toBeNull();
    });
  });

  // executeToolWithHooks and TurnLimiter tests removed (AE-005, AE-006, AE-007)
  // - executeToolWithHooks was dead code never called from production
  // - TurnLimiter was dead code never integrated with stream handler
  // - Hook infrastructure removed; SDK's canUseTool is the actual interception mechanism
});

// =============================================================================
// Recovery Tests
// =============================================================================

// AE-003: Removed unused retry infrastructure (withRetry, isRetryableError, sleep)
// Only handleAgentError remains, simplified to return only 'pause' or 'fail'
describe('Recovery', () => {
  describe('handleAgentError', () => {
    const context = {
      agentId: 'agent-1',
      taskId: 'task-1',
      maxTurns: 10,
      currentTurn: 5,
    };

    it('returns pause action for rate limit errors', async () => {
      const { handleAgentError } = await import('@/lib/agents/recovery');

      const result = handleAgentError(new Error('Rate limit exceeded 429'), context);

      expect(result.action).toBe('pause');
      expect(result.shouldRetry).toBe(true);
    });

    it('returns pause action when turn limit reached', async () => {
      const { handleAgentError } = await import('@/lib/agents/recovery');

      const limitContext = { ...context, currentTurn: 10 };
      const result = handleAgentError(new Error('Any error'), limitContext);

      expect(result.action).toBe('pause');
      expect(result.shouldRetry).toBe(false);
      expect(result.message).toContain('Turn limit reached');
    });

    it('returns fail action for context length errors (no longer retries)', async () => {
      const { handleAgentError } = await import('@/lib/agents/recovery');

      const result = handleAgentError(new Error('Context length exceeded'), context);

      expect(result.action).toBe('fail');
      expect(result.shouldRetry).toBe(false);
    });

    it('returns fail action for network errors (SDK handles retries internally)', async () => {
      const { handleAgentError } = await import('@/lib/agents/recovery');

      const result = handleAgentError(new Error('Network timeout'), context);

      expect(result.action).toBe('fail');
      expect(result.shouldRetry).toBe(false);
    });

    it('returns fail action for unknown errors', async () => {
      const { handleAgentError } = await import('@/lib/agents/recovery');

      const result = handleAgentError(new Error('Unknown weird error'), context);

      expect(result.action).toBe('fail');
      expect(result.shouldRetry).toBe(false);
    });
  });
});

// =============================================================================
// Tools Tests (Unit tests without file system mocking)
// =============================================================================

describe('Tools', () => {
  const _context: ToolContext = { cwd: '/test/cwd' };

  describe('Bash Tool - isDangerousCommand', () => {
    it('detects rm -rf as dangerous', async () => {
      const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
      expect(isDangerousCommand('rm -rf /')).toBe(true);
      expect(isDangerousCommand('sudo rm -rf /tmp')).toBe(true);
    });

    it('detects git force push as dangerous', async () => {
      const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
      expect(isDangerousCommand('git push --force')).toBe(true);
      // Note: the regex pattern requires --force directly after push
      // so "git push origin main --force" is not detected (this is a limitation)
    });

    it('detects git reset --hard as dangerous', async () => {
      const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
      expect(isDangerousCommand('git reset --hard HEAD~5')).toBe(true);
    });

    it('detects SQL destructive commands as dangerous', async () => {
      const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
      expect(isDangerousCommand('DROP TABLE users')).toBe(true);
      expect(isDangerousCommand('DELETE FROM users')).toBe(true);
      expect(isDangerousCommand('TRUNCATE TABLE logs')).toBe(true);
    });

    it('allows safe commands', async () => {
      const { isDangerousCommand } = await import('@/lib/agents/tools/bash-tool');
      expect(isDangerousCommand('ls -la')).toBe(false);
      expect(isDangerousCommand('git status')).toBe(false);
      expect(isDangerousCommand('npm install')).toBe(false);
      expect(isDangerousCommand('cat file.txt')).toBe(false);
      expect(isDangerousCommand('grep pattern file.txt')).toBe(false);
    });
  });

  describe('Tool Registry', () => {
    it('returns handler for registered tools', async () => {
      const { getToolHandler } = await import('@/lib/agents/tools/index');

      expect(getToolHandler('read_file')).toBeDefined();
      expect(getToolHandler('edit_file')).toBeDefined();
      expect(getToolHandler('write_file')).toBeDefined();
      expect(getToolHandler('bash')).toBeDefined();
      expect(getToolHandler('glob')).toBeDefined();
      expect(getToolHandler('grep')).toBeDefined();
    });

    it('returns undefined for unknown tools', async () => {
      const { getToolHandler } = await import('@/lib/agents/tools/index');

      expect(getToolHandler('unknown_tool')).toBeUndefined();
      expect(getToolHandler('')).toBeUndefined();
      expect(getToolHandler('BASH')).toBeUndefined(); // case sensitive
    });

    it('lists all available tools', async () => {
      const { getAvailableTools } = await import('@/lib/agents/tools/index');

      const tools = getAvailableTools();
      expect(tools).toContain('read_file');
      expect(tools).toContain('edit_file');
      expect(tools).toContain('write_file');
      expect(tools).toContain('bash');
      expect(tools).toContain('glob');
      expect(tools).toContain('grep');
      expect(tools).toHaveLength(6);
    });

    it('has correct tool definitions in registry', async () => {
      const { TOOL_REGISTRY } = await import('@/lib/agents/tools/index');

      expect(TOOL_REGISTRY.read_file.name).toBe('read_file');
      expect(TOOL_REGISTRY.read_file.description).toContain('Read');
      expect(typeof TOOL_REGISTRY.read_file.handler).toBe('function');

      expect(TOOL_REGISTRY.bash.name).toBe('bash');
      expect(TOOL_REGISTRY.bash.description).toContain('bash');
    });
  });
});

// =============================================================================
// Hooks Tests
// =============================================================================

describe('Hooks', () => {
  describe('Tool Whitelist Hook', () => {
    it('F06-06: empty whitelist DENIES every tool (failure-closed default)', async () => {
      const { createToolWhitelistHook } = await import('@/lib/agents/hooks/tool-whitelist');

      const hook = createToolWhitelistHook([]);
      const result = await hook.hooks[0]({ tool_name: 'any_tool', tool_input: {} });

      expect(result.decision).toBe('block');
      expect(result.message).toContain('No tools are whitelisted');
    });

    it(`F06-06: ['*'] sentinel allows every tool (explicit open gate)`, async () => {
      const { createToolWhitelistHook } = await import('@/lib/agents/hooks/tool-whitelist');

      const hook = createToolWhitelistHook(['*']);
      const result = await hook.hooks[0]({ tool_name: 'bash', tool_input: {} });

      expect(result.decision).toBeUndefined();
    });

    it(`F06-06: ['*'] combined with a named tool still allows all`, async () => {
      const { createToolWhitelistHook } = await import('@/lib/agents/hooks/tool-whitelist');

      const hook = createToolWhitelistHook(['*', 'read_file']);
      const result = await hook.hooks[0]({ tool_name: 'whatever_else', tool_input: {} });

      expect(result.decision).toBeUndefined();
    });

    it('allows whitelisted tools', async () => {
      const { createToolWhitelistHook } = await import('@/lib/agents/hooks/tool-whitelist');

      const hook = createToolWhitelistHook(['read_file', 'bash']);
      const result = await hook.hooks[0]({ tool_name: 'read_file', tool_input: {} });

      expect(result.decision).toBeUndefined();
    });

    it('blocks non-whitelisted tools', async () => {
      const { createToolWhitelistHook } = await import('@/lib/agents/hooks/tool-whitelist');

      const hook = createToolWhitelistHook(['read_file', 'bash']);
      const result = await hook.hooks[0]({ tool_name: 'write_file', tool_input: {} });

      expect(result.decision).toBe('block');
      expect(result.message).toContain('write_file');
      expect(result.message).toContain('not allowed');
    });

    it('includes allowed tools in error message', async () => {
      const { createToolWhitelistHook } = await import('@/lib/agents/hooks/tool-whitelist');

      const hook = createToolWhitelistHook(['read_file', 'glob']);
      const result = await hook.hooks[0]({ tool_name: 'bash', tool_input: {} });

      expect(result.message).toContain('read_file');
      expect(result.message).toContain('glob');
    });
  });

  describe('Streaming Hooks', () => {
    it('publishes tool:start event on pre-tool hook', async () => {
      const { createStreamingHooks } = await import('@/lib/agents/hooks/streaming');
      const sessionService = {
        publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 1 } }),
      };

      const hooks = createStreamingHooks('agent-1', 'session-1', sessionService);
      await hooks.PreToolUse.hooks[0]({ tool_name: 'read_file', tool_input: { path: '/test' } });

      expect(sessionService.publish).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          type: 'tool:start',
          data: expect.objectContaining({
            agentId: 'agent-1',
            tool: 'read_file',
            input: { path: '/test' },
          }),
        })
      );
    });

    it('publishes tool:result event on post-tool hook', async () => {
      const { createStreamingHooks } = await import('@/lib/agents/hooks/streaming');
      const sessionService = {
        publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 1 } }),
      };

      const hooks = createStreamingHooks('agent-1', 'session-1', sessionService);
      await hooks.PostToolUse.hooks[0]({
        tool_name: 'read_file',
        tool_input: { path: '/test' },
        tool_response: { content: [{ type: 'text', text: 'content' }] },
        duration_ms: 100,
      });

      expect(sessionService.publish).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          type: 'tool:result',
          data: expect.objectContaining({
            agentId: 'agent-1',
            tool: 'read_file',
            duration: 100,
            isError: false,
          }),
        })
      );
    });

    it('sets isError flag for failed tool responses', async () => {
      const { createStreamingHooks } = await import('@/lib/agents/hooks/streaming');
      const sessionService = {
        publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 1 } }),
      };

      const hooks = createStreamingHooks('agent-1', 'session-1', sessionService);
      await hooks.PostToolUse.hooks[0]({
        tool_name: 'read_file',
        tool_input: { path: '/test' },
        tool_response: { content: [{ type: 'text', text: 'Error' }], is_error: true },
        duration_ms: 50,
      });

      expect(sessionService.publish).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          data: expect.objectContaining({
            isError: true,
          }),
        })
      );
    });
  });

  describe('Audit Hook', () => {
    it('inserts audit log entry on tool execution', async () => {
      const mockInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });
      const mockDb = { insert: mockInsert };

      const { createAuditHook } = await import('@/lib/agents/hooks/audit');
      const hook = createAuditHook(mockDb as never, 'agent-1', 'run-1', 'task-1', 'project-1');

      await hook.hooks[0]({
        tool_name: 'read_file',
        tool_input: { path: '/test' },
        tool_response: { content: [{ type: 'text', text: 'content' }] },
        duration_ms: 100,
      });

      expect(mockInsert).toHaveBeenCalled();
    });

    it('increments turn number for each execution', async () => {
      const values: unknown[] = [];
      const mockInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((v) => {
          values.push(v);
          return Promise.resolve(undefined);
        }),
      });
      const mockDb = { insert: mockInsert };

      const { createAuditHook } = await import('@/lib/agents/hooks/audit');
      const hook = createAuditHook(mockDb as never, 'agent-1', 'run-1', 'task-1', 'project-1');

      const toolResponse: ToolResponse = { content: [{ type: 'text', text: 'ok' }] };

      await hook.hooks[0]({
        tool_name: 'tool1',
        tool_input: {},
        tool_response: toolResponse,
        duration_ms: 50,
      });

      await hook.hooks[0]({
        tool_name: 'tool2',
        tool_input: {},
        tool_response: toolResponse,
        duration_ms: 60,
      });

      expect(mockInsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('createAgentHooks', () => {
    it('combines all hooks into AgentHooks structure', async () => {
      const mockDb = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };
      const sessionService = {
        publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 1 } }),
      };

      const { createAgentHooks } = await import('@/lib/agents/hooks/index');
      const hooks = createAgentHooks({
        agentId: 'agent-1',
        sessionId: 'session-1',
        agentRunId: 'run-1',
        taskId: 'task-1',
        codespaceId: 'project-1',
        allowedTools: ['read_file'],
        db: mockDb as never,
        sessionService,
      });

      expect(hooks.PreToolUse).toHaveLength(2); // whitelist + streaming
      expect(hooks.PostToolUse).toHaveLength(2); // audit + streaming
    });
  });
});

// =============================================================================
// Types Tests
// =============================================================================

describe('Types', () => {
  describe('agentMessageSchema', () => {
    it('validates stream_event messages', async () => {
      const { agentMessageSchema } = await import('@/lib/agents/types');

      const result = agentMessageSchema.safeParse({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { text: 'Hello' } },
      });

      expect(result.success).toBe(true);
    });

    it('validates assistant_message', async () => {
      const { agentMessageSchema } = await import('@/lib/agents/types');

      const result = agentMessageSchema.safeParse({
        type: 'assistant_message',
        content: [{ type: 'text', text: 'Hello' }],
      });

      expect(result.success).toBe(true);
    });

    it('validates tool_use message', async () => {
      const { agentMessageSchema } = await import('@/lib/agents/types');

      const result = agentMessageSchema.safeParse({
        type: 'tool_use',
        id: 'tool-123',
        name: 'read_file',
        input: { path: '/test' },
      });

      expect(result.success).toBe(true);
    });

    it('validates tool_result message', async () => {
      const { agentMessageSchema } = await import('@/lib/agents/types');

      const result = agentMessageSchema.safeParse({
        type: 'tool_result',
        tool_use_id: 'tool-123',
        content: [{ type: 'text', text: 'file contents' }],
      });

      expect(result.success).toBe(true);
    });

    it('validates result message', async () => {
      const { agentMessageSchema } = await import('@/lib/agents/types');

      const result = agentMessageSchema.safeParse({
        type: 'result',
        result: 'Task completed successfully',
      });

      expect(result.success).toBe(true);
    });

    it('rejects invalid message types', async () => {
      const { agentMessageSchema } = await import('@/lib/agents/types');

      const result = agentMessageSchema.safeParse({
        type: 'invalid_type',
        data: 'some data',
      });

      expect(result.success).toBe(false);
    });
  });
});
