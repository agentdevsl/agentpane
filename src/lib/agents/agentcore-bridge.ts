/**
 * AgentCore Bridge - Processes SSE events from AWS AgentCore invoke and bridges them to DurableStreams.
 *
 * Unlike ContainerBridge which parses raw JSON lines from Docker stdout,
 * this bridge receives pre-parsed SSEEvent objects from the AgentCoreSandboxInstance
 * and publishes them to the same DurableStreams channels.
 */
import type {
  DurableStreamsService,
  StreamEventMap,
  TypedEventType,
} from '../../services/durable-streams.service.js';
import type { SSEEvent } from '../sandbox/providers/agentcore-sandbox-instance.js';
import { type AgentRunnerEventType, EVENT_TYPE_MAP } from './event-type-map.js';

// Re-export for consumers that previously imported from this module
export type { SSEEvent } from '../sandbox/providers/agentcore-sandbox-instance.js';

// Debug logging helper
const DEBUG = process.env.DEBUG_AGENTCORE_BRIDGE === 'true' || process.env.DEBUG === 'true';

function debugLog(context: string, message: string, data?: Record<string, unknown>): void {
  if (DEBUG) {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    console.log(`[${timestamp}] [AgentCoreBridge:${context}] ${message}${dataStr}`);
  }
}

function warnLog(context: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.error(`[${timestamp}] [AgentCoreBridge:${context}] ${message}${dataStr}`);
}

/**
 * Plan ready data from ExitPlanMode.
 */
export interface AgentCorePlanReadyData {
  plan: string;
  turnCount: number;
  sdkSessionId: string;
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  launchSwarm?: boolean;
  teammateCount?: number;
}

/**
 * Options for creating an AgentCore bridge.
 */
export interface AgentCoreBridgeOptions {
  taskId: string;
  sessionId: string;
  projectId: string;
  streams: DurableStreamsService;
  onComplete?: (status: 'completed' | 'turn_limit' | 'cancelled', turnCount: number) => void;
  onError?: (error: string, turnCount: number) => void;
  onPlanReady?: (data: AgentCorePlanReadyData) => void;
}

/**
 * AgentCore bridge instance.
 */
export interface AgentCoreBridge {
  /**
   * Process an async iterable of SSE events from AgentCore.
   */
  processStream(events: AsyncIterable<SSEEvent>): Promise<void>;

  /**
   * Stop processing and clean up.
   */
  stop(): void;
}

/**
 * Create an AgentCore bridge for processing SSE events from AWS AgentCore invoke.
 */
export function createAgentCoreBridge(options: AgentCoreBridgeOptions): AgentCoreBridge {
  const { taskId, sessionId, projectId, streams, onComplete, onError, onPlanReady } = options;
  let stopped = false;
  let eventCount = 0;
  let consecutivePublishFailures = 0;
  const MAX_CONSECUTIVE_PUBLISH_FAILURES = 5;

  debugLog('createAgentCoreBridge', 'Creating AgentCore bridge', { taskId, sessionId, projectId });

  /**
   * Publish an event to DurableStreams.
   * Tracks consecutive failures and throws after MAX_CONSECUTIVE_PUBLISH_FAILURES
   * to prevent silent event loss.
   */
  async function publishEvent(
    streamType: TypedEventType,
    data: Record<string, unknown>
  ): Promise<void> {
    // Context keys placed after spread so they cannot be overwritten by event data
    const eventData = {
      ...data,
      taskId,
      sessionId,
      projectId,
    };

    debugLog('publishEvent', 'Publishing event to DurableStreams', {
      type: streamType,
      sessionId,
      dataKeys: Object.keys(eventData),
    });

    try {
      await streams.publish(sessionId, streamType, eventData as StreamEventMap[typeof streamType]);
      consecutivePublishFailures = 0;
      debugLog('publishEvent', 'Event published successfully', { type: streamType });
    } catch (error) {
      consecutivePublishFailures++;
      warnLog(
        'publishEvent',
        `Failed to publish event (${consecutivePublishFailures}/${MAX_CONSECUTIVE_PUBLISH_FAILURES})`,
        {
          type: streamType,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      if (consecutivePublishFailures >= MAX_CONSECUTIVE_PUBLISH_FAILURES) {
        throw new Error(
          `Stream publishing failed ${consecutivePublishFailures} consecutive times: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * Handle completion event.
   * Uses fallback values for malformed data to ensure the callback always fires
   * for terminal events — silently dropping them would leave tasks stuck forever.
   */
  function handleComplete(data: Record<string, unknown>): void {
    const rawStatus = data.status as string;
    const turnCount = typeof data.turnCount === 'number' ? data.turnCount : 0;

    const validStatuses = ['completed', 'turn_limit', 'cancelled'] as const;
    const status = validStatuses.includes(rawStatus as (typeof validStatuses)[number])
      ? (rawStatus as 'completed' | 'turn_limit' | 'cancelled')
      : 'completed';

    if (rawStatus !== status || typeof data.turnCount !== 'number') {
      warnLog('handleComplete', 'Unexpected completion data, using fallback values', {
        taskId,
        originalStatus: rawStatus,
        resolvedStatus: status,
        originalTurnCount: data.turnCount,
        resolvedTurnCount: turnCount,
      });
    }

    debugLog('handleComplete', 'Agent completed', {
      taskId,
      status,
      turnCount,
      totalEvents: eventCount,
    });

    if (onComplete) {
      onComplete(status, turnCount);
    }
  }

  /**
   * Handle error event.
   * Uses fallback values for malformed data to ensure the callback always fires.
   */
  function handleError(data: Record<string, unknown>): void {
    const error =
      typeof data.error === 'string' ? data.error : String(data.error ?? 'Unknown error');
    const turnCount = typeof data.turnCount === 'number' ? data.turnCount : 0;

    if (typeof data.error !== 'string' || typeof data.turnCount !== 'number') {
      warnLog('handleError', 'Unexpected error event data, using fallback values', {
        taskId,
        data,
      });
    }

    debugLog('handleError', 'Agent error received', {
      taskId,
      error,
      turnCount,
      totalEvents: eventCount,
    });

    if (onError) {
      onError(error, turnCount);
    }
  }

  /**
   * Handle cancelled event.
   * Uses fallback values for malformed data to ensure the callback always fires.
   */
  function handleCancelled(data: Record<string, unknown>): void {
    const turnCount = typeof data.turnCount === 'number' ? data.turnCount : 0;

    if (typeof data.turnCount !== 'number') {
      warnLog('handleCancelled', 'Unexpected cancelled event data, using fallback values', {
        taskId,
        data,
      });
    }

    debugLog('handleCancelled', 'Agent cancelled', {
      taskId,
      turnCount,
      totalEvents: eventCount,
    });

    if (onComplete) {
      onComplete('cancelled', turnCount);
    }
  }

  /**
   * Handle plan_ready event.
   * Uses fallback values for malformed data to ensure the callback always fires —
   * silently dropping a plan_ready event would leave the task stuck in planning forever.
   */
  function handlePlanReady(data: Record<string, unknown>): void {
    const plan = typeof data.plan === 'string' ? data.plan : JSON.stringify(data);
    const turnCount = typeof data.turnCount === 'number' ? data.turnCount : 0;
    const sdkSessionId = typeof data.sdkSessionId === 'string' ? data.sdkSessionId : '';
    const allowedPrompts = Array.isArray(data.allowedPrompts)
      ? (data.allowedPrompts as Array<{ tool: 'Bash'; prompt: string }>)
      : undefined;

    if (typeof data.plan !== 'string' || typeof data.turnCount !== 'number') {
      warnLog('handlePlanReady', 'Unexpected plan_ready event data, using fallback values', {
        taskId,
        data,
      });
    }

    debugLog('handlePlanReady', 'Plan ready for approval', {
      taskId,
      turnCount,
      sdkSessionId,
      planLength: plan.length,
    });

    if (onPlanReady) {
      onPlanReady({ plan, turnCount, sdkSessionId, allowedPrompts });
    }
  }

  return {
    async processStream(events: AsyncIterable<SSEEvent>): Promise<void> {
      if (stopped) {
        debugLog('processStream', 'Bridge already stopped, skipping', { taskId });
        return;
      }

      debugLog('processStream', 'Starting to process AgentCore SSE stream', { taskId, sessionId });

      try {
        for await (const event of events) {
          if (stopped) {
            debugLog('processStream', 'Bridge stopped during processing', { taskId, eventCount });
            break;
          }

          // Validate event structure
          if (!event.type || !event.data || typeof event.data !== 'object') {
            debugLog('processStream', 'Skipping invalid event', {
              hasType: !!event.type,
              hasData: !!event.data,
            });
            continue;
          }

          // Map event type
          const streamType = EVENT_TYPE_MAP[event.type as AgentRunnerEventType];
          if (!streamType) {
            debugLog('processStream', 'Unknown event type, skipping', { type: event.type });
            continue;
          }

          eventCount++;

          // Publish event to DurableStreams
          await publishEvent(streamType, event.data);

          // Handle terminal and special events
          if (event.type === 'agent:complete') {
            handleComplete(event.data);
          } else if (event.type === 'agent:error') {
            handleError(event.data);
          } else if (event.type === 'agent:cancelled') {
            handleCancelled(event.data);
          } else if (event.type === 'agent:plan_ready') {
            handlePlanReady(event.data);
          }
        }
      } catch (error) {
        // Stream error -- publish error event and notify
        const errorMessage = error instanceof Error ? error.message : String(error);
        warnLog('processStream', 'Stream error', { taskId, error: errorMessage });

        await publishEvent('container-agent:error', {
          error: errorMessage,
          turnCount: 0,
        });

        if (onError) {
          onError(errorMessage, 0);
        }
      }

      debugLog('processStream', 'Stream processing complete', {
        taskId,
        totalEvents: eventCount,
      });
    },

    stop(): void {
      debugLog('stop', 'Stopping AgentCore bridge', { taskId, eventCount });
      stopped = true;
    },
  };
}
