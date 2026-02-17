// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createAgentEvent,
  createContainerAgentEvent,
  createMockDurableStreamsServer,
  createMockDurableStreamsService,
  createMockEventCollector,
  createMockSSEResponse,
} from '../mock-streams';

describe('mock-streams', () => {
  describe('createMockDurableStreamsServer', () => {
    it('creates a functional in-memory stream server', async () => {
      const server = createMockDurableStreamsServer();

      await server.createStream('stream-1', {});
      const offset = await server.publish('stream-1', 'agent:started', {
        model: 'claude-sonnet-4',
        maxTurns: 50,
      });

      expect(offset).toBe(0);

      const events = server.getEvents('stream-1');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('agent:started');
      expect(events[0].offset).toBe(0);
    });

    it('supports offset-based event replay', async () => {
      const server = createMockDurableStreamsServer();

      await server.createStream('stream-1', {});
      await server.publish('stream-1', 'agent:started', { model: 'claude' });
      await server.publish('stream-1', 'agent:turn', { turn: 1 });
      await server.publish('stream-1', 'agent:completed', { status: 'completed' });

      const events: unknown[] = [];
      for await (const event of server.subscribe('stream-1')) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ type: 'agent:started', offset: 0 });
      expect(events[1]).toMatchObject({ type: 'agent:turn', offset: 1 });
      expect(events[2]).toMatchObject({ type: 'agent:completed', offset: 2 });
    });

    it('throws when publishing to non-existent stream', async () => {
      const server = createMockDurableStreamsServer();

      await expect(server.publish('stream-1', 'agent:started', {})).rejects.toThrow(
        "Stream 'stream-1' does not exist"
      );
    });

    it('deletes streams', async () => {
      const server = createMockDurableStreamsServer();

      await server.createStream('stream-1', {});
      await server.publish('stream-1', 'agent:started', {});

      const deleted = await server.deleteStream('stream-1');
      expect(deleted).toBe(true);

      expect(server.getEvents('stream-1')).toEqual([]);
    });
  });

  describe('createMockDurableStreamsService', () => {
    it('creates a mock service with vi.fn() spies', () => {
      const service = createMockDurableStreamsService();

      expect(service.createStream).toBeDefined();
      expect(service.publish).toBeDefined();
      expect(service.subscribe).toBeDefined();
    });

    it('returns incrementing offsets by default', async () => {
      const service = createMockDurableStreamsService();

      const offset1 = await service.publish('stream-1', 'agent:started', {});
      const offset2 = await service.publish('stream-1', 'agent:turn', {});
      const offset3 = await service.publish('stream-1', 'agent:completed', {});

      expect(offset1).toBe(0);
      expect(offset2).toBe(1);
      expect(offset3).toBe(2);
    });
  });

  describe('createMockEventCollector', () => {
    it('collects events via handler', () => {
      const collector = createMockEventCollector();

      collector.handler({
        id: 'event-1',
        type: 'agent:started',
        timestamp: Date.now(),
        data: { model: 'claude' },
      });

      collector.handler({
        id: 'event-2',
        type: 'agent:turn',
        timestamp: Date.now(),
        data: { turn: 1 },
      });

      expect(collector.events).toHaveLength(2);
      expect(collector.events[0].type).toBe('agent:started');
      expect(collector.events[1].type).toBe('agent:turn');
    });

    it('waits for specific event types', async () => {
      const collector = createMockEventCollector();

      setTimeout(() => {
        collector.handler({
          id: 'event-1',
          type: 'agent:completed',
          timestamp: Date.now(),
          data: { status: 'completed' },
        });
      }, 50);

      const event = await collector.waitFor('agent:completed', 200);
      expect(event.type).toBe('agent:completed');
    });

    it('returns existing event if already collected', async () => {
      const collector = createMockEventCollector();

      collector.handler({
        id: 'event-1',
        type: 'agent:started',
        timestamp: Date.now(),
        data: {},
      });

      const event = await collector.waitFor('agent:started', 100);
      expect(event.id).toBe('event-1');
    });

    it('times out if event not received', async () => {
      const collector = createMockEventCollector();

      await expect(collector.waitFor('agent:completed', 100)).rejects.toThrow(
        'Timeout waiting for event type: agent:completed'
      );
    });

    it('clears collected events', () => {
      const collector = createMockEventCollector();

      collector.handler({
        id: 'event-1',
        type: 'agent:started',
        timestamp: Date.now(),
        data: {},
      });

      expect(collector.events).toHaveLength(1);

      collector.clear();

      expect(collector.events).toHaveLength(0);
    });
  });

  describe('createMockSSEResponse', () => {
    it('parses SSE format into structured events', () => {
      const res = createMockSSEResponse();

      res.write('event: agent:started\n');
      res.write('data: {"model":"claude-sonnet-4","maxTurns":50}\n\n');

      expect(res.writtenEvents).toHaveLength(1);
      expect(res.writtenEvents[0]).toEqual({
        type: 'agent:started',
        data: { model: 'claude-sonnet-4', maxTurns: 50 },
      });
    });

    it('handles multiple events', () => {
      const res = createMockSSEResponse();

      res.write('event: agent:started\n');
      res.write('data: {"model":"claude"}\n\n');
      res.write('event: agent:turn\n');
      res.write('data: {"turn":1}\n\n');

      expect(res.writtenEvents).toHaveLength(2);
      expect(res.writtenEvents[0].type).toBe('agent:started');
      expect(res.writtenEvents[1].type).toBe('agent:turn');
    });

    it('handles multi-line writes', () => {
      const res = createMockSSEResponse();

      res.write('event: agent:started\ndata: {"model":"claude"}\n\n');

      expect(res.writtenEvents).toHaveLength(1);
      expect(res.writtenEvents[0].type).toBe('agent:started');
    });

    it('ignores invalid JSON', () => {
      const res = createMockSSEResponse();

      res.write('event: agent:started\n');
      res.write('data: {invalid json}\n\n');

      expect(res.writtenEvents).toHaveLength(0);
    });
  });

  describe('createAgentEvent', () => {
    it('creates agent:started with defaults', () => {
      const event = createAgentEvent('agent:started');

      expect(event).toEqual({
        model: 'claude-sonnet-4-6',
        maxTurns: 50,
      });
    });

    it('creates agent:started with overrides', () => {
      const event = createAgentEvent('agent:started', {
        model: 'claude-opus-4',
        maxTurns: 100,
        taskId: 'task-1',
      });

      expect(event).toEqual({
        model: 'claude-opus-4',
        maxTurns: 100,
        taskId: 'task-1',
      });
    });

    it('creates agent:plan_ready with defaults', () => {
      const event = createAgentEvent('agent:plan_ready');

      expect(event).toMatchObject({
        plan: expect.stringContaining('Implementation Plan'),
        sdkSessionId: expect.any(String),
      });
    });

    it('creates agent:turn with defaults', () => {
      const event = createAgentEvent('agent:turn');

      expect(event).toEqual({
        turn: 1,
        maxTurns: 50,
        remaining: 49,
      });
    });

    it('creates agent:completed with defaults', () => {
      const event = createAgentEvent('agent:completed');

      expect(event).toEqual({
        status: 'completed',
        turnCount: 15,
      });
    });

    it('creates agent:error with defaults', () => {
      const event = createAgentEvent('agent:error');

      expect(event).toMatchObject({
        error: expect.any(String),
        turnCount: 5,
      });
    });
  });

  describe('createContainerAgentEvent', () => {
    it('creates container-agent:started with defaults', () => {
      const event = createContainerAgentEvent('container-agent:started');

      expect(event).toMatchObject({
        taskId: expect.any(String),
        sessionId: expect.any(String),
        model: 'claude-sonnet-4-6',
        maxTurns: 50,
      });
    });

    it('creates container-agent:status with defaults', () => {
      const event = createContainerAgentEvent('container-agent:status');

      expect(event).toMatchObject({
        taskId: expect.any(String),
        sessionId: expect.any(String),
        stage: 'initializing',
        message: expect.any(String),
      });
    });

    it('creates container-agent:tool:start with defaults', () => {
      const event = createContainerAgentEvent('container-agent:tool:start');

      expect(event).toMatchObject({
        taskId: expect.any(String),
        sessionId: expect.any(String),
        toolName: 'Read',
        toolId: expect.any(String),
        input: expect.any(Object),
      });
    });

    it('creates container-agent:complete with overrides', () => {
      const event = createContainerAgentEvent('container-agent:complete', {
        taskId: 'task-1',
        sessionId: 'session-1',
        status: 'turn_limit',
        turnCount: 50,
      });

      expect(event).toEqual({
        taskId: 'task-1',
        sessionId: 'session-1',
        status: 'turn_limit',
        turnCount: 50,
        result: 'Task completed successfully',
      });
    });

    it('creates container-agent:file_changed with defaults', () => {
      const event = createContainerAgentEvent('container-agent:file_changed');

      expect(event).toMatchObject({
        taskId: expect.any(String),
        sessionId: expect.any(String),
        path: expect.any(String),
        action: 'modify',
        toolName: 'Edit',
        additions: expect.any(Number),
        deletions: expect.any(Number),
      });
    });
  });
});
