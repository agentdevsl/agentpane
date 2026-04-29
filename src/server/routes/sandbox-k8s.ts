/**
 * Kubernetes sandbox routes
 *
 * Split from sandbox.ts as part of AR-023 (March 2026 architecture review).
 * Handles K8s cluster status, context management, namespace listing,
 * CRD controller checks, minikube start, and CRD installation.
 */

import {
  AgentSandboxClient,
  getClusterInfo,
  loadKubeConfig,
  resolveContext,
} from '@agentpane/agent-sandbox-sdk';
import { Hono } from 'hono';
import { createLogger } from '../../lib/logging/logger.js';
import type { Database } from '../../types/database.js';
import { json, parseLimit } from '../shared.js';

const log = createLogger('SandboxK8sRoutes');

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

function isMinikubeContext(context?: string): boolean {
  return context === 'minikube';
}

async function fetchK8sVersion(
  serverUrl: string,
  skipTLSVerify: boolean,
  timeoutMs = 5000
): Promise<{ version: string; reachable: true } | { version: string; reachable: false }> {
  const https = await import('node:https');
  const { URL } = await import('node:url');
  const versionUrl = new URL('/version', serverUrl);

  try {
    const versionData = await new Promise<{
      gitVersion?: string;
      major?: string;
      minor?: string;
    }>((resolve, reject) => {
      const req = https.request(
        versionUrl,
        {
          method: 'GET',
          rejectUnauthorized: !skipTLSVerify,
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              log.warn('K8s version endpoint returned non-200 status', {
                data: { statusCode: res.statusCode, responsePreview: data.substring(0, 200) },
              });
              reject(new Error(`K8s version endpoint returned HTTP ${res.statusCode}`));
              return;
            }
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

    const version =
      versionData.gitVersion ||
      (versionData.major && versionData.minor
        ? `v${versionData.major}.${versionData.minor}`
        : null);
    if (!version) {
      log.warn('K8s version response missing version fields', {
        data: { keys: Object.keys(versionData) },
      });
    }
    return {
      version: version ?? 'unknown',
      reachable: true,
    };
  } catch (err) {
    log.warn('K8s Status version fetch failed', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return { version: 'unknown', reachable: false };
  }
}

function parseKubeconfigParam(raw: string | undefined): { path?: string } | Response {
  if (!raw) return {};
  try {
    return { path: validateKubeconfigPath(raw) };
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
}

/**
 * Create K8s-specific routes
 */
export function createK8sRoutes(deps?: { db?: Database }) {
  const app = new Hono();

  // GET /api/sandbox/k8s/status
  app.get('/status', async (c) => {
    const context = c.req.query('context') ?? undefined;

    const kcResult = parseKubeconfigParam(c.req.query('kubeconfigPath') ?? undefined);
    if (kcResult instanceof Response) return kcResult;
    const kubeconfigPath = kcResult.path;

    try {
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

      let serverVersion = 'unknown';
      let clusterReachable = false;
      const cluster = kc.getCurrentCluster();
      if (cluster?.server) {
        const versionResult = await fetchK8sVersion(cluster.server, skipTLSVerify);
        serverVersion = versionResult.version;
        clusterReachable = versionResult.reachable;
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
            if (cluster?.server) {
              const retryResult = await fetchK8sVersion(cluster.server, true, 10000);
              serverVersion = retryResult.version;
              clusterReachable = retryResult.reachable;
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
    const kcResult = parseKubeconfigParam(c.req.query('kubeconfigPath') ?? undefined);
    if (kcResult instanceof Response) return kcResult;
    const kubeconfigPath = kcResult.path;

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
    const kcResult = parseKubeconfigParam(c.req.query('kubeconfigPath') ?? undefined);
    if (kcResult instanceof Response) return kcResult;
    const kubeconfigPath = kcResult.path;

    const context = c.req.query('context') ?? undefined;
    const limit = parseLimit(c);
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

      // Step 5: Try to install the external CRD controller from vendored
      // manifest (arch29-W1-C / F04-11 — supply-chain hardening). Replaces
      // the previous live `kubectl apply -f <github releases/latest URL>`
      // which was a cluster-takeover supply-chain vector.
      try {
        const { VENDORED_AGENT_SANDBOX_MANIFEST, VENDORED_AGENT_SANDBOX_SHA256 } = await import(
          '../bootstrap/sandbox/k8s-init.js'
        );
        const { createHash } = await import('node:crypto');
        const { readFile } = await import('node:fs/promises');
        const manifestPath = path.join(process.cwd(), VENDORED_AGENT_SANDBOX_MANIFEST);
        const manifestBytes = await readFile(manifestPath);
        const actualSha = createHash('sha256').update(manifestBytes).digest('hex');
        if (actualSha !== VENDORED_AGENT_SANDBOX_SHA256) {
          results.push({
            step: 'CRD Controller',
            success: false,
            message: `Vendored manifest SHA-256 mismatch: expected ${VENDORED_AGENT_SANDBOX_SHA256}, got ${actualSha}`,
          });
        } else {
          const { stdout, stderr } = await execAsync(`kubectl apply -f "${manifestPath}"`, {
            timeout: 60_000,
          });
          results.push({
            step: 'CRD Controller',
            success: true,
            message: (stdout || stderr).trim().split('\n').pop() ?? 'Controller installed',
          });
        }
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
