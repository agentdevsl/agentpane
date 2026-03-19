import { writeSync } from 'node:fs';

/**
 * Event emitter for container-to-host communication.
 * Outputs JSON-line events to stdout for parsing by the host process.
 *
 * IMPORTANT: Events are written with explicit flush to ensure immediate delivery
 * in containerized environments where stdout may be buffered.
 *
 * Critical events (started, complete, error) use synchronous writes to ensure
 * they are delivered immediately. High-frequency events (token) use regular
 * writes for performance.
 */

export type AgentEventType =
  | 'agent:started'
  | 'agent:token'
  | 'agent:turn'
  | 'agent:tool:start'
  | 'agent:tool:result'
  | 'agent:message'
  | 'agent:complete'
  | 'agent:error'
  | 'agent:cancelled'
  | 'agent:plan_ready'
  | 'agent:file_changed'
  | 'agent:topology:spawned'
  | 'agent:topology:progress'
  | 'agent:topology:completed';

export interface AgentEvent {
  type: AgentEventType;
  timestamp: number;
  taskId: string;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface AgentStartedData {
  model: string;
  maxTurns: number;
}

export interface AgentTokenData {
  delta: string;
  accumulated: string;
}

export interface AgentTurnData {
  turn: number;
  maxTurns: number;
  remaining: number;
}

export interface AgentToolStartData {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
}

export interface AgentToolResultData {
  toolName: string;
  toolId: string;
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface AgentMessageData {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentCompleteData {
  status: 'completed' | 'turn_limit' | 'cancelled';
  turnCount: number;
  result?: string;
}

export interface AgentErrorData {
  error: string;
  code?: string;
  turnCount: number;
}

/**
 * Matching type exists in src/types/agent-events.ts (canonical).
 * Keep in sync — build boundary prevents shared import.
 */
export interface AgentFileChangedData {
  path: string;
  action: 'create' | 'modify' | 'delete';
  toolName: string;
  additions?: number;
  deletions?: number;
}

export interface AgentTopologySpawnedData {
  agentId: string;
  name: string;
  role: string;
  parentId: string | null;
  sdkTaskId?: string;
}

export interface AgentTopologyProgressData {
  agentId: string;
  sdkTaskId: string;
  tokens: number;
  toolUses: number;
  durationMs: number;
  summary?: string;
  lastToolName?: string;
}

export interface AgentTopologyCompletedData {
  agentId: string;
  sdkTaskId?: string;
  status: 'completed' | 'failed' | 'stopped';
  summary?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface AgentPlanReadyData {
  plan: string;
  turnCount: number;
  sdkSessionId: string;
  /** Allowed bash prompts from ExitPlanMode */
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  launchSwarm?: boolean;
  teammateCount?: number;
}

// File descriptor for stdout (used for synchronous writes)
const STDOUT_FD = 1;

/**
 * EventEmitter class for emitting agent events as JSON lines to stdout.
 * The host process reads these lines and bridges them to DurableStreams.
 */
export class EventEmitter {
  constructor(
    private readonly taskId: string,
    private readonly sessionId: string
  ) {}

  /**
   * Emit an event to stdout as a JSON line.
   * The host process parses these lines to bridge events to DurableStreams.
   *
   * @param type - The event type
   * @param data - Event payload data
   * @param sync - If true, use synchronous write (for critical events)
   */
  emit(type: AgentEventType, data: Record<string, unknown>, sync = false): void {
    const event: AgentEvent = {
      type,
      timestamp: Date.now(),
      taskId: this.taskId,
      sessionId: this.sessionId,
      data,
    };

    // Write as a single JSON line to stdout
    // The host process reads line-by-line and parses JSON
    const line = `${JSON.stringify(event)}\n`;

    if (sync) {
      // Use synchronous write for critical events to ensure immediate delivery
      // This bypasses Node's stream buffering entirely
      try {
        writeSync(STDOUT_FD, line);
      } catch {
        // Fallback to async write if sync fails (e.g., in some environments)
        process.stdout.write(line);
      }
    } else {
      // Use regular async write for high-frequency events (tokens)
      // This is more performant but may be slightly buffered
      process.stdout.write(line);
    }
  }

  /**
   * Emit agent:started event (SYNC - critical for UI feedback).
   * This MUST be delivered immediately so the client sees the agent has started.
   */
  started(data: AgentStartedData): void {
    this.emit('agent:started', { ...data }, true);
  }

  /**
   * Emit agent:token event (ASYNC - high frequency streaming).
   * Uses buffered write for better performance during streaming.
   */
  token(data: AgentTokenData): void {
    this.emit('agent:token', { ...data }, false);
  }

  /**
   * Emit agent:turn event (SYNC - important progress indicator).
   */
  turn(data: AgentTurnData): void {
    this.emit('agent:turn', { ...data }, true);
  }

  /**
   * Emit agent:tool:start event (ASYNC - frequent during execution).
   */
  toolStart(data: AgentToolStartData): void {
    this.emit('agent:tool:start', { ...data }, false);
  }

  /**
   * Emit agent:tool:result event (SYNC - critical for UI state).
   * Changed to synchronous to ensure tool results are delivered before process exit.
   */
  toolResult(data: AgentToolResultData): void {
    this.emit('agent:tool:result', { ...data }, true);
  }

  /**
   * Emit agent:message event (SYNC - important for conversation flow).
   */
  message(data: AgentMessageData): void {
    this.emit('agent:message', { ...data }, true);
  }

  /**
   * Emit agent:complete event (SYNC - critical for task completion).
   * This MUST be delivered immediately so the client knows the task is done.
   */
  complete(data: AgentCompleteData): void {
    this.emit('agent:complete', { ...data }, true);
  }

  /**
   * Emit agent:error event (SYNC - critical for error handling).
   * This MUST be delivered immediately so the client can handle the error.
   */
  error(data: AgentErrorData): void {
    this.emit('agent:error', { ...data }, true);
  }

  /**
   * Emit agent:cancelled event (SYNC - critical for cancellation feedback).
   */
  cancelled(turnCount: number): void {
    this.emit('agent:cancelled', { turnCount }, true);
  }

  /**
   * Emit agent:file_changed event (ASYNC - informational, can be batched).
   * Emitted when the agent modifies a file via Write, Edit, or similar tools.
   */
  fileChanged(data: AgentFileChangedData): void {
    this.emit('agent:file_changed', { ...data }, false);
  }

  /**
   * Emit agent:plan_ready event (SYNC - critical for plan approval flow).
   * Emitted when the agent calls ExitPlanMode and the plan is ready for approval.
   */
  planReady(data: AgentPlanReadyData): void {
    this.emit('agent:plan_ready', { ...data }, true);
  }

  /**
   * Emit agent:topology:spawned event (SYNC - important for UI node creation).
   */
  topologySpawned(data: AgentTopologySpawnedData): void {
    this.emit('agent:topology:spawned', { ...data }, true);
  }

  /**
   * Emit agent:topology:progress event (ASYNC - frequent metric updates).
   */
  topologyProgress(data: AgentTopologyProgressData): void {
    this.emit('agent:topology:progress', { ...data }, false);
  }

  /**
   * Emit agent:topology:completed event (SYNC - important for UI completion).
   */
  topologyCompleted(data: AgentTopologyCompletedData): void {
    this.emit('agent:topology:completed', { ...data }, true);
  }
}

/**
 * Create an event emitter for a specific task and session.
 */
export function createEventEmitter(taskId: string, sessionId: string): EventEmitter {
  return new EventEmitter(taskId, sessionId);
}
