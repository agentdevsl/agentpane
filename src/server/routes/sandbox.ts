/**
 * Sandbox routes (K8s, Nomad, and shared config CRUD)
 */

import { resolve as dnsResolve } from 'node:dns/promises';
import {
  AgentSandboxClient,
  getClusterInfo,
  loadKubeConfig,
  resolveContext,
} from '@agentpane/agent-sandbox-sdk';
import { Hono } from 'hono';
import type { SandboxType } from '../../db/schema/shared/enums.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { SandboxConfigService } from '../../services/sandbox-config.service.js';
import type { Database } from '../../types/database.js';
import { isValidId, json } from '../shared.js';

const log = createLogger('SandboxRoutes');

/** Strip the nomadToken field from a config before returning it to the client. */
function redactConfig<T extends Record<string, unknown>>(config: T): Omit<T, 'nomadToken'> {
  const { nomadToken: _token, ...safe } = config;
  return safe;
}

interface SandboxDeps {
  sandboxConfigService: SandboxConfigService;
}

export function createSandboxRoutes({ sandboxConfigService }: SandboxDeps) {
  const app = new Hono();

  // GET /api/sandbox-configs
  app.get('/', async (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 100);
    const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0);

    try {
      const result = await sandboxConfigService.list({ limit, offset });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({
        ok: true,
        data: {
          items: result.value.items.map(({ nomadToken, ...rest }) => rest),
          totalCount: result.value.totalCount,
        },
      });
    } catch (error) {
      log.error('SandboxConfigs list error', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list sandbox configs' } },
        500
      );
    }
  });

  // POST /api/sandbox-configs
  app.post('/', async (c) => {
    let body: {
      name: string;
      description?: string;
      type?: SandboxType;
      isDefault?: boolean;
      baseImage?: string;
      memoryMb?: number;
      cpuCores?: number;
      maxProcesses?: number;
      timeoutMinutes?: number;
      volumeMountPath?: string;
      kubeConfigPath?: string;
      kubeContext?: string;
      kubeNamespace?: string;
      networkPolicyEnabled?: boolean;
      allowedEgressHosts?: string[];
      nomadAddress?: string;
      nomadToken?: string;
      nomadNamespace?: string;
      nomadDatacenter?: string;
      nomadRegion?: string;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } },
        400
      );
    }
    try {
      if (!body.name) {
        return json(
          { ok: false, error: { code: 'MISSING_PARAMS', message: 'Name is required' } },
          400
        );
      }

      if (body.nomadAddress) {
        const addrValidation = await validateNomadAddress(body.nomadAddress);
        if (!addrValidation.valid) {
          return json(
            {
              ok: false,
              error: {
                code: 'INVALID_ADDRESS',
                message: addrValidation.error,
              },
            },
            400
          );
        }
      }

      const result = await sandboxConfigService.create({
        name: body.name,
        description: body.description,
        type: body.type,
        isDefault: body.isDefault,
        baseImage: body.baseImage,
        memoryMb: body.memoryMb,
        cpuCores: body.cpuCores,
        maxProcesses: body.maxProcesses,
        timeoutMinutes: body.timeoutMinutes,
        volumeMountPath: body.volumeMountPath,
        kubeConfigPath: body.kubeConfigPath,
        kubeContext: body.kubeContext,
        kubeNamespace: body.kubeNamespace,
        networkPolicyEnabled: body.networkPolicyEnabled,
        allowedEgressHosts: body.allowedEgressHosts,
        nomadAddress: body.nomadAddress,
        nomadToken: body.nomadToken,
        nomadNamespace: body.nomadNamespace,
        nomadDatacenter: body.nomadDatacenter,
        nomadRegion: body.nomadRegion,
      });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: redactConfig(result.value) }, 201);
    } catch (error) {
      log.error('SandboxConfigs create error', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create sandbox config' } },
        500
      );
    }
  });

  // GET /api/sandbox-configs/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await sandboxConfigService.getById(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: redactConfig(result.value) });
    } catch (error) {
      log.error('SandboxConfigs get error', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get sandbox config' } },
        500
      );
    }
  });

  // PATCH /api/sandbox-configs/:id
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    let body: {
      name?: string;
      description?: string;
      type?: SandboxType;
      isDefault?: boolean;
      baseImage?: string;
      memoryMb?: number;
      cpuCores?: number;
      maxProcesses?: number;
      timeoutMinutes?: number;
      volumeMountPath?: string;
      kubeConfigPath?: string;
      kubeContext?: string;
      kubeNamespace?: string;
      networkPolicyEnabled?: boolean;
      allowedEgressHosts?: string[];
      nomadAddress?: string;
      nomadToken?: string;
      nomadNamespace?: string;
      nomadDatacenter?: string;
      nomadRegion?: string;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } },
        400
      );
    }
    try {
      if (body.nomadAddress) {
        const addrValidation = await validateNomadAddress(body.nomadAddress);
        if (!addrValidation.valid) {
          return json(
            {
              ok: false,
              error: {
                code: 'INVALID_ADDRESS',
                message: addrValidation.error,
              },
            },
            400
          );
        }
      }

      const result = await sandboxConfigService.update(id, {
        name: body.name,
        description: body.description,
        type: body.type,
        isDefault: body.isDefault,
        baseImage: body.baseImage,
        memoryMb: body.memoryMb,
        cpuCores: body.cpuCores,
        maxProcesses: body.maxProcesses,
        timeoutMinutes: body.timeoutMinutes,
        volumeMountPath: body.volumeMountPath,
        kubeConfigPath: body.kubeConfigPath,
        kubeContext: body.kubeContext,
        kubeNamespace: body.kubeNamespace,
        networkPolicyEnabled: body.networkPolicyEnabled,
        allowedEgressHosts: body.allowedEgressHosts,
        nomadAddress: body.nomadAddress,
        nomadToken: body.nomadToken,
        nomadNamespace: body.nomadNamespace,
        nomadDatacenter: body.nomadDatacenter,
        nomadRegion: body.nomadRegion,
      });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: redactConfig(result.value) });
    } catch (error) {
      log.error('SandboxConfigs update error', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update sandbox config' } },
        500
      );
    }
  });

  // DELETE /api/sandbox-configs/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await sandboxConfigService.delete(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: null });
    } catch (error) {
      log.error('SandboxConfigs delete error', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete sandbox config' } },
        500
      );
    }
  });

  return app;
}

/**
 * Validate kubeconfigPath to prevent path traversal attacks.
 * Only allows paths under the user's home directory or standard kubeconfig locations.
 */
function validateKubeconfigPath(path: string | undefined): string | undefined {
  if (!path) return undefined;

  // Reject path traversal attempts
  if (path.includes('..')) {
    throw new Error('Invalid kubeconfig path: path traversal not allowed');
  }

  // Only allow paths that look like kubeconfig files
  const normalized = path.startsWith('~/') ? path.replace('~', process.env.HOME ?? '') : path;

  // Must be under home directory or /etc/kubernetes or /var/run
  const homeDir = process.env.HOME ?? '/home';
  const allowedPrefixes = [homeDir, '/etc/kubernetes', '/var/run/secrets/kubernetes.io'];

  if (!allowedPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(
      'Invalid kubeconfig path: must be under home directory or standard K8s config location'
    );
  }

  return path;
}

/**
 * Attempt to start minikube. Returns true if started successfully.
 */
async function attemptMinikubeStart(): Promise<{ started: boolean; message: string }> {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    const { stdout, stderr } = await execAsync('minikube start', {
      timeout: 120_000,
    });
    const output = stdout || stderr;
    return { started: true, message: output.trim().split('\n').pop() ?? 'Minikube started' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('K8s failed to start minikube', { error: new Error(message) });
    return { started: false, message: `Failed to start minikube: ${message}` };
  }
}

/**
 * Poll `kubectl get crd sandboxes.agents.x-k8s.io` every 1s until success
 * or the timeout is reached. Returns true when the CRD is registered.
 */
async function waitForCrdRegistration(
  execAsync: (cmd: string, opts: { timeout: number }) => Promise<unknown>,
  maxWaitMs = 10_000
): Promise<boolean> {
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
 * Check if the given context is minikube.
 */
function isMinikubeContext(context?: string): boolean {
  return context === 'minikube';
}

/**
 * Create K8s-specific routes
 */
export function createK8sRoutes(deps?: { db?: Database }) {
  const app = new Hono();

  // GET /api/sandbox/k8s/status
  app.get('/status', async (c) => {
    const context = c.req.query('context') ?? undefined;

    let kubeconfigPath: string | undefined;
    try {
      kubeconfigPath = validateKubeconfigPath(c.req.query('kubeconfigPath') ?? undefined);
    } catch (error) {
      return json(
        {
          ok: false,
          error: {
            code: 'INVALID_KUBECONFIG_PATH',
            message: error instanceof Error ? error.message : 'Invalid kubeconfig path',
          },
        },
        400
      );
    }

    try {
      // Load kubeconfig
      const skipTLSVerify = c.req.query('skipTLSVerify') === 'true';
      const kc = loadKubeConfig({ kubeconfigPath, skipTLSVerify });

      // Resolve context if specified
      if (context) {
        resolveContext(kc, context);
      }

      // Get cluster info
      const clusterInfo = getClusterInfo(kc);
      const currentContext = kc.getCurrentContext();

      // Try to connect to the cluster
      const k8s = await import('@kubernetes/client-node');
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);

      // Get server version using Node.js https module
      // This also serves as the cluster connectivity check
      let serverVersion = 'unknown';
      let clusterReachable = false;
      try {
        const cluster = kc.getCurrentCluster();
        if (cluster?.server) {
          const https = await import('node:https');
          const { URL } = await import('node:url');
          const versionUrl = new URL('/version', cluster.server);

          const versionData = await new Promise<{
            gitVersion?: string;
            major?: string;
            minor?: string;
          }>((resolve, reject) => {
            const req = https.request(
              versionUrl,
              {
                method: 'GET',
                rejectUnauthorized: false,
                timeout: 5000,
              },
              (res) => {
                let data = '';
                res.on('data', (chunk) => {
                  data += chunk;
                });
                res.on('end', () => {
                  try {
                    resolve(JSON.parse(data));
                  } catch (parseError) {
                    log.warn('K8s Status failed to parse version response', {
                      error: parseError instanceof Error ? parseError : new Error('parse error'),
                      data: { responsePreview: data.substring(0, 100) },
                    });
                    reject(new Error('Invalid JSON response from K8s version endpoint'));
                  }
                });
              }
            );
            req.on('timeout', () => {
              req.destroy();
              reject(new Error('Connection timed out'));
            });
            req.on('error', reject);
            req.end();
          });

          serverVersion = versionData.gitVersion || `v${versionData.major}.${versionData.minor}`;
          clusterReachable = true;
        }
      } catch (versionError) {
        log.warn('K8s Status version fetch failed', {
          error: versionError instanceof Error ? versionError : new Error(String(versionError)),
        });
      }

      // If version fetch failed, the cluster is not reachable
      if (!clusterReachable) {
        // Check if autoStartMinikube is enabled and context is minikube
        let autoStartEnabled = false;
        if (deps?.db && isMinikubeContext(currentContext)) {
          try {
            const { eq } = await import('drizzle-orm');
            const { settings } = await import('../../db/schema/index.js');
            const k8sSetting = await deps.db.query.settings.findFirst({
              where: eq(settings.key, 'sandbox.kubernetes'),
            });
            if (k8sSetting?.value) {
              const parsed = JSON.parse(k8sSetting.value);
              autoStartEnabled = parsed.autoStartMinikube === true;
            }
          } catch (dbErr) {
            log.warn('Failed to load autoStartMinikube setting from database', {
              error: dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
            });
          }
        }

        // Attempt auto-start if configured
        if (autoStartEnabled) {
          log.info('K8s Status auto-starting minikube (autoStartMinikube enabled)');
          const startResult = await attemptMinikubeStart();
          if (startResult.started) {
            log.info('K8s Status minikube auto-started, retrying cluster check');
            // Retry the version fetch after minikube starts
            try {
              const cluster = kc.getCurrentCluster();
              if (cluster?.server) {
                const https = await import('node:https');
                const { URL } = await import('node:url');
                const retryUrl = new URL('/version', cluster.server);
                const retryData = await new Promise<{
                  gitVersion?: string;
                  major?: string;
                  minor?: string;
                }>((resolve, reject) => {
                  const retryReq = https.request(
                    retryUrl,
                    { method: 'GET', rejectUnauthorized: false, timeout: 10000 },
                    (res) => {
                      let data = '';
                      res.on('data', (chunk) => {
                        data += chunk;
                      });
                      res.on('end', () => {
                        try {
                          resolve(JSON.parse(data));
                        } catch {
                          reject(new Error('Parse error'));
                        }
                      });
                    }
                  );
                  retryReq.on('timeout', () => {
                    retryReq.destroy();
                    reject(new Error('Timeout'));
                  });
                  retryReq.on('error', reject);
                  retryReq.end();
                });
                serverVersion = retryData.gitVersion || `v${retryData.major}.${retryData.minor}`;
                clusterReachable = true;
              }
            } catch (retryErr) {
              log.warn('Cluster still unreachable after minikube auto-start', {
                error: retryErr instanceof Error ? retryErr : new Error(String(retryErr)),
              });
            }
          }
        }

        // If still unreachable, return unhealthy status
        if (!clusterReachable) {
          return json({
            ok: true,
            data: {
              healthy: false,
              message:
                'Cannot reach the Kubernetes cluster. Check that minikube or your cluster is running.',
              context: currentContext,
              cluster: clusterInfo?.name,
              server: clusterInfo?.server,
              serverVersion,
            },
          });
        }
      }

      // Check namespace
      const namespace = 'agentpane-sandboxes';
      let namespaceExists = false;
      let pods = 0;
      let podsRunning = 0;

      try {
        await coreApi.readNamespace({ name: namespace });
        namespaceExists = true;

        // Count pods in namespace
        const podList = await coreApi.listNamespacedPod({ namespace });
        pods = podList.items.length;
        podsRunning = podList.items.filter((p) => p.status?.phase === 'Running').length;
      } catch (error) {
        // Check if this is a 404 (namespace doesn't exist) vs other errors
        const statusCode = (error as { response?: { statusCode?: number } }).response?.statusCode;
        if (statusCode === 404) {
          // Namespace doesn't exist yet - this is expected
          log.debug('K8s Status namespace does not exist yet', { data: { namespace } });
        } else {
          // Log other errors (auth failures, network issues, etc.)
          log.error('K8s Status namespace check failed', {
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }

      return json({
        ok: true,
        data: {
          healthy: true,
          context: currentContext,
          cluster: clusterInfo?.name,
          server: clusterInfo?.server,
          serverVersion,
          namespace,
          namespaceExists,
          pods,
          podsRunning,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect to cluster';
      log.error('K8s Status error', { error: new Error(message) });
      return json(
        {
          ok: false,
          error: {
            code: 'K8S_CONNECTION_ERROR',
            message,
          },
        },
        500
      );
    }
  });

  // GET /api/sandbox/k8s/contexts
  app.get('/contexts', async (c) => {
    let kubeconfigPath: string | undefined;
    try {
      kubeconfigPath = validateKubeconfigPath(c.req.query('kubeconfigPath') ?? undefined);
    } catch (error) {
      return json(
        {
          ok: false,
          error: {
            code: 'INVALID_KUBECONFIG_PATH',
            message: error instanceof Error ? error.message : 'Invalid kubeconfig path',
          },
        },
        400
      );
    }

    try {
      const kc = loadKubeConfig({ kubeconfigPath });
      const contexts = kc.getContexts();
      const currentContext = kc.getCurrentContext();

      return json({
        ok: true,
        data: {
          contexts: contexts.map((ctx) => ({
            name: ctx.name,
            cluster: ctx.cluster,
            user: ctx.user,
            namespace: ctx.namespace,
          })),
          current: currentContext,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load kubeconfig';
      log.error('K8s Contexts error', { error: new Error(message) });
      return json(
        {
          ok: false,
          error: { code: 'K8S_CONFIG_ERROR', message },
        },
        400
      );
    }
  });

  // GET /api/sandbox/k8s/namespaces
  app.get('/namespaces', async (c) => {
    let kubeconfigPath: string | undefined;
    try {
      kubeconfigPath = validateKubeconfigPath(c.req.query('kubeconfigPath') ?? undefined);
    } catch (error) {
      return json(
        {
          ok: false,
          error: {
            code: 'INVALID_KUBECONFIG_PATH',
            message: error instanceof Error ? error.message : 'Invalid kubeconfig path',
          },
        },
        400
      );
    }

    const context = c.req.query('context') ?? undefined;
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const skipTLSVerify = c.req.query('skipTLSVerify') === 'true';

    try {
      const kc = loadKubeConfig({ kubeconfigPath, skipTLSVerify });

      if (context) {
        resolveContext(kc, context);
      }

      const k8s = await import('@kubernetes/client-node');
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);

      const namespaceList = await coreApi.listNamespace({ limit });

      return json({
        ok: true,
        data: {
          namespaces: namespaceList.items.map((ns) => ({
            name: ns.metadata?.name,
            status: ns.status?.phase,
            createdAt: ns.metadata?.creationTimestamp,
          })),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list namespaces';
      log.error('K8s Namespaces error', { error: new Error(message) });
      return json(
        {
          ok: false,
          error: { code: 'K8S_API_ERROR', message },
        },
        500
      );
    }
  });

  // GET /api/sandbox/k8s/controller - CRD controller installation status
  app.get('/controller', async (c) => {
    try {
      // Load K8s settings from query params or defaults
      let namespace = 'agentpane-sandboxes';
      let kubeconfigPath: string | undefined = c.req.query('kubeconfigPath') ?? undefined;
      let kubeContext: string | undefined = c.req.query('context') ?? undefined;
      let skipTLSVerify = c.req.query('skipTLSVerify') === 'true';

      // Also try loading from DB settings if available
      if (deps?.db && !kubeconfigPath && !kubeContext) {
        try {
          const { eq } = await import('drizzle-orm');
          const { settings } = await import('../../db/schema/index.js');
          const k8sSetting = await deps.db.query.settings.findFirst({
            where: eq(settings.key, 'sandbox.kubernetes'),
          });
          if (k8sSetting?.value) {
            const parsed = JSON.parse(k8sSetting.value);
            namespace = parsed.namespace ?? namespace;
            kubeconfigPath = parsed.kubeConfigPath;
            kubeContext = parsed.kubeContext;
            skipTLSVerify = parsed.skipTLSVerify ?? skipTLSVerify;
          }
        } catch (dbErr) {
          log.warn('Failed to load K8s settings from database, using defaults', {
            error: dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
          });
        }
      }

      // Create a temporary SDK client to check controller status
      const client = new AgentSandboxClient({
        namespace,
        kubeconfigPath,
        context: kubeContext,
        skipTLSVerify,
      });
      const health = await client.healthCheck();

      return json({
        ok: true,
        data: {
          installed: health.controllerInstalled,
          crdReady: health.crdRegistered && health.namespaceExists,
          version: health.controllerVersion ?? null,
          crdRegistered: health.crdRegistered,
          crdGroup: 'agents.x-k8s.io',
          crdApiVersion: 'v1alpha1',
          clusterVersion: health.clusterVersion ?? null,
          ready: health.healthy,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('K8s Controller error', { error: new Error(message) });
      return json(
        {
          ok: false,
          error: {
            code: 'K8S_CONTROLLER_ERROR',
            message: `Failed to check CRD controller: ${message}`,
          },
        },
        500
      );
    }
  });

  // POST /api/sandbox/k8s/minikube/start - Manually start minikube
  app.post('/minikube/start', async (c) => {
    const context = c.req.query('context') ?? undefined;

    // Only allow starting minikube if context is minikube (or unset, defaulting to minikube)
    if (context && !isMinikubeContext(context)) {
      return json(
        {
          ok: false,
          error: {
            code: 'NOT_MINIKUBE',
            message: 'Minikube start is only supported when the context is minikube',
          },
        },
        400
      );
    }

    try {
      log.info('K8s Minikube starting minikube');
      const result = await attemptMinikubeStart();

      return json({
        ok: true,
        data: {
          started: result.started,
          message: result.message,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('K8s Minikube start error', { error: new Error(message) });
      return json(
        {
          ok: false,
          error: {
            code: 'MINIKUBE_START_ERROR',
            message: `Failed to start minikube: ${message}`,
          },
        },
        500
      );
    }
  });

  // POST /api/sandbox/k8s/install-crds - Install CRDs, namespace, and supporting manifests
  app.post('/install-crds', async (_c) => {
    try {
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const path = await import('node:path');
      const fs = await import('node:fs');
      const execAsync = promisify(exec);

      const manifestsDir = path.join(process.cwd(), 'k8s', 'manifests');

      // Verify manifests directory exists
      if (!fs.existsSync(manifestsDir)) {
        return json(
          {
            ok: false,
            error: {
              code: 'MANIFESTS_NOT_FOUND',
              message: `Manifests directory not found at ${manifestsDir}`,
            },
          },
          500
        );
      }

      // Check kubectl is available
      try {
        await execAsync('kubectl version --client --output=json', { timeout: 5000 });
      } catch {
        return json(
          {
            ok: false,
            error: {
              code: 'KUBECTL_NOT_FOUND',
              message: 'kubectl is not installed or not in PATH',
            },
          },
          500
        );
      }

      const results: Array<{ step: string; success: boolean; message: string }> = [];

      // Helper to apply a manifest file
      const applyManifest = async (filename: string, stepName: string) => {
        const filePath = path.join(manifestsDir, filename);
        if (!fs.existsSync(filePath)) {
          results.push({ step: stepName, success: false, message: `File not found: ${filename}` });
          return;
        }
        try {
          const { stdout, stderr } = await execAsync(`kubectl apply -f "${filePath}"`, {
            timeout: 30_000,
          });
          results.push({
            step: stepName,
            success: true,
            message: (stdout || stderr).trim().split('\n').pop() ?? 'Applied',
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ step: stepName, success: false, message: msg });
        }
      };

      log.info('K8s Install starting CRD installation');

      // Step 1: Apply CRD definitions
      await applyManifest('crds.yaml', 'CRD Definitions');

      // Wait for CRD to be registered before applying custom resources
      const crdRegistered = await waitForCrdRegistration(execAsync, 10_000);
      if (!crdRegistered) {
        log.warn('K8s Install CRD registration timed out after 10s — custom resources may fail');
      }

      // Step 2: Create namespace
      await applyManifest('namespace.yaml', 'Namespace');

      // Step 3: Apply RuntimeClass (optional, may fail without gvisor)
      await applyManifest('runtime-class-gvisor.yaml', 'RuntimeClass');

      // Step 4: Apply LimitRange
      await applyManifest('limit-range.yaml', 'LimitRange');

      // Step 5: Try to install the external CRD controller
      try {
        const CRD_INSTALL_URL =
          'https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml';
        const { stdout, stderr } = await execAsync(`kubectl apply -f "${CRD_INSTALL_URL}"`, {
          timeout: 60_000,
        });
        results.push({
          step: 'CRD Controller',
          success: true,
          message: (stdout || stderr).trim().split('\n').pop() ?? 'Controller installed',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          step: 'CRD Controller',
          success: false,
          message: `Controller install failed (CRDs still usable): ${msg.split('\n')[0]}`,
        });
      }

      // Step 6: Apply SandboxTemplate (requires CRDs to be registered)
      await applyManifest('agentpane-sandbox-template.yaml', 'SandboxTemplate');

      // Step 7: Apply WarmPool
      await applyManifest('agentpane-warm-pool.yaml', 'WarmPool');

      const allCriticalSuccess = results
        .filter((r) => ['CRD Definitions', 'Namespace'].includes(r.step))
        .every((r) => r.success);

      log.info('K8s Install installation complete', {
        data: { results: results.map((r) => `${r.step}: ${r.success ? 'OK' : 'FAIL'}`).join(', ') },
      });

      return json({
        ok: true,
        data: {
          installed: allCriticalSuccess,
          results,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('K8s Install error', { error: new Error(message) });
      return json(
        {
          ok: false,
          error: {
            code: 'CRD_INSTALL_ERROR',
            message: `Failed to install CRDs: ${message}`,
          },
        },
        500
      );
    }
  });

  return app;
}

/**
 * Nomad-specific routes
 */

interface NomadRouteDeps {
  db?: Database;
}

/**
 * Check whether an IP address string falls within a private or reserved range.
 * Covers IPv4 loopback, RFC 1918, link-local (including cloud metadata 169.254.x.x),
 * the unspecified address, and common IPv6 reserved addresses.
 */
function isPrivateIp(ip: string): boolean {
  // IPv6 reserved addresses
  if (ip === '::1' || ip === '::') return true;
  if (ip.toLowerCase().startsWith('fe80:')) return true;

  // IPv4 ranges
  const parts = ip.split('.');
  if (parts.length === 4) {
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (ip === '0.0.0.0') return true;
  }

  return false;
}

/**
 * Validate Nomad address to prevent SSRF attacks against cloud metadata endpoints.
 * Returns { valid: true } on success or { valid: false, error: string } on failure.
 * Also performs DNS resolution to prevent DNS rebinding attacks.
 */
export async function validateNomadAddress(
  address: string
): Promise<{ valid: true } | { valid: false; error: string }> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { valid: false, error: 'Invalid Nomad address URL format' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { valid: false, error: 'Nomad address must use http or https protocol' };
  }
  const hostname = url.hostname;
  // Block cloud metadata endpoints (full 169.254.0.0/16 link-local range)
  if (hostname.startsWith('169.254.') || hostname === 'metadata.google.internal') {
    return { valid: false, error: 'Nomad address cannot target cloud metadata endpoints' };
  }
  // Block 0.0.0.0 (binds to all interfaces, effectively localhost)
  if (hostname === '0.0.0.0') {
    return { valid: false, error: 'Nomad address cannot target 0.0.0.0' };
  }
  // Block "localhost" hostname
  if (hostname === 'localhost') {
    return {
      valid: false,
      error: 'Nomad address cannot use "localhost" — use an IP address instead',
    };
  }
  // Restrict loopback addresses (127.x.x.x) to Nomad's default port (4646) only.
  // This prevents SSRF against other locally-bound services (Redis, databases, etc.)
  // while still allowing local Nomad development setups.
  const NOMAD_DEFAULT_PORT = 4646;
  if (hostname.startsWith('127.')) {
    const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
    if (port !== NOMAD_DEFAULT_PORT) {
      return {
        valid: false,
        error: `Nomad address on loopback (127.x) must use port ${NOMAD_DEFAULT_PORT} to prevent SSRF`,
      };
    }
  }
  // Block IPv6 loopback and IPv6-mapped loopback/metadata addresses
  if (hostname === '[::1]' || hostname === '::1') {
    return { valid: false, error: 'Nomad address cannot target IPv6 loopback' };
  }
  const normalizedHost = hostname.replace(/^\[|\]$/g, '');
  if (
    normalizedHost === '::1' ||
    normalizedHost === '0:0:0:0:0:0:0:1' ||
    normalizedHost.startsWith('::ffff:169.254.') ||
    normalizedHost.startsWith('::ffff:127.') ||
    // URL constructor normalizes 169.254.x.y to hex a9fe:XXYY in IPv6-mapped form
    normalizedHost.startsWith('::ffff:a9fe:')
  ) {
    return {
      valid: false,
      error: 'Nomad address cannot target loopback or cloud metadata via IPv6',
    };
  }
  // Block IPv6 link-local (fe80::/10)
  if (hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) {
    return { valid: false, error: 'Nomad address cannot target IPv6 link-local addresses' };
  }
  // Block RFC 1918 private addresses in the 10.0.0.0/8 and 172.16.0.0/12 ranges
  const blockedPrefixes = [
    '10.',
    '172.16.',
    '172.17.',
    '172.18.',
    '172.19.',
    '172.20.',
    '172.21.',
    '172.22.',
    '172.23.',
    '172.24.',
    '172.25.',
    '172.26.',
    '172.27.',
    '172.28.',
    '172.29.',
    '172.30.',
    '172.31.',
  ];
  // 127.x is port-restricted to 4646 above. 10.x and 172.16-31.x are blocked because they
  // typically correspond to cloud VPC infrastructure (AWS VPC, GCP internal, etc.) where
  // SSRF could reach sensitive internal services or metadata endpoints.
  for (const prefix of blockedPrefixes) {
    if (hostname.startsWith(prefix)) {
      return { valid: false, error: 'Nomad address cannot target internal network addresses' };
    }
  }
  // Restrict 192.168.x.x (home/office LAN) to Nomad's default port (4646) only,
  // matching the 127.x restriction. This prevents SSRF against other LAN services
  // while still allowing local Nomad setups.
  if (hostname.startsWith('192.168.')) {
    const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
    if (port !== NOMAD_DEFAULT_PORT) {
      return {
        valid: false,
        error: `Nomad address on LAN (192.168.x) must use port ${NOMAD_DEFAULT_PORT} to prevent SSRF`,
      };
    }
  }

  // Resolve DNS to prevent rebinding attacks.
  // Skip DNS check for literal IP addresses (they don't need resolution).
  const isLiteralIp =
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.includes(':');
  if (!isLiteralIp) {
    try {
      const addresses = await dnsResolve(hostname);
      for (const addr of addresses) {
        if (isPrivateIp(addr)) {
          return { valid: false, error: `Nomad address resolves to private/reserved IP: ${addr}` };
        }
      }
    } catch {
      // DNS resolution failure — fail-closed to prevent SSRF via DNS rebinding.
      // If users need to use internal hostnames, they should use IP addresses directly.
      return {
        valid: false,
        error: `Cannot resolve hostname "${hostname}" — DNS lookup failed. Use an IP address or ensure the hostname is resolvable.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Helper to load Nomad settings from DB or query params.
 * Token is ONLY loaded from the database, never from query/overrides.
 * If an address override is provided, it is validated against the SSRF blocklist.
 * The stored token is only attached when the address matches the persisted address
 * (prevents sending the token to an attacker-controlled server).
 */
async function loadNomadSettings(
  db: Database | undefined,
  overrides?: { address?: string; namespace?: string }
): Promise<{
  address?: string;
  token?: string;
  namespace: string;
  tokenDecryptionFailed?: boolean;
}> {
  // Validate overridden address against SSRF blocklist
  if (overrides?.address) {
    const addrValidation = await validateNomadAddress(overrides.address);
    if (!addrValidation.valid) {
      throw new Error(addrValidation.error);
    }
  }

  let address = overrides?.address;
  let token: string | undefined;
  let tokenDecryptionFailed = false;
  let namespace = overrides?.namespace ?? 'default';

  // Single DB query to load persisted Nomad settings
  if (db) {
    try {
      const { eq } = await import('drizzle-orm');
      const { settings } = await import('../../db/schema/index.js');
      const nomadSetting = await db.query.settings.findFirst({
        where: eq(settings.key, 'sandbox.nomad'),
      });
      if (nomadSetting?.value) {
        const parsed = JSON.parse(nomadSetting.value);
        const dbAddress = parsed.address as string | undefined;

        // Use DB address if no override provided
        if (!address) {
          address = dbAddress;
        }

        // Use DB namespace as fallback when no override
        if (!overrides?.namespace) {
          namespace = parsed.namespace ?? 'default';
        }

        // Only attach the stored token when the address matches the persisted address.
        // This prevents sending our token to an attacker-controlled server.
        if (!overrides?.address || overrides.address === dbAddress) {
          const encryptedToken = parsed.token as string | undefined;
          if (encryptedToken) {
            try {
              const { decryptToken } = await import('../../lib/crypto/server-encryption.js');
              token = decryptToken(encryptedToken);
            } catch (decryptErr) {
              log.error(
                'Token decryption failed — the Nomad token must be re-entered in Settings. ' +
                  'This usually means the encryption key was rotated or the data is corrupted.',
                {
                  error: decryptErr instanceof Error ? decryptErr : new Error(String(decryptErr)),
                }
              );
              token = undefined;
              tokenDecryptionFailed = true;
            }
          }
        }
      }
    } catch (dbErr) {
      log.error('Failed to load Nomad settings from database', {
        error: dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
      });
      // Don't silently return defaults — let the caller know something is wrong
      throw dbErr;
    }
  }

  return { address, token, namespace, tokenDecryptionFailed: tokenDecryptionFailed || undefined };
}

export function createNomadRoutes(deps?: NomadRouteDeps) {
  const app = new Hono();

  // Lazy-cached import for NomadSandboxClient
  let NomadSandboxClientClass:
    | typeof import('@agentpane/nomad-sandbox-sdk').NomadSandboxClient
    | null = null;
  async function getNomadClient(opts: { address: string; token?: string; namespace?: string }) {
    if (!NomadSandboxClientClass) {
      const sdk = await import('@agentpane/nomad-sandbox-sdk');
      NomadSandboxClientClass = sdk.NomadSandboxClient;
    }
    return new NomadSandboxClientClass(opts);
  }

  // GET /api/sandbox/nomad/status - Nomad cluster health
  app.get('/status', async (c) => {
    try {
      const { address, token, namespace, tokenDecryptionFailed } = await loadNomadSettings(
        deps?.db,
        {
          address: c.req.query('address') ?? undefined,
          namespace: c.req.query('namespace') ?? undefined,
        }
      );

      if (!address) {
        return json({
          ok: true,
          data: { healthy: false, message: 'No Nomad address configured' },
        });
      }

      const client = await getNomadClient({ address, token, namespace });
      const health = await client.healthCheck();

      // Get job count (best effort)
      let jobCount: number | null = 0;
      try {
        const jobs = await client.listJobs();
        jobCount = jobs.length;
      } catch (err) {
        log.warn('Failed to fetch Nomad job count', {
          error: err instanceof Error ? err : new Error(String(err)),
        });
        jobCount = null;
      }

      return json({
        ok: true,
        data: {
          healthy: health.healthy,
          leader: health.leader,
          version: health.version,
          datacenter: health.datacenter,
          namespace,
          namespaceExists: health.namespaceExists,
          jobCount,
          ...(tokenDecryptionFailed && { tokenDecryptionFailed: true }),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect to Nomad';
      return json({ ok: false, error: { code: 'NOMAD_CONNECTION_ERROR', message } }, 500);
    }
  });

  // GET /api/sandbox/nomad/namespaces
  app.get('/namespaces', async (c) => {
    try {
      const { address, token, namespace } = await loadNomadSettings(deps?.db, {
        address: c.req.query('address') ?? undefined,
        namespace: c.req.query('namespace') ?? undefined,
      });

      if (!address) {
        return json(
          {
            ok: false,
            error: { code: 'NOMAD_NOT_CONFIGURED', message: 'No Nomad address configured' },
          },
          400
        );
      }

      const client = await getNomadClient({ address, token, namespace });
      const namespaces = await client.listNamespaces();
      return json({ ok: true, data: { namespaces } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list namespaces';
      return json({ ok: false, error: { code: 'NOMAD_API_ERROR', message } }, 500);
    }
  });

  // GET /api/sandbox/nomad/datacenters
  app.get('/datacenters', async (c) => {
    try {
      const { address, token, namespace } = await loadNomadSettings(deps?.db, {
        address: c.req.query('address') ?? undefined,
        namespace: c.req.query('namespace') ?? undefined,
      });

      if (!address) {
        return json(
          {
            ok: false,
            error: { code: 'NOMAD_NOT_CONFIGURED', message: 'No Nomad address configured' },
          },
          400
        );
      }

      const client = await getNomadClient({ address, token, namespace });
      const datacenters = await client.listDatacenters();
      return json({ ok: true, data: { datacenters } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list datacenters';
      return json({ ok: false, error: { code: 'NOMAD_API_ERROR', message } }, 500);
    }
  });

  // POST /api/sandbox/nomad/validate - Validate connection
  app.post('/validate', async (c) => {
    let body: { address: string; token?: string; namespace?: string };
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } },
        400
      );
    }

    if (!body.address) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'Nomad address is required' } },
        400
      );
    }

    // Validate address to prevent SSRF
    const addrValidation = await validateNomadAddress(body.address);
    if (!addrValidation.valid) {
      return json(
        {
          ok: false,
          error: {
            code: 'INVALID_ADDRESS',
            message: addrValidation.error,
          },
        },
        400
      );
    }

    try {
      // Note: validate endpoint accepts user-supplied token for initial setup.
      // The SSRF validation in validateNomadAddress prevents targeting internal services.
      const client = await getNomadClient({
        address: body.address,
        token: body.token,
        namespace: body.namespace ?? 'default',
      });
      const health = await client.healthCheck();

      return json({
        ok: true,
        data: {
          healthy: health.healthy,
          leader: health.leader,
          version: health.version,
          datacenter: health.datacenter,
          namespaceExists: health.namespaceExists,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to validate Nomad connection';
      return json({ ok: false, error: { code: 'NOMAD_VALIDATION_ERROR', message } }, 500);
    }
  });

  return app;
}
