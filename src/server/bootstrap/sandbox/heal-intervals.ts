/**
 * Sandbox Provider Health Check Intervals
 *
 * Periodic auto-heal intervals for K8s and Nomad providers.
 * Validates cache, ensures default sandboxes, and repairs CRDs.
 */

import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as sqliteSchema from '../../../db/schema/sqlite/index.js';
import { createLogger } from '../../../lib/logging/logger.js';
import type { Database } from '../../../types/database.js';
import type { SandboxState } from '../types.js';
import { ensureDefaultSandbox } from './sandbox-helpers.js';

const log = createLogger('HealIntervals');

const schemaTables = { settings: sqliteSchema.settings };

/**
 * Start the K8s CRD auto-heal interval (60s).
 * Validates sandbox cache, ensures default sandbox, and repairs CRDs when needed.
 */
export function startK8sHealInterval(db: Database, sandboxState: SandboxState): void {
  if (sandboxState.k8sHealInterval) return; // already running

  let healInProgress = false;

  sandboxState.k8sHealInterval = setInterval(async () => {
    const provider = sandboxState.k8sProvider;
    if (!provider) return;
    if (healInProgress) return;

    healInProgress = true;
    try {
      // Proactive cache validation
      try {
        if ('validateSandboxes' in provider && typeof provider.validateSandboxes === 'function') {
          await provider.validateSandboxes();
        }
      } catch (valErr) {
        log.warn('[K8s Heal] Cache validation failed', {
          error: valErr instanceof Error ? valErr.message : String(valErr),
        });
      }

      // Ensure default sandbox exists and is healthy
      try {
        await ensureDefaultSandbox(provider, 'K8s', db);
      } catch (defaultErr) {
        log.warn('[K8s Heal] Default sandbox check failed', {
          error: defaultErr instanceof Error ? defaultErr.message : String(defaultErr),
        });
      }

      const health = await provider.healthCheck();
      if (health.healthy) return;

      // Check if autoInstallCRDs is enabled
      let autoInstall = true;
      try {
        const k8sSetting = await db.query.settings.findFirst({
          where: eq(schemaTables.settings.key, 'sandbox.kubernetes'),
        });
        if (k8sSetting?.value) {
          const parsed = JSON.parse(k8sSetting.value);
          autoInstall = parsed.autoInstallCRDs ?? true;
        }
      } catch {
        // Use default
      }

      if (!autoInstall) return;

      const details = health.details ?? {};
      const needsRepair = details.crdRegistered === false || details.namespaceExists === false;

      if (!needsRepair) return;

      log.info('[K8s Heal] CRD/namespace missing, attempting auto-heal...');

      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);
      const manifestsDir = path.join(process.cwd(), 'k8s', 'manifests');

      for (const manifest of [
        'crds.yaml',
        'namespace.yaml',
        'runtime-class-gvisor.yaml',
        'limit-range.yaml',
      ]) {
        try {
          await execAsync(`kubectl apply -f "${path.join(manifestsDir, manifest)}"`, {
            timeout: 30_000,
          });
        } catch {
          // Best effort
        }
      }

      // Wait for CRD registration
      const { exec: exec2 } = await import('node:child_process');
      const execAsync2 = promisify(exec2);
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        try {
          await execAsync2('kubectl get crd sandboxes.agents.x-k8s.io', { timeout: 5_000 });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }

      for (const manifest of ['agentpane-sandbox-template.yaml', 'agentpane-warm-pool.yaml']) {
        try {
          await execAsync(`kubectl apply -f "${path.join(manifestsDir, manifest)}"`, {
            timeout: 30_000,
          });
        } catch {
          // Best effort
        }
      }

      const recheck = await provider.healthCheck();
      if (recheck.healthy) {
        log.info('[K8s Heal] Auto-heal succeeded - CRDs restored');
      } else {
        log.warn('[K8s Heal] Auto-heal ran but cluster is still unhealthy');
      }
    } catch (err) {
      log.warn('[K8s Heal] Health check failed', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      healInProgress = false;
    }
  }, 60_000);
}

/**
 * Start the Nomad auto-heal interval (60s).
 * Validates sandbox cache and ensures default sandbox exists.
 */
export function startNomadHealInterval(db: Database, sandboxState: SandboxState): void {
  if (sandboxState.nomadHealInterval) return; // already running

  let healInProgress = false;

  sandboxState.nomadHealInterval = setInterval(async () => {
    const provider = sandboxState.nomadProvider;
    if (!provider) return;
    if (healInProgress) return;

    healInProgress = true;
    try {
      // Proactive cache validation
      try {
        await provider.validateSandboxes();
      } catch (valErr) {
        log.warn('[Nomad Heal] Cache validation failed', {
          error: valErr instanceof Error ? valErr.message : String(valErr),
        });
      }

      // Ensure default sandbox exists and is healthy
      try {
        await ensureDefaultSandbox(provider, 'Nomad', db);
      } catch (defaultErr) {
        log.warn('[Nomad Heal] Default sandbox check failed', {
          error: defaultErr instanceof Error ? defaultErr.message : String(defaultErr),
        });
      }

      const health = await provider.healthCheck();
      if (health.healthy) {
        // Clear stale error
        try {
          await db
            .delete(schemaTables.settings)
            .where(eq(schemaTables.settings.key, 'sandbox.nomad.lastError'));
        } catch {
          // ignore
        }
        return;
      }

      log.warn('[Nomad Heal] Cluster unhealthy', {
        data: { message: health.message },
      });
    } catch (err) {
      log.warn('[Nomad Heal] Health check failed', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      healInProgress = false;
    }
  }, 60_000);
}
