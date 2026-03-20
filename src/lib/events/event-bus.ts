/**
 * EventBus -- In-process event pub/sub for SSE event stream.
 *
 * RS-009: This is one of three intentionally separate event delivery systems:
 *   1. DurableStreamsService -- typed events persisted to DB + published to Caddy SSE.
 *   2. EventBus (this file) -- in-process pub/sub for general UI updates via SSE.
 *   3. CliMonitorService -- dedicated SSE stream for CLI monitor daemon data.
 * See durable-streams.service.ts for full documentation on this separation.
 *
 * RS-002: This module tracks activeSSEConnections for the main event stream (/api/events).
 * The CLI monitor SSE endpoint (cli-monitor.ts) maintains its own separate counter.
 * TODO: Consolidate both counters here with per-route tracking (e.g., a Map<string, number>)
 * so total connection counts can be queried from a single location.
 */
import { createLogger } from '../logging/logger.js';

const log = createLogger('EventBus');

type EventStreamListener = (event: { type: string; data: unknown }) => void;

let activeSSEConnections = 0;
const eventStreamListeners = new Set<EventStreamListener>();

export const MAX_SSE_CONNECTIONS = 50;

/**
 * Publish an event to all connected SSE clients.
 */
export function publishEventToStream(event: { type: string; data: unknown }): void {
  for (const listener of eventStreamListeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn('SSE listener error, removing stale listener', {
        error: err instanceof Error ? err.message : String(err),
      });
      eventStreamListeners.delete(listener);
    }
  }
}

export function addStreamListener(listener: EventStreamListener): void {
  eventStreamListeners.add(listener);
}

export function removeStreamListener(listener: EventStreamListener): void {
  eventStreamListeners.delete(listener);
}

export function getActiveSSEConnections(): number {
  return activeSSEConnections;
}

export function incrementSSEConnections(): void {
  activeSSEConnections++;
}

export function decrementSSEConnections(): void {
  activeSSEConnections = Math.max(0, activeSSEConnections - 1);
}
