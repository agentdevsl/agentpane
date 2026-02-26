/**
 * Dev-mode durable streams server.
 * Starts DurableStreamTestServer on :3002 to provide the same
 * streaming API that Caddy provides in production.
 */
import { DurableStreamTestServer } from '@durable-streams/server';

const PORT = parseInt(process.env.STREAMS_PORT ?? '3002', 10);

const server = new DurableStreamTestServer({
  port: PORT,
  host: '0.0.0.0',
  longPollTimeout: 30_000,
});

const url = await server.start();
console.log(`[Streams] DurableStreamTestServer running at ${url}`);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Streams] Shutting down...');
  await server.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Streams] Shutting down...');
  await server.stop();
  process.exit(0);
});
