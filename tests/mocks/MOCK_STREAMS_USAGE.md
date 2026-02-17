# Mock Streams Usage Guide

This guide demonstrates how to use the mock stream utilities for testing DurableStreams and SSE infrastructure.

## Overview

The `mock-streams.ts` file provides five main utilities:

1. **`createMockDurableStreamsServer()`** - Functional in-memory stream server
2. **`createMockDurableStreamsService()`** - Spy-based service mock
3. **`createMockEventCollector()`** - Event collection and assertion helper
4. **`createMockSSEResponse()`** - SSE response simulator
5. **`createAgentEvent()` / `createContainerAgentEvent()`** - Typed event factories

## Examples

### 1. Testing Event Publishing with Functional Server

```typescript
import { createMockDurableStreamsServer, DurableStreamsService } from '@/tests/mocks';

test('publishes events to stream', async () => {
  const server = createMockDurableStreamsServer();
  const service = new DurableStreamsService(server);

  await service.createStream('session-1', {});
  await service.publish('session-1', 'container-agent:started', {
    taskId: 'task-1',
    sessionId: 'session-1',
    model: 'claude-sonnet-4-6',
    maxTurns: 50,
  });

  const events = server.getEvents('session-1');
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe('container-agent:started');
});
```

### 2. Testing Event Subscription with Offset Replay

```typescript
test('replays events from offset', async () => {
  const server = createMockDurableStreamsServer();

  await server.createStream('session-1', {});
  await server.publish('session-1', 'agent:started', { model: 'claude' });
  await server.publish('session-1', 'agent:turn', { turn: 1 });
  await server.publish('session-1', 'agent:completed', { status: 'completed' });

  const events = [];
  for await (const event of server.subscribe('session-1')) {
    events.push(event);
  }

  expect(events).toHaveLength(3);
  expect(events[0].offset).toBe(0);
  expect(events[1].offset).toBe(1);
  expect(events[2].offset).toBe(2);
});
```

### 3. Testing with Event Collector (waitFor pattern)

```typescript
import { createMockEventCollector } from '@/tests/mocks';

test('waits for specific events', async () => {
  const collector = createMockEventCollector();
  const service = createDurableStreamsService();

  service.addSubscriber('session-1', collector.handler);

  // Trigger async event publishing
  someAsyncOperation();

  // Wait for the event with timeout
  const event = await collector.waitFor('container-agent:complete', 5000);

  expect(event.data).toMatchObject({
    status: 'completed',
    turnCount: expect.any(Number),
  });

  // Check all collected events
  expect(collector.events).toHaveLength(3);
});
```

### 4. Testing SSE Streaming Endpoints

```typescript
import { createMockSSEResponse } from '@/tests/mocks';

test('streams events via SSE', async () => {
  const res = createMockSSEResponse();

  // Simulate SSE endpoint writing events
  res.write('event: agent:started\\n');
  res.write('data: {"model":"claude-sonnet-4","maxTurns":50}\\n\\n');
  res.write('event: agent:turn\\n');
  res.write('data: {"turn":1,"remaining":49}\\n\\n');

  expect(res.writtenEvents).toHaveLength(2);
  expect(res.writtenEvents[0]).toEqual({
    type: 'agent:started',
    data: { model: 'claude-sonnet-4', maxTurns: 50 },
  });
  expect(res.writtenEvents[1].type).toBe('agent:turn');
});
```

### 5. Using Event Factories for Type Safety

```typescript
import { createAgentEvent, createContainerAgentEvent } from '@/tests/mocks';

test('creates typed events with defaults', () => {
  // Agent events
  const started = createAgentEvent('agent:started');
  // { model: 'claude-sonnet-4-6', maxTurns: 50 }

  const planReady = createAgentEvent('agent:plan_ready', {
    plan: 'Custom plan',
  });
  // { plan: 'Custom plan', sdkSessionId: '...' }

  // Container agent events
  const containerStarted = createContainerAgentEvent('container-agent:started', {
    taskId: 'task-1',
    sessionId: 'session-1',
  });
  // { taskId: 'task-1', sessionId: 'session-1', model: 'claude-sonnet-4-6', maxTurns: 50 }

  const fileChanged = createContainerAgentEvent('container-agent:file_changed', {
    path: 'src/updated.ts',
    action: 'modify',
  });
  // { path: 'src/updated.ts', action: 'modify', toolName: 'Edit', additions: 5, deletions: 2, ... }
});
```

### 6. Testing Container Agent Events Flow

```typescript
import {
  createMockEventCollector,
  createContainerAgentEvent,
  createMockDurableStreamsService,
} from '@/tests/mocks';

test('handles container agent lifecycle', async () => {
  const collector = createMockEventCollector();
  const service = createMockDurableStreamsService();

  service.addSubscriber('session-1', collector.handler);

  // Simulate container agent execution
  await service.publish(
    'session-1',
    'container-agent:status',
    createContainerAgentEvent('container-agent:status', {
      stage: 'initializing',
    })
  );

  await service.publish(
    'session-1',
    'container-agent:started',
    createContainerAgentEvent('container-agent:started', {
      taskId: 'task-1',
      sessionId: 'session-1',
    })
  );

  const statusEvent = await collector.waitFor('container-agent:status');
  expect(statusEvent.data.stage).toBe('initializing');

  const startedEvent = await collector.waitFor('container-agent:started');
  expect(startedEvent.data.model).toBe('claude-sonnet-4-6');
});
```

### 7. Testing with Spy-based Mock Service

```typescript
import { createMockDurableStreamsService } from '@/tests/mocks';

test('tracks publish calls', async () => {
  const service = createMockDurableStreamsService();

  // Override default behavior
  service.publish.mockResolvedValueOnce(42);

  const offset = await service.publish('stream-1', 'agent:started', {
    model: 'claude',
  });

  expect(offset).toBe(42);
  expect(service.publish).toHaveBeenCalledWith('stream-1', 'agent:started', {
    model: 'claude',
  });
});
```

## Common Patterns

### Pattern: Test Event Publishing + Subscription Together

```typescript
test('publishes and subscribes to events', async () => {
  const server = createMockDurableStreamsServer();
  const collector = createMockEventCollector();
  const service = new DurableStreamsService(server);

  await service.createStream('session-1', {});
  service.addSubscriber('session-1', collector.handler);

  await service.publish('session-1', 'agent:started', { model: 'claude' });

  const event = await collector.waitFor('agent:started', 1000);
  expect(event.data.model).toBe('claude');
});
```

### Pattern: Test Container Bridge Events

```typescript
test('container bridge emits events', async () => {
  const collector = createMockEventCollector();
  const streams = createDurableStreamsService();

  streams.addSubscriber('session-1', collector.handler);

  // Simulate container agent emitting events
  await emitContainerEvent('session-1', 'status', { stage: 'creating_sandbox' });
  await emitContainerEvent('session-1', 'started', { model: 'claude' });

  const statusEvent = await collector.waitFor('container-agent:status');
  expect(statusEvent.data.stage).toBe('creating_sandbox');
});
```

### Pattern: Clear and Reset Between Tests

```typescript
beforeEach(() => {
  // Reset all vitest mocks
  vi.clearAllMocks();
});

test('isolates event collection', () => {
  const collector = createMockEventCollector();

  collector.handler({ id: '1', type: 'agent:started', timestamp: Date.now(), data: {} });
  expect(collector.events).toHaveLength(1);

  // Clear for next test phase
  collector.clear();
  expect(collector.events).toHaveLength(0);
});
```

## Tips

1. **Use `createMockDurableStreamsServer()` for integration tests** where you need a functional stream with replay.
2. **Use `createMockDurableStreamsService()` for unit tests** where you just need to verify calls.
3. **Use `createMockEventCollector()` for async event testing** with the `waitFor` helper.
4. **Use event factories** to reduce boilerplate and ensure type safety.
5. **Always set timeouts on `waitFor`** to prevent hanging tests.
6. **Check `collector.events` array** for asserting on multiple events or order.

## See Also

- `/Users/simon.lynch/git/claudorc/tests/mocks/__tests__/mock-streams.test.ts` - Full test suite with examples
- `/Users/simon.lynch/git/claudorc/src/services/durable-streams.service.ts` - Real implementation
- `/Users/simon.lynch/git/claudorc/src/lib/agents/container-bridge.ts` - Container agent event bridge
