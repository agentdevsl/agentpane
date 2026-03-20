/**
 * Bun API Server
 *
 * Entry point for the API server. Delegates all initialization
 * to the structured bootstrap pipeline.
 *
 * Previously 1,671 lines — now delegates to src/server/bootstrap/.
 */

import { createLogger } from '../lib/logging/logger.js';
import { run } from './bootstrap/server-bootstrap.js';

const log = createLogger('APIServer');

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception', { error });
});

process.on('unhandledRejection', (reason, _promise) => {
  log.error('Unhandled Rejection', { error: reason });
});

// Run the bootstrap pipeline
run().catch((error) => {
  log.error('Server bootstrap failed', { error });
  process.exit(1);
});
