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
