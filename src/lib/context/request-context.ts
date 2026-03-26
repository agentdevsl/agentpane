/**
 * Request Context via AsyncLocalStorage
 *
 * Provides per-request context (e.g. requestId) that propagates
 * automatically through the async call chain without explicit threading.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** Return the current requestId, or undefined outside a request. */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}
