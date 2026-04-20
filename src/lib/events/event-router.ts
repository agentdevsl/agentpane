/**
 * EventRouter — F05-03.
 *
 * Unified accounting layer for the two in-process SSE subsystems:
 *   - `/api/events` in event-bus.ts
 *   - `/api/cli-monitor/stream` in cli-monitor route
 *
 * Previously each maintained its own counter and hard-coded `MAX_SSE_CONNECTIONS=50`
 * with no per-user quota. The router centralises the cap into one place so that
 * capacity planning, graceful degradation, and per-user fairness are tractable.
 *
 * Caddy-managed `/v1/stream/*` is not counted here because Caddy's plugin handles
 * its own SSE termination and the API server never sees those connections. See
 * the review's F05-07 for Caddy-side quota work.
 */

import { createLogger } from '../logging/logger.js';

const log = createLogger('EventRouter');

/** Global cap across all in-process SSE routes. */
export const EVENT_ROUTER_GLOBAL_CAP = 200;

/** Per-user cap within the global limit. */
export const EVENT_ROUTER_PER_USER_CAP = 10;

export type AcquireReason =
  | { ok: true; total: number; perUser: number }
  | { ok: false; code: 'USER_QUOTA_EXCEEDED'; perUserCap: number; retryAfterSeconds: number }
  | { ok: false; code: 'GLOBAL_CAP_EXCEEDED'; globalCap: number; retryAfterSeconds: number };

interface RouteCounters {
  /** Active connections per route. */
  byRoute: Map<string, number>;
  /** Active connections per user ID. Anonymous connections keyed as `__anon`. */
  byUser: Map<string, number>;
  /** Total across all routes. */
  total: number;
}

const counters: RouteCounters = {
  byRoute: new Map(),
  byUser: new Map(),
  total: 0,
};

function anonKey(userId?: string | null): string {
  return userId && userId.length > 0 ? userId : '__anon';
}

export interface EventRouterOverrides {
  globalCap?: number;
  perUserCap?: number;
}

let overrides: EventRouterOverrides = {};

/** Test/admin hook to override the caps (e.g. from SettingsService). */
export function setEventRouterOverrides(next: EventRouterOverrides): void {
  overrides = { ...overrides, ...next };
}

export function getGlobalCap(): number {
  return overrides.globalCap ?? EVENT_ROUTER_GLOBAL_CAP;
}

export function getPerUserCap(): number {
  return overrides.perUserCap ?? EVENT_ROUTER_PER_USER_CAP;
}

/**
 * Try to acquire an SSE slot for a route+user pair.
 * Returns success with running totals, or a rejection with a retry hint.
 */
export function acquireSseSlot(route: string, userId?: string | null): AcquireReason {
  const user = anonKey(userId);
  const globalCap = getGlobalCap();
  const perUserCap = getPerUserCap();

  const perUser = counters.byUser.get(user) ?? 0;
  if (perUser >= perUserCap) {
    log.warn('SSE per-user quota exceeded', {
      data: { userId: user, route, perUserCap, perUser },
    });
    return { ok: false, code: 'USER_QUOTA_EXCEEDED', perUserCap, retryAfterSeconds: 5 };
  }

  if (counters.total >= globalCap) {
    log.warn('SSE global cap exceeded', {
      data: { route, globalCap, total: counters.total },
    });
    return { ok: false, code: 'GLOBAL_CAP_EXCEEDED', globalCap, retryAfterSeconds: 10 };
  }

  counters.total += 1;
  counters.byUser.set(user, perUser + 1);
  counters.byRoute.set(route, (counters.byRoute.get(route) ?? 0) + 1);
  return { ok: true, total: counters.total, perUser: perUser + 1 };
}

/** Release an SSE slot. Must be called on connection close. */
export function releaseSseSlot(route: string, userId?: string | null): void {
  const user = anonKey(userId);
  counters.total = Math.max(0, counters.total - 1);
  const prevUser = counters.byUser.get(user) ?? 0;
  if (prevUser <= 1) {
    counters.byUser.delete(user);
  } else {
    counters.byUser.set(user, prevUser - 1);
  }
  const prevRoute = counters.byRoute.get(route) ?? 0;
  if (prevRoute <= 1) {
    counters.byRoute.delete(route);
  } else {
    counters.byRoute.set(route, prevRoute - 1);
  }
}

/** Snapshot for admin metrics. */
export function getEventRouterSnapshot(): {
  total: number;
  globalCap: number;
  perUserCap: number;
  byRoute: Record<string, number>;
  byUser: Record<string, number>;
} {
  return {
    total: counters.total,
    globalCap: getGlobalCap(),
    perUserCap: getPerUserCap(),
    byRoute: Object.fromEntries(counters.byRoute),
    byUser: Object.fromEntries(counters.byUser),
  };
}

/** Reset counters — test-only. */
export function __resetEventRouterForTests(): void {
  counters.total = 0;
  counters.byRoute.clear();
  counters.byUser.clear();
  overrides = {};
}
