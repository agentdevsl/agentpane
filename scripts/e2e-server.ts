#!/usr/bin/env bun
/**
 * E2E Test Server Script
 *
 * Starts the development server for E2E testing and waits for it to be ready.
 * Can be used standalone or with the e2e-test.ts script.
 *
 * Usage:
 *   bun scripts/e2e-server.ts        # Start server and keep running
 *   bun scripts/e2e-server.ts --wait # Start and wait for ready signal only
 */
import { type Subprocess, spawn } from 'bun';

const PORT = process.env.E2E_PORT ?? '3000';
const HOST = process.env.E2E_HOST ?? 'localhost';
const BASE_URL = `http://${HOST}:${PORT}`;
const STARTUP_TIMEOUT = 60000; // 60 seconds
const HEALTH_CHECK_INTERVAL = 1000; // 1 second

let serverProcess: Subprocess | null = null;

async function waitForServer(url: string, timeout: number): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok || response.status === 404) {
        // 404 is acceptable - server is responding
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await Bun.sleep(HEALTH_CHECK_INTERVAL);
  }

  return false;
}

async function startServer(): Promise<Subprocess> {
  console.log(`Starting dev server on ${BASE_URL}...`);

  const proc = spawn({
    cmd: ['bun', 'run', 'dev'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT,
      NODE_ENV: 'test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Stream server output
  const stdout = proc.stdout;
  const stderr = proc.stderr;

  if (stdout) {
    const reader = stdout.getReader();
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          process.stdout.write(value);
        }
      } catch {
        // Process ended
      }
    })();
  }

  if (stderr) {
    const reader = stderr.getReader();
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          process.stderr.write(value);
        }
      } catch {
        // Process ended
      }
    })();
  }

  return proc;
}

async function main(): Promise<void> {
  const waitOnly = process.argv.includes('--wait');

  // Check if server is already running
  const alreadyRunning = await waitForServer(BASE_URL, 3000);
  if (alreadyRunning) {
    console.log(`Server already running at ${BASE_URL}`);
    if (waitOnly) {
      process.exit(0);
    }
    // Keep running to allow manual testing
    console.log('Press Ctrl+C to exit');
    await new Promise(() => {
      /* Wait forever */
    });
    return;
  }

  // Start the server
  serverProcess = await startServer();

  // Wait for server to be ready
  console.log('Waiting for server to be ready...');
  const ready = await waitForServer(BASE_URL, STARTUP_TIMEOUT);

  if (!ready) {
    console.error(`Server failed to start within ${STARTUP_TIMEOUT / 1000} seconds`);
    serverProcess.kill();
    process.exit(1);
  }

  console.log(`Server ready at ${BASE_URL}`);

  if (waitOnly) {
    // Just signal readiness and exit (let parent manage server)
    process.exit(0);
  }

  // Keep running until interrupted
  console.log('Press Ctrl+C to stop the server');

  process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    serverProcess?.kill();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    serverProcess?.kill();
    process.exit(0);
  });

  // Wait for server process to exit
  await serverProcess.exited;
}

main().catch((error) => {
  console.error('E2E server error:', error);
  serverProcess?.kill();
  process.exit(1);
});
