import { createLogger } from '../../logging/logger.js';
import { setStreamsAvailable } from '../../streams/client.js';
import { ok } from '../../utils/result.js';

const log = createLogger('streams');

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
    // A durable-streams server (Caddy or test server) returns stream-specific headers
    // even on 404 (no streams yet). A plain Vite 404 won't have these.
    const isDurableStreams =
      response.ok || response.headers.get('access-control-allow-headers')?.includes('Stream-Seq');
    if (isDurableStreams) {
      setStreamsAvailable(true);
      return ok(null);
    }
    setStreamsAvailable(false);
    return ok(null);
    // nosemgrep: agentpane.error-masking.catch-returns-ok-helper
  } catch (error) {
    log.warn('Failed to connect to streams server', { error });
    setStreamsAvailable(false);
    return ok(null);
  }
};
