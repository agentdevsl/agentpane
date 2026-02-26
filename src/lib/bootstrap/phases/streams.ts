import { createError } from '../../errors/base.js';
import { err, ok } from '../../utils/result.js';

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
    console.error(`[Streams] Caddy returned HTTP ${response.status} at ${streamsUrl}`);
    return err(
      createError('BOOTSTRAP_STREAMS_FAILED', `Caddy streams returned HTTP ${response.status}`, 503)
    );
  } catch (e) {
    console.error(`[Streams] Caddy not reachable at ${streamsUrl}:`, e);
    return err(
      createError(
        'BOOTSTRAP_STREAMS_FAILED',
        `Caddy streams not reachable at ${streamsUrl}: ${e instanceof Error ? e.message : String(e)}`,
        503
      )
    );
  }
};
