import type { DurableStreamsServer } from '../durable-streams.service.js';

/**
 * Create a mock Durable Streams server for testing
 */
export function createMockDurableStreamsServer(): DurableStreamsServer {
  const streams = new Map<string, Array<{ type: string; data: unknown }>>();

  return {
    async createStream(id: string): Promise<void> {
      streams.set(id, []);
    },

    async publish(id: string, type: string, data: unknown): Promise<number> {
      const stream = streams.get(id);
      if (stream) {
        stream.push({ type, data });
        return stream.length - 1; // Return offset
      }
      return 0;
    },

    async *subscribe(
      id: string,
      _options?: { fromOffset?: number }
    ): AsyncIterable<{ type: string; data: unknown; offset: number }> {
      const stream = streams.get(id);
      if (stream) {
        for (const [i, event] of stream.entries()) {
          yield { type: event.type, data: event.data, offset: i };
        }
      }
    },
  };
}
