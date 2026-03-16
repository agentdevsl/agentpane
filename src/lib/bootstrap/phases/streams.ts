import { setStreamsAvailable } from '../../streams/client.js';
import { ok } from '../../utils/result.js';

/**
 * Initialize durable streams for the client.
 *
 * With Caddy durable streams, the client connects directly to the Caddy
 * SSE endpoints (e.g. /v1/stream/sessions/:id). This phase verifies
 * Caddy is reachable before declaring the streams subsystem ready.
 *
 * A 404 from Vite (when Caddy isn't running) is NOT treated as "reachable" —
 * it means the streams endpoint doesn't exist, so SSE subscriptions are disabled
 * to prevent retry loops that exhaust the browser's connection limit.
 */
export const connectStreams = async (_ctx?: unknown) => {
  // Build an absolute URL that works in both browser and SSR contexts.
  // In the browser, use the current origin. In SSR/test, fall back to
  // CADDY_STREAMS_URL env var or localhost:3000.
  const base =
    typeof window !== 'undefined'
      ? window.location.origin
      : (process.env.CADDY_STREAMS_URL ?? 'http://localhost:3000');
  const streamsUrl = `${base}/v1/stream`;

  try {
    const response = await fetch(streamsUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      // Caddy is actually running and streams are available
      console.log(`[Streams] Caddy durable streams reachable at ${streamsUrl}`);
      setStreamsAvailable(true);
      return ok(null);
    }
    // 404 = Vite responding, not Caddy. Streams are NOT available.
    console.warn(`[Streams] Caddy not available (HTTP ${response.status}). SSE streams disabled.`);
    setStreamsAvailable(false);
    return ok(null); // Still succeed bootstrap (streams are optional in dev)
  } catch {
    console.warn(`[Streams] Caddy not reachable at ${streamsUrl}. SSE streams disabled.`);
    setStreamsAvailable(false);
    return ok(null); // Non-fatal in dev mode
  }
};
