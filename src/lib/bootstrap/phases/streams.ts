import { ok } from '../../utils/result.js';

/**
 * Initialize durable streams for the client.
 *
 * With Caddy durable streams, the client connects directly to the Caddy
 * SSE endpoints (e.g. /v1/stream/sessions/:id). The old InMemoryDurableStreamsServer
 * and stream provider singleton are no longer needed.
 *
 * This phase is kept as a no-op for bootstrap compatibility.
 */
export const connectStreams = async (_ctx?: unknown) => {
  console.log('[Streams] Client streams use Caddy durable streams directly');
  return ok(null);
};
