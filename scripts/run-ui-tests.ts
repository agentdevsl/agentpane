#!/usr/bin/env bun
/**
 * UI Test Runner Script
 *
 * Starts the dev server and runs only the agent-browser E2E UI tests.
 *
 * Usage:
 *   bun scripts/run-ui-tests.ts              # Run all UI tests
 *   bun scripts/run-ui-tests.ts --headed     # Run with visible browser
 *   bun scripts/run-ui-tests.ts <pattern>    # Run tests matching pattern
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
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    // Reject 5xx server errors - these indicate the server is broken
    if (response.status >= 500) {
      return false;
    }

    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function isServerHealthy(): Promise<{ healthy: boolean; error?: string }> {
  try {
    const response = await fetch(BASE_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });

    if (response.status >= 500) {
      return {
        healthy: false,
        error: `Server returned ${response.status} error`,
      };
    }

    if (!response.ok && response.status !== 404) {
      return {
        healthy: false,
        error: `Server returned ${response.status}`,
      };
    }

    // Check that we get valid HTML back
    const html = await response.text();
    if (!html.includes('<!DOCTYPE html>') && !html.includes('<html')) {
      return {
        healthy: false,
        error: 'Server did not return valid HTML',
      };
    }

    return { healthy: true };
  } catch (err) {
    return {
      healthy: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

async function waitForServer(timeout: number): Promise<boolean> {
  const start = Date.now();
  process.stdout.write('⏳ Waiting for server');
  while (Date.now() - start < timeout) {
    if (await isServerRunning()) {
      process.stdout.write('\n');
      return true;
    }
    process.stdout.write('.');
    await Bun.sleep(1000);
  }
  process.stdout.write('\n');
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
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  return proc;
}

async function runTests(args: string[]): Promise<number> {
  console.log('🧪 Running agent-browser UI tests...\n');

  const testArgs = ['vitest', 'run', '--config', 'vitest.e2e.config.ts'];

  // Filter out script-specific args
  const filteredArgs = args.filter((arg) => !arg.includes('run-ui-tests') && arg !== '--headed');

  if (filteredArgs.length > 0) {
    testArgs.push(...filteredArgs);
  }

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

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           Agent-Browser UI Test Runner                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Check if server is already running
  if (await isServerRunning()) {
    console.log(`✅ Server already running at ${BASE_URL}`);
  } else {
    serverProcess = await startServer();
    shouldCleanupServer = true;

    const ready = await waitForServer(STARTUP_TIMEOUT);

    if (!ready) {
      console.error(`\n❌ Server failed to start within ${STARTUP_TIMEOUT / 1000} seconds`);
      console.error('💡 Try starting the server manually with: bun run dev');
      await cleanup();
      process.exit(1);
    }

    console.log('✅ Server is ready');
  }

  // Perform health check to ensure server is responding correctly
  console.log('🔍 Performing server health check...');
  const health = await isServerHealthy();

  if (!health.healthy) {
    console.error(`\n❌ Server health check failed: ${health.error}`);
    console.error('💡 The server is running but returning errors.');
    console.error('💡 Check server logs with: bun run dev');
    await cleanup();
    process.exit(1);
  }

  console.log('✅ Server health check passed\n');

  const exitCode = await runTests(args);

  await cleanup();

  if (exitCode === 0) {
    console.log('\n✅ All UI tests passed!');
  } else {
    console.log('\n❌ Some UI tests failed');
  }

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
  console.error('UI test runner error:', error);
  await cleanup();
  process.exit(1);
});
