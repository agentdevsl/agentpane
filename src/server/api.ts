/**
 * Bun API Server
 *
 * Entry point for the API server. Delegates all initialization
 * to the structured bootstrap pipeline.
 *
 * Previously 1,671 lines — now delegates to src/server/bootstrap/.
 */

import { createLogger } from '../lib/logging/logger.js';
<<<<<<< ours
import { run } from './bootstrap/server-bootstrap.js';
=======
import { CaddyDurableStreamsServer } from '../lib/streams/caddy-producer.js';
import { errorMessage } from '../lib/utils/error-message';
>>>>>>> theirs

const log = createLogger('APIServer');

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception', { error });
});

process.on('unhandledRejection', (reason, _promise) => {
  log.error('Unhandled Rejection', { error: reason });
});

// Run the bootstrap pipeline
run().catch((error) => {
  log.error('Server bootstrap failed', { error });
  process.exit(1);
});
<<<<<<< ours
=======

// ============================================================================
// Sandbox Provider Initialization (deferred — runs after server starts)
// ============================================================================
// Selects and initializes the configured sandbox provider (Docker or K8s CRD).
// Initialization runs asynchronously after Bun.serve() so it never blocks startup.
// Routes use getSandboxProvider() getter to access the latest provider reference.

let sandboxProvider: EventEmittingSandboxProvider | null = null;
let containerAgentService: ReturnType<typeof createContainerAgentService> | null = null;

// Module-level reference to the K8s provider for the auto-heal interval
// and for health/status routes. Set inside initSandboxProvider() when K8s is active.
let activeK8sProvider: ReturnType<typeof createAgentSandboxProvider> | null = null;
let sandboxController: SandboxController | null = null;

// Module-level reference to the Nomad provider for health/status routes.
let activeNomadProvider:
  | import('../lib/sandbox/providers/nomad-sandbox-provider.js').NomadSandboxProvider
  | null = null;

/** Getter for routes that need to check K8s provider health. */
function getK8sProvider() {
  return activeK8sProvider;
}

/** Getter for routes that need to check Nomad provider health. */
function getNomadProvider() {
  return activeNomadProvider;
}

/**
 * Poll `kubectl get crd sandboxes.agents.x-k8s.io` every 1s until success
 * or the timeout is reached (default 10s). Returns true when the CRD is registered.
 */
async function waitForCrdRegistration(maxWaitMs = 10_000): Promise<boolean> {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await execAsync('kubectl get crd sandboxes.agents.x-k8s.io', { timeout: 5_000 });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  return false;
}

/**
 * Create a default K8s sandbox pod if one doesn't already exist.
 * Mirrors Docker's default sandbox creation pattern.
 */
/**
 * Ensure a default sandbox exists for the given provider.
 * Shared between K8s and Nomad providers (identical lifecycle logic).
 */
async function ensureDefaultSandbox(
  provider: {
    get(projectId: string): Promise<{ status: string; stop(): Promise<void> } | null>;
    create(config: SandboxConfig): Promise<unknown>;
  },
  label: string
): Promise<void> {
  try {
    const existingDefault = await provider.get('default');

    if (
      existingDefault &&
      (existingDefault.status === 'error' || existingDefault.status === 'stopped')
    ) {
      log.info(`Default ${label} sandbox in terminal state, recreating`, {
        data: { status: existingDefault.status },
      });
      if (existingDefault.status === 'error') {
        try {
          await existingDefault.stop();
        } catch (stopErr) {
          log.warn(`Failed to stop error-state default ${label} sandbox during recreation`, {
            error: stopErr instanceof Error ? stopErr : new Error(String(stopErr)),
          });
        }
      }
      // Fall through to create
    } else if (existingDefault) {
      return; // Healthy default exists
    }

    const defaults = await loadSandboxDefaultsFromDb();
    await provider.create({
      projectId: 'default',
      projectPath: '/workspace',
      image: defaults?.image ?? SANDBOX_DEFAULTS.image,
      memoryMb: defaults?.memoryMb ?? 2048,
      cpuCores: defaults?.cpuCores ?? 2,
      idleTimeoutMinutes: defaults?.idleTimeoutMinutes ?? 30,
      volumeMounts: [],
    });
    log.info(`Default ${label} sandbox created`);
  } catch (createErr) {
    log.error(`Failed to create default ${label} sandbox`, {
      error: createErr instanceof Error ? createErr : new Error(String(createErr)),
    });
  }
}

/**
 * Load sandbox defaults from the database settings.
 * Reusable helper for both Docker and K8s default sandbox creation.
 */
async function loadSandboxDefaultsFromDb(): Promise<{
  image?: string;
  memoryMb?: number;
  cpuCores?: number;
  idleTimeoutMinutes?: number;
} | null> {
  try {
    const globalDefaults = await db.query.settings.findFirst({
      where: eq(schemaTables.settings.key, 'sandbox.defaults'),
    });
    if (globalDefaults?.value) {
      return JSON.parse(globalDefaults.value) as {
        image?: string;
        memoryMb?: number;
        cpuCores?: number;
        idleTimeoutMinutes?: number;
      };
    }
  } catch (settingsErr) {
    log.warn('Failed to load sandbox settings (using defaults)', {
      error: settingsErr instanceof Error ? settingsErr : new Error(String(settingsErr)),
    });
  }
  return null;
}

/** Clear any stale `sandbox.nomad.lastError` from the settings table. */
async function clearNomadLastError() {
  try {
    await db
      .delete(schemaTables.settings)
      .where(eq(schemaTables.settings.key, 'sandbox.nomad.lastError'));
  } catch (err) {
    log.debug('Failed to clear stale Nomad error (non-critical)', {
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** Persist a Nomad error message to the settings table for UI display. */
async function persistNomadLastError(message: string): Promise<void> {
  try {
    const value = JSON.stringify({
      error: message,
      timestamp: new Date().toISOString(),
    });
    await db
      .insert(schemaTables.settings)
      .values({ key: 'sandbox.nomad.lastError', value })
      .onConflictDoUpdate({
        target: schemaTables.settings.key,
        set: { value },
      });
  } catch (persistErr) {
    log.warn('Failed to persist Nomad error', {
      error: persistErr instanceof Error ? persistErr : new Error(String(persistErr)),
    });
  }
}

/** Clear any stale `sandbox.kubernetes.lastError` from the settings table. */
async function clearK8sLastError() {
  try {
    await db
      .delete(schemaTables.settings)
      .where(eq(schemaTables.settings.key, 'sandbox.kubernetes.lastError'));
  } catch (_) {
    // ignore — stale error display is non-critical
  }
}

/**
 * Initialize the sandbox provider asynchronously.
 * Called after Bun.serve() so the server is already accepting requests.
 */
async function initSandboxProvider() {
  // Step 1: Determine which provider to use from settings
  type ProviderSelection = 'docker' | 'kubernetes' | 'nomad';
  let providerType: ProviderSelection = 'docker'; // default
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
      if (parsed.provider === 'kubernetes') {
        providerType = 'kubernetes';
      } else if (parsed.provider === 'nomad') {
        providerType = 'nomad';
      }
      k8sFallbackToDocker = parsed.fallbackToDocker ?? false;
      // Default nomadFallbackToDocker from shared setting; may be overridden below
      nomadFallbackToDocker = parsed.fallbackToDocker ?? false;
    }

    // Check for a separate Nomad-specific fallbackToDocker setting
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

  // Step 2: Initialize the selected provider
  if (providerType === 'kubernetes') {
    // ------ Kubernetes CRD Provider ------
    try {
      // Load K8s-specific settings from the sandbox.kubernetes key
      let k8sSettings: {
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
      } = { autoInstallCRDs: true };

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

      // Verify cluster connectivity and controller installation
      let health = await k8sProvider.healthCheck();
      if (health.healthy) {
        sandboxProvider = k8sProvider;
        activeK8sProvider = k8sProvider;
        log.info('[API Server] Kubernetes CRD sandbox provider initialized', {
          data: {
            namespace: k8sSettings.namespace ?? 'agentpane-sandboxes',
            controller: health.details?.controller,
          },
        });

        // Clear any stale error from a previous failed initialization
        await clearK8sLastError();

        // Start built-in CRD controller if no external controller detected
        if (!(health.details?.controller as { installed?: boolean })?.installed) {
          sandboxController = new SandboxController(
            k8sProvider.client,
            k8sSettings.namespace ?? 'agentpane-sandboxes'
          );
          await sandboxController.start();
          log.info(
            '[API Server] Built-in sandbox controller started (no external controller detected)'
          );
        }

        // Create default K8s sandbox pod (mirrors Docker default sandbox pattern)
        await ensureDefaultSandbox(k8sProvider, 'K8s');

        // Initialize warm pool if enabled
        if (k8sSettings.enableWarmPool) {
          try {
            await k8sProvider.initWarmPool();
            log.info('[API Server] Warm pool initialized');
          } catch (warmPoolErr) {
            log.warn('Warm pool initialization failed (continuing without)', {
              error: warmPoolErr instanceof Error ? warmPoolErr : new Error(String(warmPoolErr)),
            });
          }
        }
      } else {
        // K8s unhealthy — attempt minikube autostart if configured
        const clusterUnreachable =
          !health.details?.clusterVersion && !health.details?.clusterReachable;

        if (
          clusterUnreachable &&
          k8sSettings.autoStartMinikube &&
          isMinikubeContext(k8sSettings.kubeContext)
        ) {
          log.info('[API Server] Kubernetes cluster unreachable, attempting minikube start...');
          const started = await attemptMinikubeStart();
          if (started) {
            log.info('[API Server] Minikube started successfully, retrying health check...');
            health = await k8sProvider.healthCheck();
            if (health.healthy) {
              sandboxProvider = k8sProvider;
              activeK8sProvider = k8sProvider;
              log.info(
                '[API Server] Kubernetes CRD sandbox provider initialized after minikube start',
                {
                  data: { namespace: k8sSettings.namespace ?? 'agentpane-sandboxes' },
                }
              );

              // Clear any stale error from a previous failed initialization
              await clearK8sLastError();

              // Start built-in CRD controller if no external controller detected
              if (!(health.details?.controller as { installed?: boolean })?.installed) {
                sandboxController = new SandboxController(
                  k8sProvider.client,
                  k8sSettings.namespace ?? 'agentpane-sandboxes'
                );
                await sandboxController.start();
                log.info(
                  '[API Server] Built-in sandbox controller started (no external controller detected)'
                );
              }

              // Create default K8s sandbox pod
              await ensureDefaultSandbox(k8sProvider, 'K8s');

              // Initialize warm pool if enabled
              if (k8sSettings.enableWarmPool) {
                try {
                  await k8sProvider.initWarmPool();
                  log.info('[API Server] Warm pool initialized');
                } catch (warmPoolErr) {
                  log.warn('Warm pool initialization failed (continuing without)', {
                    error:
                      warmPoolErr instanceof Error ? warmPoolErr : new Error(String(warmPoolErr)),
                  });
                }
              }
            }
          }
        }

        // Auto-install CRDs if configured and CRDs are missing
        if (!sandboxProvider && k8sSettings.autoInstallCRDs) {
          const details = health.details ?? {};
          const needsCrdInstall =
            details.crdRegistered === false || details.namespaceExists === false;

          if (needsCrdInstall) {
            log.info('[API Server] Auto-installing CRDs (autoInstallCRDs enabled)...');
            try {
              const { exec } = await import('node:child_process');
              const { promisify } = await import('node:util');
              const execAsync = promisify(exec);
              const manifestsDir = path.join(process.cwd(), 'k8s', 'manifests');

              // Apply CRDs, namespace, and supporting manifests
              const manifests = [
                'crds.yaml',
                'namespace.yaml',
                'runtime-class-gvisor.yaml',
                'limit-range.yaml',
              ];

              for (const manifest of manifests) {
                const filePath = path.join(manifestsDir, manifest);
                try {
                  await execAsync(`kubectl apply -f "${filePath}"`, { timeout: 30_000 });
                  log.info(`[API Server] Applied ${manifest}`);
                } catch (err) {
                  log.warn(`Failed to apply ${manifest}`, {
                    error: err instanceof Error ? err : new Error(String(err)),
                  });
                }
              }

              // Wait for CRD registration before applying custom resources
              const crdReady = await waitForCrdRegistration(10_000);
              if (!crdReady) {
                log.warn('CRD registration timed out after 10s — custom resources may fail');
              }

              // Try to install the external CRD controller
              try {
                await execAsync(
                  'kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml"',
                  { timeout: 60_000 }
                );
                log.info('[API Server] CRD controller installed from release URL');
              } catch (ctrlErr) {
                log.warn(
                  '[API Server] CRD controller install from URL failed (continuing with local CRDs)',
                  { error: ctrlErr instanceof Error ? ctrlErr.message : String(ctrlErr) }
                );
              }

              // Apply custom resources (requires CRDs to be registered)
              for (const manifest of [
                'agentpane-sandbox-template.yaml',
                'agentpane-warm-pool.yaml',
              ]) {
                const filePath = path.join(manifestsDir, manifest);
                try {
                  await execAsync(`kubectl apply -f "${filePath}"`, { timeout: 30_000 });
                  log.info(`[API Server] Applied ${manifest}`);
                } catch (err) {
                  log.warn(`Failed to apply ${manifest}`, {
                    error: err instanceof Error ? err : new Error(String(err)),
                  });
                }
              }

              // Retry health check after installation
              health = await k8sProvider.healthCheck();
              if (health.healthy) {
                sandboxProvider = k8sProvider;
                activeK8sProvider = k8sProvider;
                log.info('[API Server] Kubernetes CRD provider initialized after auto-install');

                // Start built-in CRD controller if no external controller detected
                if (!(health.details?.controller as { installed?: boolean })?.installed) {
                  sandboxController = new SandboxController(
                    k8sProvider.client,
                    k8sSettings.namespace ?? 'agentpane-sandboxes'
                  );
                  await sandboxController.start();
                  log.info(
                    '[API Server] Built-in sandbox controller started (no external controller detected)'
                  );
                }

                // Create default K8s sandbox pod
                await ensureDefaultSandbox(k8sProvider, 'K8s');

                if (k8sSettings.enableWarmPool) {
                  try {
                    await k8sProvider.initWarmPool();
                    log.info('[API Server] Warm pool initialized');
                  } catch (warmPoolErr) {
                    log.warn('Warm pool initialization failed (continuing without)', {
                      error:
                        warmPoolErr instanceof Error ? warmPoolErr : new Error(String(warmPoolErr)),
                    });
                  }
                }
              }
            } catch (installErr) {
              log.warn('[API Server] Auto-install CRDs failed:', {
                error: installErr instanceof Error ? installErr.message : String(installErr),
              });
            }
          }
        }

        // Still unhealthy after potential minikube start
        if (!sandboxProvider) {
          const diagnosis = diagnoseK8sFailure(health);
          if (k8sFallbackToDocker) {
            log.warn(
              `[API Server] Kubernetes CRD provider unhealthy: ${diagnosis}. ` +
                'Falling back to Docker provider (fallbackToDocker enabled).'
            );
          } else {
            log.error(
              `[API Server] Kubernetes CRD provider unhealthy: ${diagnosis}. ` +
                'Docker fallback is disabled. Container agent service will not be available.'
            );
            try {
              await db
                .insert(schemaTables.settings)
                .values({
                  key: 'sandbox.kubernetes.lastError',
                  value: JSON.stringify({ error: diagnosis, timestamp: new Date().toISOString() }),
                })
                .onConflictDoUpdate({
                  target: schemaTables.settings.key,
                  set: {
                    value: JSON.stringify({
                      error: diagnosis,
                      timestamp: new Date().toISOString(),
                    }),
                  },
                });
            } catch (persistErr) {
              log.warn('Failed to persist K8s error', { error: persistErr });
            }
          }
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      if (k8sFallbackToDocker) {
        log.warn(
          `[API Server] Kubernetes CRD provider init failed: ${message}. Falling back to Docker (fallbackToDocker enabled).`
        );
      } else {
        log.error(
          `[API Server] Kubernetes CRD provider init failed: ${message}. ` +
            'Docker fallback is disabled. Container agent service will not be available.'
        );
        try {
          await db
            .insert(schemaTables.settings)
            .values({
              key: 'sandbox.kubernetes.lastError',
              value: JSON.stringify({ error: message, timestamp: new Date().toISOString() }),
            })
            .onConflictDoUpdate({
              target: schemaTables.settings.key,
              set: {
                value: JSON.stringify({ error: message, timestamp: new Date().toISOString() }),
              },
            });
        } catch (persistErr) {
          log.warn('Failed to persist K8s error', { error: persistErr });
        }
      }
    }
  }

  // Step 2b: Nomad provider initialization
  if (providerType === 'nomad' && !sandboxProvider) {
    try {
      // Load Nomad-specific settings from the sandbox.nomad key
      let nomadSettings: {
        address?: string;
        token?: string;
        namespace?: string;
        region?: string;
        datacenter?: string;
        image?: string;
      } = {};

      try {
        const nomadSetting = await db.query.settings.findFirst({
          where: eq(schemaTables.settings.key, 'sandbox.nomad'),
        });
        if (nomadSetting?.value) {
          nomadSettings = JSON.parse(nomadSetting.value);
          // Decrypt the stored token (encrypted at rest)
          if (nomadSettings.token) {
            try {
              nomadSettings.token = decryptToken(nomadSettings.token);
            } catch (decryptErr) {
              log.error('[API Server] Nomad token decryption failed, token must be re-entered', {
                error: decryptErr instanceof Error ? decryptErr : new Error(String(decryptErr)),
              });
              nomadSettings.token = undefined;
            }
          }
        }
      } catch (dbErr) {
        log.warn('[API Server] Failed to read Nomad settings from database', {
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }

      if (!nomadSettings.address) {
        log.warn('[API Server] Nomad address not configured, falling back to Docker');
      } else {
        // Defense-in-depth: validate stored address at startup (not just on save)
        const { validateNomadAddress } = await import('./routes/sandbox.js');
        const addrValidation = await validateNomadAddress(nomadSettings.address);
        if (!addrValidation.valid) {
          log.warn(
            `[API Server] Nomad address failed SSRF validation: ${addrValidation.error}. Falling back to Docker.`
          );
          await persistNomadLastError(
            `Stored Nomad address failed security validation: ${addrValidation.error}`
          );
        } else {
          const { createNomadSandboxProvider } = await import(
            '../lib/sandbox/providers/nomad-sandbox-provider.js'
          );
          const nomadProvider = createNomadSandboxProvider({
            address: nomadSettings.address,
            token: nomadSettings.token,
            namespace: nomadSettings.namespace,
            region: nomadSettings.region,
            datacenter: nomadSettings.datacenter,
            image: nomadSettings.image,
          });

          const health = await nomadProvider.healthCheck();
          if (health.healthy) {
            sandboxProvider = nomadProvider;
            activeNomadProvider = nomadProvider;
            log.info('[API Server] Nomad sandbox provider initialized', {
              data: {
                address: nomadSettings.address,
                namespace: nomadSettings.namespace ?? 'default',
              },
            });

            // Clear any stale error
            await clearNomadLastError();

            // Create default Nomad sandbox (mirrors Docker/K8s pattern)
            await ensureDefaultSandbox(nomadProvider, 'Nomad');
          } else {
            const diagnosis = health.message ?? 'Nomad cluster health check failed';
            const willFallback = nomadFallbackToDocker;
            const logFn = willFallback ? log.warn : log.error;
            logFn(
              `[API Server] Nomad provider unhealthy: ${diagnosis}.${willFallback ? ' Falling back to Docker.' : ' No fallback configured — sandbox operations will be unavailable.'}`
            );
            await persistNomadLastError(diagnosis);
          }
        } // end SSRF-validated else block
      }
    } catch (error) {
      const message = errorMessage(error);
      const willFallback = nomadFallbackToDocker;
      const { NomadApiError, ConnectionError } = await import('@agentpane/nomad-sandbox-sdk');
      const isInfraError = error instanceof NomadApiError || error instanceof ConnectionError;
      // Use warn only for expected infrastructure failures when a fallback is available.
      // Programming errors and no-fallback degradation warrant error-level visibility.
      const logFn = isInfraError && willFallback ? log.warn : log.error;
      logFn(
        `[API Server] Nomad provider init failed: ${message}.${willFallback ? ' Falling back to Docker.' : ' No fallback configured — sandbox operations will be unavailable.'}`
      );
      await persistNomadLastError(message);
    }
  }

  // Step 3: Fall back to Docker if K8s/Nomad was not initialized (or was not selected)
  // Skip Docker fallback if K8s or Nomad was configured and fallback is explicitly disabled
  if (
    !sandboxProvider &&
    !(providerType === 'kubernetes' && !k8sFallbackToDocker) &&
    !(providerType === 'nomad' && !nomadFallbackToDocker)
  ) {
    try {
      const dockerProvider = createDockerProvider();
      log.info('[API Server] Docker provider initialized');

      // Recover existing containers from previous runs
      const { recovered, removed } = await dockerProvider.recover();
      if (recovered > 0 || removed > 0) {
        log.info(`Container recovery: ${recovered} recovered, ${removed} stale removed`);
      }

      sandboxProvider = dockerProvider;

      // Create default sandbox (Docker-specific behavior, not needed for K8s CRD)
      try {
        const existingDefault = await dockerProvider.get('default');
        if (!existingDefault) {
          const defaults = await loadSandboxDefaultsFromDb();

          const defaultImage = defaults?.image ?? SANDBOX_DEFAULTS.image;
          log.info('Checking for default sandbox image', { data: { image: defaultImage } });

          const imageAvailable = await dockerProvider.isImageAvailable(defaultImage);
          log.info('Image availability check', { data: { imageAvailable } });
          if (imageAvailable) {
            try {
              const defaultWorkspacePath = path.join(
                process.cwd(),
                'data',
                'sandbox-workspaces',
                'default'
              );
              await fs.mkdir(defaultWorkspacePath, { recursive: true });

              await dockerProvider.create({
                projectId: 'default',
                projectPath: defaultWorkspacePath,
                image: defaultImage,
                memoryMb: defaults?.memoryMb ?? 2048,
                cpuCores: defaults?.cpuCores ?? 2,
                idleTimeoutMinutes: defaults?.idleTimeoutMinutes ?? 30,
                volumeMounts: [],
              });
              log.info('[API Server] Default global sandbox created');
            } catch (createErr) {
              log.warn('[API Server] Failed to create default sandbox', {
                error: createErr,
              });
            }
          } else {
            log.info('Default sandbox image not available, skipping default sandbox creation', {
              data: { image: defaultImage },
            });
          }
        } else {
          log.info('[API Server] Default global sandbox already exists');
        }
      } catch (sandboxErr) {
        log.warn('Failed to setup default sandbox (container agent still available)', {
          error: sandboxErr instanceof Error ? sandboxErr : new Error(String(sandboxErr)),
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      const isExpectedError =
        message.includes('ENOENT') ||
        message.includes('connect ECONNREFUSED') ||
        message.includes('permission denied') ||
        message.includes('Cannot connect to Docker');

      if (isExpectedError) {
        log.info('[API Server] Docker not available (expected), container agent service disabled');
      } else {
        log.error(`[API Server] Docker initialization failed with unexpected error: ${message}`);
      }
    }
  }

  // K8s diagnostic helpers
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

  // Step 4: Create ContainerAgentService with whichever provider was initialized
  if (sandboxProvider) {
    try {
      containerAgentService = createContainerAgentService(
        db,
        sandboxProvider,
        durableStreamsService,
        apiKeyService,
        worktreeService,
        githubService
      );

      taskService.setContainerAgentService(containerAgentService);
      log.info(
        `[API Server] ContainerAgentService wired up to TaskService ` +
          `(provider: ${sandboxProvider.name})`
      );
    } catch (serviceErr) {
      log.error('Failed to create ContainerAgentService', {
        error: serviceErr instanceof Error ? serviceErr : new Error(String(serviceErr)),
      });
    }
  } else {
    log.warn('[API Server] initSandboxProvider completed but no sandbox provider was initialized');
  }
} // end initSandboxProvider

// MarketplaceService for plugin marketplace operations
const marketplaceService = new MarketplaceService(db);

// Terraform services
const terraformRegistryService = new TerraformRegistryService(db);
const settingsServiceForCompose = new SettingsService(db);
const terraformComposeService = new TerraformComposeService(
  terraformRegistryService,
  db,
  settingsServiceForCompose,
  durableStreamsService
);

// AgentService for agent lifecycle management
const agentService = new AgentService(db, worktreeService, taskService, sessionService);

// WorkflowService for workflow CRUD
const workflowService = new WorkflowService(db);

// GitService for git operations (shell commands with proper escaping)
const gitService = new GitService(db, bunCommandRunner);

// ProjectService for project CRUD and summaries (with N+1 fix)
const projectService = new ProjectService(db, worktreeService, bunCommandRunner);

// Event plugin system
const pluginRegistry = new PluginRegistry();
pluginRegistry.register('github', new GitHubEventSourcePlugin());
pluginRegistry.register('cron', new CronEventSourcePlugin());

const eventSourceService = new EventSourceService(db);
const eventSubscriptionService = new EventSubscriptionService(db);
const eventProcessingService = new EventProcessingService(
  db,
  pluginRegistry,
  eventSourceService,
  eventSubscriptionService,
  taskService
);

// Task scheduling service
const schedulerService = new SchedulerService(
  db,
  pluginRegistry,
  eventProcessingService,
  eventSourceService
);

// Create the Hono router with all dependencies
const app = createRouter({
  db,
  githubService,
  apiKeyService,
  templateService,
  sandboxConfigService,
  taskService,
  sessionService,
  taskCreationService,
  worktreeService,
  marketplaceService,
  agentService,
  commandRunner: bunCommandRunner,
  workflowService,
  gitService,
  projectService,
  getSandboxProvider: () => {
    // In dev mode, trigger a lazy re-init if provider is null and no retry is pending
    if (!sandboxProvider && isDev && !sandboxRetryTimer) {
      scheduleSandboxRetry();
    }
    return sandboxProvider;
  },
  getK8sProvider,
  getNomadProvider,
  cliMonitorService,
  terraformRegistryService,
  terraformComposeService,
  settingsService: settingsServiceForCompose,
  eventSourceService,
  eventSubscriptionService,
  eventProcessingService,
  schedulerService,
});

// Start server
const PORT = 3001;

Bun.serve({
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 0, // Disable idle timeout to prevent Bun from killing long-lived SSE connections
});

log.info(`Server running on http://localhost:${PORT}`);

// Periodic K8s CRD health check + auto-heal (60s interval)
let k8sCrdHealInProgress = false;
let k8sHealInterval: ReturnType<typeof setInterval> | null = null;

function startK8sHealInterval() {
  if (k8sHealInterval) return; // already running

  k8sHealInterval = setInterval(async () => {
    const provider = activeK8sProvider;
    if (!provider) return;
    if (k8sCrdHealInProgress) return;

    k8sCrdHealInProgress = true;
    try {
      // Proactive cache validation: evict dead sandboxes from provider cache
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
        await ensureDefaultSandbox(provider, 'K8s');
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

      await waitForCrdRegistration(10_000);

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
        log.info('[K8s Heal] Auto-heal succeeded — CRDs restored');
      } else {
        log.warn('[K8s Heal] Auto-heal ran but cluster is still unhealthy');
      }
    } catch (err) {
      log.warn('[K8s Heal] Health check failed', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      k8sCrdHealInProgress = false;
    }
  }, 60_000);
}

// Periodic Nomad health check + auto-heal (60s interval)
let nomadHealInProgress = false;
let nomadHealInterval: ReturnType<typeof setInterval> | null = null;

function startNomadHealInterval() {
  if (nomadHealInterval) return; // already running

  nomadHealInterval = setInterval(async () => {
    const provider = activeNomadProvider;
    if (!provider) return;
    if (nomadHealInProgress) return;

    nomadHealInProgress = true;
    try {
      // Proactive cache validation: evict dead sandboxes from provider cache
      try {
        await provider.validateSandboxes();
      } catch (valErr) {
        log.warn('[Nomad Heal] Cache validation failed', {
          error: valErr instanceof Error ? valErr.message : String(valErr),
        });
      }

      // Ensure default sandbox exists and is healthy
      try {
        await ensureDefaultSandbox(provider, 'Nomad');
      } catch (defaultErr) {
        log.warn('[Nomad Heal] Default sandbox check failed', {
          error: defaultErr instanceof Error ? defaultErr.message : String(defaultErr),
        });
      }

      const health = await provider.healthCheck();
      if (health.healthy) {
        await clearNomadLastError();
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
      nomadHealInProgress = false;
    }
  }, 60_000);
}

// Initialize sandbox provider in the background (non-blocking)
// Then start K8s/Nomad auto-heal intervals if providers are active.
// If initialization fails (e.g. cluster not running at startup), retry with backoff.
let sandboxRetryCount = 0;
const isDev = process.env.NODE_ENV === 'development';
const SANDBOX_MAX_RETRIES = isDev ? 0 : 10; // 0 = unlimited in dev
const SANDBOX_BASE_DELAY_MS = isDev ? 3_000 : 15_000; // 3s in dev, 15s in prod
const SANDBOX_MAX_DELAY_MS = isDev ? 30_000 : 300_000; // 30s in dev, 5m in prod
let sandboxRetryTimer: ReturnType<typeof setTimeout> | null = null;

function onSandboxProviderReady() {
  sandboxRetryCount = 0;
  if (sandboxRetryTimer) {
    clearTimeout(sandboxRetryTimer);
    sandboxRetryTimer = null;
  }
  if (activeK8sProvider) {
    startK8sHealInterval();
    log.info('[API Server] K8s CRD auto-heal interval started (60s)');
  }
  if (activeNomadProvider) {
    startNomadHealInterval();
    log.info('[API Server] Nomad auto-heal interval started (60s)');
  }
}

function scheduleSandboxRetry() {
  if (SANDBOX_MAX_RETRIES > 0 && sandboxRetryCount >= SANDBOX_MAX_RETRIES) {
    log.warn(
      `[API Server] Sandbox provider initialization failed after ${SANDBOX_MAX_RETRIES} retries — giving up. Restart the server to try again.`
    );
    return;
  }

  const delay = Math.min(SANDBOX_BASE_DELAY_MS * 2 ** sandboxRetryCount, SANDBOX_MAX_DELAY_MS);
  sandboxRetryCount++;

  log.info(
    `[API Server] Will retry sandbox provider initialization in ${Math.round(delay / 1000)}s (attempt ${sandboxRetryCount}/${SANDBOX_MAX_RETRIES})`
  );

  sandboxRetryTimer = setTimeout(async () => {
    sandboxRetryTimer = null;
    if (sandboxProvider) return; // Already initialized

    try {
      await initSandboxProvider();
      if (sandboxProvider) {
        log.info('[API Server] Sandbox provider initialized on retry');
        onSandboxProviderReady();
      } else {
        scheduleSandboxRetry();
      }
    } catch (err) {
      log.warn('[API Server] Sandbox provider retry failed:', {
        error: err instanceof Error ? err.message : String(err),
      });
      scheduleSandboxRetry();
    }
  }, delay);
  sandboxRetryTimer.unref(); // Don't prevent process exit
}

initSandboxProvider()
  .then(() => {
    if (sandboxProvider) {
      onSandboxProviderReady();
    } else {
      scheduleSandboxRetry();
    }
  })
  .catch((err) => {
    log.error('[API Server] Sandbox provider initialization failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    scheduleSandboxRetry();
  });

// Start the template sync scheduler
const stopTemplateSync = startSyncScheduler(db, templateService);
log.info('[API Server] Template sync scheduler started');

// Start the Terraform sync scheduler
const stopTerraformSync = startTerraformSyncScheduler(db, terraformRegistryService);
log.info('[API Server] Terraform sync scheduler started');

// Start the task scheduler
schedulerService.start().catch((err) => {
  log.error('[API Server] Failed to start scheduler', { error: err });
});
log.info('[API Server] Task scheduler started');

// Graceful shutdown: stop accepting requests, clean up services, close DB
let isShuttingDown = false;

async function shutdownServer(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`[API Server] Received ${signal}, shutting down gracefully...`);

  // Force-exit safety net after 30 seconds
  const forceExitTimer = setTimeout(() => {
    log.error('[API Server] Graceful shutdown timed out after 30s, forcing exit');
    process.exit(1);
  }, 30_000);
  forceExitTimer.unref();

  // Stop running agents
  if (containerAgentService) {
    const runningAgents = containerAgentService.getRunningAgents();
    for (const agent of runningAgents) {
      containerAgentService.stopAgent(agent.taskId).catch((stopErr) => {
        log.warn('[API Server] Failed to stop agent during shutdown', {
          data: { taskId: agent.taskId, error: String(stopErr) },
        });
      });
    }
    containerAgentService.dispose();
  }

  // Stop K8s auto-heal interval
  if (k8sHealInterval) {
    clearInterval(k8sHealInterval);
    k8sHealInterval = null;
  }

  // Stop Nomad auto-heal interval
  if (nomadHealInterval) {
    clearInterval(nomadHealInterval);
    nomadHealInterval = null;
  }

  // Stop sandbox provider retry timer
  if (sandboxRetryTimer) {
    clearTimeout(sandboxRetryTimer);
    sandboxRetryTimer = null;
  }

  // Stop sandbox controller
  sandboxController?.stop();

  // Stop schedulers
  stopTemplateSync();
  stopTerraformSync();

  // Stop scheduler
  await schedulerService.stop();

  // Clean up services
  cliMonitorService.destroy();

  // Close database
  if (pgClient) {
    try {
      await pgClient.end();
      log.info('[API Server] Database closed');
    } catch (dbErr) {
      log.warn('[API Server] Failed to close database', { error: dbErr });
    }
  } else if (sqlite) {
    try {
      sqlite.close();
      log.info('[API Server] Database closed');
    } catch (dbErr) {
      log.warn('[API Server] Failed to close database', { error: dbErr });
    }
  }

  log.info('[API Server] Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdownServer('SIGINT'));
process.on('SIGTERM', () => shutdownServer('SIGTERM'));
>>>>>>> theirs
