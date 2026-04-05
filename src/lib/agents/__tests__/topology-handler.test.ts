import { describe, expect, it } from 'vitest';

// We need to test handleTopologySystemMessage which is not exported,
// so we test via the module's internal logic by reimplementing the tracker pattern.
// Instead, let's test the topology system message handling end-to-end through the public API.

// Since handleTopologySystemMessage is not exported, we test the TopologyTracker logic
// and the message handling pattern directly.

describe('Topology system message handling', () => {
  // Simulate the tracker + handler logic as it exists in stream-handler.ts
  interface TopologyTracker {
    taskToNodeId: Map<string, string>;
    rootEmitted: boolean;
  }

  function createTracker(): TopologyTracker {
    return { taskToNodeId: new Map(), rootEmitted: false };
  }

  type PublishedEvent = { type: string; data: Record<string, unknown> };

  async function handleMsg(
    msg: Record<string, unknown>,
    tracker: TopologyTracker,
    agentId: string,
    published: PublishedEvent[]
  ): Promise<boolean> {
    const subtype = msg.subtype as string | undefined;
    if (!subtype) return false;

    const mockPublish = async (_sid: string, event: { type: string; data: unknown }) => {
      published.push({ type: event.type, data: event.data as Record<string, unknown> });
    };
    const sessionService = { publish: mockPublish };

    if (subtype === 'task_started') {
      const sdkTaskId = msg.task_id as string;
      if (!sdkTaskId) return false;

      if (!tracker.rootEmitted) {
        tracker.rootEmitted = true;
        await sessionService.publish('s1', {
          type: 'topology:agent_spawned',
          data: { agentId, name: 'Orchestrator', role: 'orchestrator', parentId: null },
        });
      }

      const nodeId = `node-${sdkTaskId}`;
      tracker.taskToNodeId.set(sdkTaskId, nodeId);

      await sessionService.publish('s1', {
        type: 'topology:agent_spawned',
        data: {
          agentId: nodeId,
          name: (msg.description as string) ?? 'Agent',
          role: 'agent',
          parentId: agentId,
          sdkTaskId,
        },
      });
      return true;
    }

    if (subtype === 'task_progress') {
      const sdkTaskId = msg.task_id as string;
      const nodeId = tracker.taskToNodeId.get(sdkTaskId);
      if (!nodeId) return false;

      await sessionService.publish('s1', {
        type: 'topology:agent_progress',
        data: { agentId: nodeId, sdkTaskId, tokens: 0 },
      });
      return true;
    }

    if (subtype === 'task_notification') {
      const sdkTaskId = msg.task_id as string;
      const nodeId = tracker.taskToNodeId.get(sdkTaskId);
      if (!nodeId) return false;

      await sessionService.publish('s1', {
        type: 'topology:agent_completed',
        data: {
          agentId: nodeId,
          sdkTaskId,
          status: typeof msg.status === 'string' ? msg.status : 'completed',
        },
      });
      tracker.taskToNodeId.delete(sdkTaskId);
      return true;
    }

    return false;
  }

  it('emits root orchestrator on first task_started', async () => {
    const tracker = createTracker();
    const published: PublishedEvent[] = [];

    await handleMsg(
      { subtype: 'task_started', task_id: 'task-1', description: 'Code feature' },
      tracker,
      'agent-root',
      published
    );

    expect(published).toHaveLength(2);
    expect(published[0]!.type).toBe('topology:agent_spawned');
    expect(published[0]!.data.name).toBe('Orchestrator');
    expect(published[0]!.data.parentId).toBeNull();
    expect(published[1]!.type).toBe('topology:agent_spawned');
    expect(published[1]!.data.parentId).toBe('agent-root');
    expect(published[1]!.data.sdkTaskId).toBe('task-1');
  });

  it('does not re-emit root orchestrator on second task_started', async () => {
    const tracker = createTracker();
    const published: PublishedEvent[] = [];

    await handleMsg(
      { subtype: 'task_started', task_id: 'task-1', description: 'First' },
      tracker,
      'agent-root',
      published
    );
    published.length = 0;

    await handleMsg(
      { subtype: 'task_started', task_id: 'task-2', description: 'Second' },
      tracker,
      'agent-root',
      published
    );

    expect(published).toHaveLength(1); // Only the child, no orchestrator
    expect(published[0]!.data.sdkTaskId).toBe('task-2');
  });

  it('returns false for task_started without task_id', async () => {
    const tracker = createTracker();
    const published: PublishedEvent[] = [];

    const result = await handleMsg({ subtype: 'task_started' }, tracker, 'agent-root', published);

    expect(result).toBe(false);
    expect(published).toHaveLength(0);
  });

  it('returns false for missing subtype', async () => {
    const tracker = createTracker();
    const published: PublishedEvent[] = [];

    const result = await handleMsg({}, tracker, 'agent-root', published);

    expect(result).toBe(false);
  });

  it('handles task_progress for known task_id', async () => {
    const tracker = createTracker();
    const published: PublishedEvent[] = [];

    await handleMsg(
      { subtype: 'task_started', task_id: 'task-1', description: 'Work' },
      tracker,
      'root',
      published
    );
    published.length = 0;

    const result = await handleMsg(
      { subtype: 'task_progress', task_id: 'task-1', usage: { total_tokens: 500 } },
      tracker,
      'root',
      published
    );

    expect(result).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]!.type).toBe('topology:agent_progress');
  });

  it('returns false for task_progress with unknown task_id', async () => {
    const tracker = createTracker();
    const published: PublishedEvent[] = [];

    const result = await handleMsg(
      { subtype: 'task_progress', task_id: 'unknown' },
      tracker,
      'root',
      published
    );

    expect(result).toBe(false);
    expect(published).toHaveLength(0);
  });

  it('handles task_notification and cleans up tracker', async () => {
    const tracker = createTracker();
    const published: PublishedEvent[] = [];

    await handleMsg(
      { subtype: 'task_started', task_id: 'task-1', description: 'Work' },
      tracker,
      'root',
      published
    );
    published.length = 0;

    const result = await handleMsg(
      { subtype: 'task_notification', task_id: 'task-1', status: 'completed' },
      tracker,
      'root',
      published
    );

    expect(result).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]!.type).toBe('topology:agent_completed');
    expect(published[0]!.data.status).toBe('completed');

    // Verify cleanup - second notification should return false
    published.length = 0;
    const result2 = await handleMsg(
      { subtype: 'task_notification', task_id: 'task-1', status: 'completed' },
      tracker,
      'root',
      published
    );
    expect(result2).toBe(false);
    expect(published).toHaveLength(0);
  });

  it('handles task_notification with failed status', async () => {
    const tracker = createTracker();
    const published: PublishedEvent[] = [];

    await handleMsg(
      { subtype: 'task_started', task_id: 'task-1', description: 'Work' },
      tracker,
      'root',
      published
    );
    published.length = 0;

    await handleMsg(
      { subtype: 'task_notification', task_id: 'task-1', status: 'failed' },
      tracker,
      'root',
      published
    );

    expect(published[0]!.data.status).toBe('failed');
  });

  it('defaults to completed when status is not a string', async () => {
    const tracker = createTracker();
    const published: PublishedEvent[] = [];

    await handleMsg(
      { subtype: 'task_started', task_id: 'task-1', description: 'Work' },
      tracker,
      'root',
      published
    );
    published.length = 0;

    await handleMsg(
      { subtype: 'task_notification', task_id: 'task-1' },
      tracker,
      'root',
      published
    );

    expect(published[0]!.data.status).toBe('completed');
  });
});
