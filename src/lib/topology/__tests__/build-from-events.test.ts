import { describe, expect, it } from 'vitest';
import type { TaskColumn } from '@/db/schema/shared/enums.js';
import {
  buildTopologyFromEvents,
  extractSessionEvents,
  type TopologyBuildContext,
  type TopologyEvent,
} from '../build-from-events.js';

// ── Helpers ──

/** Assert a value is defined — avoids optional-chaining noise on every `graph.nodes[i]` access. */
function defined<T>(value: T | undefined, label = 'value'): T {
  if (value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

const BASE_TS = 1700000000000;

function makeContext(overrides: Partial<TopologyBuildContext> = {}): TopologyBuildContext {
  return {
    sessionId: 'sess-1',
    agentId: 'agent-1',
    taskId: 'task-1',
    taskTitle: 'Fix login bug',
    taskColumn: 'in_progress',
    lastAgentStatus: null,
    skillId: null,
    skillName: null,
    ...overrides,
  };
}

function makeEvent(type: string, data: unknown, id?: string, timestamp?: number): TopologyEvent {
  return {
    id: id ?? `evt-${Math.random().toString(36).slice(2, 8)}`,
    type,
    timestamp: timestamp ?? BASE_TS,
    data,
  };
}

// ── extractSessionEvents ──

describe('extractSessionEvents', () => {
  it('returns flat array as-is', () => {
    const events: TopologyEvent[] = [makeEvent('test', {})];
    expect(extractSessionEvents(events)).toBe(events);
  });

  it('unwraps { data: [...] } wrapper', () => {
    const events: TopologyEvent[] = [makeEvent('test', {})];
    expect(extractSessionEvents({ data: events })).toBe(events);
  });
});

// ── buildTopologyFromEvents ──

describe('buildTopologyFromEvents', () => {
  // ── Empty events / fallback ──

  describe('empty events (fallback node)', () => {
    it('creates a fallback root node when events array is empty', () => {
      const ctx = makeContext();
      const graph = buildTopologyFromEvents([], ctx);

      expect(graph.nodes).toHaveLength(1);
      expect(graph.edges).toHaveLength(0);

      const root = defined(graph.nodes[0]);
      expect(root.id).toBe('agent-task-1');
      expect(root.name).toBe('Fix login bug');
      expect(root.role).toBe('agent');
      expect(root.parentId).toBeNull();
      expect(root.childIds).toEqual([]);
    });

    it('derives status "running" when taskColumn is in_progress', () => {
      const graph = buildTopologyFromEvents([], makeContext({ taskColumn: 'in_progress' }));
      expect(defined(graph.nodes[0]).status).toBe('running');
    });

    it('derives status "completed" when taskColumn is verified', () => {
      const graph = buildTopologyFromEvents([], makeContext({ taskColumn: 'verified' }));
      const root = defined(graph.nodes[0]);
      expect(root.status).toBe('completed');
      expect(root.progress).toBe(100);
      expect(root.verified).toBe(true);
      expect(root.verificationScore).toBe(1);
    });

    it('derives status "queued" when taskColumn is an unrecognized value', () => {
      // "done" is not a valid task column — falls through to queued
      const graph = buildTopologyFromEvents([], makeContext({ taskColumn: 'done' as TaskColumn }));
      expect(defined(graph.nodes[0]).status).toBe('queued');
    });

    it('derives status "verifying" when lastAgentStatus is planning', () => {
      const graph = buildTopologyFromEvents(
        [],
        makeContext({ taskColumn: 'backlog', lastAgentStatus: 'planning' })
      );
      expect(defined(graph.nodes[0]).status).toBe('verifying');
      expect(defined(graph.nodes[0]).progress).toBe(80);
    });

    it('derives status "queued" for other column values', () => {
      const graph = buildTopologyFromEvents([], makeContext({ taskColumn: 'backlog' }));
      expect(defined(graph.nodes[0]).status).toBe('queued');
    });

    it('uses "Agent" as name when taskTitle is null', () => {
      const graph = buildTopologyFromEvents([], makeContext({ taskTitle: null }));
      expect(defined(graph.nodes[0]).name).toBe('Agent');
    });

    it('counts tool:start events for fallback progress/tokens/cost', () => {
      const events = [
        makeEvent('container-agent:tool:start', { tool: 'Bash' }, 'e1', BASE_TS),
        makeEvent('container-agent:tool:start', { tool: 'Read' }, 'e2', BASE_TS + 1),
        makeEvent('container-agent:tool:start', { tool: 'Edit' }, 'e3', BASE_TS + 2),
      ];
      // These events don't create topology nodes (no container-agent:started first),
      // so they end up in fallback path
      const graph = buildTopologyFromEvents(events, makeContext());
      const root = defined(graph.nodes[0]);
      expect(root.turns).toBe(3);
      expect(root.tokens).toBe(1500); // 3 * 500
      expect(root.cost).toBeGreaterThan(0);
      expect(root.progress).toBe(30); // 3 * 10, capped at 90
    });

    it('counts message events in fallback', () => {
      const events = [
        makeEvent('container-agent:message', { delta: 'hello' }, 'e1'),
        makeEvent('container-agent:message', { delta: 'world' }, 'e2'),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).messages).toBe(2);
    });

    it('caps fallback progress at 90', () => {
      const events = Array.from({ length: 15 }, (_, i) =>
        makeEvent('container-agent:tool:start', { tool: 'Bash' }, `e${i}`, BASE_TS + i)
      );
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).progress).toBe(90);
    });

    it('sets completedAt for completed fallback node', () => {
      const events = [makeEvent('something', {}, 'e1', BASE_TS + 999)];
      const graph = buildTopologyFromEvents(events, makeContext({ taskColumn: 'verified' }));
      expect(defined(graph.nodes[0]).completedAt).toBe(BASE_TS + 999);
    });

    it('uses first event timestamp as startedAt', () => {
      const events = [
        makeEvent('something', {}, 'e1', BASE_TS + 100),
        makeEvent('something', {}, 'e2', BASE_TS + 200),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).startedAt).toBe(BASE_TS + 100);
    });

    it('derives node ID from agentId when taskId is missing', () => {
      const graph = buildTopologyFromEvents(
        [],
        makeContext({ taskId: null, agentId: 'custom-agent' })
      );
      expect(defined(graph.nodes[0]).id).toBe('custom-agent');
    });

    it('derives node ID from sessionId when both taskId and agentId missing', () => {
      const graph = buildTopologyFromEvents(
        [],
        makeContext({ taskId: null, agentId: null, sessionId: 'sess-99' })
      );
      expect(defined(graph.nodes[0]).id).toBe('agent-sess-99');
    });
  });

  // ── Graph metadata ──

  describe('graph metadata', () => {
    it('populates taskId and taskName from context', () => {
      const graph = buildTopologyFromEvents([], makeContext());
      expect(graph.taskId).toBe('task-1');
      expect(graph.taskName).toBe('Fix login bug');
    });

    it('populates skillId and skillName from context', () => {
      const graph = buildTopologyFromEvents(
        [],
        makeContext({ skillId: 'sk-1', skillName: 'Terraform' })
      );
      expect(graph.skillId).toBe('sk-1');
      expect(graph.skillName).toBe('Terraform');
    });

    it('defaults null taskId and taskName to empty strings', () => {
      const graph = buildTopologyFromEvents([], makeContext({ taskId: null, taskTitle: null }));
      expect(graph.taskId).toBe('');
      expect(graph.taskName).toBe('');
    });
  });

  // ── topology:agent_spawned ──

  describe('topology:agent_spawned', () => {
    it('creates a node from spawned event', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Planner',
          role: 'planner',
          agentType: 'Plan',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      expect(graph.nodes).toHaveLength(1);
      const node = defined(graph.nodes[0]);
      expect(node.id).toBe('sub-1');
      expect(node.name).toBe('Planner');
      expect(node.role).toBe('planner');
      expect(node.agentType).toBe('Plan');
      expect(node.status).toBe('running');
      expect(node.parentId).toBeNull();
    });

    it('creates parent-child edges', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'root-1',
          name: 'Orchestrator',
          role: 'orchestrator',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'child-1',
          name: 'Coder',
          role: 'coder',
          parentId: 'root-1',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]).toEqual({
        id: 'root-1->child-1',
        sourceId: 'root-1',
        targetId: 'child-1',
      });

      const parent = graph.nodes.find((n) => n.id === 'root-1');
      expect(parent?.childIds).toEqual(['child-1']);

      const child = graph.nodes.find((n) => n.id === 'child-1');
      expect(child?.parentId).toBe('root-1');
    });

    it('passes through unknown role as-is', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Custom Agent',
          role: 'unknown_role',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).role).toBe('unknown_role');
    });

    it('defaults missing role to agent', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'No Role Agent',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).role).toBe('agent');
    });

    it('defaults missing agentType to null', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Agent',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).agentType).toBeNull();
    });

    it('uses event timestamp as startedAt when no data.timestamp', () => {
      const events = [
        makeEvent(
          'topology:agent_spawned',
          { agentId: 'sub-1', name: 'Agent' },
          'e1',
          BASE_TS + 500
        ),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).startedAt).toBe(BASE_TS + 500);
    });

    it('prefers data.timestamp over event.timestamp for startedAt', () => {
      const events = [
        makeEvent(
          'topology:agent_spawned',
          { agentId: 'sub-1', name: 'Agent', timestamp: BASE_TS + 100 },
          'e1',
          BASE_TS + 500
        ),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).startedAt).toBe(BASE_TS + 100);
    });

    it('handles multiple children for one parent', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'root',
          name: 'Root',
          role: 'orchestrator',
        }),
        makeEvent('topology:agent_spawned', { agentId: 'c1', name: 'C1', parentId: 'root' }),
        makeEvent('topology:agent_spawned', { agentId: 'c2', name: 'C2', parentId: 'root' }),
        makeEvent('topology:agent_spawned', { agentId: 'c3', name: 'C3', parentId: 'root' }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      expect(graph.nodes).toHaveLength(4);
      expect(graph.edges).toHaveLength(3);
      const root = graph.nodes.find((n) => n.id === 'root');
      expect(root?.childIds).toEqual(['c1', 'c2', 'c3']);
    });

    it('handles orphan child (parentId references non-existent node)', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'orphan',
          name: 'Orphan',
          parentId: 'missing-parent',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      expect(graph.nodes).toHaveLength(1);
      expect(graph.edges).toHaveLength(1);
      // Edge is created but parent node doesn't exist — this is the actual behavior
      expect(defined(graph.edges[0]).sourceId).toBe('missing-parent');
      expect(defined(graph.nodes[0]).parentId).toBe('missing-parent');
    });
  });

  // ── topology:agent_progress ──

  describe('topology:agent_progress', () => {
    it('updates tokens, cost, progress, and turns on existing node', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_progress', {
          agentId: 'sub-1',
          tokens: 2000,
          toolUses: 5,
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      const node = defined(graph.nodes[0]);

      expect(node.tokens).toBe(2000);
      expect(node.cost).toBe(Number.parseFloat((2000 * 0.000009).toFixed(4)));
      expect(node.turns).toBe(5);
      // progress = min(95, floor(2000 / 500)) = min(95, 4) = 4
      expect(node.progress).toBe(4);
    });

    it('caps progress at 95', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_progress', {
          agentId: 'sub-1',
          tokens: 100000,
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(graph.nodes[0]?.progress).toBe(95);
    });

    it('ignores progress event for unknown agentId', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_progress', { agentId: 'non-existent', tokens: 1000 }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).tokens).toBe(0);
    });

    it('preserves existing turns when toolUses is missing', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_progress', { agentId: 'sub-1', tokens: 1000 }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).turns).toBe(0);
    });

    it('does not update node when tokens is falsy (0 or undefined)', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_progress', { agentId: 'sub-1', tokens: 0 }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      // tokens=0 is falsy, so the if(d.tokens) guard skips the update
      expect(defined(graph.nodes[0]).tokens).toBe(0);
      expect(defined(graph.nodes[0]).cost).toBe(0);
    });
  });

  // ── topology:agent_completed ──

  describe('topology:agent_completed', () => {
    it('marks node as completed with progress 100', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_completed', {
          agentId: 'sub-1',
          status: 'completed',
          tokens: 5000,
          timestamp: BASE_TS + 1000,
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      const node = defined(graph.nodes[0]);

      expect(node.status).toBe('completed');
      expect(node.progress).toBe(100);
      expect(node.completedAt).toBe(BASE_TS + 1000);
      expect(node.tokens).toBe(5000);
      expect(node.cost).toBe(Number.parseFloat((5000 * 0.000009).toFixed(4)));
    });

    it('marks node as stopped', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_completed', {
          agentId: 'sub-1',
          status: 'stopped',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).status).toBe('stopped');
      expect(defined(graph.nodes[0]).progress).not.toBe(100);
    });

    it('marks node as failed for unknown status values', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_completed', {
          agentId: 'sub-1',
          status: 'error',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).status).toBe('failed');
    });

    it('marks node as failed when status is missing', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_completed', { agentId: 'sub-1' }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).status).toBe('failed');
    });

    it('falls back to event.timestamp when data.timestamp is missing', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent(
          'topology:agent_completed',
          { agentId: 'sub-1', status: 'completed' },
          'e2',
          BASE_TS + 2000
        ),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).completedAt).toBe(BASE_TS + 2000);
    });

    it('ignores completion event for unknown agentId', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_completed', { agentId: 'non-existent', status: 'completed' }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).status).toBe('running');
    });

    it('does not update tokens when tokens is missing', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_completed', { agentId: 'sub-1', status: 'completed' }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).tokens).toBe(0);
      expect(defined(graph.nodes[0]).cost).toBe(0);
    });
  });

  // ── container-agent:started ──

  describe('container-agent:started', () => {
    it('creates root node from container-agent:started', () => {
      const events = [
        makeEvent(
          'container-agent:started',
          { taskId: 'task-1', model: 'claude-sonnet-4' },
          'e1',
          BASE_TS + 10
        ),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      expect(graph.nodes).toHaveLength(1);
      const root = defined(graph.nodes[0]);
      expect(root.id).toBe('agent-task-1');
      expect(root.name).toBe('Fix login bug');
      expect(root.role).toBe('agent');
      expect(root.status).toBe('running');
      expect(root.startedAt).toBe(BASE_TS + 10);
    });

    it('uses context.taskTitle when model is missing', () => {
      const events = [makeEvent('container-agent:started', { taskId: 'task-1' })];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).name).toBe('Fix login bug');
    });

    it('uses "Orchestrator" when both model and taskTitle are missing', () => {
      const events = [makeEvent('container-agent:started', {})];
      const graph = buildTopologyFromEvents(events, makeContext({ taskTitle: null }));
      expect(defined(graph.nodes[0]).name).toBe('Orchestrator');
    });

    it('is ignored if topology nodes already exist', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Orchestrator' }),
        makeEvent('container-agent:started', { taskId: 'task-1', model: 'claude-sonnet-4' }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      // Only the topology:agent_spawned node should exist
      expect(graph.nodes).toHaveLength(1);
      expect(defined(graph.nodes[0]).id).toBe('sub-1');
    });
  });

  // ── container-agent:complete ──

  describe('container-agent:complete', () => {
    it('marks root node as completed', () => {
      const events = [
        makeEvent('container-agent:started', { taskId: 'task-1' }, 'e1', BASE_TS),
        makeEvent(
          'container-agent:complete',
          { status: 'completed', result: 'success' },
          'e2',
          BASE_TS + 5000
        ),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      const root = defined(graph.nodes[0]);

      expect(root.status).toBe('completed');
      expect(root.completedAt).toBe(BASE_TS + 5000);
      expect(root.progress).toBe(100);
    });

    it('marks root node as failed on turn_limit', () => {
      const events = [
        makeEvent('container-agent:started', { taskId: 'task-1' }, 'e1', BASE_TS),
        makeEvent('container-agent:complete', { status: 'turn_limit' }, 'e2', BASE_TS + 5000),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      const root = defined(graph.nodes[0]);

      expect(root?.status).toBe('failed');
      expect(root?.completedAt).toBe(BASE_TS + 5000);
      expect(root?.progress).not.toBe(100);
    });

    it('marks root node as stopped on cancelled', () => {
      const events = [
        makeEvent('container-agent:started', { taskId: 'task-1' }, 'e1', BASE_TS),
        makeEvent('container-agent:complete', { status: 'cancelled' }, 'e2', BASE_TS + 5000),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      const root = defined(graph.nodes[0]);

      expect(root?.status).toBe('stopped');
      expect(root?.completedAt).toBe(BASE_TS + 5000);
      expect(root?.progress).not.toBe(100);
    });

    it('does nothing when no nodes exist', () => {
      const events = [makeEvent('container-agent:complete', { result: 'success' })];
      // No container-agent:started, so no nodes created by this event type.
      // Falls through to fallback.
      const graph = buildTopologyFromEvents(events, makeContext());
      // Should have the fallback node, not crash
      expect(graph.nodes).toHaveLength(1);
    });
  });

  // ── container-agent:tool:start ──

  describe('container-agent:tool:start', () => {
    it('increments turns, tokens, and cost on root node', () => {
      const events = [
        makeEvent('container-agent:started', { taskId: 'task-1' }),
        makeEvent('container-agent:tool:start', { tool: 'Bash' }),
        makeEvent('container-agent:tool:start', { tool: 'Read' }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      const root = defined(graph.nodes[0]);

      expect(root?.turns).toBe(2);
      expect(root?.tokens).toBe(1000); // 2 * 500
      expect(root?.cost).toBe(Number.parseFloat((1000 * 0.000009).toFixed(4)));
      expect(root?.progress).toBe(20); // 2 * 10
    });

    it('caps progress at 95', () => {
      const events = [
        makeEvent('container-agent:started', { taskId: 'task-1' }),
        ...Array.from({ length: 12 }, (_, i) =>
          makeEvent('container-agent:tool:start', { tool: 'Bash' }, `e${i}`)
        ),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(graph.nodes[0]?.progress).toBe(95);
    });
  });

  // ── container-agent:message ──

  describe('container-agent:message', () => {
    it('increments message count on root node', () => {
      const events = [
        makeEvent('container-agent:started', { taskId: 'task-1' }),
        makeEvent('container-agent:message', { delta: 'hello' }),
        makeEvent('container-agent:message', { delta: 'world' }),
        makeEvent('container-agent:message', { delta: '!' }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(graph.nodes[0]?.messages).toBe(3);
    });
  });

  // ── container-agent:plan_ready ──

  describe('container-agent:plan_ready', () => {
    it('sets root node to verifying with progress 80', () => {
      const events = [
        makeEvent('container-agent:started', { taskId: 'task-1' }),
        makeEvent('container-agent:plan_ready', {}),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      const root = defined(graph.nodes[0]);

      expect(root?.status).toBe('verifying');
      expect(root?.progress).toBe(80);
    });
  });

  // ── Cost calculation accuracy ──

  describe('cost calculations', () => {
    it('uses AVERAGE_TOKEN_COST of 0.000009 per token', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_progress', { agentId: 'sub-1', tokens: 10000 }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      // 10000 * 0.000009 = 0.09
      expect(graph.nodes[0]?.cost).toBe(0.09);
    });

    it('rounds cost to 4 decimal places', () => {
      const events = [
        makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Coder' }),
        makeEvent('topology:agent_progress', { agentId: 'sub-1', tokens: 1111 }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      // 1111 * 0.000009 = 0.009999
      expect(graph.nodes[0]?.cost).toBe(0.01);
    });
  });

  // ── Complex multi-agent scenario ──

  describe('complex topology', () => {
    it('builds a tree with orchestrator, spawned children, progress, and completion', () => {
      const events = [
        // Root orchestrator spawned
        makeEvent(
          'topology:agent_spawned',
          { agentId: 'orch-1', name: 'Orchestrator', role: 'orchestrator' },
          'e1',
          BASE_TS
        ),
        // Two children spawned
        makeEvent(
          'topology:agent_spawned',
          { agentId: 'coder-1', name: 'Frontend Coder', role: 'coder', parentId: 'orch-1' },
          'e2',
          BASE_TS + 100
        ),
        makeEvent(
          'topology:agent_spawned',
          {
            agentId: 'tester-1',
            name: 'Test Writer',
            role: 'tester',
            parentId: 'orch-1',
            agentType: 'test-writer',
          },
          'e3',
          BASE_TS + 200
        ),
        // Progress on coder
        makeEvent(
          'topology:agent_progress',
          { agentId: 'coder-1', tokens: 3000, toolUses: 8 },
          'e4',
          BASE_TS + 500
        ),
        // Coder completes
        makeEvent(
          'topology:agent_completed',
          { agentId: 'coder-1', status: 'completed', tokens: 5000, timestamp: BASE_TS + 1000 },
          'e5',
          BASE_TS + 1000
        ),
        // Tester fails
        makeEvent(
          'topology:agent_completed',
          { agentId: 'tester-1', status: 'error', timestamp: BASE_TS + 1200 },
          'e6',
          BASE_TS + 1200
        ),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      // orch + test-writer group + coder + tester = 4 nodes
      // edges: orch→coder, orch→group, group→tester = 3 edges
      expect(graph.nodes).toHaveLength(4);
      expect(graph.edges).toHaveLength(3);

      const orch = graph.nodes.find((n) => n.id === 'orch-1')!;
      expect(orch.role).toBe('orchestrator');
      const groupNode = graph.nodes.find((n) => n.id.startsWith('agent-type-'))!;
      expect(orch.childIds).toEqual(['coder-1', groupNode.id]);
      expect(orch.status).toBe('completed'); // reconciled: all children are done

      const coder = graph.nodes.find((n) => n.id === 'coder-1')!;
      expect(coder.status).toBe('completed');
      expect(coder.progress).toBe(100);
      expect(coder.tokens).toBe(5000);
      expect(coder.completedAt).toBe(BASE_TS + 1000);

      const tester = graph.nodes.find((n) => n.id === 'tester-1')!;
      expect(tester.status).toBe('failed');
      expect(tester.agentType).toBe('test-writer');
      expect(tester.completedAt).toBe(BASE_TS + 1200);
    });
  });

  // ── Skill fields ──

  describe('skill fields on nodes', () => {
    it('defaults new fields for spawned nodes without agentType', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Agent',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      const node = defined(graph.nodes[0]);
      expect(node.type).toBe('agent');
      expect(node.skillId).toBeNull();
      expect(node.skillName).toBeNull();
      expect(node.skillCalls).toEqual([]);
      expect(node.agentMeta).toBeNull();
    });

    it('extracts skillId from colon-separated agentType', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Code Reviewer',
          agentType: 'pr-review-toolkit:code-reviewer',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      const node = defined(graph.nodes[0]);
      expect(node.skillId).toBe('pr-review-toolkit');
      expect(node.skillName).toBe('pr-review-toolkit:code-reviewer');
    });

    it('extracts skillId from dot-separated agentType', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Plan',
          agentType: 'speckit.plan',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).skillId).toBe('speckit');
    });

    it('returns null skillId for SDK built-in agentTypes', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Explorer',
          agentType: 'Explore',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).skillId).toBeNull();
      expect(defined(graph.nodes[0]).skillName).toBeNull();
    });

    it('resolves agentMeta from knownAgents by exact name match', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Reviewer',
          agentType: 'code-reviewer',
        }),
      ];
      const graph = buildTopologyFromEvents(events, {
        ...makeContext(),
        knownAgents: [
          {
            name: 'code-reviewer',
            model: 'claude-sonnet-4',
            color: 'blue',
            skills: ['lint'],
            tools: ['Bash'],
          },
        ],
      });
      const node = defined(graph.nodes[0]);
      expect(node.agentMeta).toEqual({
        model: 'claude-sonnet-4',
        color: 'blue',
        skills: ['lint'],
        tools: ['Bash'],
      });
    });

    it('resolves agentMeta from knownAgents by suffix match', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Reviewer',
          agentType: 'pr-review-toolkit:code-reviewer',
        }),
      ];
      const graph = buildTopologyFromEvents(events, {
        ...makeContext(),
        knownAgents: [{ name: 'code-reviewer', model: 'opus', color: 'purple' }],
      });
      expect(defined(graph.nodes[0]).agentMeta?.model).toBe('opus');
    });

    it('returns null agentMeta when no knownAgents match', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Agent',
          agentType: 'unknown-agent',
        }),
      ];
      const graph = buildTopologyFromEvents(events, {
        ...makeContext(),
        knownAgents: [{ name: 'other-agent' }],
      });
      expect(defined(graph.nodes[0]).agentMeta).toBeNull();
    });

    it('defaults new fields in fallback node', () => {
      const graph = buildTopologyFromEvents([], makeContext());
      const root = defined(graph.nodes[0]);
      expect(root.type).toBe('agent');
      expect(root.skillId).toBeNull();
      expect(root.skillName).toBeNull();
      expect(root.skillCalls).toEqual([]);
      expect(root.agentMeta).toBeNull();
    });
  });

  // ── Skill tool call accumulation ──

  describe('skill calls from tool:start events', () => {
    it('accumulates Skill tool calls on the root node', () => {
      const events = [
        makeEvent('container-agent:started', { taskId: 'task-1' }),
        makeEvent('tool:start', { tool: 'Skill', input: { skill: 'commit' } }),
        makeEvent('tool:start', { tool: 'Skill', input: { skill: 'review-pr' } }),
        makeEvent('tool:start', { tool: 'Bash', input: { command: 'ls' } }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      const root = defined(graph.nodes[0]);
      expect(root.skillCalls).toEqual(['commit', 'review-pr']);
    });

    it('deduplicates repeated skill calls', () => {
      const events = [
        makeEvent('container-agent:started', { taskId: 'task-1' }),
        makeEvent('tool:start', { tool: 'Skill', input: { skill: 'commit' } }),
        makeEvent('tool:start', { tool: 'Skill', input: { skill: 'commit' } }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).skillCalls).toEqual(['commit']);
    });

    it('ignores tool:start events without Skill tool name', () => {
      const events = [
        makeEvent('container-agent:started', { taskId: 'task-1' }),
        makeEvent('tool:start', { tool: 'Bash', input: { command: 'ls' } }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).skillCalls).toEqual([]);
    });

    it('accumulates skill calls in fallback node', () => {
      const events = [makeEvent('tool:start', { tool: 'Skill', input: { skill: 'deploy' } })];
      const graph = buildTopologyFromEvents(events, makeContext());
      expect(defined(graph.nodes[0]).skillCalls).toEqual(['deploy']);
    });
  });

  // ── Synthetic skill nodes ──

  describe('synthetic skill nodes', () => {
    it('creates skill nodes from agentMeta.skills', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Reviewer',
          agentType: 'code-reviewer',
        }),
      ];
      const graph = buildTopologyFromEvents(events, {
        ...makeContext(),
        knownAgents: [{ name: 'code-reviewer', skills: ['lint-rules', 'security-scan'] }],
      });
      // 1 agent + 2 skill nodes
      expect(graph.nodes).toHaveLength(3);
      const skillNodes = graph.nodes.filter((n) => n.type === 'skill');
      expect(skillNodes).toHaveLength(2);
      expect(skillNodes.map((n) => n.name).sort()).toEqual(['lint-rules', 'security-scan']);
      // 2 edges from agent -> skills
      const skillEdges = graph.edges.filter((e) => e.targetId.startsWith('skill-'));
      expect(skillEdges).toHaveLength(2);
    });

    it('deduplicates skill nodes across multiple agents', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'agent-1',
          name: 'Agent 1',
          agentType: 'reviewer-a',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'agent-2',
          name: 'Agent 2',
          agentType: 'reviewer-b',
        }),
      ];
      const graph = buildTopologyFromEvents(events, {
        ...makeContext(),
        knownAgents: [
          { name: 'reviewer-a', skills: ['shared-skill', 'unique-a'] },
          { name: 'reviewer-b', skills: ['shared-skill', 'unique-b'] },
        ],
      });
      // 2 agents + 3 unique skill nodes
      expect(graph.nodes).toHaveLength(5);
      const skillNodes = graph.nodes.filter((n) => n.type === 'skill');
      expect(skillNodes).toHaveLength(3);
      // shared-skill should have 2 edges (from both agents)
      const sharedEdges = graph.edges.filter((e) => e.targetId === 'skill-shared-skill');
      expect(sharedEdges).toHaveLength(2);
    });

    it('skill nodes have correct default properties', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'sub-1',
          name: 'Agent',
          agentType: 'my-agent',
        }),
      ];
      const graph = buildTopologyFromEvents(events, {
        ...makeContext(),
        knownAgents: [{ name: 'my-agent', skills: ['test-skill'] }],
      });
      const skillNode = graph.nodes.find((n) => n.type === 'skill');
      expect(skillNode).toBeDefined();
      expect(skillNode!.id).toBe('skill-test-skill');
      expect(skillNode!.role).toBe('skill');
      expect(skillNode!.status).toBe('completed');
      expect(skillNode!.progress).toBe(100);
      expect(skillNode!.skillId).toBe('test-skill');
      expect(skillNode!.skillName).toBe('test-skill');
    });
  });

  // ── Agent-type grouping ──

  describe('agent-type grouping', () => {
    it('creates a group parent when 2+ agents share the same agentType under one parent', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'orch',
          name: 'Orchestrator',
          role: 'orchestrator',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r1',
          name: 'Research DynamoDB tables',
          role: 'researcher',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r2',
          name: 'Research DynamoDB GSI',
          role: 'researcher',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      // Should have: orch, group node, r1, r2 = 4 nodes
      expect(graph.nodes).toHaveLength(4);

      const groupNode = graph.nodes.find((n) => n.id.startsWith('agent-type-'));
      expect(groupNode).toBeDefined();
      expect(groupNode!.name).toBe('tf-module-research');
      expect(groupNode!.role).toBe('tf-module-research');
      expect(groupNode!.agentType).toBe('tf-module-research');
      expect(groupNode!.parentId).toBe('orch');
      expect(groupNode!.childIds).toEqual(['r1', 'r2']);

      // r1 and r2 should be children of the group node, not the orchestrator
      const r1 = graph.nodes.find((n) => n.id === 'r1');
      const r2 = graph.nodes.find((n) => n.id === 'r2');
      expect(r1!.parentId).toBe(groupNode!.id);
      expect(r2!.parentId).toBe(groupNode!.id);

      // Orchestrator should have the group node as child, not r1/r2 directly
      const orch = graph.nodes.find((n) => n.id === 'orch');
      expect(orch!.childIds).toContain(groupNode!.id);
      expect(orch!.childIds).not.toContain('r1');
      expect(orch!.childIds).not.toContain('r2');
    });

    it('creates separate group parents for different agentTypes', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'orch',
          name: 'Orchestrator',
          role: 'orchestrator',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r1',
          name: 'Research A',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'd1',
          name: 'Design A',
          agentType: 'tf-module-design',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r2',
          name: 'Research B',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'd2',
          name: 'Design B',
          agentType: 'tf-module-design',
          parentId: 'orch',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      // orch + 2 group nodes + 4 agents = 7
      expect(graph.nodes).toHaveLength(7);

      const groupNodes = graph.nodes.filter((n) => n.id.startsWith('agent-type-'));
      expect(groupNodes).toHaveLength(2);

      const researchGroup = groupNodes.find((n) => n.name === 'tf-module-research');
      const designGroup = groupNodes.find((n) => n.name === 'tf-module-design');
      expect(researchGroup!.childIds).toEqual(['r1', 'r2']);
      expect(designGroup!.childIds).toEqual(['d1', 'd2']);
    });

    it('does not group agents with agentType "general-purpose"', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'orch',
          name: 'Orchestrator',
          role: 'orchestrator',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'g1',
          name: 'GP Agent 1',
          agentType: 'general-purpose',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'g2',
          name: 'GP Agent 2',
          agentType: 'general-purpose',
          parentId: 'orch',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      // No group node should be created — just orch + g1 + g2
      expect(graph.nodes).toHaveLength(3);
      expect(graph.nodes.find((n) => n.id.startsWith('agent-type-'))).toBeUndefined();

      const orch = graph.nodes.find((n) => n.id === 'orch');
      expect(orch!.childIds).toEqual(['g1', 'g2']);
    });

    it('does not group agents with null agentType', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'orch',
          name: 'Orchestrator',
          role: 'orchestrator',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'a1',
          name: 'Agent 1',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'a2',
          name: 'Agent 2',
          parentId: 'orch',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      // No group node — just orch + a1 + a2
      expect(graph.nodes).toHaveLength(3);
      expect(graph.nodes.find((n) => n.id.startsWith('agent-type-'))).toBeUndefined();
    });

    it('creates group node even for a single agent of a type', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'orch',
          name: 'Orchestrator',
          role: 'orchestrator',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r1',
          name: 'Research A',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      // Group node created eagerly: orch + group + r1 = 3
      expect(graph.nodes).toHaveLength(3);
      const groupNode = graph.nodes.find((n) => n.id.startsWith('agent-type-'));
      expect(groupNode).toBeDefined();
      expect(groupNode!.childIds).toEqual(['r1']);
      expect(graph.nodes.find((n) => n.id === 'r1')!.parentId).toBe(groupNode!.id);
    });

    it('handles 3+ agents of the same type under one parent', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'orch',
          name: 'Orchestrator',
          role: 'orchestrator',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r1',
          name: 'Research 1',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r2',
          name: 'Research 2',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r3',
          name: 'Research 3',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      // orch + group + r1 + r2 + r3 = 5
      expect(graph.nodes).toHaveLength(5);

      const groupNode = graph.nodes.find((n) => n.id.startsWith('agent-type-'));
      expect(groupNode).toBeDefined();
      expect(groupNode!.childIds).toEqual(['r1', 'r2', 'r3']);

      // All three should be children of the group
      for (const id of ['r1', 'r2', 'r3']) {
        expect(graph.nodes.find((n) => n.id === id)!.parentId).toBe(groupNode!.id);
      }
    });

    it('creates correct edges for group hierarchy', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'orch',
          name: 'Orchestrator',
          role: 'orchestrator',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r1',
          name: 'Research 1',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r2',
          name: 'Research 2',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      const groupNode = graph.nodes.find((n) => n.id.startsWith('agent-type-'))!;

      // Should have edge: orch → group, group → r1, group → r2
      expect(graph.edges).toHaveLength(3);
      expect(
        graph.edges.find((e) => e.sourceId === 'orch' && e.targetId === groupNode.id)
      ).toBeDefined();
      expect(
        graph.edges.find((e) => e.sourceId === groupNode.id && e.targetId === 'r1')
      ).toBeDefined();
      expect(
        graph.edges.find((e) => e.sourceId === groupNode.id && e.targetId === 'r2')
      ).toBeDefined();

      // Should NOT have direct orch → r1 or orch → r2 edges
      expect(graph.edges.find((e) => e.sourceId === 'orch' && e.targetId === 'r1')).toBeUndefined();
      expect(graph.edges.find((e) => e.sourceId === 'orch' && e.targetId === 'r2')).toBeUndefined();
    });

    it('resolves agentMeta on group nodes from knownAgents', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'orch',
          name: 'Orchestrator',
          role: 'orchestrator',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r1',
          name: 'Research 1',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r2',
          name: 'Research 2',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
      ];
      const graph = buildTopologyFromEvents(events, {
        ...makeContext(),
        knownAgents: [{ name: 'tf-module-research', model: 'claude-sonnet-4', color: 'green' }],
      });

      const groupNode = graph.nodes.find((n) => n.id.startsWith('agent-type-'))!;
      expect(groupNode.agentMeta).toEqual({
        model: 'claude-sonnet-4',
        color: 'green',
        skills: undefined,
        tools: undefined,
      });
    });

    it('group node status reconciles when all children complete', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'orch',
          name: 'Orchestrator',
          role: 'orchestrator',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r1',
          name: 'Research 1',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r2',
          name: 'Research 2',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_completed', {
          agentId: 'r1',
          status: 'completed',
        }),
        makeEvent('topology:agent_completed', {
          agentId: 'r2',
          status: 'completed',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      const groupNode = graph.nodes.find((n) => n.id.startsWith('agent-type-'))!;
      // Group should be reconciled to completed since all children are done
      expect(groupNode.status).toBe('completed');
      expect(groupNode.progress).toBe(100);
    });

    it('mixes grouped and ungrouped children under the same parent', () => {
      const events = [
        makeEvent('topology:agent_spawned', {
          agentId: 'orch',
          name: 'Orchestrator',
          role: 'orchestrator',
        }),
        // Two research agents (will be grouped)
        makeEvent('topology:agent_spawned', {
          agentId: 'r1',
          name: 'Research 1',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
        makeEvent('topology:agent_spawned', {
          agentId: 'r2',
          name: 'Research 2',
          agentType: 'tf-module-research',
          parentId: 'orch',
        }),
        // One general-purpose agent (not grouped)
        makeEvent('topology:agent_spawned', {
          agentId: 'gp1',
          name: 'General Agent',
          agentType: 'general-purpose',
          parentId: 'orch',
        }),
      ];
      const graph = buildTopologyFromEvents(events, makeContext());

      // orch + group + r1 + r2 + gp1 = 5
      expect(graph.nodes).toHaveLength(5);

      const orch = graph.nodes.find((n) => n.id === 'orch')!;
      const groupNode = graph.nodes.find((n) => n.id.startsWith('agent-type-'))!;

      // Orchestrator should have the group node and gp1 as direct children
      expect(orch.childIds).toContain(groupNode.id);
      expect(orch.childIds).toContain('gp1');
      expect(orch.childIds).not.toContain('r1');
      expect(orch.childIds).not.toContain('r2');
    });
  });

  // ── Valid roles ──

  describe('role validation', () => {
    const validRoles = [
      'orchestrator',
      'planner',
      'coder',
      'reviewer',
      'tester',
      'scanner',
      'deployer',
    ];
    for (const role of validRoles) {
      it(`accepts valid role: ${role}`, () => {
        const events = [
          makeEvent('topology:agent_spawned', { agentId: 'sub-1', name: 'Agent', role }),
        ];
        const graph = buildTopologyFromEvents(events, makeContext());
        expect(graph.nodes[0]?.role).toBe(role);
      });
    }
  });
});
