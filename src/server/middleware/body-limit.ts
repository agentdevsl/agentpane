/**
 * Body-size limit middleware (F06-NEW-09).
 *
 * Caps incoming request body size so the API and webhook surfaces cannot be
 * OOM'd by an attacker streaming arbitrarily large payloads. Bun's default
 * body limit is generous (~100MB); combined with the in-memory rate limiter
 * this would let a single client send tens of GB/min into Hono's memory.
 *
 * Behaviour:
 * - Reads `Content-Length` and short-circuits with 413 BEFORE the handler
 *   parses the body. This avoids buffering large payloads at all.
 * - For chunked / unknown-length requests (no `Content-Length`, e.g. with
 *   `Transfer-Encoding: chunked`), we wrap the request body in a streaming
 *   reader that aborts the stream once `maxBytes` is exceeded. The handler
 *   that calls `c.req.text()` / `c.req.json()` will then fail; we map that
 *   failure to a 413 response.
 *
 * Returns the canonical API error envelope `{ ok: false, error: { code,
 * message } }` so existing client error handling works unchanged. Errors use
 * the `PAYLOAD_TOO_LARGE` code, mirroring the cli-monitor route's existing
 * cap (`src/server/routes/cli-monitor.ts`).
 *
 * Usage:
 * ```ts
 * app.use('/api/*', bodyLimit({ maxBytes: 5 * 1024 * 1024 }));
 * app.use('/hooks/*', bodyLimit({ maxBytes: 5 * 1024 * 1024 }));
 * ```
 *
 * Cross-ref: spec `arch_review_april29/06-security.md` finding F06-NEW-09.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';

/** Default cap applied to `/api/*` and `/hooks/*` per April 29 review. */
export const DEFAULT_BODY_LIMIT_BYTES = 5 * 1024 * 1024; // 5MB

export interface BodyLimitOptions {
  /** Maximum allowed body size in bytes. Defaults to {@link DEFAULT_BODY_LIMIT_BYTES}. */
  maxBytes?: number;
}

/** Internal sentinel marking a stream that exceeded the cap mid-read. */
class BodyLimitExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} byte limit`);
    this.name = 'BodyLimitExceededError';
  }
}

function tooLarge(c: Context, maxBytes: number): Response {
  return c.json(
    {
      ok: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Request body exceeds ${maxBytes} byte limit`,
      },
    },
    413
  );
}

/**
 * Hono middleware that caps request body size.
 *
 * Methods that never carry a body (GET, HEAD, OPTIONS, DELETE) are skipped
 * to avoid wrapping unrelated requests in a stream reader.
 */
export function bodyLimit(options: BodyLimitOptions = {}): MiddlewareHandler {
  const maxBytes = options.maxBytes ?? DEFAULT_BODY_LIMIT_BYTES;

  return async function bodyLimitMiddleware(c: Context, next: Next) {
    // No body to inspect for read-only methods.
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'DELETE') {
      await next();
      return;
    }

    // Fast path: reject by Content-Length before reading anything.
    const contentLengthHeader = c.req.header('content-length');
    if (contentLengthHeader) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        return tooLarge(c, maxBytes);
      }
    }

    // Slow path: chunked or missing Content-Length — wrap the body so we
    // can abort once we've read more than `maxBytes`. Skip when the body
    // is absent (e.g. a POST with no body).
    const rawBody = c.req.raw.body;
    if (rawBody) {
      let totalRead = 0;
      const reader = rawBody.getReader();
      const wrapped = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            totalRead += value.byteLength;
            if (totalRead > maxBytes) {
              controller.error(new BodyLimitExceededError(maxBytes));
              return;
            }
            controller.enqueue(value);
          } catch (err) {
            controller.error(err);
          }
        },
        cancel(reason) {
          // Propagate cancellation upstream.
          reader.cancel(reason).catch(() => {
            /* swallow — reader already errored */
          });
        },
      });

      // Replace the raw request with one whose body is bounded.
      c.req.raw = new Request(c.req.raw, {
        body: wrapped,
        // `duplex: 'half'` is required by the Fetch spec for streaming bodies.
        // @ts-expect-error duplex is not yet in the standard RequestInit type
        duplex: 'half',
      });
    }

    try {
      await next();
    } catch (err) {
      if (isBodyLimitError(err)) {
        return tooLarge(c, maxBytes);
      }
      throw err;
    }

    // The handler may swallow stream errors via `c.req.text().catch(...)`
    // or — more commonly — Hono catches the throw internally and stores
    // it on `c.error` while the runtime returns a default 500 response.
    // Override that response with our 413 envelope. We also match by
    // name as a fallback because Bun's stream pipeline can wrap
    // controller errors in a way that breaks `instanceof`.
    if (isBodyLimitError(c.error)) {
      // Hono's compose layer already set c.res to a 500 when the handler
      // threw. Replace it with our 413 envelope and clear `c.error` so
      // the global onError handler doesn't double-respond / re-log.
      c.res = tooLarge(c, maxBytes);
      c.error = undefined;
    }
    return;
  };
}

/**
 * Identity check that survives realm-boundary serialisation. Bun's stream
 * pipeline can wrap controller errors in such a way that `instanceof`
 * yields `false` even when the same class was thrown — the only stable
 * marker is the constructor `name`.
 */
function isBodyLimitError(err: unknown): boolean {
  if (err instanceof BodyLimitExceededError) return true;
  if (err instanceof Error && err.name === 'BodyLimitExceededError') return true;
  return false;
}
