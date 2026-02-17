import { createId } from '@paralleldrive/cuid2';
import { desc, eq } from 'drizzle-orm';
import { sessionEvents } from '../db/schema';
import type { AgentFileChangedData } from '../types/agent-events.js';
import type { Database } from '../types/database.js';
import type { SessionEvent, SessionEventType } from './session.service.js';

/**
 * Durable Streams server interface for real-time event streaming
 */
export interface DurableStreamsServer {
  createStream: (id: string, schema: unknown) => Promise<void>;
  publish: (id: string, type: string, data: unknown) => Promise<number>;
  subscribe: (id: string) => AsyncIterable<{ type: string; data: unknown }>;
  deleteStream?: (id: string) => Promise<boolean>;
}

// ============================================
// Event Data Interfaces
// ============================================

/**
 * Plan mode events
 */
export interface PlanStartedEvent {
  sessionId: string;
  taskId: string;
  projectId: string;
}

export interface PlanTurnEvent {
  sessionId: string;
  turnId: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface PlanTokenEvent {
  sessionId: string;
  delta: string;
  accumulated: string;
}

export interface PlanInteractionEvent {
  sessionId: string;
  interactionId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export interface PlanCompletedEvent {
  sessionId: string;
  issueUrl?: string;
  issueNumber?: number;
}

export interface PlanErrorEvent {
  sessionId: string;
  error: string;
  code?: string;
}

/**
 * Sandbox events
 */
export interface SandboxCreatingEvent {
  sandboxId: string;
  projectId: string;
  image: string;
}

export interface SandboxReadyEvent {
  sandboxId: string;
  projectId: string;
  containerId: string;
}

export interface SandboxIdleEvent {
  sandboxId: string;
  projectId: string;
  idleSince: number;
  timeoutMinutes: number;
}

export interface SandboxStoppingEvent {
  sandboxId: string;
  projectId: string;
  reason: 'idle_timeout' | 'manual' | 'error';
}

export interface SandboxStoppedEvent {
  sandboxId: string;
  projectId: string;
}

export interface SandboxErrorEvent {
  sandboxId: string;
  projectId: string;
  error: string;
  code?: string;
}

export interface SandboxTmuxCreatedEvent {
  sandboxId: string;
  sessionName: string;
  taskId?: string;
}

export interface SandboxTmuxDestroyedEvent {
  sandboxId: string;
  sessionName: string;
}

/**
 * Container agent events - emitted from agent-runner inside Docker containers
 */
export interface ContainerAgentStartedEvent {
  taskId: string;
  sessionId: string;
  model: string;
  maxTurns: number;
  sandboxProvider?: string;
  sandboxContainerId?: string;
}

export interface ContainerAgentTokenEvent {
  taskId: string;
  sessionId: string;
  delta: string;
  accumulated: string;
}

export interface ContainerAgentTurnEvent {
  taskId: string;
  sessionId: string;
  turn: number;
  maxTurns: number;
  remaining: number;
}

export interface ContainerAgentToolStartEvent {
  taskId: string;
  sessionId: string;
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
}

export interface ContainerAgentToolResultEvent {
  taskId: string;
  sessionId: string;
  toolName: string;
  toolId: string;
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface ContainerAgentMessageEvent {
  taskId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ContainerAgentCompleteEvent {
  taskId: string;
  sessionId: string;
  status: 'completed' | 'turn_limit' | 'cancelled';
  turnCount: number;
  result?: string;
}

export interface ContainerAgentErrorEvent {
  taskId: string;
  sessionId: string;
  error: string;
  code?: string;
  turnCount: number;
}

export interface ContainerAgentCancelledEvent {
  taskId: string;
  sessionId: string;
  turnCount: number;
}

export interface ContainerAgentPlanReadyEvent {
  taskId: string;
  sessionId: string;
  plan: string;
  turnCount: number;
  sdkSessionId: string;
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  // TODO: Pending GA — swarm features
  // launchSwarm?: boolean;
  // teammateCount?: number;
}

export interface ContainerAgentTaskUpdateFailedEvent {
  taskId: string;
  sessionId: string;
  error: string;
  attemptedStatus: string;
}

export interface ContainerAgentStatusEvent {
  taskId: string;
  sessionId: string;
  stage:
    | 'initializing'
    | 'validating'
    | 'credentials'
    | 'creating_sandbox'
    | 'executing'
    | 'running';
  message: string;
}

export interface ContainerAgentFileChangedEvent extends AgentFileChangedData {
  taskId: string;
  sessionId: string;
}

/**
 * Task creation events
 */
export interface TaskCreationStartedEvent {
  sessionId: string;
  projectId: string;
}

export interface TaskCreationMessageEvent {
  sessionId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface TaskCreationTokenEvent {
  sessionId: string;
  delta: string;
  accumulated: string;
}

export interface TaskCreationSuggestionEvent {
  sessionId: string;
  suggestion: {
    title: string;
    description: string;
    labels: string[];
    priority: 'high' | 'medium' | 'low';
  };
}

export interface TaskCreationQuestionsEvent {
  sessionId: string;
  questions: {
    id: string;
    questions: Array<{
      header: string;
      question: string;
      options: Array<{ label: string; description?: string }>;
    }>;
    round: number;
    totalAsked: number;
    maxQuestions: number;
  };
}

export interface TaskCreationCompletedEvent {
  sessionId: string;
  taskId: string;
  suggestion: {
    title: string;
    description: string;
    labels: string[];
    priority: 'high' | 'medium' | 'low';
  };
}

export interface TaskCreationCancelledEvent {
  sessionId: string;
}

export interface TaskCreationErrorEvent {
  sessionId: string;
  error: string;
  code?: string;
}

export interface TaskCreationProcessingEvent {
  sessionId: string;
  message?: string;
}

export interface ContainerAgentWorktreeEvent {
  taskId: string;
  sessionId: string;
  worktreeId: string;
  branch: string;
  containerPath: string;
}

// ============================================
// Type-safe Event Map
// ============================================

/**
 * Maps event type strings to their corresponding data types.
 * This single source of truth enables type-safe publishing without
 * requiring individual helper methods for each event type.
 */
export interface StreamEventMap {
  // Plan events
  'plan:started': PlanStartedEvent;
  'plan:turn': PlanTurnEvent;
  'plan:token': PlanTokenEvent;
  'plan:interaction': PlanInteractionEvent;
  'plan:completed': PlanCompletedEvent;
  'plan:error': PlanErrorEvent;
  'plan:cancelled': { sessionId: string };

  // Sandbox events
  'sandbox:creating': SandboxCreatingEvent;
  'sandbox:ready': SandboxReadyEvent;
  'sandbox:idle': SandboxIdleEvent;
  'sandbox:stopping': SandboxStoppingEvent;
  'sandbox:stopped': SandboxStoppedEvent;
  'sandbox:error': SandboxErrorEvent;
  'sandbox:tmux:created': SandboxTmuxCreatedEvent;
  'sandbox:tmux:destroyed': SandboxTmuxDestroyedEvent;

  // Task creation events
  'task-creation:started': TaskCreationStartedEvent;
  'task-creation:message': TaskCreationMessageEvent;
  'task-creation:token': TaskCreationTokenEvent;
  'task-creation:suggestion': TaskCreationSuggestionEvent;
  'task-creation:questions': TaskCreationQuestionsEvent;
  'task-creation:processing': TaskCreationProcessingEvent;
  'task-creation:completed': TaskCreationCompletedEvent;
  'task-creation:cancelled': TaskCreationCancelledEvent;
  'task-creation:error': TaskCreationErrorEvent;

  // Container agent events
  'container-agent:status': ContainerAgentStatusEvent;
  'container-agent:started': ContainerAgentStartedEvent;
  'container-agent:token': ContainerAgentTokenEvent;
  'container-agent:turn': ContainerAgentTurnEvent;
  'container-agent:tool:start': ContainerAgentToolStartEvent;
  'container-agent:tool:result': ContainerAgentToolResultEvent;
  'container-agent:message': ContainerAgentMessageEvent;
  'container-agent:complete': ContainerAgentCompleteEvent;
  'container-agent:error': ContainerAgentErrorEvent;
  'container-agent:cancelled': ContainerAgentCancelledEvent;
  'container-agent:task-update-failed': ContainerAgentTaskUpdateFailedEvent;
  'container-agent:plan_ready': ContainerAgentPlanReadyEvent;
  'container-agent:worktree': ContainerAgentWorktreeEvent;
  'container-agent:file_changed': ContainerAgentFileChangedEvent;
}

/**
 * All typed event types derived from the event map
 */
export type TypedEventType = keyof StreamEventMap;

/**
 * Combined event type for all stream events (includes session events)
 */
export type StreamEventType = SessionEventType | TypedEventType;

/**
 * Generic stream event
 */
export interface StreamEvent<T = unknown> {
  id: string;
  type: StreamEventType;
  timestamp: number;
  data: T;
  offset?: number;
}

/**
 * DurableStreamsService provides a centralized interface for real-time event streaming.
 *
 * Two subscription mechanisms are available:
 * 1. Local synchronous callbacks via addSubscriber() - for immediate in-process notifications
 * 2. Async iteration via subscribe() - for cross-process/distributed scenarios through the server
 *
 * The service wraps the underlying Durable Streams server and maintains a local subscriber
 * map for fast in-process event delivery alongside the distributed streaming capability.
 */
export class DurableStreamsService {
  private subscribers = new Map<string, Set<(event: StreamEvent) => void>>();

  constructor(
    private server: DurableStreamsServer,
    private db?: Database
  ) {}

  /**
   * Map event type to channel for database storage.
   * Channels group related events (e.g., all container-agent events go to 'containerAgent').
   */
  private getChannelForType(type: TypedEventType): string {
    // Map event types to their channels
    if (type.startsWith('plan:')) return 'plan';
    if (type.startsWith('sandbox:')) return 'sandbox';
    if (type.startsWith('task-creation:')) return 'taskCreation';
    if (type.startsWith('container-agent:')) return 'containerAgent';
    return 'default';
  }

  /**
   * Create a new stream for a session or plan
   */
  async createStream(id: string, schema: unknown): Promise<void> {
    if (!id || typeof id !== 'string' || id.trim() === '') {
      const error = new Error(
        '[DurableStreamsService] createStream: streamId is required and must be a non-empty string'
      );
      console.error('[DurableStreamsService] createStream validation error:', { id });
      throw error;
    }

    try {
      await this.server.createStream(id, schema);
      this.subscribers.set(id, new Set());
    } catch (error) {
      console.error('[DurableStreamsService] createStream failed:', { streamId: id, error });
      throw new Error(
        `[DurableStreamsService] Failed to create stream '${id}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Delete a stream and clean up resources
   */
  async deleteStream(id: string): Promise<void> {
    // Clean up local subscribers
    this.subscribers.delete(id);

    // Call server.deleteStream if available
    if ('deleteStream' in this.server && this.server.deleteStream) {
      await this.server.deleteStream(id);
    }

    console.log(`[DurableStreamsService] Stream ${id} deleted`);
  }

  /**
   * Type-safe publish for mapped event types.
   * Ensures the data type matches the event type at compile time.
   *
   * Events are persisted to the database FIRST, then published to the in-memory stream.
   * This ensures events are durable and available after page refresh or server restart.
   *
   * @example
   * // TypeScript enforces correct data shape:
   * await streams.publish(streamId, 'plan:started', { sessionId, taskId, projectId });
   * await streams.publish(streamId, 'sandbox:ready', { sandboxId, projectId, containerId });
   */
  async publish<T extends TypedEventType>(
    streamId: string,
    type: T,
    data: StreamEventMap[T]
  ): Promise<number> {
    if (!streamId || typeof streamId !== 'string' || streamId.trim() === '') {
      const error = new Error(
        '[DurableStreamsService] publish: streamId is required and must be a non-empty string'
      );
      console.error('[DurableStreamsService] publish validation error:', { streamId, type });
      throw error;
    }

    try {
      const timestamp = Date.now();
      const eventId = createId();

      // Get next offset for this session from database (if db available)
      let offset = 0;
      if (this.db) {
        const lastEvent = await this.db.query.sessionEvents.findFirst({
          where: eq(sessionEvents.sessionId, streamId),
          orderBy: [desc(sessionEvents.offset)],
        });
        offset = (lastEvent?.offset ?? -1) + 1;

        // PERSIST TO DATABASE FIRST (ensures durability)
        await this.db.insert(sessionEvents).values({
          id: eventId,
          sessionId: streamId,
          offset,
          type,
          channel: this.getChannelForType(type),
          data: data as unknown,
          timestamp,
        });
      }

      // THEN publish to in-memory stream for real-time delivery
      const memoryOffset = await this.server.publish(streamId, type, data);

      // Use database offset if available, otherwise use memory offset
      const finalOffset = this.db ? offset : memoryOffset;

      const event: StreamEvent<StreamEventMap[T]> = {
        id: eventId,
        type,
        timestamp,
        data,
        offset: finalOffset,
      };
      this.notifySubscribers(streamId, event);

      return finalOffset;
    } catch (error) {
      console.error('[DurableStreamsService] publish failed:', { streamId, type, error });
      throw new Error(
        `[DurableStreamsService] Failed to publish event '${type}' to stream '${streamId}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ============================================
  // Compatibility helpers (plan + task creation)
  // ============================================

  async publishPlanStarted(streamId: string, data: PlanStartedEvent): Promise<void> {
    await this.publish(streamId, 'plan:started', data);
  }

  async publishPlanTurn(streamId: string, data: PlanTurnEvent): Promise<void> {
    await this.publish(streamId, 'plan:turn', data);
  }

  async publishPlanToken(streamId: string, data: PlanTokenEvent): Promise<void> {
    await this.publish(streamId, 'plan:token', data);
  }

  async publishPlanInteraction(streamId: string, data: PlanInteractionEvent): Promise<void> {
    await this.publish(streamId, 'plan:interaction', data);
  }

  async publishPlanCompleted(streamId: string, data: PlanCompletedEvent): Promise<void> {
    await this.publish(streamId, 'plan:completed', data);
  }

  async publishPlanError(streamId: string, data: PlanErrorEvent): Promise<void> {
    await this.publish(streamId, 'plan:error', data);
  }

  async publishPlanCancelled(streamId: string, data: { sessionId: string }): Promise<void> {
    await this.publish(streamId, 'plan:cancelled', data);
  }

  async publishTaskCreationStarted(
    streamId: string,
    data: TaskCreationStartedEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:started', data);
  }

  async publishTaskCreationMessage(
    streamId: string,
    data: TaskCreationMessageEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:message', data);
  }

  async publishTaskCreationToken(streamId: string, data: TaskCreationTokenEvent): Promise<void> {
    await this.publish(streamId, 'task-creation:token', data);
  }

  async publishTaskCreationSuggestion(
    streamId: string,
    data: TaskCreationSuggestionEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:suggestion', data);
  }

  async publishTaskCreationQuestions(
    streamId: string,
    data: TaskCreationQuestionsEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:questions', data);
  }

  async publishTaskCreationCompleted(
    streamId: string,
    data: TaskCreationCompletedEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:completed', data);
  }

  async publishTaskCreationCancelled(
    streamId: string,
    data: TaskCreationCancelledEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:cancelled', data);
  }

  async publishTaskCreationError(streamId: string, data: TaskCreationErrorEvent): Promise<void> {
    await this.publish(streamId, 'task-creation:error', data);
  }

  async publishTaskCreationProcessing(
    streamId: string,
    data: TaskCreationProcessingEvent
  ): Promise<void> {
    await this.publish(streamId, 'task-creation:processing', data);
  }

  /**
   * Publish a session event (uses SessionEvent's own type/data structure)
   */
  async publishSessionEvent(streamId: string, event: SessionEvent): Promise<void> {
    const offset = await this.server.publish(streamId, event.type, event.data);

    // Notify local subscribers
    const streamEvent: StreamEvent = {
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      data: event.data,
      offset,
    };
    this.notifySubscribers(streamId, streamEvent);
  }

  /**
   * Subscribe to a stream and receive events
   */
  async *subscribe(streamId: string): AsyncIterable<StreamEvent> {
    if (!streamId || typeof streamId !== 'string' || streamId.trim() === '') {
      const error = new Error(
        '[DurableStreamsService] subscribe: streamId is required and must be a non-empty string'
      );
      console.error('[DurableStreamsService] subscribe validation error:', { streamId });
      throw error;
    }

    try {
      const subscription = this.server.subscribe(streamId);
      for await (const event of subscription) {
        yield {
          id: createId(),
          type: event.type as StreamEventType,
          timestamp: Date.now(),
          data: event.data,
        };
      }
    } catch (error) {
      console.error('[DurableStreamsService] subscribe iteration failed:', { streamId, error });
      throw new Error(
        `[DurableStreamsService] Failed to subscribe to stream '${streamId}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Add a local subscriber for immediate event notification
   */
  addSubscriber(streamId: string, callback: (event: StreamEvent) => void): () => void {
    const subscribers = this.subscribers.get(streamId) ?? new Set();
    subscribers.add(callback);
    this.subscribers.set(streamId, subscribers);

    return () => {
      subscribers.delete(callback);
    };
  }

  private notifySubscribers(streamId: string, event: StreamEvent): void {
    const subscribers = this.subscribers.get(streamId);
    if (!subscribers) return;

    for (const callback of subscribers) {
      try {
        callback(event);
      } catch (error) {
        console.error(`[DurableStreamsService] Subscriber error for ${streamId}:`, error);
      }
    }
  }

  /**
   * Get the underlying server for advanced operations
   */
  getServer(): DurableStreamsServer {
    return this.server;
  }
}
