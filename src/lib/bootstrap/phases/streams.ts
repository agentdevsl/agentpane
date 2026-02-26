import { ok } from '../../utils/result.js';

/**
 * Initialize durable streams for the client.
 *
 * With Caddy durable streams, the client connects directly to the Caddy
 * SSE endpoints (e.g. /v1/stream/sessions/:id). This phase verifies
 * Caddy is reachable before declaring the streams subsystem ready.
 */
export const connectStreams = async (_ctx?: unknown) => {
  const streamsUrl = process.env.CADDY_STREAMS_URL ?? 'http://localhost:3000/v1/stream';
  try {
    const response = await fetch(streamsUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    if (response.ok || response.status === 404) {
      // 404 is expected — no streams exist yet, but Caddy is reachable
      console.log(`[Streams] Caddy durable streams reachable at ${streamsUrl}`);
      return ok(null);
    }
    console.warn(`[Streams] Caddy returned ${response.status}, proceeding anyway`);
    return ok(null);
  } catch (e) {
    console.warn(`[Streams] Caddy not reachable at ${streamsUrl}:`, e);
    // Non-fatal: app can start, streams will connect when Caddy is available
    return ok(null);
  }
};
