/**
 * EventBus -- In-process event pub/sub for SSE event stream.
 *
 * RS-009: This is one of three intentionally separate event delivery systems:
 *   1. DurableStreamsService -- typed events persisted to DB + published to Caddy SSE.
 *   2. EventBus (this file) -- in-process pub/sub for general UI updates via SSE.
 *   3. CliMonitorService -- dedicated SSE stream for CLI monitor daemon data.
 * See durable-streams.service.ts for full documentation on this separation.
 *
 * F05-03: Connection counting is now delegated to EventRouter so the cap is
 * shared between the `/api/events` stream and the CLI monitor stream. The
 * per-route number returned by `getActiveSSEConnections()` is the legacy
 * "events route" count; use `getEventRouterSnapshot()` for the global total.
 */
import { createLogger } from '../logging/logger.js';
import {
  type AcquireReason,
  acquireSseSlot,
  getEventRouterSnapshot,
  releaseSseSlot,
} from './event-router.js';

const log = createLogger('EventBus');

type EventStreamListener = (event: { type: string; data: unknown }) => void;

const eventStreamListeners = new Set<EventStreamListener>();

/** Route identifier used when acquiring/releasing EventRouter slots. */
export const EVENT_BUS_ROUTE = '/api/events';

/**
 * Legacy constant preserved for tests that import it. The real limit now lives
 * in EventRouter (`EVENT_ROUTER_GLOBAL_CAP` with a per-user cap).
 */
export const MAX_SSE_CONNECTIONS = 200;

/**
 * Publish an event to all connected SSE clients.
 */
export function publishEventToStream(event: { type: string; data: unknown }): void {
  for (const listener of eventStreamListeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn('SSE listener error, removing stale listener', {
        data: { error: err instanceof Error ? err.message : String(err) },
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

/** F05-03: number of active `/api/events` SSE connections. */
export function getActiveSSEConnections(): number {
  return getEventRouterSnapshot().byRoute[EVENT_BUS_ROUTE] ?? 0;
}

/** F05-03: acquire an SSE slot. Returns the router result. */
export function tryAcquireEventBusSlot(userId?: string | null): AcquireReason {
  return acquireSseSlot(EVENT_BUS_ROUTE, userId);
}

/**
 * @deprecated F05-03: use `tryAcquireEventBusSlot(userId)` so the shared
 * EventRouter can enforce global and per-user caps.
 */
export function incrementSSEConnections(): void {
  acquireSseSlot(EVENT_BUS_ROUTE, null);
}

export function decrementSSEConnections(): void {
  releaseSseSlot(EVENT_BUS_ROUTE, null);
}

/** F05-03: release an SSE slot for a specific user. */
export function releaseEventBusSlot(userId?: string | null): void {
  releaseSseSlot(EVENT_BUS_ROUTE, userId);
}
