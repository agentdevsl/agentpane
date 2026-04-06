/**
 * Container Bridge - Parses JSON stdout from container agent-runner and bridges events to DurableStreams.
 *
 * The agent-runner inside Docker containers emits JSON-line events to stdout.
 * This bridge reads those lines, parses them, and publishes to the appropriate DurableStreams stream.
 */

import { createInterface, type Interface } from 'node:readline';
import type { Readable } from 'node:stream';
import type {
  DurableStreamsService,
  StreamEventMap,
} from '../../services/durable-streams.service.js';
import { errorMessage } from '../utils/error-message';
import { type AgentRunnerEventType, EVENT_TYPE_MAP } from './event-type-map.js';

// Re-export AgentRunnerEventType as ContainerAgentEventType for backwards compatibility
export type ContainerAgentEventType = AgentRunnerEventType;

// Debug logging helper
function debugLog(_context: string, _message: string, _data?: Record<string, unknown>): void {
  // Debug logging intentionally suppressed; enable via DEBUG_CONTAINER_BRIDGE env var
}

function infoLog(_context: string, _message: string, _data?: Record<string, unknown>): void {
  // Info logging intentionally suppressed
}

/**
 * Raw event structure from the container stdout.
 */
export interface ContainerAgentEvent {
  type: ContainerAgentEventType;
  timestamp: number;
  taskId: string;
  sessionId: string;
  data: Record<string, unknown>;
}

/**
 * Options for creating a container bridge.
 */
/**
 * Plan ready data from ExitPlanMode.
 */
export interface PlanReadyData {
  plan: string;
  turnCount: number;
  sdkSessionId: string;
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  launchSwarm?: boolean;
  teammateCount?: number;
}

import type { AgentCompleteMetrics } from '../../services/container-agent/types.js';

/** Enriched completion data forwarded from the agent-runner's complete event. */
export type CompleteEventMetrics = AgentCompleteMetrics;

export interface ContainerBridgeOptions {
  taskId: string;
  sessionId: string;
  codespaceId: string;
  streams: DurableStreamsService;
  onComplete?: (
    status: 'completed' | 'turn_limit' | 'cancelled' | 'error',
    turnCount: number,
    metrics?: CompleteEventMetrics
  ) => void;
  onError?: (error: string, turnCount: number) => void;
  onPlanReady?: (data: PlanReadyData) => void;
}

/**
 * Container bridge instance.
 */
export interface ContainerBridge {
  /**
   * Process a stdout stream from the container.
   */
  processStream(stream: Readable): Promise<void>;

  /**
   * Process a stderr stream from the container to capture error events.
   * The agent-runner writes JSON error events to stderr as a fallback when stdout fails.
   */
  processStderr(stream: Readable): void;

  /**
   * Stop processing and clean up.
   */
  stop(): void;
}

/**
 * Create a container bridge for processing agent events from Docker stdout.
 */
export function createContainerBridge(options: ContainerBridgeOptions): ContainerBridge {
  const { taskId, sessionId, codespaceId, streams, onComplete, onError, onPlanReady } = options;
  let readline: Interface | null = null;
  let stopped = false;
  let lineCount = 0;
  let eventCount = 0;

  debugLog('createContainerBridge', 'Creating container bridge', {
    taskId,
    sessionId,
    codespaceId,
  });

  /**
   * Parse a JSON line from stdout.
   */
  function parseLine(line: string): ContainerAgentEvent | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const event = JSON.parse(trimmed) as ContainerAgentEvent;
      const data =
        event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : {};

      // Validate event structure
      if (!event.type || !event.timestamp || !event.taskId || !event.sessionId) {
        infoLog('parseLine', 'Invalid event structure', {
          line: trimmed.slice(0, 200),
          hasType: !!event.type,
          hasTimestamp: !!event.timestamp,
          hasTaskId: !!event.taskId,
          hasSessionId: !!event.sessionId,
        });
        return null;
      }

      debugLog('parseLine', 'Parsed event', {
        type: event.type,
        taskId: event.taskId,
        dataKeys: Object.keys(event.data || {}),
      });

      return { ...event, data };
    } catch (parseError) {
      // Check if this looks like it was supposed to be JSON (starts with { or [)
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        // This was probably malformed JSON from agent-runner - this is a problem worth noting
        infoLog(
          'parseLine',
          'Malformed JSON event - possible agent-runner bug or stream corruption',
          {
            linePreview: trimmed.slice(0, 200),
            error: parseError instanceof Error ? parseError.message : String(parseError),
          }
        );
      } else {
        // Regular non-JSON stdout from commands - expected behavior
        debugLog('parseLine', 'Non-JSON output', { line: trimmed.slice(0, 100) });
      }
      return null;
    }
  }

  /**
   * Publish an event to DurableStreams.
   */
  async function publishEvent(event: ContainerAgentEvent): Promise<void> {
    const streamType = EVENT_TYPE_MAP[event.type];
    if (!streamType) {
      infoLog('publishEvent', 'Unknown event type', { type: event.type });
      return;
    }

    // Build event data with task/session context
    const eventData = {
      taskId,
      sessionId,
      codespaceId, // Include codespaceId for context
      ...event.data,
    };

    debugLog('publishEvent', 'Publishing event to DurableStreams', {
      type: streamType,
      sessionId,
      dataKeys: Object.keys(eventData),
    });

    try {
      await streams.publish(sessionId, streamType, eventData as StreamEventMap[typeof streamType]);
      debugLog('publishEvent', 'Event published successfully', { type: streamType });
    } catch (error) {
      infoLog('publishEvent', 'Failed to publish event', {
        type: streamType,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Handle completion event.
   */
  function handleComplete(event: ContainerAgentEvent): void {
    const data = event.data as {
      status: 'completed' | 'turn_limit' | 'cancelled' | 'error';
      turnCount: number;
      skillId?: string;
      skillName?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
      fileChanges?: { filesModified: number; linesAdded: number; linesRemoved: number };
    };

    if (!data || typeof data.turnCount !== 'number') {
      infoLog('handleComplete', 'Invalid completion event data', {
        taskId,
        data: event.data,
      });
      return;
    }

    if (!['completed', 'turn_limit', 'cancelled', 'error'].includes(data.status)) {
      infoLog('handleComplete', 'Invalid completion status', {
        taskId,
        status: data.status,
      });
      return;
    }

    infoLog('handleComplete', 'Agent completed', {
      taskId,
      status: data.status,
      turnCount: data.turnCount,
      totalLines: lineCount,
      totalEvents: eventCount,
    });

    if (onComplete) {
      // Forward enriched metrics from agent-runner complete event
      const metrics: CompleteEventMetrics = {};
      if (data.skillId) metrics.skillId = data.skillId;
      if (data.skillName) metrics.skillName = data.skillName;
      if (data.usage) metrics.usage = data.usage;
      if (data.fileChanges) metrics.fileChanges = data.fileChanges;
      onComplete(
        data.status,
        data.turnCount,
        Object.keys(metrics).length > 0 ? metrics : undefined
      );
    }
  }

  /**
   * Handle error event.
   */
  function handleError(event: ContainerAgentEvent): void {
    const data = event.data as {
      error: string;
      turnCount: number;
    };

    if (!data || typeof data.error !== 'string' || typeof data.turnCount !== 'number') {
      infoLog('handleError', 'Invalid error event data', {
        taskId,
        data: event.data,
      });
      return;
    }

    infoLog('handleError', 'Agent error received', {
      taskId,
      error: data.error,
      turnCount: data.turnCount,
      totalLines: lineCount,
      totalEvents: eventCount,
    });

    if (onError) {
      onError(data.error, data.turnCount);
    }
  }

  /**
   * Handle cancelled event.
   */
  function handleCancelled(event: ContainerAgentEvent): void {
    const data = event.data as { turnCount: number };

    if (!data || typeof data.turnCount !== 'number') {
      infoLog('handleCancelled', 'Invalid cancelled event data', {
        taskId,
        data: event.data,
      });
      return;
    }

    infoLog('handleCancelled', 'Agent cancelled', {
      taskId,
      turnCount: data.turnCount,
      totalLines: lineCount,
      totalEvents: eventCount,
    });

    if (onComplete) {
      onComplete('cancelled', data.turnCount);
    }
  }

  /**
   * Handle plan_ready event.
   */
  function handlePlanReady(event: ContainerAgentEvent): void {
    const data = event.data as unknown as PlanReadyData;

    if (!data || typeof data.plan !== 'string' || typeof data.turnCount !== 'number') {
      infoLog('handlePlanReady', 'Invalid plan_ready event data', {
        taskId,
        data: event.data,
      });
      return;
    }

    infoLog('handlePlanReady', 'Plan ready for approval', {
      taskId,
      turnCount: data.turnCount,
      sdkSessionId: data.sdkSessionId,
      planLength: data.plan.length,
    });

    if (onPlanReady) {
      onPlanReady(data);
    }
  }

  return {
    async processStream(stream: Readable): Promise<void> {
      if (stopped) {
        debugLog('processStream', 'Bridge already stopped, skipping', { taskId });
        return;
      }

      infoLog('processStream', 'Starting to process stdout stream', { taskId, sessionId });

      readline = createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      // Process each line
      for await (const line of readline) {
        lineCount++;

        if (stopped) {
          debugLog('processStream', 'Bridge stopped during processing', { taskId, lineCount });
          break;
        }

        const event = parseLine(line);
        if (!event) {
          continue;
        }

        eventCount++;

        // Verify event belongs to this task/session
        if (event.taskId !== taskId || event.sessionId !== sessionId) {
          infoLog('processStream', 'Event task/session mismatch', {
            expected: { taskId, sessionId },
            received: { taskId: event.taskId, sessionId: event.sessionId },
          });
          continue;
        }

        // Publish event
        await publishEvent(event);

        // Handle terminal events
        if (event.type === 'agent:complete') {
          handleComplete(event);
        } else if (event.type === 'agent:error') {
          handleError(event);
        } else if (event.type === 'agent:cancelled') {
          handleCancelled(event);
        } else if (event.type === 'agent:plan_ready') {
          handlePlanReady(event);
        }
      }

      infoLog('processStream', 'Stream processing complete', {
        taskId,
        totalLines: lineCount,
        totalEvents: eventCount,
      });
    },

    processStderr(stream: Readable): void {
      if (stopped) {
        debugLog('processStderr', 'Bridge already stopped, skipping', { taskId });
        return;
      }

      infoLog('processStderr', 'Starting to process stderr stream for error events', {
        taskId,
        sessionId,
      });

      const stderrReader = createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      stderrReader.on('line', async (line: string) => {
        if (stopped) {
          return;
        }

        // Check if line looks like a JSON error event from agent-runner
        // The agent-runner writes JSON to stderr in its final catch block
        if (line.includes('"type":"agent:error"') || line.includes('"type": "agent:error"')) {
          try {
            const event = JSON.parse(line.trim()) as ContainerAgentEvent;

            // Validate it's an error event with required fields
            if (
              event.type === 'agent:error' &&
              event.taskId === taskId &&
              event.sessionId === sessionId
            ) {
              infoLog('processStderr', 'Captured error event from stderr', {
                taskId,
                error: (event.data as { error?: string }).error,
              });

              eventCount++;

              // Publish the error event
              await publishEvent(event);

              // Handle the error
              handleError(event);
            }
          } catch {
            // Not valid JSON, just a regular stderr log line - ignore
            debugLog('processStderr', 'Non-JSON stderr line', { line: line.slice(0, 100) });
          }
        }
      });

      stderrReader.on('close', () => {
        debugLog('processStderr', 'Stderr stream closed', { taskId });
      });
    },

    stop(): void {
      infoLog('stop', 'Stopping container bridge', { taskId, lineCount, eventCount });
      stopped = true;
      if (readline) {
        readline.close();
        readline = null;
      }
    },
  };
}

/**
 * Process a single line of JSON output (for testing or manual processing).
 */
export function parseContainerEvent(line: string): ContainerAgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const event = JSON.parse(trimmed) as ContainerAgentEvent;
    const data =
      event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : {};

    if (!event.type || !event.timestamp || !event.taskId || !event.sessionId) {
      return null;
    }

    return { ...event, data };
  } catch {
    return null;
  }
}
