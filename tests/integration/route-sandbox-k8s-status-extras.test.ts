/**
 * Integration tests for sandbox-k8s.ts /status, /controller, and /minikube/start
 * extras — branches the existing route-sandbox-k8s.test.ts does not exercise:
 *
 * - /status reachable cluster: namespace exists with pods (lines 289-296)
 * - /status reachable cluster: namespace 404 (lines 300-302) and other-error (303-307)
 * - /status auto-start minikube via DB setting (lines 235-264)
 * - /status DB error reading autoStartMinikube setting (245-249)
 * - /controller with DB-loaded settings (lines 433-447)
 * - /controller DB error swallowed
 * - /minikube/start happy path (lines 510-518)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agentpane/agent-sandbox-sdk', () => ({
  loadKubeConfig: vi.fn(),
  getClusterInfo: vi.fn(),
  resolveContext: vi.fn(),
  AgentSandboxClient: vi.fn(),
}));

vi.mock('@kubernetes/client-node', () => ({
  CoreV1Api: class {},
}));

// Mock node:https request used by fetchK8sVersion. Default to "reachable"
// (200 + valid version JSON) so tests can opt into unreachable by overriding.
const httpsRequestMock = vi.hoisted(() => vi.fn());
vi.mock('node:https', () => ({
  default: { request: httpsRequestMock },
  request: httpsRequestMock,
}));

// Mock node:child_process so attemptMinikubeStart never spawns a real process.
const execMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ exec: execMock }));

import { AgentSandboxClient, getClusterInfo, loadKubeConfig } from '@agentpane/agent-sandbox-sdk';
import { createK8sRoutes } from '../../src/server/routes/sandbox-k8s';

const mockLoadKubeConfig = vi.mocked(loadKubeConfig);
const mockGetClusterInfo = vi.mocked(getClusterInfo);
const MockAgentSandboxClient = vi.mocked(AgentSandboxClient);

function makeReachableHttpsResponse(version = 'v1.30.0') {
  // The route does `https.request(url, opts, (res) => …)`. Build a minimal
  // EventEmitter-like response that emits 'data' then 'end'.
  return (_url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    const res = {
      statusCode: 200,
      on(event: string, handler: (arg?: unknown) => void) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
    };
    const req = {
      on: vi.fn(),
      end: () => {
        cb(res);
        for (const h of handlers.data ?? []) h(JSON.stringify({ gitVersion: version }));
        for (const h of handlers.end ?? []) h();
      },
      destroy: vi.fn(),
    };
    return req;
  };
}

function makeUnreachableHttpsResponse() {
  return (_url: unknown, _opts: unknown, _cb: unknown) => {
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    const req = {
      on(event: string, handler: (arg?: unknown) => void) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
      end: () => {
        // Fire the 'error' handler synchronously after end()
        for (const h of handlers.error ?? []) h(new Error('ECONNREFUSED'));
      },
      destroy: vi.fn(),
    };
    return req;
  };
}

function createKubeConfigMock(
  opts: {
    context?: string;
    contexts?: Array<{ name: string; cluster: string; user: string; namespace?: string }>;
    cluster?: { server: string };
    apiClient?: Record<string, unknown>;
  } = {}
) {
  return {
    getCurrentContext: vi.fn().mockReturnValue(opts.context ?? 'minikube'),
    getContexts: vi
      .fn()
      .mockReturnValue(
        opts.contexts ?? [{ name: 'minikube', cluster: 'minikube', user: 'minikube' }]
      ),
    getCurrentCluster: vi
      .fn()
      .mockReturnValue(opts.cluster ?? { server: 'https://127.0.0.1:8443' }),
    makeApiClient: vi.fn().mockReturnValue(
      opts.apiClient ?? {
        readNamespace: vi.fn().mockResolvedValue({}),
        listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
        listNamespace: vi.fn().mockResolvedValue({ items: [] }),
      }
    ),
  };
}

describe('K8s /status extras (reachable + namespace branches)', () => {
  let app: ReturnType<typeof createK8sRoutes>;

  beforeEach(() => {
    vi.clearAllMocks();
    httpsRequestMock.mockImplementation(makeReachableHttpsResponse());
    app = createK8sRoutes();
  });

  it('IT-K8S-S1: returns healthy with pod counts when reachable + namespace has pods', async () => {
    const podList = {
      items: [
        { status: { phase: 'Running' } },
        { status: { phase: 'Running' } },
        { status: { phase: 'Pending' } },
      ],
    };
    const apiClient = {
      readNamespace: vi.fn().mockResolvedValue({}),
      listNamespacedPod: vi.fn().mockResolvedValue(podList),
    };
    const kc = createKubeConfigMock({ apiClient });
    mockLoadKubeConfig.mockReturnValue(kc as any);
    mockGetClusterInfo.mockReturnValue({
      name: 'minikube',
      server: 'https://127.0.0.1:8443',
    } as any);

    const response = await app.request('http://localhost/status');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.healthy).toBe(true);
    expect(body.data.namespaceExists).toBe(true);
    expect(body.data.pods).toBe(3);
    expect(body.data.podsRunning).toBe(2);
  });

  it('IT-K8S-S2: returns healthy with namespaceExists=false when readNamespace 404s', async () => {
    const apiClient = {
      readNamespace: vi.fn().mockRejectedValue({ response: { statusCode: 404 } }),
      listNamespacedPod: vi.fn(),
    };
    const kc = createKubeConfigMock({ apiClient });
    mockLoadKubeConfig.mockReturnValue(kc as any);
    mockGetClusterInfo.mockReturnValue({
      name: 'minikube',
      server: 'https://127.0.0.1:8443',
    } as any);

    const response = await app.request('http://localhost/status');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.healthy).toBe(true);
    expect(body.data.namespaceExists).toBe(false);
    expect(body.data.pods).toBe(0);
  });

  it('IT-K8S-S3: still returns healthy=true when namespace check throws non-404', async () => {
    const apiClient = {
      readNamespace: vi
        .fn()
        .mockRejectedValue({ response: { statusCode: 500 }, message: 'auth failure' }),
      listNamespacedPod: vi.fn(),
    };
    const kc = createKubeConfigMock({ apiClient });
    mockLoadKubeConfig.mockReturnValue(kc as any);
    mockGetClusterInfo.mockReturnValue({
      name: 'minikube',
      server: 'https://127.0.0.1:8443',
    } as any);

    const response = await app.request('http://localhost/status');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.healthy).toBe(true);
    expect(body.data.namespaceExists).toBe(false);
  });

  it('IT-K8S-S4: returns unhealthy with informative message when cluster unreachable', async () => {
    httpsRequestMock.mockImplementation(makeUnreachableHttpsResponse());
    const kc = createKubeConfigMock();
    mockLoadKubeConfig.mockReturnValue(kc as any);
    mockGetClusterInfo.mockReturnValue({
      name: 'minikube',
      server: 'https://127.0.0.1:8443',
    } as any);

    const response = await app.request('http://localhost/status');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.healthy).toBe(false);
    expect(body.data.message).toContain('Kubernetes');
  });

  it('IT-K8S-S5: auto-starts minikube when DB setting enabled and cluster unreachable', async () => {
    httpsRequestMock
      .mockImplementationOnce(makeUnreachableHttpsResponse())
      .mockImplementationOnce(makeUnreachableHttpsResponse());
    // exec(minikube start, ...) invoked via util.promisify(exec).
    // Provide a callback-style exec so promisify resolves with stdout/stderr.
    execMock.mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        cb?: (e: Error | null, r: { stdout: string; stderr: string }) => void
      ) => {
        if (typeof cb === 'function') cb(null, { stdout: 'started', stderr: '' });
        return undefined as unknown;
      }
    );
    const kc = createKubeConfigMock();
    mockLoadKubeConfig.mockReturnValue(kc as any);
    mockGetClusterInfo.mockReturnValue({
      name: 'minikube',
      server: 'https://127.0.0.1:8443',
    } as any);

    const db = {
      query: {
        settings: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ value: JSON.stringify({ autoStartMinikube: true }) }),
        },
      },
    } as any;
    const appWithDb = createK8sRoutes({ db });

    const response = await appWithDb.request('http://localhost/status');
    expect(response.status).toBe(200);
    expect(execMock).toHaveBeenCalledWith(
      'minikube start',
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function)
    );
  });

  it('IT-K8S-S6: tolerates DB error when reading autoStartMinikube (defaults to no auto-start)', async () => {
    httpsRequestMock.mockImplementation(makeUnreachableHttpsResponse());
    const kc = createKubeConfigMock();
    mockLoadKubeConfig.mockReturnValue(kc as any);
    mockGetClusterInfo.mockReturnValue({
      name: 'minikube',
      server: 'https://127.0.0.1:8443',
    } as any);

    const db = {
      query: {
        settings: {
          findFirst: vi.fn().mockRejectedValue(new Error('db down')),
        },
      },
    } as any;
    const appWithDb = createK8sRoutes({ db });

    const response = await appWithDb.request('http://localhost/status');
    expect(response.status).toBe(200);
    const body = await response.json();
    // Should remain unhealthy — no auto-start was attempted
    expect(body.data.healthy).toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('K8s /controller extras (DB-settings load)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('IT-K8S-C1: loads namespace + kubeconfig from DB settings when no query overrides', async () => {
    const ctorArgs: Array<Record<string, unknown>> = [];
    MockAgentSandboxClient.mockImplementation(function (this: any, opts: Record<string, unknown>) {
      ctorArgs.push(opts);
      this.healthCheck = vi.fn().mockResolvedValue({
        healthy: true,
        controllerInstalled: true,
        crdRegistered: true,
        namespaceExists: true,
      });
    } as any);

    const db = {
      query: {
        settings: {
          findFirst: vi.fn().mockResolvedValue({
            value: JSON.stringify({
              namespace: 'custom-ns',
              kubeConfigPath: '/home/user/.kube/config',
              kubeContext: 'production',
              skipTLSVerify: true,
            }),
          }),
        },
      },
    } as any;
    const appWithDb = createK8sRoutes({ db });

    const response = await appWithDb.request('http://localhost/controller');
    expect(response.status).toBe(200);
    expect(ctorArgs[0]).toMatchObject({
      namespace: 'custom-ns',
      kubeconfigPath: '/home/user/.kube/config',
      context: 'production',
      skipTLSVerify: true,
    });
  });

  it('IT-K8S-C2: tolerates DB error when reading K8s settings (uses defaults)', async () => {
    MockAgentSandboxClient.mockImplementation(function (this: any) {
      this.healthCheck = vi.fn().mockResolvedValue({
        healthy: true,
        controllerInstalled: true,
        crdRegistered: true,
        namespaceExists: true,
      });
    } as any);

    const db = {
      query: { settings: { findFirst: vi.fn().mockRejectedValue(new Error('db down')) } },
    } as any;
    const appWithDb = createK8sRoutes({ db });

    const response = await appWithDb.request('http://localhost/controller');
    expect(response.status).toBe(200);
    // Should still respond OK — DB error is swallowed by the inner try/catch
  });
});

describe('K8s /minikube/start happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('IT-K8S-M1: returns started=true when minikube exec succeeds', async () => {
    execMock.mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        cb?: (e: Error | null, r: { stdout: string; stderr: string }) => void
      ) => {
        if (typeof cb === 'function') cb(null, { stdout: 'minikube ready\n', stderr: '' });
        return undefined as unknown;
      }
    );
    const app = createK8sRoutes();

    const response = await app.request('http://localhost/minikube/start', { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.started).toBe(true);
  });

  it('IT-K8S-M2: returns started=false with message when minikube exec fails', async () => {
    execMock.mockImplementation((_cmd: string, _opts: unknown, cb?: (e: Error | null) => void) => {
      if (typeof cb === 'function') cb(new Error('VBoxManage not found'));
      return undefined as unknown;
    });
    const app = createK8sRoutes();

    const response = await app.request('http://localhost/minikube/start', { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.started).toBe(false);
    expect(body.data.message).toContain('VBoxManage');
  });
});
