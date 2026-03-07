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
import { createLogger } from '../../lib/logging/logger.js';
import type { EventEmittingSandboxProvider } from '../../lib/sandbox/index.js';
import { SANDBOX_DEFAULTS } from '../../lib/sandbox/types.js';
import type { Database } from '../../types/database.js';
import { isValidId, json } from '../shared.js';

const log = createLogger('SandboxStatus');

/** Extended sandbox provider health interface for status routes (includes auto-heal support). */
interface SandboxProviderHealth {
  healthCheck(): Promise<{
    healthy: boolean;
    message?: string;
    details?: Record<string, unknown>;
  }>;
  listSandboxes?(): Promise<Array<{ name: string; phase: string }>>;
  get?(projectId: string): Promise<unknown>;
  create?(config: {
    projectId: string;
    projectPath: string;
    image: string;
    memoryMb: number;
    cpuCores: number;
    idleTimeoutMinutes: number;
    volumeMounts: unknown[];
  }): Promise<unknown>;
}

interface SandboxStatusDeps {
  db: Database;
  getDockerProvider: () => EventEmittingSandboxProvider | null;
  getK8sProvider?: () => SandboxProviderHealth | null;
  getNomadProvider?: () => SandboxProviderHealth | null;
  getAgentCoreProvider?: () => SandboxProviderHealth | null;
}

// Track in-flight auto-heal to prevent concurrent attempts
let autoHealInProgress = false;
let k8sAutoHealInProgress = false;

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
  } catch (err) {
    log.warn('Failed to load sandbox defaults from database, using built-in defaults', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
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
      log.info('Auto-heal skipped: image not available', { data: { image } });
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

    log.info('Auto-heal: created sandbox', { data: { lookupId } });
    return true;
  } catch (error) {
    log.error('Auto-heal failed', { error });
    return false;
  } finally {
    autoHealInProgress = false;
  }
}

/**
 * Auto-heal: create a sandbox pod via the K8s provider when none exists.
 * Mirrors autoHealSandbox for Docker but delegates to the CRD provider.
 */
async function autoHealK8sSandbox(
  db: Database,
  k8sProvider: SandboxProviderHealth,
  lookupId: string
): Promise<boolean> {
  if (k8sAutoHealInProgress) return false;
  if (!k8sProvider.create) return false;

  k8sAutoHealInProgress = true;
  try {
    const defaults = await loadSandboxDefaults(db);
    const image = defaults?.image ?? SANDBOX_DEFAULTS.image;

    await k8sProvider.create({
      projectId: lookupId,
      projectPath: '/workspace',
      image,
      memoryMb: defaults?.memoryMb ?? SANDBOX_DEFAULTS.memoryMb,
      cpuCores: defaults?.cpuCores ?? SANDBOX_DEFAULTS.cpuCores,
      idleTimeoutMinutes: defaults?.idleTimeoutMinutes ?? SANDBOX_DEFAULTS.idleTimeoutMinutes,
      volumeMounts: [],
    });

    log.info('K8s auto-heal: created sandbox', { data: { lookupId } });
    return true;
  } catch (error) {
    log.error('K8s auto-heal failed', { error });
    return false;
  } finally {
    k8sAutoHealInProgress = false;
  }
}

export function createSandboxStatusRoutes({
  db,
  getDockerProvider,
  getK8sProvider,
  getNomadProvider,
  getAgentCoreProvider,
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
        } catch (err) {
          log.warn('Docker sandbox lookup failed', {
            error: err instanceof Error ? err : new Error(String(err)),
          });
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
            } catch (err) {
              log.warn('K8s listSandboxes failed', {
                error: err instanceof Error ? err : new Error(String(err)),
              });
            }
          }

          // Self-healing: auto-create K8s sandbox if cluster is healthy but no pods exist
          if (k8sCrdReady && k8sPodCount === 0) {
            const lookupId =
              (await db.query.settings
                .findFirst({ where: eq(settings.key, 'sandbox.mode') })
                .then((s) => (s?.value ? JSON.parse(s.value) : 'shared'))
                .catch(() => 'shared')) === 'shared'
                ? 'default'
                : projectId;
            const healed = await autoHealK8sSandbox(db, k8sProvider, lookupId);
            if (healed) {
              // Re-count pods after healing
              if (k8sProvider.listSandboxes) {
                try {
                  const sandboxes = await k8sProvider.listSandboxes();
                  k8sPodCount = sandboxes.length;
                  k8sPodsRunning = sandboxes.filter((s) => s.phase === 'Running').length;
                } catch (err) {
                  log.warn('K8s re-count pods failed after auto-heal', {
                    error: err instanceof Error ? err : new Error(String(err)),
                  });
                }
              }
            }
          }
        } catch (err) {
          log.warn('K8s health check failed', {
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }

      // Gather Nomad health fields when the provider is available
      let nomadHealthy = false;
      let nomadVersion: string | null = null;
      let nomadLeader: string | null = null;
      let nomadJobCount = 0;

      const nomadProvider = getNomadProvider?.();
      if (nomadProvider) {
        try {
          const health = await nomadProvider.healthCheck();
          nomadHealthy = health.healthy;
          const details = health.details ?? {};
          nomadVersion = typeof details.version === 'string' ? details.version : null;
          nomadLeader = typeof details.leader === 'string' ? details.leader : null;
          nomadJobCount = typeof details.jobCount === 'number' ? details.jobCount : 0;
        } catch (err) {
          log.warn('Nomad health check failed in status route', {
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }

      // Gather AgentCore health fields when the provider is available
      let agentCoreHealthy = false;
      let agentCoreRegion: string | null = null;

      const agentCoreProvider = getAgentCoreProvider?.();
      if (agentCoreProvider) {
        try {
          const health = await agentCoreProvider.healthCheck();
          agentCoreHealthy = health.healthy;
          const details = health.details ?? {};
          agentCoreRegion = typeof details.region === 'string' ? details.region : null;
        } catch (err) {
          log.warn('AgentCore health check failed in status route', {
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }

      return json({
        ok: true,
        data: {
          mode: sandboxMode,
          containerStatus,
          containerId,
          providerAvailable:
            !!dockerProvider || !!k8sProvider || !!nomadProvider || !!agentCoreProvider,
          provider: dockerProvider?.name ?? 'none',
          k8sCrdReady,
          k8sClusterVersion,
          k8sPodCount,
          k8sPodsRunning,
          nomadHealthy,
          nomadVersion,
          nomadLeader,
          nomadJobCount,
          agentCoreHealthy,
          agentCoreRegion,
        },
      });
    } catch (error) {
      log.error('Failed to get sandbox status', { error });
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
      log.error('Restart failed', { error });
      const message = error instanceof Error ? error.message : 'Failed to restart container';
      return json({ ok: false, error: { code: 'RESTART_FAILED', message } }, 500);
    }
  });

  return app;
}
