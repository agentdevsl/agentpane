import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AgentPaneClient } from './agentpane-client.js';
import { printError, printStatusBox } from './display.js';
import { logger } from './logger.js';
import { SessionStore } from './session-store.js';
import { createId, errorMessage } from './utils.js';
import { VERSION } from './version.js';
import { FileWatcher } from './watcher.js';

const IDLE_SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_SESSION_EVICTION_MS = 30 * 60 * 1000; // 30 minutes

// ── PID Lock ──

const LOCK_FILE = path.join(homedir(), '.claude', '.cli-monitor.lock');

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(): Promise<boolean> {
  try {
    try {
      const content = await fsp.readFile(LOCK_FILE, 'utf-8');
      const pid = parseInt(content, 10);
      if (pid && isProcessRunning(pid)) {
        return false; // Another daemon is running
      }
    } catch {
      // No lock file exists
    }
    await fsp.mkdir(path.dirname(LOCK_FILE), { recursive: true });
    await fsp.writeFile(LOCK_FILE, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await fsp.unlink(LOCK_FILE);
  } catch {
    /* ok */
  }
}

export { acquireLock, isProcessRunning, LOCK_FILE, releaseLock };

export interface DaemonOptions {
  port: number;
  watchPath?: string;
  background?: boolean;
  retentionDays?: number;
}

export async function startDaemon(options: DaemonOptions): Promise<void> {
  // Fork to background if --daemon flag is set
  if (options.background) {
    const childArgs = ['start', '--port', String(options.port)];
    if (options.watchPath) childArgs.push('--path', options.watchPath);
    if (options.retentionDays) childArgs.push('--retention', String(options.retentionDays));
    const scriptPath = process.argv[1] ?? '';
    const child = spawn(process.execPath, [scriptPath, ...childArgs], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(`Daemon started in background (PID ${child.pid}).`);
    return;
  }

  const daemonId = `dm_${createId()}`;
  const watchDir = options.watchPath || path.join(homedir(), '.claude', 'projects');
  const client = new AgentPaneClient(options.port);
  const store = new SessionStore();

  const buildRegisterPayload = () => ({
    daemonId,
    pid: process.pid,
    version: VERSION,
    watchPath: watchDir,
    capabilities: ['watch', 'parse', 'subagents'],
    startedAt: Date.now(),
  });
  let watcher: FileWatcher | null = null;
  let ingestTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let isShuttingDown = false;

  // Graceful shutdown
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Shutting down...');

    if (ingestTimer) clearInterval(ingestTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (watcher) watcher.close();

    try {
      await client.deregister(daemonId);
    } catch (err) {
      logger.error('Deregister on shutdown failed', {
        error: errorMessage(err),
      });
    }
    await releaseLock();
    process.exit(0);
  };

  // Signal handlers must handle the async shutdown properly.
  // Use a forced exit timeout to prevent hanging if cleanup stalls.
  const handleSignal = () => {
    void shutdown().finally(() => {
      // shutdown() calls process.exit(0) on success,
      // but if it somehow doesn't exit, force it after 5s
    });
    setTimeout(() => {
      logger.error('Forced exit after shutdown timeout');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
  process.on('SIGHUP', handleSignal);

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: String(error) });
    handleSignal();
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { error: String(reason) });
    handleSignal();
  });

  // Acquire PID lock
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    logger.error('Another daemon instance is already running. Exiting.');
    process.exit(1);
  }

  // Connect to AgentPane with retry
  let connected = false;
  let retryDelay = 1000;
  const maxRetryDelay = 30000;

  while (!connected && !isShuttingDown) {
    try {
      await client.register(buildRegisterPayload());
      connected = true;
      retryDelay = 1000; // Reset on success
    } catch {
      printError(
        `Could not connect to AgentPane at localhost:${options.port}. Retrying in ${retryDelay / 1000}s...`
      );
      await new Promise((r) => setTimeout(r, retryDelay));
      retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
    }
  }

  if (isShuttingDown) return;

  // Start file watcher
  watcher = new FileWatcher(watchDir, store, options.retentionDays ?? 7);
  await watcher.start();

  // Print status
  const fileCount = store.getSessionCount();
  printStatusBox({
    version: VERSION,
    serverUrl: `http://localhost:${options.port}`,
    watchPath: watchDir,
    sessionCount: fileCount,
  });

  // Heartbeat every 10s (unref to not block exit)
  const doReregister = async () => {
    try {
      await client.register(buildRegisterPayload());
      store.markAllChanged();
      logger.info('Re-registered with server, triggering full session re-sync');
    } catch (retryErr) {
      logger.error('Re-register failed', {
        error: errorMessage(retryErr),
      });
    }
  };

  heartbeatTimer = setInterval(async () => {
    try {
      const result = await client.heartbeat(daemonId, store.getSessionCount());
      if (result === 'reregister') {
        logger.info('Server requested re-registration');
        await doReregister();
      }
    } catch (err) {
      logger.error('Heartbeat failed', { error: errorMessage(err) });
      await doReregister();
    }
  }, 10_000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  // Ingest batch every 500ms
  let ingestInFlight = false;
  let idleCheckCounter = 0;

  ingestTimer = setInterval(async () => {
    // D5: Idle check every 30s (60 * 500ms)
    idleCheckCounter++;
    if (idleCheckCounter >= 60) {
      idleCheckCounter = 0;
      store.markIdleSessions(IDLE_SESSION_TIMEOUT_MS);
      const evicted = store.evictIdleSessions(IDLE_SESSION_EVICTION_MS);
      if (evicted > 0) logger.info('Evicted idle sessions', { count: evicted });
    }

    if (ingestInFlight) return;
    const { updated, removed } = store.flushChanges();
    if (updated.length === 0 && removed.length === 0) return;

    ingestInFlight = true;
    try {
      await client.ingest(daemonId, updated, removed);
    } catch (err) {
      logger.error('Ingest failed', { error: errorMessage(err) });
      store.markPendingRetry(updated, removed);
    } finally {
      ingestInFlight = false;
    }
  }, 500);
  if (ingestTimer.unref) ingestTimer.unref();
}
