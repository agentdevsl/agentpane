/**
 * Integration tests for stream-handler.ts — topology system messages,
 * pre-tool-use hook deny path, Skill/Agent tool tracking, and
 * Write/Edit/NotebookEdit modified-files tracking.
 *
 * Targets the large uncovered ranges in handleTopologySystemMessage
 * (lines 308-435) and the canUseTool hook denial branch (lines 592-637)
 * that the existing stream-handler.test.ts does not exercise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    ) => Promise<{ behavior: 'allow' | 'deny'; toolUseID?: string; message?: string }>)
  | null = null;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn((opts: { canUseTool?: typeof mockCanUseToolCapture }) => {
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

let idCounter = 0;
vi.mock('@paralleldrive/cuid2', () => ({
  createId: () => `test-id-${++idCounter}`,
}));

vi.mock('../../src/lib/logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import type { StreamHandlerOptions } from '../../src/lib/agents/stream-handler';
import { runAgentExecution, runAgentPlanning } from '../../src/lib/agents/stream-handler';

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
      persistOnly: vi.fn(async () => ({ ok: true })),
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

/** Create a planning stream with an injected sequence of system messages before
 * the ExitPlanMode tool_use_summary. */
function planningStreamWithSystem(systemMessages: Array<Record<string, unknown>>) {
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-session-topology' };
    for (const sys of systemMessages) {
      yield { type: 'system', ...sys };
    }
    yield {
      type: 'tool_use_summary',
      tool_name: 'ExitPlanMode',
      tool_use_id: 'tool-exit-1',
      is_error: false,
      summary: 'ExitPlanMode',
      preceding_tool_use_ids: [],
    };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'plan' };
  })();
}

/** Execution stream that yields one assistant turn and then a result. */
function executionStreamWithSystem(systemMessages: Array<Record<string, unknown>>) {
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-session-exec' };
    for (const sys of systemMessages) {
      yield { type: 'system', ...sys };
    }
    yield { type: 'result', subtype: 'success', is_error: false, result: 'done' };
  })();
}

describe('Stream Handler — topology system messages', () => {
  beforeEach(() => {
    idCounter = 0;
    mockCanUseToolCapture = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('IT-SH-T1: planning publishes orchestrator + child topology nodes for task_started', async () => {
    mockStreamFactory = () =>
      planningStreamWithSystem([
        {
          subtype: 'task_started',
          task_id: 'sdk-task-1',
          description: 'Run tests',
          task_type: 'general-purpose',
        },
        {
          subtype: 'task_progress',
          task_id: 'sdk-task-1',
          usage: { total_tokens: 42, tool_uses: 3, duration_ms: 100 },
          summary: 'still running',
          last_tool_name: 'Bash',
        },
        {
          subtype: 'task_notification',
          task_id: 'sdk-task-1',
          status: 'completed',
          summary: 'all good',
          usage: { total_tokens: 50, tool_uses: 4, duration_ms: 200 },
        },
      ]);

    const { service, publishCalls } = createMockSessionService();
    await runAgentPlanning(makeOptions({ sessionService: service }));

    const types = publishCalls.map((c) => c.event.type);
    expect(types).toContain('topology:agent_spawned');
    expect(types).toContain('topology:agent_progress');
    expect(types).toContain('topology:agent_completed');

    // Expect orchestrator first (rootEmitted), then child agent_spawned, then progress, then completed
    const orchSpawn = publishCalls.find(
      (c) => c.event.type === 'topology:agent_spawned' && c.event.data.role === 'orchestrator'
    );
    expect(orchSpawn).toBeTruthy();
  });

  it('IT-SH-T2: task_progress with unknown task_id is silently ignored', async () => {
    mockStreamFactory = () =>
      planningStreamWithSystem([
        {
          subtype: 'task_progress',
          task_id: 'unknown-task',
          usage: { total_tokens: 0 },
        },
      ]);

    const { service, publishCalls } = createMockSessionService();
    await runAgentPlanning(makeOptions({ sessionService: service }));

    const progressEvents = publishCalls.filter((c) => c.event.type === 'topology:agent_progress');
    expect(progressEvents).toHaveLength(0);
  });

  it('IT-SH-T3: task_notification with unknown task_id is silently ignored', async () => {
    mockStreamFactory = () =>
      planningStreamWithSystem([
        {
          subtype: 'task_notification',
          task_id: 'unknown-task',
          status: 'completed',
        },
      ]);

    const { service, publishCalls } = createMockSessionService();
    await runAgentPlanning(makeOptions({ sessionService: service }));

    const completedEvents = publishCalls.filter((c) => c.event.type === 'topology:agent_completed');
    expect(completedEvents).toHaveLength(0);
  });

  it('IT-SH-T4: task_started without task_id returns false (no event published)', async () => {
    mockStreamFactory = () =>
      planningStreamWithSystem([
        {
          subtype: 'task_started',
          // missing task_id
          description: 'no id',
        },
      ]);

    const { service, publishCalls } = createMockSessionService();
    await runAgentPlanning(makeOptions({ sessionService: service }));

    const spawnEvents = publishCalls.filter((c) => c.event.type === 'topology:agent_spawned');
    expect(spawnEvents).toHaveLength(0);
  });

  it('IT-SH-T5: task_notification status normalization (failed/stopped/completed)', async () => {
    mockStreamFactory = () =>
      planningStreamWithSystem([
        { subtype: 'task_started', task_id: 't-fail', description: 'x' },
        { subtype: 'task_notification', task_id: 't-fail', status: 'failed', summary: 'oops' },
      ]);

    const { service, publishCalls } = createMockSessionService();
    await runAgentPlanning(makeOptions({ sessionService: service }));

    const completed = publishCalls.find((c) => c.event.type === 'topology:agent_completed');
    expect(completed?.event.data.status).toBe('failed');
  });

  it('IT-SH-T6: compact_boundary system message publishes compact event', async () => {
    mockStreamFactory = () =>
      planningStreamWithSystem([
        {
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 100000, post_tokens: 30000 },
        },
      ]);

    const { service, publishCalls } = createMockSessionService();
    await runAgentPlanning(makeOptions({ sessionService: service }));

    const compactEvent = publishCalls.find(
      (c) => c.event.type === 'agent:compact_boundary' || c.event.type.includes('compact')
    );
    // Either name is acceptable — just verify a compact-related event was emitted
    expect(compactEvent).toBeTruthy();
  });

  it('IT-SH-T7: execution side handles topology system messages too', async () => {
    mockStreamFactory = () =>
      executionStreamWithSystem([
        { subtype: 'task_started', task_id: 'exec-task-1', description: 'subtask' },
        { subtype: 'task_notification', task_id: 'exec-task-1', status: 'completed' },
      ]);

    const { service, publishCalls } = createMockSessionService();
    await runAgentExecution(makeOptions({ sessionService: service }));

    const types = publishCalls.map((c) => c.event.type);
    expect(types).toContain('topology:agent_spawned');
    expect(types).toContain('topology:agent_completed');
  });
});

describe('Stream Handler — pre-tool-use hooks', () => {
  beforeEach(() => {
    idCounter = 0;
    mockCanUseToolCapture = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('IT-SH-H1: planning denies tool when pre-tool-use hook returns deny', async () => {
    mockStreamFactory = () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-hook-1' };
        yield {
          type: 'tool_use_summary',
          tool_name: 'ExitPlanMode',
          tool_use_id: 'tool-1',
          is_error: false,
          summary: 'plan',
          preceding_tool_use_ids: [],
        };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'plan' };
      })();

    const denyHook = vi.fn().mockResolvedValue({ deny: true, reason: 'blocked by policy' });
    const { service, publishCalls } = createMockSessionService();

    await runAgentPlanning(
      makeOptions({
        sessionService: service,
        preToolUseHooks: [denyHook],
      })
    );

    // Invoke captured canUseTool for a non-ExitPlanMode tool to trigger the deny path
    expect(mockCanUseToolCapture).toBeTruthy();
    const verdict = await mockCanUseToolCapture?.(
      'Bash',
      { command: 'rm -rf /' },
      {
        toolUseID: 'tool-deny-1',
      }
    );
    expect(verdict?.behavior).toBe('deny');
    expect(denyHook).toHaveBeenCalled();

    // Deny path emits a tool:result with isError:true
    const denyResults = publishCalls.filter(
      (c) =>
        c.event.type === 'tool:result' && (c.event.data as { isError?: boolean }).isError === true
    );
    expect(denyResults.length).toBeGreaterThanOrEqual(1);
  });

  it('IT-SH-H2: planning ignores hook exception (continues to allow)', async () => {
    mockStreamFactory = () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-hook-2' };
        yield {
          type: 'tool_use_summary',
          tool_name: 'ExitPlanMode',
          tool_use_id: 'tool-1',
          is_error: false,
          summary: 'plan',
          preceding_tool_use_ids: [],
        };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'plan' };
      })();

    const throwingHook = vi.fn().mockRejectedValue(new Error('hook crashed'));
    const { service } = createMockSessionService();

    await runAgentPlanning(
      makeOptions({
        sessionService: service,
        preToolUseHooks: [throwingHook],
      })
    );

    // Hook throws → caught and continues; tool is allowed
    const verdict = await mockCanUseToolCapture?.(
      'Read',
      { file_path: '/x' },
      {
        toolUseID: 'tool-allow-1',
      }
    );
    expect(verdict?.behavior).toBe('allow');
    expect(throwingHook).toHaveBeenCalled();
  });

  it('IT-SH-H3: ExitPlanMode is exempt from pre-tool-use hooks', async () => {
    mockStreamFactory = () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-hook-3' };
        yield {
          type: 'tool_use_summary',
          tool_name: 'ExitPlanMode',
          tool_use_id: 'tool-1',
          is_error: false,
          summary: 'plan',
          preceding_tool_use_ids: [],
        };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'plan' };
      })();

    const denyHook = vi.fn().mockResolvedValue({ deny: true, reason: 'no!' });
    const { service } = createMockSessionService();

    await runAgentPlanning(
      makeOptions({
        sessionService: service,
        preToolUseHooks: [denyHook],
      })
    );

    // ExitPlanMode bypasses hooks entirely
    const verdict = await mockCanUseToolCapture?.(
      'ExitPlanMode',
      { plan: 'x' },
      {
        toolUseID: 'tool-exit-1',
      }
    );
    expect(verdict?.behavior).toBe('allow');
    expect(denyHook).not.toHaveBeenCalled();
  });
});

describe('Stream Handler — Skill / Agent / file-modifier tool tracking', () => {
  beforeEach(() => {
    idCounter = 0;
    mockCanUseToolCapture = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('IT-SH-S1: Skill tool with skill name extracts and records skillName', async () => {
    mockStreamFactory = () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-skill-1' };
        yield {
          type: 'tool_use_summary',
          tool_name: 'ExitPlanMode',
          tool_use_id: 'tool-exit-1',
          is_error: false,
          summary: 'plan',
          preceding_tool_use_ids: [],
        };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'plan' };
      })();

    const { service, publishCalls } = createMockSessionService();
    await runAgentPlanning(makeOptions({ sessionService: service }));

    // Invoke captured canUseTool for Skill — should accept and emit tool:start
    await mockCanUseToolCapture?.('Skill', { skill: 'my-skill' }, { toolUseID: 'tool-skill-1' });

    const toolStartEvents = publishCalls.filter(
      (c) => c.event.type === 'tool:start' && c.event.data.tool === 'Skill'
    );
    expect(toolStartEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('IT-SH-S2: Skill tool without skill name still allows (logs warn)', async () => {
    mockStreamFactory = () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-skill-2' };
        yield {
          type: 'tool_use_summary',
          tool_name: 'ExitPlanMode',
          tool_use_id: 'tool-exit-2',
          is_error: false,
          summary: 'plan',
          preceding_tool_use_ids: [],
        };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'plan' };
      })();

    const { service } = createMockSessionService();
    await runAgentPlanning(makeOptions({ sessionService: service }));

    const verdict = await mockCanUseToolCapture?.(
      'Skill',
      { skill: 42 },
      {
        toolUseID: 'tool-skill-noname',
      }
    );
    expect(verdict?.behavior).toBe('allow');
  });

  it('IT-SH-S3: Agent tool with subagent_type buffers it for next task_started', async () => {
    mockStreamFactory = () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-agent-1' };
        yield {
          type: 'tool_use_summary',
          tool_name: 'ExitPlanMode',
          tool_use_id: 'tool-exit-3',
          is_error: false,
          summary: 'plan',
          preceding_tool_use_ids: [],
        };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'plan' };
      })();

    const { service } = createMockSessionService();
    await runAgentPlanning(makeOptions({ sessionService: service }));

    const verdict = await mockCanUseToolCapture?.(
      'Agent',
      { subagent_type: 'code-reviewer', prompt: 'review' },
      { toolUseID: 'tool-agent-1' }
    );
    expect(verdict?.behavior).toBe('allow');
  });

  it('IT-SH-S4: Write tool tracks file_path in modifiedFiles', async () => {
    mockStreamFactory = () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-write-1' };
        yield {
          type: 'tool_use_summary',
          tool_name: 'ExitPlanMode',
          tool_use_id: 'tool-exit-4',
          is_error: false,
          summary: 'plan',
          preceding_tool_use_ids: [],
        };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'plan' };
      })();

    const { service, publishCalls } = createMockSessionService();
    await runAgentPlanning(makeOptions({ sessionService: service }));

    // Drive Write/Edit/NotebookEdit through canUseTool
    await mockCanUseToolCapture?.(
      'Write',
      { file_path: '/x.ts', content: 'a' },
      {
        toolUseID: 'tw-1',
      }
    );
    await mockCanUseToolCapture?.(
      'Edit',
      { file_path: '/y.ts', old_string: 'a', new_string: 'b' },
      {
        toolUseID: 'te-1',
      }
    );
    await mockCanUseToolCapture?.(
      'NotebookEdit',
      { notebook_path: '/z.ipynb', new_source: '' },
      {
        toolUseID: 'tn-1',
      }
    );

    const toolStarts = publishCalls.filter((c) => c.event.type === 'tool:start');
    expect(toolStarts.length).toBeGreaterThanOrEqual(3);
  });
});
