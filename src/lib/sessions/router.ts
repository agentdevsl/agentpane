/**
 * Session Event Router
 *
 * Routes session events to registered handlers by channel type.
 * Provides type-safe event handling with channel discrimination.
 *
 * @module lib/sessions/router
 */

import type { SessionEvent } from './schema.js';

/**
 * Handler function for a specific channel type
 */
export type ChannelHandler<T extends SessionEvent = SessionEvent> = (event: T) => void;

/**
 * Extract event type for a specific channel
 */
type ChannelEvent<C extends SessionEvent['channel']> = Extract<SessionEvent, { channel: C }>;

/**
 * Session event router that dispatches events to channel-specific handlers
 */
export class SessionEventRouter {
  private handlers = new Map<string, Set<ChannelHandler>>();

  /**
   * Register a handler for a specific channel
   *
   * @param channel - The channel to handle (e.g., 'chunks', 'toolCalls')
   * @param handler - The handler function
   * @returns Unsubscribe function
   *
   * @example
   * const unsubscribe = router.on('chunks', (event) => {
   *   console.log('Received chunk:', event.data.text);
   * });
   */
  on<C extends SessionEvent['channel']>(
    channel: C,
    handler: ChannelHandler<ChannelEvent<C>>
  ): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
    }

    this.handlers.get(channel)?.add(handler as ChannelHandler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(channel)?.delete(handler as ChannelHandler);
    };
  }

  /**
   * Register a one-time handler for a specific channel
   *
   * @param channel - The channel to handle
   * @param handler - The handler function (will be called once)
   * @returns Unsubscribe function
   */
  once<C extends SessionEvent['channel']>(
    channel: C,
    handler: ChannelHandler<ChannelEvent<C>>
  ): () => void {
    const wrappedHandler: ChannelHandler<ChannelEvent<C>> = (event) => {
      unsubscribe();
      handler(event);
    };

    const unsubscribe = this.on(channel, wrappedHandler);
    return unsubscribe;
  }

  /**
   * Route an incoming event to registered handlers
   *
   * @param event - The session event to route
   */
  route(event: SessionEvent): void {
    const channelHandlers = this.handlers.get(event.channel);
    if (channelHandlers) {
      for (const handler of channelHandlers) {
        try {
          handler(event);
        } catch (_error) {}
      }
    }
  }

  /**
   * Remove a specific handler from a channel
   */
  off<C extends SessionEvent['channel']>(
    channel: C,
    handler: ChannelHandler<ChannelEvent<C>>
  ): void {
    this.handlers.get(channel)?.delete(handler as ChannelHandler);
  }

  /**
   * Clear all handlers for a specific channel
   */
  clearChannel(channel: SessionEvent['channel']): void {
    this.handlers.delete(channel);
  }

  /**
   * Clear all handlers
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Get the number of handlers for a channel
   */
  getHandlerCount(channel: SessionEvent['channel']): number {
    return this.handlers.get(channel)?.size ?? 0;
  }

  /**
   * Get all registered channels
   */
  getChannels(): SessionEvent['channel'][] {
    return Array.from(this.handlers.keys()) as SessionEvent['channel'][];
  }
}

/**
 * Factory function to create a session router
 */
export function createSessionRouter(): SessionEventRouter {
  return new SessionEventRouter();
}
