import { createId } from '@paralleldrive/cuid2';
import { vi } from 'vitest';
import type {
  ContainerAgentCancelledEvent,
  ContainerAgentCompleteEvent,
  ContainerAgentErrorEvent,
  ContainerAgentFileChangedEvent,
  ContainerAgentMessageEvent,
  ContainerAgentPlanReadyEvent,
  ContainerAgentStartedEvent,
  ContainerAgentStatusEvent,
  ContainerAgentTaskUpdateFailedEvent,
  ContainerAgentTokenEvent,
  ContainerAgentToolResultEvent,
  ContainerAgentToolStartEvent,
  ContainerAgentTurnEvent,
  ContainerAgentWorktreeEvent,
  DurableStreamsServer,
  StreamEvent,
  StreamEventType,
} from '../../src/services/durable-streams.service';

// ============================================
// Type Definitions
// ============================================

/**
 * Agent event types from session service
 */
type AgentEventType =
  | 'agent:started'
  | 'agent:planning'
  | 'agent:plan_ready'
  | 'agent:turn'
  | 'agent:turn_limit'
  | 'agent:completed'
  | 'agent:error'
  | 'agent:warning';

/**
 * Container agent event types
 */
type ContainerEventType =
  | 'container-agent:status'
  | 'container-agent:started'
  | 'container-agent:token'
  | 'container-agent:turn'
  | 'container-agent:tool:start'
  | 'container-agent:tool:result'
  | 'container-agent:message'
  | 'container-agent:complete'
  | 'container-agent:error'
  | 'container-agent:cancelled'
  | 'container-agent:plan_ready'
  | 'container-agent:task-update-failed'
  | 'container-agent:worktree'
  | 'container-agent:file_changed';

/**
 * Agent event data types
 */
interface AgentStartedData {
  model: string;
  maxTurns: number;
  taskId?: string;
  sessionId?: string;
}

interface AgentPlanningData {
  model: string;
  maxTurns: number;
  taskId?: string;
  sessionId?: string;
}

interface AgentPlanReadyData {
  plan: string;
  sdkSessionId: string;
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
}

interface AgentTurnData {
  turn: number;
  maxTurns: number;
  remaining: number;
}

interface AgentTurnLimitData {
  maxTurns: number;
}

interface AgentCompletedData {
  status: 'completed' | 'turn_limit' | 'cancelled';
  turnCount: number;
  result?: string;
}

interface AgentErrorData {
  error: string;
  code?: string;
  turnCount?: number;
}

interface AgentWarningData {
  message: string;
  code?: string;
}

/**
 * Mock event collector for testing event publishing
 */
export interface MockEventCollector {
  events: StreamEvent[];
  handler: (event: StreamEvent) => void;
  waitFor: (type: StreamEventType, timeout?: number) => Promise<StreamEvent>;
  clear: () => void;
}

/**
 * Mock SSE response for testing SSE streaming
 */
export interface MockSSEResponse {
  write: ReturnType<typeof vi.fn>;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  writtenEvents: Array<{ type: string; data: unknown }>;
}

// ============================================
// DurableStreamsServer Mock (Functional)
// ============================================

/**
 * Creates a functional in-memory implementation of DurableStreamsServer.
 * Tracks all published events with offset-based replay support.
 *
 * @returns Functional mock server with Map storage
 *
 * @example
 * ```ts
 * const server = createMockDurableStreamsServer();
 * await server.createStream('stream-1', {});
 * await server.publish('stream-1', 'agent:started', { model: 'claude-sonnet-4' });
 *
 * for await (const event of server.subscribe('stream-1')) {
 *   console.log(event.type, event.offset);
 * }
 * ```
 */
export function createMockDurableStreamsServer(): DurableStreamsServer & {
  getEvents: (id: string) => Array<{ type: string; data: unknown; offset: number }>;
} {
  const streams = new Map<string, Array<{ type: string; data: unknown; offset: number }>>();

  return {
    createStream: async (id: string) => {
      streams.set(id, []);
    },

    publish: async (id: string, type: string, data: unknown) => {
      const events = streams.get(id);
      if (!events) {
        throw new Error(`Stream '${id}' does not exist`);
      }

      const offset = events.length;
      events.push({ type, data, offset });
      return offset;
    },

    subscribe: async function* (id: string) {
      const events = streams.get(id);
      if (!events) {
        throw new Error(`Stream '${id}' does not exist`);
      }

      for (const event of events) {
        yield event;
      }
    },

    deleteStream: async (id: string) => {
      return streams.delete(id);
    },

    getEvents: (id: string) => {
      return streams.get(id) ?? [];
    },
  };
}

// ============================================
// DurableStreamsService Mock (Spy-based)
// ============================================

/**
 * Creates a mock DurableStreamsService with vi.fn() spies for all methods.
 * Defaults: publish returns incrementing offset, subscribe yields empty.
 *
 * @returns Mock service with configurable spy behavior
 *
 * @example
 * ```ts
 * const service = createMockDurableStreamsService();
 * service.publish.mockResolvedValue(5);
 *
 * await service.publish('stream-1', 'agent:started', { model: 'claude' });
 * expect(service.publish).toHaveBeenCalledWith('stream-1', 'agent:started', { model: 'claude' });
 * ```
 */
export function createMockDurableStreamsService() {
  let nextOffset = 0;

  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockImplementation(async () => nextOffset++),
    subscribe: vi.fn().mockReturnValue(
      (async function* () {
        // Empty by default
      })()
    ),
    deleteStream: vi.fn().mockResolvedValue(true),
    publishPlanStarted: vi.fn().mockResolvedValue(undefined),
    publishPlanTurn: vi.fn().mockResolvedValue(undefined),
    publishPlanToken: vi.fn().mockResolvedValue(undefined),
    publishPlanInteraction: vi.fn().mockResolvedValue(undefined),
    publishPlanCompleted: vi.fn().mockResolvedValue(undefined),
    publishPlanError: vi.fn().mockResolvedValue(undefined),
    publishPlanCancelled: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationStarted: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationMessage: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationToken: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationSuggestion: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationQuestions: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationCompleted: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationCancelled: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationError: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationProcessing: vi.fn().mockResolvedValue(undefined),
    publishSessionEvent: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================
// Event Collector
// ============================================

/**
 * Creates an event collector for capturing and asserting on published events.
 * Provides a handler to attach to subscribers and utilities for testing.
 *
 * @returns Event collector with waitFor promise support
 *
 * @example
 * ```ts
 * const collector = createMockEventCollector();
 * service.addSubscriber('stream-1', collector.handler);
 *
 * await service.publish('stream-1', 'agent:started', { model: 'claude' });
 *
 * const event = await collector.waitFor('agent:started', 1000);
 * expect(event.data).toMatchObject({ model: 'claude' });
 * expect(collector.events).toHaveLength(1);
 * ```
 */
export function createMockEventCollector(): MockEventCollector {
  const events: StreamEvent[] = [];
  const waiters = new Map<
    StreamEventType,
    Array<{ resolve: (event: StreamEvent) => void; reject: (error: Error) => void }>
  >();

  const handler = (event: StreamEvent) => {
    events.push(event);

    // Notify any waiting promises for this event type
    const typeWaiters = waiters.get(event.type);
    if (typeWaiters && typeWaiters.length > 0) {
      const waiter = typeWaiters.shift();
      waiter?.resolve(event);
    }
  };

  const waitFor = (type: StreamEventType, timeout = 5000): Promise<StreamEvent> => {
    // Check if event already collected
    const existing = events.find((e) => e.type === type);
    if (existing) {
      return Promise.resolve(existing);
    }

    // Wait for future event
    return new Promise<StreamEvent>((resolve, reject) => {
      const typeWaiters = waiters.get(type) ?? [];
      typeWaiters.push({ resolve, reject });
      waiters.set(type, typeWaiters);

      setTimeout(() => {
        const index = typeWaiters.findIndex((w) => w.resolve === resolve);
        if (index !== -1) {
          typeWaiters.splice(index, 1);
          reject(new Error(`Timeout waiting for event type: ${type}`));
        }
      }, timeout);
    });
  };

  const clear = () => {
    events.length = 0;
    waiters.clear();
  };

  return {
    events,
    handler,
    waitFor,
    clear,
  };
}

// ============================================
// SSE Response Mock
// ============================================

/**
 * Creates a mock SSE response object for testing Server-Sent Events.
 * Parses written SSE format into structured events.
 *
 * @returns Mock response with write spies and parsed events
 *
 * @example
 * ```ts
 * const res = createMockSSEResponse();
 *
 * res.write('event: agent:started\n');
 * res.write('data: {"model":"claude-sonnet-4"}\n\n');
 *
 * expect(res.writtenEvents).toHaveLength(1);
 * expect(res.writtenEvents[0].type).toBe('agent:started');
 * expect(res.writtenEvents[0].data).toEqual({ model: 'claude-sonnet-4' });
 * ```
 */
export function createMockSSEResponse(): MockSSEResponse {
  const writtenEvents: Array<{ type: string; data: unknown }> = [];
  let currentEvent: { type?: string; data?: string } = {};

  const write = vi.fn((chunk: string) => {
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent.type = line.slice('event: '.length).trim();
      } else if (line.startsWith('data: ')) {
        currentEvent.data = line.slice('data: '.length).trim();
      } else if (line === '' && currentEvent.type && currentEvent.data) {
        // End of event
        try {
          const data = JSON.parse(currentEvent.data);
          writtenEvents.push({ type: currentEvent.type, data });
        } catch {
          // Invalid JSON, skip
        }
        currentEvent = {};
      }
    }

    return true;
  });

  return {
    write,
    writeHead: vi.fn(),
    end: vi.fn(),
    writtenEvents,
  };
}

// ============================================
// Agent Event Factory
// ============================================

/**
 * Creates typed agent events with sensible defaults per type.
 * Ensures type safety and reduces test boilerplate.
 *
 * @param type Agent event type
 * @param data Optional partial data to override defaults
 * @returns Typed event data
 *
 * @example
 * ```ts
 * const event = createAgentEvent('agent:started');
 * // { model: 'claude-sonnet-4-6', maxTurns: 50 }
 *
 * const custom = createAgentEvent('agent:turn', { turn: 5, remaining: 45 });
 * // { turn: 5, maxTurns: 50, remaining: 45 }
 * ```
 */
export function createAgentEvent(
  type: 'agent:started',
  data?: Partial<AgentStartedData>
): AgentStartedData;
export function createAgentEvent(
  type: 'agent:planning',
  data?: Partial<AgentPlanningData>
): AgentPlanningData;
export function createAgentEvent(
  type: 'agent:plan_ready',
  data?: Partial<AgentPlanReadyData>
): AgentPlanReadyData;
export function createAgentEvent(type: 'agent:turn', data?: Partial<AgentTurnData>): AgentTurnData;
export function createAgentEvent(
  type: 'agent:turn_limit',
  data?: Partial<AgentTurnLimitData>
): AgentTurnLimitData;
export function createAgentEvent(
  type: 'agent:completed',
  data?: Partial<AgentCompletedData>
): AgentCompletedData;
export function createAgentEvent(
  type: 'agent:error',
  data?: Partial<AgentErrorData>
): AgentErrorData;
export function createAgentEvent(
  type: 'agent:warning',
  data?: Partial<AgentWarningData>
): AgentWarningData;
export function createAgentEvent(type: AgentEventType, data?: unknown): unknown {
  switch (type) {
    case 'agent:started':
    case 'agent:planning': {
      const defaults: AgentStartedData = {
        model: 'claude-sonnet-4-6',
        maxTurns: 50,
      };
      return { ...defaults, ...(data as Partial<AgentStartedData>) };
    }

    case 'agent:plan_ready': {
      const defaults: AgentPlanReadyData = {
        plan: '# Implementation Plan\n\n1. Read files\n2. Make changes\n3. Test',
        sdkSessionId: createId(),
      };
      return { ...defaults, ...(data as Partial<AgentPlanReadyData>) };
    }

    case 'agent:turn': {
      const defaults: AgentTurnData = {
        turn: 1,
        maxTurns: 50,
        remaining: 49,
      };
      return { ...defaults, ...(data as Partial<AgentTurnData>) };
    }

    case 'agent:turn_limit': {
      const defaults: AgentTurnLimitData = {
        maxTurns: 50,
      };
      return { ...defaults, ...(data as Partial<AgentTurnLimitData>) };
    }

    case 'agent:completed': {
      const defaults: AgentCompletedData = {
        status: 'completed',
        turnCount: 15,
      };
      return { ...defaults, ...(data as Partial<AgentCompletedData>) };
    }

    case 'agent:error': {
      const defaults: AgentErrorData = {
        error: 'An error occurred',
        turnCount: 5,
      };
      return { ...defaults, ...(data as Partial<AgentErrorData>) };
    }

    case 'agent:warning': {
      const defaults: AgentWarningData = {
        message: 'A warning occurred',
      };
      return { ...defaults, ...(data as Partial<AgentWarningData>) };
    }

    default:
      throw new Error(`Unknown agent event type: ${type}`);
  }
}

// ============================================
// Container Agent Event Factory
// ============================================

/**
 * Creates typed container agent events with sensible defaults per type.
 * Matches the event format emitted by agent-runner inside Docker containers.
 *
 * @param type Container agent event type
 * @param data Optional partial data to override defaults
 * @returns Typed event data
 *
 * @example
 * ```ts
 * const event = createContainerAgentEvent('container-agent:started', {
 *   taskId: 'task-1',
 *   sessionId: 'session-1'
 * });
 * // { taskId: 'task-1', sessionId: 'session-1', model: 'claude-sonnet-4-6', maxTurns: 50 }
 * ```
 */
export function createContainerAgentEvent(
  type: 'container-agent:status',
  data?: Partial<ContainerAgentStatusEvent>
): ContainerAgentStatusEvent;
export function createContainerAgentEvent(
  type: 'container-agent:started',
  data?: Partial<ContainerAgentStartedEvent>
): ContainerAgentStartedEvent;
export function createContainerAgentEvent(
  type: 'container-agent:token',
  data?: Partial<ContainerAgentTokenEvent>
): ContainerAgentTokenEvent;
export function createContainerAgentEvent(
  type: 'container-agent:turn',
  data?: Partial<ContainerAgentTurnEvent>
): ContainerAgentTurnEvent;
export function createContainerAgentEvent(
  type: 'container-agent:tool:start',
  data?: Partial<ContainerAgentToolStartEvent>
): ContainerAgentToolStartEvent;
export function createContainerAgentEvent(
  type: 'container-agent:tool:result',
  data?: Partial<ContainerAgentToolResultEvent>
): ContainerAgentToolResultEvent;
export function createContainerAgentEvent(
  type: 'container-agent:message',
  data?: Partial<ContainerAgentMessageEvent>
): ContainerAgentMessageEvent;
export function createContainerAgentEvent(
  type: 'container-agent:complete',
  data?: Partial<ContainerAgentCompleteEvent>
): ContainerAgentCompleteEvent;
export function createContainerAgentEvent(
  type: 'container-agent:error',
  data?: Partial<ContainerAgentErrorEvent>
): ContainerAgentErrorEvent;
export function createContainerAgentEvent(
  type: 'container-agent:cancelled',
  data?: Partial<ContainerAgentCancelledEvent>
): ContainerAgentCancelledEvent;
export function createContainerAgentEvent(
  type: 'container-agent:plan_ready',
  data?: Partial<ContainerAgentPlanReadyEvent>
): ContainerAgentPlanReadyEvent;
export function createContainerAgentEvent(
  type: 'container-agent:task-update-failed',
  data?: Partial<ContainerAgentTaskUpdateFailedEvent>
): ContainerAgentTaskUpdateFailedEvent;
export function createContainerAgentEvent(
  type: 'container-agent:worktree',
  data?: Partial<ContainerAgentWorktreeEvent>
): ContainerAgentWorktreeEvent;
export function createContainerAgentEvent(
  type: 'container-agent:file_changed',
  data?: Partial<ContainerAgentFileChangedEvent>
): ContainerAgentFileChangedEvent;
export function createContainerAgentEvent(type: ContainerEventType, data?: unknown): unknown {
  const taskId = createId();
  const sessionId = createId();

  switch (type) {
    case 'container-agent:status': {
      const defaults: ContainerAgentStatusEvent = {
        taskId,
        sessionId,
        stage: 'initializing',
        message: 'Initializing container agent',
      };
      return { ...defaults, ...(data as Partial<ContainerAgentStatusEvent>) };
    }

    case 'container-agent:started': {
      const defaults: ContainerAgentStartedEvent = {
        taskId,
        sessionId,
        model: 'claude-sonnet-4-6',
        maxTurns: 50,
      };
      return { ...defaults, ...(data as Partial<ContainerAgentStartedEvent>) };
    }

    case 'container-agent:token': {
      const defaults: ContainerAgentTokenEvent = {
        taskId,
        sessionId,
        delta: 'Hello',
        accumulated: 'Hello',
      };
      return { ...defaults, ...(data as Partial<ContainerAgentTokenEvent>) };
    }

    case 'container-agent:turn': {
      const defaults: ContainerAgentTurnEvent = {
        taskId,
        sessionId,
        turn: 1,
        maxTurns: 50,
        remaining: 49,
      };
      return { ...defaults, ...(data as Partial<ContainerAgentTurnEvent>) };
    }

    case 'container-agent:tool:start': {
      const defaults: ContainerAgentToolStartEvent = {
        taskId,
        sessionId,
        toolName: 'Read',
        toolId: createId(),
        input: { file_path: '/path/to/file.ts' },
      };
      return { ...defaults, ...(data as Partial<ContainerAgentToolStartEvent>) };
    }

    case 'container-agent:tool:result': {
      const defaults: ContainerAgentToolResultEvent = {
        taskId,
        sessionId,
        toolName: 'Read',
        toolId: createId(),
        result: 'File contents here',
        isError: false,
        durationMs: 150,
      };
      return { ...defaults, ...(data as Partial<ContainerAgentToolResultEvent>) };
    }

    case 'container-agent:message': {
      const defaults: ContainerAgentMessageEvent = {
        taskId,
        sessionId,
        role: 'assistant',
        content: 'I will help you with this task.',
      };
      return { ...defaults, ...(data as Partial<ContainerAgentMessageEvent>) };
    }

    case 'container-agent:complete': {
      const defaults: ContainerAgentCompleteEvent = {
        taskId,
        sessionId,
        status: 'completed',
        turnCount: 15,
        result: 'Task completed successfully',
      };
      return { ...defaults, ...(data as Partial<ContainerAgentCompleteEvent>) };
    }

    case 'container-agent:error': {
      const defaults: ContainerAgentErrorEvent = {
        taskId,
        sessionId,
        error: 'An error occurred during execution',
        turnCount: 5,
      };
      return { ...defaults, ...(data as Partial<ContainerAgentErrorEvent>) };
    }

    case 'container-agent:cancelled': {
      const defaults: ContainerAgentCancelledEvent = {
        taskId,
        sessionId,
        turnCount: 10,
      };
      return { ...defaults, ...(data as Partial<ContainerAgentCancelledEvent>) };
    }

    case 'container-agent:plan_ready': {
      const defaults: ContainerAgentPlanReadyEvent = {
        taskId,
        sessionId,
        plan: '# Implementation Plan\n\n1. Read files\n2. Make changes\n3. Test',
        turnCount: 3,
        sdkSessionId: createId(),
      };
      return { ...defaults, ...(data as Partial<ContainerAgentPlanReadyEvent>) };
    }

    case 'container-agent:task-update-failed': {
      const defaults: ContainerAgentTaskUpdateFailedEvent = {
        taskId,
        sessionId,
        error: 'Failed to update task status',
        attemptedStatus: 'waiting_approval',
      };
      return { ...defaults, ...(data as Partial<ContainerAgentTaskUpdateFailedEvent>) };
    }

    case 'container-agent:worktree': {
      const defaults: ContainerAgentWorktreeEvent = {
        taskId,
        sessionId,
        worktreeId: createId(),
        branch: 'agent/task/123',
        containerPath: '/workspace',
      };
      return { ...defaults, ...(data as Partial<ContainerAgentWorktreeEvent>) };
    }

    case 'container-agent:file_changed': {
      const defaults: ContainerAgentFileChangedEvent = {
        taskId,
        sessionId,
        path: 'src/example.ts',
        action: 'modify',
        toolName: 'Edit',
        additions: 5,
        deletions: 2,
      };
      return { ...defaults, ...(data as Partial<ContainerAgentFileChangedEvent>) };
    }

    default:
      throw new Error(`Unknown container agent event type: ${type}`);
  }
}
