/**
 * Sandbox Provider Initialization (CB-005)
 *
 * Orchestrates sandbox provider selection and initialization with
 * configurable timeout via Promise.race.
 *
 * Provider selection order:
 * 1. Kubernetes CRD (if configured)
 * 2. Nomad (if configured)
 * 3. Docker (default fallback)
 */

import { eq } from 'drizzle-orm';
import * as sqliteSchema from '../../../db/schema/sqlite/index.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { createContainerAgentService } from '../../../services/container-agent.service.js';
import type { Database } from '../../../types/database.js';
import type { SandboxState, ServiceContainer } from '../types.js';
import { initDockerProvider } from './docker-init.js';
import { startK8sHealInterval, startNomadHealInterval } from './heal-intervals.js';
import { initK8sProvider } from './k8s-init.js';
import { initNomadProvider } from './nomad-init.js';

const log = createLogger('SandboxInit');

const schemaTables = { settings: sqliteSchema.settings };

type ProviderSelection = 'docker' | 'kubernetes' | 'nomad';

/**
 * Determine provider selection and fallback settings from database.
 */
async function resolveProviderConfig(db: Database): Promise<{
  providerType: ProviderSelection;
  k8sFallbackToDocker: boolean;
  nomadFallbackToDocker: boolean;
}> {
  let providerType: ProviderSelection = 'docker';
  let k8sFallbackToDocker = false;
  let nomadFallbackToDocker = false;

  try {
    const providerSetting = await db.query.settings.findFirst({
      where: eq(schemaTables.settings.key, 'sandbox.defaults'),
    });
    if (providerSetting?.value) {
      const parsed = JSON.parse(providerSetting.value) as {
        provider?: string;
        fallbackToDocker?: boolean;
      };
      if (parsed.provider === 'kubernetes') providerType = 'kubernetes';
      else if (parsed.provider === 'nomad') providerType = 'nomad';
      k8sFallbackToDocker = parsed.fallbackToDocker ?? false;
      nomadFallbackToDocker = parsed.fallbackToDocker ?? false;
    }

    // Check for Nomad-specific fallback setting
    if (providerType === 'nomad') {
      try {
        const nomadSetting = await db.query.settings.findFirst({
          where: eq(schemaTables.settings.key, 'sandbox.nomad'),
        });
        if (nomadSetting?.value) {
          const nomadParsed = JSON.parse(nomadSetting.value) as {
            fallbackToDocker?: boolean;
          };
          if (nomadParsed.fallbackToDocker !== undefined) {
            nomadFallbackToDocker = nomadParsed.fallbackToDocker;
          }
        }
      } catch (err) {
        log.warn('Failed to read Nomad fallbackToDocker setting, using shared value', {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  } catch (settingsErr) {
    log.warn('Failed to load sandbox provider setting (using Docker default)', {
      error: settingsErr instanceof Error ? settingsErr : new Error(String(settingsErr)),
    });
  }

  return { providerType, k8sFallbackToDocker, nomadFallbackToDocker };
}

/**
 * Core sandbox initialization logic.
 * Selects and initializes the configured provider, wires up ContainerAgentService.
 */
async function initSandboxProviderCore(
  db: Database,
  services: ServiceContainer,
  sandboxState: SandboxState
): Promise<void> {
  const { providerType, k8sFallbackToDocker, nomadFallbackToDocker } =
    await resolveProviderConfig(db);

  // Step 1: Try Kubernetes if configured
  if (providerType === 'kubernetes') {
    const provider = await initK8sProvider(db, sandboxState, k8sFallbackToDocker);
    if (provider) {
      sandboxState.provider = provider;
    }
  }

  // Step 2: Try Nomad if configured (and K8s was not initialized)
  if (providerType === 'nomad' && !sandboxState.provider) {
    const provider = await initNomadProvider(db, sandboxState, nomadFallbackToDocker);
    if (provider) {
      sandboxState.provider = provider;
    }
  }

  // Step 3: Fall back to Docker (unless K8s/Nomad was configured and fallback is disabled)
  if (
    !sandboxState.provider &&
    !(providerType === 'kubernetes' && !k8sFallbackToDocker) &&
    !(providerType === 'nomad' && !nomadFallbackToDocker)
  ) {
    const provider = await initDockerProvider(db);
    if (provider) {
      sandboxState.provider = provider;
    }
  }

  // Step 4: Wire up ContainerAgentService
  if (sandboxState.provider) {
    try {
      sandboxState.containerAgentService = createContainerAgentService(
        db,
        sandboxState.provider,
        services.durableStreamsService,
        services.apiKeyService,
        services.worktreeService,
        services.githubService
      );

      services.taskService.setContainerAgentService(sandboxState.containerAgentService);
      services.containerAgentService = sandboxState.containerAgentService;
      log.info(
        `ContainerAgentService wired up to TaskService (provider: ${sandboxState.provider.name})`
      );
    } catch (serviceErr) {
      log.error('Failed to create ContainerAgentService', {
        error: serviceErr instanceof Error ? serviceErr : new Error(String(serviceErr)),
      });
    }
  } else {
    log.warn('initSandboxProvider completed but no sandbox provider was initialized');
  }
}

/**
 * Called when sandbox provider is ready.
 * Starts heal intervals and clears retry state.
 */
function onSandboxProviderReady(db: Database, sandboxState: SandboxState): void {
  sandboxState.retryCount = 0;
  if (sandboxState.retryTimer) {
    clearTimeout(sandboxState.retryTimer);
    sandboxState.retryTimer = null;
  }
  if (sandboxState.k8sProvider) {
    startK8sHealInterval(db, sandboxState);
    log.info('K8s CRD auto-heal interval started (60s)');
  }
  if (sandboxState.nomadProvider) {
    startNomadHealInterval(db, sandboxState);
    log.info('Nomad auto-heal interval started (60s)');
  }
}

/**
 * Schedule a retry of sandbox initialization with exponential backoff.
 */
function scheduleSandboxRetry(
  db: Database,
  services: ServiceContainer,
  sandboxState: SandboxState
): void {
  const isDev = process.env.NODE_ENV === 'development';
  const maxRetries = isDev ? 0 : 10;
  const baseDelay = isDev ? 3_000 : 15_000;
  const maxDelay = isDev ? 30_000 : 300_000;

  if (maxRetries > 0 && sandboxState.retryCount >= maxRetries) {
    log.warn(
      `Sandbox provider initialization failed after ${maxRetries} retries - giving up. Restart the server to try again.`
    );
    return;
  }

  const delay = Math.min(baseDelay * 2 ** sandboxState.retryCount, maxDelay);
  sandboxState.retryCount++;

  log.info(
    `Will retry sandbox provider initialization in ${Math.round(delay / 1000)}s (attempt ${sandboxState.retryCount}/${maxRetries || 'unlimited'})`
  );

  sandboxState.retryTimer = setTimeout(async () => {
    sandboxState.retryTimer = null;
    if (sandboxState.provider) return; // Already initialized

    try {
      await initSandboxProviderCore(db, services, sandboxState);
      if (sandboxState.provider) {
        log.info('Sandbox provider initialized on retry');
        onSandboxProviderReady(db, sandboxState);
      } else {
        scheduleSandboxRetry(db, services, sandboxState);
      }
    } catch (err) {
      log.warn('Sandbox provider retry failed:', {
        error: err instanceof Error ? err.message : String(err),
      });
      scheduleSandboxRetry(db, services, sandboxState);
    }
  }, delay);
  sandboxState.retryTimer.unref(); // Don't prevent process exit
}

/**
 * Initialize sandbox provider with configurable timeout (CB-005).
 *
 * Wraps the entire initialization in Promise.race with SANDBOX_INIT_TIMEOUT_MS.
 * Runs in the background (non-blocking) after server starts.
 */
export async function initSandboxProvider(
  db: Database,
  services: ServiceContainer,
  sandboxState: SandboxState,
  timeoutMs: number
): Promise<void> {
  const initPromise = initSandboxProviderCore(db, services, sandboxState);

  const timeoutPromise = new Promise<void>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Sandbox initialization timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  });

  try {
    await Promise.race([initPromise, timeoutPromise]);
    if (sandboxState.provider) {
      onSandboxProviderReady(db, sandboxState);
    } else {
      scheduleSandboxRetry(db, services, sandboxState);
    }
  } catch (err) {
    log.error('Sandbox provider initialization failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!sandboxState.provider) {
      scheduleSandboxRetry(db, services, sandboxState);
    }
  }
}
