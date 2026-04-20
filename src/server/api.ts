/**
 * Bun API Server
 *
 * Entry point for the API server. Delegates all initialization
 * to the structured bootstrap pipeline.
 *
 * Previously 1,671 lines — now delegates to src/server/bootstrap/.
 */

import { createLogger } from '../lib/logging/logger.js';
import { captureException, initSentryIfConfigured } from '../lib/telemetry/error-sink.js';
import { run } from './bootstrap/server-bootstrap.js';

const log = createLogger('APIServer');

// F10-04: initialise the (optional) Sentry adapter before handlers install.
// Currently a no-op beyond a log breadcrumb when SENTRY_DSN is set; full
// Sentry wiring is a follow-up without a dependency add.
initSentryIfConfigured();

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception', { error });
  captureException(error, { source: 'process:uncaughtException' });
});

process.on('unhandledRejection', (reason, _promise) => {
  log.error('Unhandled Rejection', { error: reason });
  captureException(reason, { source: 'process:unhandledRejection' });
});

// Run the bootstrap pipeline
run().catch((error) => {
  log.error('Server bootstrap failed', { error });
  captureException(error, { source: 'bootstrap' });
  process.exit(1);
});
