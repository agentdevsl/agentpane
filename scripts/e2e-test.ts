#!/usr/bin/env bun
/**
 * E2E Test Runner Script
 *
 * Runs E2E tests with proper server management.
 * Starts the dev server if not already running, runs tests, then cleans up.
 *
 * Usage:
 *   bun scripts/e2e-test.ts              # Run all E2E tests
 *   bun scripts/e2e-test.ts --headed     # Run with visible browser
 *   bun scripts/e2e-test.ts <test-file>  # Run specific test file
 */
import { type Subprocess, spawn } from 'bun';

const PORT = process.env.E2E_PORT ?? '3000';
const HOST = process.env.E2E_HOST ?? 'localhost';
const BASE_URL = `http://${HOST}:${PORT}`;
const STARTUP_TIMEOUT = 60000;

let serverProcess: Subprocess | null = null;
let shouldCleanupServer = false;

async function isServerRunning(): Promise<boolean> {
  try {
    const response = await fetch(BASE_URL, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2000),
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function waitForServer(timeout: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isServerRunning()) {
      return true;
    }
    await Bun.sleep(1000);
  }
  return false;
}

async function startServer(): Promise<Subprocess> {
  console.log(`🚀 Starting dev server on ${BASE_URL}...`);

  const proc = spawn({
    cmd: ['bun', 'run', 'dev'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT,
      NODE_ENV: 'test',
      VITE_E2E_SEED: 'true',
      PGLITE_DATA_DIR: 'memory://agentpane-e2e',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  return proc;
}

async function runTests(args: string[]): Promise<number> {
  console.log('🧪 Running E2E tests...\n');

  const testArgs = ['vitest', '--config', 'vitest.e2e.config.ts'];

  // Pass through any additional arguments
  const filteredArgs = args.filter((arg) => !arg.includes('e2e-test'));
  if (filteredArgs.length > 0) {
    testArgs.push(...filteredArgs);
  }

  // Set environment for tests
  const env = {
    ...process.env,
    E2E_BASE_URL: BASE_URL,
    HEADLESS: args.includes('--headed') ? 'false' : 'true',
  };

  const testProcess = spawn({
    cmd: ['bunx', ...testArgs],
    cwd: process.cwd(),
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await testProcess.exited;
  return exitCode;
}

async function cleanup(): Promise<void> {
  if (serverProcess && shouldCleanupServer) {
    console.log('\n🛑 Stopping dev server...');
    serverProcess.kill();
    await serverProcess.exited.catch(() => {
      /* Best-effort: process may already be dead */
    });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check if server is already running
  if (await isServerRunning()) {
    console.log(`✅ Server already running at ${BASE_URL}`);
  } else {
    // Start the server
    serverProcess = await startServer();
    shouldCleanupServer = true;

    // Wait for server to be ready
    console.log('⏳ Waiting for server to be ready...');
    const ready = await waitForServer(STARTUP_TIMEOUT);

    if (!ready) {
      console.error(`\n❌ Server failed to start within ${STARTUP_TIMEOUT / 1000} seconds`);
      console.error('💡 Try starting the server manually with: bun run dev');
      await cleanup();
      process.exit(1);
    }

    console.log('✅ Server is ready\n');
  }

  // Run the tests
  const exitCode = await runTests(args);

  // Cleanup
  await cleanup();

  process.exit(exitCode);
}

// Handle interrupts
process.on('SIGINT', async () => {
  console.log('\n⚠️  Interrupted');
  await cleanup();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(143);
});

main().catch(async (error) => {
  console.error('E2E test runner error:', error);
  await cleanup();
  process.exit(1);
});
