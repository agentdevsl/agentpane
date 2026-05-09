/**
 * Integration tests for the K8s install-crds + minikube/start routes.
 *
 * Mocks node:child_process.exec, node:fs, and the agentcore manifest import
 * so the install-crds endpoint can be exercised without a real kubectl binary
 * or k8s/manifests directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const fakeExec = vi.fn();
  const fakeExistsSync = vi.fn();
  const fakeReadFile = vi.fn();
  const fakeCreateHash = vi.fn();
  return { fakeExec, fakeExistsSync, fakeReadFile, fakeCreateHash };
});

vi.mock('node:child_process', () => ({
  exec: mocks.fakeExec,
}));

vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:util')>();
  return {
    ...original,
    promisify: (_fn: unknown) => {
      // Return a function that calls our fake exec and returns its resolved value
      return async (cmd: string, opts?: { timeout?: number }) => {
        return new Promise((resolve, reject) => {
          mocks.fakeExec(cmd, opts ?? {}, (err: Error | null, stdout: string, stderr: string) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          });
        });
      };
    },
  };
});

vi.mock('node:fs', () => ({
  existsSync: mocks.fakeExistsSync,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mocks.fakeReadFile,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return {
    ...original,
    createHash: (algorithm: string) => mocks.fakeCreateHash(algorithm),
  };
});

vi.mock('../../src/server/bootstrap/sandbox/k8s-init.js', () => ({
  VENDORED_AGENT_SANDBOX_MANIFEST: 'k8s/manifests/agent-sandbox-vendored.yaml',
  VENDORED_AGENT_SANDBOX_SHA256: 'expected-sha-256-value',
}));

vi.mock('@agentpane/agent-sandbox-sdk', () => ({
  loadKubeConfig: vi.fn(),
  getClusterInfo: vi.fn(),
  resolveContext: vi.fn(),
  AgentSandboxClient: vi.fn(),
}));

import { createK8sRoutes } from '../../src/server/routes/sandbox-k8s';

function setupKubectlExec(handler: (cmd: string) => { stdout: string; stderr?: string } | Error) {
  mocks.fakeExec.mockImplementation(
    (
      cmd: string,
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const result = handler(cmd);
      if (result instanceof Error) {
        cb(result);
      } else {
        cb(null, result.stdout, result.stderr ?? '');
      }
    }
  );
}

describe('K8s install-crds + minikube/start (IT-K8S-INSTALL)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fakeExistsSync.mockReturnValue(true);
    mocks.fakeReadFile.mockResolvedValue(Buffer.from('manifest content'));
    // Default hash mock returns the expected SHA so the controller install proceeds
    mocks.fakeCreateHash.mockReturnValue({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue('expected-sha-256-value'),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('POST /minikube/start returns 200 + started:true on success', async () => {
    setupKubectlExec((cmd) => {
      if (cmd.includes('minikube start')) return { stdout: 'minikube started\n' };
      return { stdout: '' };
    });
    const app = createK8sRoutes();
    const res = await app.request('http://localhost/minikube/start', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { started: boolean; message: string } };
    expect(body.data.started).toBe(true);
  });

  it('POST /minikube/start returns 200 with started:false when minikube command fails', async () => {
    setupKubectlExec((cmd) => {
      if (cmd.includes('minikube start')) return new Error('minikube binary not found');
      return { stdout: '' };
    });
    const app = createK8sRoutes();
    const res = await app.request('http://localhost/minikube/start', { method: 'POST' });
    // attemptMinikubeStart catches and returns started:false with message
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { started: boolean; message: string } };
    expect(body.data.started).toBe(false);
    expect(body.data.message).toContain('Failed to start minikube');
  });

  it('POST /install-crds returns 500 MANIFESTS_NOT_FOUND when k8s/manifests is missing', async () => {
    mocks.fakeExistsSync.mockReturnValueOnce(false);
    const app = createK8sRoutes();
    const res = await app.request('http://localhost/install-crds', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('MANIFESTS_NOT_FOUND');
  });

  it('POST /install-crds returns 500 KUBECTL_NOT_FOUND when kubectl version check fails', async () => {
    setupKubectlExec((cmd) => {
      if (cmd.includes('kubectl version')) return new Error('kubectl: command not found');
      return { stdout: '' };
    });
    const app = createK8sRoutes();
    const res = await app.request('http://localhost/install-crds', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('KUBECTL_NOT_FOUND');
  });

  it('POST /install-crds returns 200 with results on happy path', async () => {
    setupKubectlExec((cmd) => {
      if (cmd.includes('kubectl version'))
        return { stdout: '{"clientVersion":{"gitVersion":"v1.30.0"}}' };
      if (cmd.includes('kubectl get crd sandboxes'))
        return { stdout: 'sandboxes.agents.x-k8s.io ready' };
      if (cmd.includes('kubectl apply')) return { stdout: 'applied\n' };
      return { stdout: '' };
    });
    const app = createK8sRoutes();
    const res = await app.request('http://localhost/install-crds', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { installed: boolean; results: Array<{ step: string; success: boolean }> };
    };
    expect(body.data.installed).toBe(true);
    // Should have steps for: CRD Definitions, Namespace, RuntimeClass, LimitRange,
    // CRD Controller, SandboxTemplate, WarmPool
    const stepNames = body.data.results.map((r) => r.step);
    expect(stepNames).toContain('CRD Definitions');
    expect(stepNames).toContain('Namespace');
    expect(stepNames).toContain('CRD Controller');
  });

  it('POST /install-crds reports SHA-mismatch as a non-success step but still returns 200', async () => {
    // Hash mock returns a different SHA — controller install should report failure
    mocks.fakeCreateHash.mockReturnValue({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue('different-sha'),
    });
    setupKubectlExec((cmd) => {
      if (cmd.includes('kubectl version')) return { stdout: '{}' };
      if (cmd.includes('kubectl get crd sandboxes')) return { stdout: 'ready' };
      if (cmd.includes('kubectl apply')) return { stdout: 'applied\n' };
      return { stdout: '' };
    });
    const app = createK8sRoutes();
    const res = await app.request('http://localhost/install-crds', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { results: Array<{ step: string; success: boolean; message: string }> };
    };
    const controllerStep = body.data.results.find((r) => r.step === 'CRD Controller');
    expect(controllerStep?.success).toBe(false);
    expect(controllerStep?.message).toMatch(/SHA-256 mismatch/);
  });

  it('POST /install-crds records per-manifest apply failures without aborting the loop', async () => {
    setupKubectlExec((cmd) => {
      if (cmd.includes('kubectl version')) return { stdout: '{}' };
      if (cmd.includes('kubectl get crd sandboxes')) return { stdout: 'ready' };
      // Make namespace.yaml apply fail; everything else succeed
      if (cmd.includes('namespace.yaml'))
        return new Error('namespaces "agentpane-sandboxes" forbidden');
      if (cmd.includes('kubectl apply')) return { stdout: 'applied\n' };
      return { stdout: '' };
    });
    const app = createK8sRoutes();
    const res = await app.request('http://localhost/install-crds', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { installed: boolean; results: Array<{ step: string; success: boolean }> };
    };
    // Critical step (Namespace) failed → installed:false
    expect(body.data.installed).toBe(false);
    const nsStep = body.data.results.find((r) => r.step === 'Namespace');
    expect(nsStep?.success).toBe(false);
  });
});
