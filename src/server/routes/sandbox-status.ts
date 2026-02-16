/**
 * Sandbox Status routes
 *
 * Provides API endpoint for getting sandbox mode and container status.
 * Includes self-healing: auto-creates the default sandbox when Docker
 * is available but no container exists.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { settings } from '../../db/schema';
import type { EventEmittingSandboxProvider } from '../../lib/sandbox/index.js';
import { SANDBOX_DEFAULTS } from '../../lib/sandbox/types.js';
import type { Database } from '../../types/database.js';
import { isValidId, json } from '../shared.js';

/** Minimal interface for reading K8s provider health in status routes. */
interface K8sProviderHealth {
  healthCheck(): Promise<{
    healthy: boolean;
    message?: string;
    details?: Record<string, unknown>;
  }>;
  listSandboxes?(): Promise<Array<{ name: string; phase: string }>>;
}

interface SandboxStatusDeps {
  db: Database;
  getDockerProvider: () => EventEmittingSandboxProvider | null;
  getK8sProvider?: () => K8sProviderHealth | null;
}

// Track in-flight auto-heal to prevent concurrent attempts
let autoHealInProgress = false;

/**
 * Load sandbox defaults from settings or use built-in defaults.
 */
async function loadSandboxDefaults(db: Database) {
  try {
    const globalDefaults = await db.query.settings.findFirst({
      where: eq(settings.key, 'sandbox.defaults'),
    });
    if (globalDefaults?.value) {
      return JSON.parse(globalDefaults.value) as {
        image?: string;
        memoryMb?: number;
        cpuCores?: number;
        idleTimeoutMinutes?: number;
      };
    }
  } catch {
    // Use built-in defaults
  }
  return null;
}

/**
 * Auto-heal: create the default sandbox container when Docker is available
 * but no container exists. Runs at most once at a time.
 */
async function autoHealSandbox(
  db: Database,
  dockerProvider: EventEmittingSandboxProvider,
  lookupId: string
): Promise<boolean> {
  if (autoHealInProgress) return false;

  autoHealInProgress = true;
  try {
    const defaults = await loadSandboxDefaults(db);
    const image = defaults?.image ?? SANDBOX_DEFAULTS.image;

    // Check if image is available before attempting to create
    const imageAvailable = await dockerProvider.isImageAvailable(image);
    if (!imageAvailable) {
      console.log(`[SandboxStatus] Auto-heal skipped: image '${image}' not available`);
      return false;
    }

    const workspacePath = path.join(process.cwd(), 'data', 'sandbox-workspaces', lookupId);
    await fs.mkdir(workspacePath, { recursive: true });

    await dockerProvider.create({
      projectId: lookupId,
      projectPath: workspacePath,
      image,
      memoryMb: defaults?.memoryMb ?? SANDBOX_DEFAULTS.memoryMb,
      cpuCores: defaults?.cpuCores ?? SANDBOX_DEFAULTS.cpuCores,
      idleTimeoutMinutes: defaults?.idleTimeoutMinutes ?? SANDBOX_DEFAULTS.idleTimeoutMinutes,
      volumeMounts: [],
    });

    console.log(`[SandboxStatus] Auto-heal: created sandbox for '${lookupId}'`);
    return true;
  } catch (error) {
    console.error(
      '[SandboxStatus] Auto-heal failed:',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  } finally {
    autoHealInProgress = false;
  }
}

export function createSandboxStatusRoutes({
  db,
  getDockerProvider,
  getK8sProvider,
}: SandboxStatusDeps) {
  const app = new Hono();

  // GET /api/sandbox/status/:projectId - Get sandbox mode and container status
  app.get('/:projectId', async (c) => {
    const projectId = c.req.param('projectId');

    if (!isValidId(projectId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid project ID' } }, 400);
    }

    try {
      // Get sandbox mode from settings
      const modeSetting = await db.query.settings.findFirst({
        where: eq(settings.key, 'sandbox.mode'),
      });
      const sandboxMode = modeSetting?.value ? JSON.parse(modeSetting.value) : 'shared';

      // Get container status from docker provider (uses getter for deferred initialization)
      let containerStatus: 'stopped' | 'creating' | 'running' | 'idle' | 'error' | 'unavailable' =
        'unavailable';
      let containerId: string | null = null;
      const dockerProvider = getDockerProvider();

      if (dockerProvider) {
        try {
          const lookupId = sandboxMode === 'shared' ? 'default' : projectId;

          // Validate cached containers are still alive in Docker before checking status
          if (
            typeof (dockerProvider as unknown as { validateContainers: () => Promise<void> })
              .validateContainers === 'function'
          ) {
            await (
              dockerProvider as unknown as { validateContainers: () => Promise<void> }
            ).validateContainers();
          }

          let sandbox = await dockerProvider.get(lookupId);

          // Self-healing: auto-create sandbox if Docker is available but container is missing
          if (!sandbox) {
            const healed = await autoHealSandbox(db, dockerProvider, lookupId);
            if (healed) {
              sandbox = await dockerProvider.get(lookupId);
            }
          }

          if (sandbox) {
            containerStatus = sandbox.status as typeof containerStatus;
            containerId = sandbox.containerId ?? null;
          } else {
            containerStatus = 'stopped';
          }
        } catch {
          containerStatus = 'error';
        }
      }

      // Gather K8s health fields when the provider is available
      let k8sCrdReady = false;
      let k8sClusterVersion: string | null = null;
      let k8sPodCount = 0;
      let k8sPodsRunning = 0;

      const k8sProvider = getK8sProvider?.();
      if (k8sProvider) {
        try {
          const health = await k8sProvider.healthCheck();
          const details = health.details ?? {};
          k8sCrdReady = details.crdRegistered === true && details.namespaceExists === true;
          k8sClusterVersion =
            typeof details.clusterVersion === 'string' ? details.clusterVersion : null;
          // Pod counts come from listSandboxes if available
          if (k8sProvider.listSandboxes) {
            try {
              const sandboxes = await k8sProvider.listSandboxes();
              k8sPodCount = sandboxes.length;
              k8sPodsRunning = sandboxes.filter((s) => s.phase === 'Running').length;
            } catch {
              // Best effort
            }
          }
        } catch {
          // Best effort — leave defaults
        }
      }

      return json({
        ok: true,
        data: {
          mode: sandboxMode,
          containerStatus,
          containerId,
          dockerAvailable: !!dockerProvider,
          provider: dockerProvider?.name ?? 'none',
          k8sCrdReady,
          k8sClusterVersion,
          k8sPodCount,
          k8sPodsRunning,
        },
      });
    } catch (error) {
      console.error('[SandboxStatus] Error:', error);
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to get sandbox status' } },
        500
      );
    }
  });

  // POST /api/sandbox/status/:projectId/restart - Restart the sandbox container
  app.post('/:projectId/restart', async (c) => {
    const projectId = c.req.param('projectId');

    if (!isValidId(projectId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid project ID' } }, 400);
    }

    const dockerProviderForRestart = getDockerProvider();
    if (!dockerProviderForRestart) {
      return json(
        { ok: false, error: { code: 'DOCKER_UNAVAILABLE', message: 'Docker is not available' } },
        503
      );
    }

    try {
      // Get sandbox mode to determine which container to restart
      const modeSetting = await db.query.settings.findFirst({
        where: eq(settings.key, 'sandbox.mode'),
      });
      const sandboxMode = modeSetting?.value ? JSON.parse(modeSetting.value) : 'shared';
      const lookupId = sandboxMode === 'shared' ? 'default' : projectId;

      // Cast to access restart method (it's on DockerProvider but not the interface)
      const provider = dockerProviderForRestart as unknown as {
        restart: (id: string) => Promise<unknown>;
      };

      if (typeof provider.restart !== 'function') {
        return json(
          { ok: false, error: { code: 'NOT_SUPPORTED', message: 'Restart not supported' } },
          501
        );
      }

      await provider.restart(lookupId);

      return json({
        ok: true,
        data: { message: 'Container restarted successfully' },
      });
    } catch (error) {
      console.error('[SandboxStatus] Restart error:', error);
      const message = error instanceof Error ? error.message : 'Failed to restart container';
      return json({ ok: false, error: { code: 'RESTART_FAILED', message } }, 500);
    }
  });

  return app;
}
