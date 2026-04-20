/**
 * Kubernetes Sandbox Provider Initialization
 *
 * Handles K8s CRD provider setup including:
 * - Loading K8s-specific settings from database
 * - Health checks and minikube auto-start
 * - CRD auto-installation
 * - Built-in controller startup
 * - Warm pool initialization
 */

import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as sqliteSchema from '../../../db/schema/sqlite/index.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { SandboxController } from '../../../lib/sandbox/controllers/sandbox-controller.js';
import { createAgentSandboxProvider } from '../../../lib/sandbox/providers/agent-sandbox-provider.js';
import type { EventEmittingSandboxProvider } from '../../../lib/sandbox/providers/sandbox-provider.js';
import type { Database } from '../../../types/database.js';
import type { SandboxState } from '../types.js';
import { ensureDefaultSandbox } from './sandbox-helpers.js';

declare const Bun: {
  spawn: (
    cmd: string[],
    options: { cwd: string; stdout: 'pipe'; stderr: 'pipe' }
  ) => {
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  };
};

const log = createLogger('K8sInit');

const schemaTables = { settings: sqliteSchema.settings };

interface K8sSettings {
  namespace?: string;
  kubeConfigPath?: string;
  kubeContext?: string;
  enableWarmPool?: boolean;
  warmPoolSize?: number;
  runtimeClassName?: 'gvisor' | 'kata' | 'none';
  image?: string;
  skipTLSVerify?: boolean;
  autoStartMinikube?: boolean;
  autoInstallCRDs?: boolean;
}

/**
 * Poll `kubectl get crd sandboxes.agents.x-k8s.io` every 1s until success
 * or the timeout is reached (default 10s).
 */
async function waitForCrdRegistration(maxWaitMs = 10_000): Promise<boolean> {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await execAsync('kubectl get crd sandboxes.agents.x-k8s.io', {
        timeout: 5_000,
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  return false;
}

function isMinikubeContext(kubeContext?: string): boolean {
  return kubeContext === 'minikube';
}

async function attemptMinikubeStart(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['minikube', 'start'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const result = await Promise.race([
      proc.exited,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('minikube start timed out after 120s')), 120_000)
      ),
    ]);
    return result === 0;
  } catch (err) {
    log.warn('Failed to start minikube', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return false;
  }
}

function diagnoseK8sFailure(health: {
  healthy: boolean;
  message?: string;
  details?: Record<string, unknown>;
}): string {
  const details = health.details ?? {};
  if (!details.clusterVersion && !details.clusterReachable) {
    return 'Kubernetes cluster is not reachable';
  }
  if (details.crdRegistered === false) {
    return 'Agent Sandbox CRD is not registered in the cluster';
  }
  if (details.namespaceExists === false) {
    return `Namespace '${details.namespace ?? 'unknown'}' does not exist`;
  }
  return health.message ?? 'Kubernetes cluster health check failed';
}

/** Clear any stale `sandbox.kubernetes.lastError` from the settings table. */
async function clearK8sLastError(db: Database): Promise<void> {
  try {
    await db
      .delete(schemaTables.settings)
      .where(eq(schemaTables.settings.key, 'sandbox.kubernetes.lastError'));
  } catch {
    // ignore - stale error display is non-critical
  }
}

async function persistK8sLastError(db: Database, diagnosis: string): Promise<void> {
  try {
    const value = JSON.stringify({
      error: diagnosis,
      timestamp: new Date().toISOString(),
    });
    await db
      .insert(schemaTables.settings)
      .values({ key: 'sandbox.kubernetes.lastError', value })
      .onConflictDoUpdate({
        target: schemaTables.settings.key,
        set: { value },
      });
  } catch (persistErr) {
    log.warn('Failed to persist K8s error', { error: persistErr });
  }
}

async function startControllerAndDefault(
  k8sProvider: ReturnType<typeof createAgentSandboxProvider>,
  k8sSettings: K8sSettings,
  health: { details?: Record<string, unknown> },
  db: Database,
  sandboxState: SandboxState
): Promise<void> {
  // Start built-in CRD controller if no external controller detected
  if (!(health.details?.controller as { installed?: boolean })?.installed) {
    const controller = new SandboxController(
      k8sProvider.client,
      k8sSettings.namespace ?? 'agentpane-sandboxes'
    );
    await controller.start();
    sandboxState.controller = controller;
    log.info('Built-in sandbox controller started (no external controller detected)');
  }

  // theme-04 P1-03: reconcile orphaned CRDs from the previous process lifetime
  // before creating a new default, so we don't accidentally create duplicates.
  try {
    const { recovered, removed } = await k8sProvider.recover();
    if (recovered > 0 || removed > 0) {
      log.info(`K8s sandbox recovery: ${recovered} recovered, ${removed} orphans removed`);
    }
  } catch (recoverErr) {
    log.warn('K8s sandbox recovery failed (continuing bootstrap)', {
      error: recoverErr instanceof Error ? recoverErr : new Error(String(recoverErr)),
    });
  }

  // Create default K8s sandbox pod
  await ensureDefaultSandbox(k8sProvider, 'K8s', db);

  // Initialize warm pool if enabled
  if (k8sSettings.enableWarmPool) {
    try {
      await k8sProvider.initWarmPool();
      log.info('Warm pool initialized');
    } catch (warmPoolErr) {
      log.warn('Warm pool initialization failed (continuing without)', {
        error: warmPoolErr instanceof Error ? warmPoolErr : new Error(String(warmPoolErr)),
      });
    }
  }
}

/**
 * Try to initialize the Kubernetes CRD sandbox provider.
 * Returns the provider if successful, null otherwise.
 */
export async function initK8sProvider(
  db: Database,
  sandboxState: SandboxState,
  k8sFallbackToDocker: boolean
): Promise<EventEmittingSandboxProvider | null> {
  try {
    // Load K8s-specific settings
    let k8sSettings: K8sSettings = { autoInstallCRDs: true };
    try {
      const k8sSetting = await db.query.settings.findFirst({
        where: eq(schemaTables.settings.key, 'sandbox.kubernetes'),
      });
      if (k8sSetting?.value) {
        const parsed = JSON.parse(k8sSetting.value);
        k8sSettings = {
          ...parsed,
          autoInstallCRDs: parsed.autoInstallCRDs ?? true,
        };
      }
    } catch {
      // Use defaults
    }

    const k8sProvider = createAgentSandboxProvider({
      namespace: k8sSettings.namespace,
      kubeConfigPath: k8sSettings.kubeConfigPath,
      kubeContext: k8sSettings.kubeContext,
      enableWarmPool: k8sSettings.enableWarmPool,
      warmPoolSize: k8sSettings.warmPoolSize,
      runtimeClassName: k8sSettings.runtimeClassName,
      image: k8sSettings.image,
      skipTLSVerify: k8sSettings.skipTLSVerify,
    });

    let health = await k8sProvider.healthCheck();

    if (health.healthy) {
      sandboxState.k8sProvider = k8sProvider;
      log.info('Kubernetes CRD sandbox provider initialized', {
        data: {
          namespace: k8sSettings.namespace ?? 'agentpane-sandboxes',
          controller: health.details?.controller,
        },
      });
      await clearK8sLastError(db);
      await startControllerAndDefault(k8sProvider, k8sSettings, health, db, sandboxState);
      return k8sProvider;
    }

    // K8s unhealthy - attempt minikube autostart if configured
    const clusterUnreachable = !health.details?.clusterVersion && !health.details?.clusterReachable;

    if (
      clusterUnreachable &&
      k8sSettings.autoStartMinikube &&
      isMinikubeContext(k8sSettings.kubeContext)
    ) {
      log.info('Kubernetes cluster unreachable, attempting minikube start...');
      const started = await attemptMinikubeStart();
      if (started) {
        log.info('Minikube started successfully, retrying health check...');
        health = await k8sProvider.healthCheck();
        if (health.healthy) {
          sandboxState.k8sProvider = k8sProvider;
          log.info('Kubernetes CRD sandbox provider initialized after minikube start', {
            data: {
              namespace: k8sSettings.namespace ?? 'agentpane-sandboxes',
            },
          });
          await clearK8sLastError(db);
          await startControllerAndDefault(k8sProvider, k8sSettings, health, db, sandboxState);
          return k8sProvider;
        }
      }
    }

    // Auto-install CRDs if configured
    if (k8sSettings.autoInstallCRDs) {
      const details = health.details ?? {};
      const needsCrdInstall = details.crdRegistered === false || details.namespaceExists === false;

      if (needsCrdInstall) {
        log.info('Auto-installing CRDs (autoInstallCRDs enabled)...');
        const provider = await attemptCrdAutoInstall(k8sProvider, k8sSettings, db, sandboxState);
        if (provider) return provider;
      }
    }

    // Still unhealthy
    const diagnosis = diagnoseK8sFailure(health);
    if (k8sFallbackToDocker) {
      log.warn(
        `Kubernetes CRD provider unhealthy: ${diagnosis}. Falling back to Docker provider (fallbackToDocker enabled).`
      );
    } else {
      log.error(
        `Kubernetes CRD provider unhealthy: ${diagnosis}. Docker fallback is disabled. Container agent service will not be available.`
      );
      await persistK8sLastError(db, diagnosis);
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (k8sFallbackToDocker) {
      log.warn(
        `Kubernetes CRD provider init failed: ${message}. Falling back to Docker (fallbackToDocker enabled).`
      );
    } else {
      log.error(
        `Kubernetes CRD provider init failed: ${message}. Docker fallback is disabled. Container agent service will not be available.`
      );
      await persistK8sLastError(db, message);
    }
    return null;
  }
}

async function attemptCrdAutoInstall(
  k8sProvider: ReturnType<typeof createAgentSandboxProvider>,
  k8sSettings: K8sSettings,
  db: Database,
  sandboxState: SandboxState
): Promise<EventEmittingSandboxProvider | null> {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const manifestsDir = path.join(process.cwd(), 'k8s', 'manifests');

    const manifests = [
      'crds.yaml',
      'namespace.yaml',
      'runtime-class-gvisor.yaml',
      'limit-range.yaml',
    ];

    for (const manifest of manifests) {
      const filePath = path.join(manifestsDir, manifest);
      try {
        await execAsync(`kubectl apply -f "${filePath}"`, {
          timeout: 30_000,
        });
        log.info(`Applied ${manifest}`);
      } catch (err) {
        log.warn(`Failed to apply ${manifest}`, {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    const crdReady = await waitForCrdRegistration(10_000);
    if (!crdReady) {
      log.warn('CRD registration timed out after 10s - custom resources may fail');
    }

    // Try to install the external CRD controller
    try {
      await execAsync(
        'kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml"',
        { timeout: 60_000 }
      );
      log.info('CRD controller installed from release URL');
    } catch (ctrlErr) {
      log.warn('CRD controller install from URL failed (continuing with local CRDs)', {
        error: ctrlErr instanceof Error ? ctrlErr.message : String(ctrlErr),
      });
    }

    // Apply custom resources
    for (const manifest of ['agentpane-sandbox-template.yaml', 'agentpane-warm-pool.yaml']) {
      const filePath = path.join(manifestsDir, manifest);
      try {
        await execAsync(`kubectl apply -f "${filePath}"`, {
          timeout: 30_000,
        });
        log.info(`Applied ${manifest}`);
      } catch (err) {
        log.warn(`Failed to apply ${manifest}`, {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    // Retry health check after installation
    const health = await k8sProvider.healthCheck();
    if (health.healthy) {
      sandboxState.k8sProvider = k8sProvider;
      log.info('Kubernetes CRD provider initialized after auto-install');

      await startControllerAndDefault(k8sProvider, k8sSettings, health, db, sandboxState);
      return k8sProvider;
    }
  } catch (installErr) {
    log.warn('Auto-install CRDs failed:', {
      error: installErr instanceof Error ? installErr.message : String(installErr),
    });
  }
  return null;
}
