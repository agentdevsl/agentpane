import { describe, expect, it, vi } from 'vitest';

const streamMessages = [
  {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Working on it' }],
    },
  },
  {
    type: 'tool_use_summary',
    summary: 'Tool finished cleanly',
    preceding_tool_use_ids: ['tool-1'],
  },
  {
    type: 'result',
    usage: { input_tokens: 10, output_tokens: 20 },
    stop_reason: 'completed',
  },
];

const { createSessionMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(
    (options?: {
      canUseTool?: (
        toolName: string,
        input: Record<string, unknown>,
        toolOptions: { toolUseID: string }
      ) => Promise<unknown>;
    }) => ({
      send: vi.fn(async () => {
        if (options?.canUseTool) {
          await options.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'tool-1' });
        }
      }),
      close: vi.fn(),
      stream: async function* () {
        for (const msg of streamMessages) {
          yield msg;
        }
      },
    })
  ),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: createSessionMock,
}));

import { runAgentExecution } from '../stream-handler.js';

describe('stream-handler metadata propagation', () => {
  it('adds envelope metadata to tool and topology events during execution', async () => {
    const publishedEvents: Array<{ sessionId: string; event: Record<string, unknown> }> = [];

    const sessionService = {
      publish: vi.fn(async (sessionId: string, event: Record<string, unknown>) => {
        publishedEvents.push({ sessionId, event });
        return { ok: true, value: { offset: 1 } };
      }),
      persistOnly: vi.fn(async () => ({ ok: true, value: { offset: 1 } })),
      publishRealtimeOnly: vi.fn(async () => 1),
    };

    await runAgentExecution({
      agentId: 'agent-1',
      sessionId: 'session-1',
      prompt: 'Do the work',
      allowedTools: ['Bash'],
      maxTurns: 5,
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/project',
      sessionService,
    });

    const toolStartEvent = publishedEvents.find((entry) => entry.event.type === 'tool:start');
    const toolResultEvent = publishedEvents.find((entry) => entry.event.type === 'tool:result');
    const topologySpawnedEvent = publishedEvents.find(
      (entry) => entry.event.type === 'topology:agent_spawned'
    );
    const topologyCompletedEvent = publishedEvents.find(
      (entry) => entry.event.type === 'topology:agent_completed'
    );

    expect(toolStartEvent?.event.data).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({
          schemaVersion: 1,
          streamId: 'session-1',
          partType: 'tool_start',
          durability: 'durable',
          blockId: 'tool-1',
        }),
      })
    );

    expect(toolResultEvent?.event.data).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({
          schemaVersion: 1,
          streamId: 'session-1',
          partType: 'tool_result',
          durability: 'durable',
          blockId: 'tool-1',
        }),
      })
    );

    expect(topologySpawnedEvent?.event.data).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({
          schemaVersion: 1,
          streamId: 'session-1',
          partType: 'lifecycle',
          durability: 'durable',
          blockId: 'agent-1',
        }),
      })
    );

    expect(topologyCompletedEvent?.event.data).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({
          schemaVersion: 1,
          streamId: 'session-1',
          partType: 'lifecycle',
          durability: 'durable',
          blockId: 'agent-1',
        }),
      })
    );
  });
});
