/**
 * Sandbox routes (including K8s)
 */

import {
  AgentSandboxClient,
  getClusterInfo,
  loadKubeConfig,
  resolveContext,
} from '@agentpane/agent-sandbox-sdk';
import { Hono } from 'hono';
import type { SandboxConfigService } from '../../services/sandbox-config.service.js';
import type { Database } from '../../types/database.js';
import { json } from '../shared.js';

interface SandboxDeps {
  sandboxConfigService: SandboxConfigService;
}

export function createSandboxRoutes({ sandboxConfigService }: SandboxDeps) {
  const app = new Hono();

  // GET /api/sandbox-configs
  app.get('/', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    try {
      const result = await sandboxConfigService.list({ limit, offset });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({
        ok: true,
        data: {
          items: result.value,
          totalCount: result.value.length,
        },
      });
    } catch (error) {
      console.error('[SandboxConfigs] List error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list sandbox configs' } },
        500
      );
    }
  });

  // POST /api/sandbox-configs
  app.post('/', async (c) => {
    try {
      const body = (await c.req.json()) as {
        name: string;
        description?: string;
        type?: 'docker' | 'devcontainer' | 'kubernetes';
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
      };

      if (!body.name) {
        return json(
          { ok: false, error: { code: 'MISSING_PARAMS', message: 'Name is required' } },
          400
        );
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
      });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: result.value }, 201);
    } catch (error) {
      console.error('[SandboxConfigs] Create error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create sandbox config' } },
        500
      );
    }
  });

  // GET /api/sandbox-configs/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');

    try {
      const result = await sandboxConfigService.getById(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      console.error('[SandboxConfigs] Get error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get sandbox config' } },
        500
      );
    }
  });

  // PATCH /api/sandbox-configs/:id
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');

    try {
      const body = (await c.req.json()) as {
        name?: string;
        description?: string;
        type?: 'docker' | 'devcontainer' | 'kubernetes';
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
      };

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
      });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      console.error('[SandboxConfigs] Update error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update sandbox config' } },
        500
      );
    }
  });

  // DELETE /api/sandbox-configs/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    try {
      const result = await sandboxConfigService.delete(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: null });
    } catch (error) {
      console.error('[SandboxConfigs] Delete error:', error);
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
    console.warn('[K8s] Failed to start minikube:', message);
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
                    console.debug(
                      '[K8s Status] Failed to parse version response:',
                      parseError instanceof Error ? parseError.message : 'parse error',
                      'data:',
                      data.substring(0, 100)
                    );
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
        console.debug(
          '[K8s Status] Version fetch failed:',
          versionError instanceof Error ? versionError.message : versionError
        );
      }

      // If version fetch failed, the cluster is not reachable
      if (!clusterReachable) {
        // Check if autoStartMinikube is enabled and context is minikube
        let autoStartEnabled = false;
        if (deps?.db && isMinikubeContext(currentContext)) {
          try {
            const { eq } = await import('drizzle-orm');
            const { settings } = await import('../../db/schema/sqlite/index.js');
            const k8sSetting = await deps.db.query.settings.findFirst({
              where: eq(settings.key, 'sandbox.kubernetes'),
            });
            if (k8sSetting?.value) {
              const parsed = JSON.parse(k8sSetting.value);
              autoStartEnabled = parsed.autoStartMinikube === true;
            }
          } catch {
            // Ignore DB errors, just skip auto-start
          }
        }

        // Attempt auto-start if configured
        if (autoStartEnabled) {
          console.log('[K8s Status] Auto-starting minikube (autoStartMinikube enabled)...');
          const startResult = await attemptMinikubeStart();
          if (startResult.started) {
            console.log('[K8s Status] Minikube auto-started, retrying cluster check...');
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
            } catch {
              // Still unreachable after auto-start
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
          console.debug('[K8s Status] Namespace does not exist yet:', namespace);
        } else {
          // Log other errors (auth failures, network issues, etc.)
          console.error(
            '[K8s Status] Namespace check failed:',
            error instanceof Error ? error.message : error
          );
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
      console.error('[K8s Status] Error:', message);
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
      console.error('[K8s Contexts] Error:', message);
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
      console.error('[K8s Namespaces] Error:', message);
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
          const { settings } = await import('../../db/schema/sqlite/index.js');
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
        } catch {
          // Use defaults
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
      console.error('[K8s Controller] Error:', message);
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
      console.log('[K8s Minikube] Starting minikube...');
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
      console.error('[K8s Minikube] Start error:', message);
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

      console.log('[K8s Install] Starting CRD installation...');

      // Step 1: Apply CRD definitions
      await applyManifest('crds.yaml', 'CRD Definitions');

      // Wait for CRD to be registered before applying custom resources
      const crdRegistered = await waitForCrdRegistration(execAsync, 10_000);
      if (!crdRegistered) {
        console.warn(
          '[K8s Install] CRD registration timed out after 10s — custom resources may fail'
        );
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

      console.log(
        '[K8s Install] Installation complete:',
        results.map((r) => `${r.step}: ${r.success ? 'OK' : 'FAIL'}`).join(', ')
      );

      return json({
        ok: true,
        data: {
          installed: allCriticalSuccess,
          results,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[K8s Install] Error:', message);
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
