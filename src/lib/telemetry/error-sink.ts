/**
 * F10-04 — error-reporting sink.
 *
 * The observability review called out that we have no aggregation target for
 * uncaught exceptions, unhandled rejections, Hono `app.onError` traffic, or
 * `invariant()` violations: everything goes to stdout and dies. This module
 * introduces a thin `captureException()` abstraction so each of those sites
 * can forward the error through a single choke point.
 *
 * The default sink is the structured logger + an in-memory ring buffer so
 * tests (and a debug endpoint if we later want one) can inspect what was
 * reported. A Sentry-style adapter will be wired in when we add the runtime
 * dep; until then, `SENTRY_DSN` merely causes a log breadcrumb so operators
 * can confirm env propagation without importing `@sentry/node`.
 */

import { createLogger } from '../logging/logger.js';

const log = createLogger('ErrorSink');

export interface ErrorContext {
  /** Where the capture was invoked — e.g. 'hono:onError', 'invariant', 'process:uncaughtException'. */
  source: string;
  /** Request ID from AsyncLocalStorage, when known. */
  requestId?: string | undefined;
  /** Matched Hono route pattern (low-cardinality), when known. */
  route?: string | undefined;
  /** HTTP method, when applicable. */
  method?: string | undefined;
  /** Task/session/codespace IDs so Sentry filters work once wired. */
  taskId?: string | undefined;
  sessionId?: string | undefined;
  codespaceId?: string | undefined;
  /** Arbitrary extra fields — passed through to the sink. */
  [key: string]: unknown;
}

export interface CapturedError {
  timestamp: string;
  message: string;
  stack?: string;
  name?: string;
  context: ErrorContext;
}

/**
 * Sink abstraction. The default writes to the structured logger + an in-memory
 * ring buffer. A future Sentry adapter registers via {@link setErrorSink}.
 */
export interface ErrorSink {
  capture(err: unknown, context: ErrorContext): void;
}

const RING_CAPACITY = 100;
const ring: CapturedError[] = [];

function normalizeError(err: unknown): { message: string; stack?: string; name?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, name: err.name };
  }
  return { message: typeof err === 'string' ? err : JSON.stringify(err ?? 'unknown') };
}

const defaultSink: ErrorSink = {
  capture(err, context) {
    const normalized = normalizeError(err);
    const entry: CapturedError = {
      timestamp: new Date().toISOString(),
      ...normalized,
      context,
    };
    ring.push(entry);
    if (ring.length > RING_CAPACITY) ring.shift();

    // Always mirror through the structured logger so the existing masking +
    // request-id threading kicks in automatically.
    log.error(`captureException: ${normalized.message}`, {
      error: err,
      data: { ...context },
    });
  },
};

let activeSink: ErrorSink = defaultSink;

/**
 * Replace the active sink. Intended for the Sentry adapter follow-up and for
 * tests. Pass `null` to reset to the default.
 */
export function setErrorSink(sink: ErrorSink | null): void {
  activeSink = sink ?? defaultSink;
}

/** Primary entry point. Swallows its own failures so callers cannot be destabilised. */
export function captureException(err: unknown, context: ErrorContext): void {
  try {
    activeSink.capture(err, context);
  } catch (sinkErr) {
    // Even the fallback log shouldn't explode — guard that too.
    try {
      log.warn('captureException: sink failed', {
        error: sinkErr instanceof Error ? sinkErr.message : String(sinkErr),
      });
    } catch {
      // Last-resort swallow.
    }
  }
}

/** Read the ring buffer. Intended for tests / debug endpoints. */
export function getRecentCapturedErrors(): CapturedError[] {
  return ring.slice();
}

/** Test helper — clear the ring buffer. */
export function __resetErrorSink(): void {
  ring.length = 0;
  activeSink = defaultSink;
}

/**
 * Best-effort Sentry env hook. We deliberately avoid importing `@sentry/node`
 * so this change stays dependency-free — a future PR adds the dep + adapter
 * and swaps the sink via {@link setErrorSink}. We log a breadcrumb so ops can
 * verify the env var is reaching the process.
 */
export function initSentryIfConfigured(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || dsn.length === 0) return;
  log.info('SENTRY_DSN detected — adapter is not wired in this build', {
    data: { dsnConfigured: true },
  });
}
