/**
 * E2E tests for Agent Sandbox CRD integration.
 *
 * These tests require a live Kubernetes cluster with the Agent Sandbox CRD
 * controller installed. They are gated behind the K8S_E2E=true env var.
 *
 * Prerequisites:
 *   - A running Kubernetes cluster (kind, minikube, or remote)
 *   - Agent Sandbox CRD controller installed
 *   - The agentpane-e2e namespace created (or override with K8S_E2E_NAMESPACE)
 *   - kubectl configured with access to the cluster
 *
 * Run with:
 *   K8S_E2E=true npm run test:k8s-e2e
 */

import {
  type AgentSandboxClient,
  SandboxBuilder,
  SandboxClaimBuilder,
  SandboxTemplateBuilder,
  SandboxWarmPoolBuilder,
} from '@agentpane/agent-sandbox-sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgentSandboxInstance } from '../../../src/lib/sandbox/providers/agent-sandbox-instance.js';
import { AgentSandboxProvider } from '../../../src/lib/sandbox/providers/agent-sandbox-provider.js';
import {
  cleanupTestSandboxes,
  createTestClient,
  generateTestName,
  getTestContext,
  getTestImage,
  getTestNamespace,
  isK8sE2EEnabled,
  waitForCondition,
} from './helpers.js';

// All test suites gated on K8S_E2E=true
const ENABLED = isK8sE2EEnabled();

let client: AgentSandboxClient;
let namespace: string;

beforeAll(async () => {
  if (!ENABLED) return;
  namespace = getTestNamespace();
  client = createTestClient();
});

afterAll(async () => {
  if (!ENABLED) return;
  // Final cleanup of any leaked test resources
  await cleanupTestSandboxes(client, namespace);
});

// ============================================================================
// 1. Controller Health
// ============================================================================

describe.skipIf(!ENABLED)('Controller Health', () => {
  it('should report a healthy cluster connection', async () => {
    const health = await client.healthCheck();
    expect(health.clusterVersion).toBeDefined();
    expect(typeof health.clusterVersion).toBe('string');
  });

  it('should detect that the Sandbox CRD is registered', async () => {
    const health = await client.healthCheck();
    expect(health.crdRegistered).toBe(true);
  });

  it('should detect the controller deployment', async () => {
    const health = await client.healthCheck();
    expect(health.controllerInstalled).toBe(true);
  });

  it('should confirm the test namespace exists', async () => {
    const health = await client.healthCheck();
    // The test namespace may differ from the client default, so check directly
    expect(health.namespaceExists).toBe(true);
  });

  it('should report overall healthy status', async () => {
    const health = await client.healthCheck();
    expect(health.healthy).toBe(true);
  });
});

// ============================================================================
// 2. Sandbox Lifecycle
// ============================================================================

describe.skipIf(!ENABLED)('Sandbox Lifecycle', () => {
  let sandboxName: string;

  afterEach(async () => {
    // Cleanup: try to delete sandbox if it still exists
    if (sandboxName) {
      try {
        await client.deleteSandbox(sandboxName, namespace);
      } catch {
        // Already deleted
      }
    }
  });

  it('should create a sandbox via CRD and reach Ready state', async () => {
    sandboxName = generateTestName('e2e-lifecycle');

    const sandbox = new SandboxBuilder(sandboxName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .shutdownTime(new Date(Date.now() + 300_000).toISOString())
      .build();

    const created = await client.createSandbox(sandbox, namespace);
    expect(created.metadata?.name).toBe(sandboxName);

    // Wait for Ready
    const ready = await client.waitForReady(sandboxName, {
      timeoutMs: 120_000,
    });

    const readyCond = ready.status?.conditions?.find((c: any) => c.type === 'Ready');
    expect(readyCond?.status).toBe('True');
  }, 130_000);

  it('should list the created sandbox', async () => {
    sandboxName = generateTestName('e2e-list');

    const sandbox = new SandboxBuilder(sandboxName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .shutdownTime(new Date(Date.now() + 300_000).toISOString())
      .build();

    await client.createSandbox(sandbox, namespace);
    await client.waitForReady(sandboxName, { timeoutMs: 120_000 });

    const result = await client.listSandboxes({
      namespace,
      labelSelector: 'agentpane.io/e2e-test=true',
    });

    const names = result.items.map((s) => s.metadata?.name);
    expect(names).toContain(sandboxName);
  }, 130_000);

  it('should get a sandbox by name', async () => {
    sandboxName = generateTestName('e2e-get');

    const sandbox = new SandboxBuilder(sandboxName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .shutdownTime(new Date(Date.now() + 300_000).toISOString())
      .build();

    await client.createSandbox(sandbox, namespace);
    await client.waitForReady(sandboxName, { timeoutMs: 120_000 });

    const fetched = await client.getSandbox(sandboxName, namespace);
    expect(fetched.metadata?.name).toBe(sandboxName);
    const readyCond = fetched.status?.conditions?.find((c: any) => c.type === 'Ready');
    expect(readyCond?.status).toBe('True');
  }, 130_000);

  it('should delete a sandbox and confirm removal', async () => {
    sandboxName = generateTestName('e2e-delete');

    const sandbox = new SandboxBuilder(sandboxName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .shutdownTime(new Date(Date.now() + 300_000).toISOString())
      .build();

    await client.createSandbox(sandbox, namespace);
    await client.waitForReady(sandboxName, { timeoutMs: 120_000 });

    await client.deleteSandbox(sandboxName, namespace);

    // Verify it's gone (may take a moment for finalizers)
    await waitForCondition(
      async () => {
        const exists = await client.sandboxExists(sandboxName, namespace);
        return !exists;
      },
      30_000,
      1_000
    );

    const exists = await client.sandboxExists(sandboxName, namespace);
    expect(exists).toBe(false);

    // Prevent afterEach from trying to delete again
    sandboxName = '';
  }, 160_000);
});

// ============================================================================
// 3. Exec in Sandbox
// ============================================================================

describe.skipIf(!ENABLED)('Exec in Sandbox', () => {
  let sandboxName: string;

  beforeAll(async () => {
    sandboxName = generateTestName('e2e-exec');

    const sandbox = new SandboxBuilder(sandboxName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .shutdownTime(new Date(Date.now() + 600_000).toISOString())
      .build();

    await client.createSandbox(sandbox, namespace);
    await client.waitForReady(sandboxName, { timeoutMs: 120_000 });
  }, 130_000);

  afterAll(async () => {
    if (sandboxName) {
      try {
        await client.deleteSandbox(sandboxName, namespace);
      } catch {
        // Already deleted
      }
    }
  });

  it('should execute echo and capture stdout', async () => {
    const result = await client.exec({
      sandboxName,
      command: ['echo', 'hello-e2e'],
      container: 'sandbox',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-e2e');
  });

  it('should capture non-zero exit codes', async () => {
    const result = await client.exec({
      sandboxName,
      command: ['sh', '-c', 'exit 42'],
      container: 'sandbox',
    });

    expect(result.exitCode).toBe(42);
  });

  it('should capture stderr output', async () => {
    const result = await client.exec({
      sandboxName,
      command: ['sh', '-c', 'echo error-msg >&2'],
      container: 'sandbox',
    });

    expect(result.stderr.trim()).toBe('error-msg');
  });

  it('should handle multi-line output', async () => {
    const result = await client.exec({
      sandboxName,
      command: ['sh', '-c', 'echo line1; echo line2; echo line3'],
      container: 'sandbox',
    });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('line1');
    expect(lines[2]).toBe('line3');
  });

  it('should handle commands with special characters', async () => {
    const result = await client.exec({
      sandboxName,
      command: ['sh', '-c', 'echo "hello world"'],
      container: 'sandbox',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
  });
});

// ============================================================================
// 4. Streaming Exec
// ============================================================================

describe.skipIf(!ENABLED)('Streaming Exec', () => {
  let sandboxName: string;

  beforeAll(async () => {
    sandboxName = generateTestName('e2e-stream');

    const sandbox = new SandboxBuilder(sandboxName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .shutdownTime(new Date(Date.now() + 600_000).toISOString())
      .build();

    await client.createSandbox(sandbox, namespace);
    await client.waitForReady(sandboxName, { timeoutMs: 120_000 });
  }, 130_000);

  afterAll(async () => {
    if (sandboxName) {
      try {
        await client.deleteSandbox(sandboxName, namespace);
      } catch {
        // Already deleted
      }
    }
  });

  it('should stream stdout from a command', async () => {
    const stream = await client.execStream({
      sandboxName,
      command: ['sh', '-c', 'echo stream-test; echo stream-test-2'],
      container: 'sandbox',
    });

    const chunks: string[] = [];
    stream.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk.toString());
    });

    const { exitCode } = await stream.wait();
    expect(exitCode).toBe(0);

    const output = chunks.join('');
    expect(output).toContain('stream-test');
    expect(output).toContain('stream-test-2');
  });

  it('should stream stderr from a command', async () => {
    const stream = await client.execStream({
      sandboxName,
      command: ['sh', '-c', 'echo stderr-line >&2'],
      container: 'sandbox',
    });

    const stderrChunks: string[] = [];
    stream.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    await stream.wait();

    const stderrOutput = stderrChunks.join('');
    expect(stderrOutput).toContain('stderr-line');
  });

  it('should support kill() to terminate a long-running process', async () => {
    const stream = await client.execStream({
      sandboxName,
      command: ['sh', '-c', 'while true; do echo tick; sleep 1; done'],
      container: 'sandbox',
    });

    // Let it run for a bit then kill
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await stream.kill();

    // After kill, the stream should be terminated
    // This verifies kill() doesn't hang
  }, 15_000);
});

// ============================================================================
// 5. tmux Sessions
// ============================================================================

describe.skipIf(!ENABLED)('tmux Sessions', () => {
  let sandboxName: string;
  let instance: AgentSandboxInstance;

  beforeAll(async () => {
    sandboxName = generateTestName('e2e-tmux');

    const sandbox = new SandboxBuilder(sandboxName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .shutdownTime(new Date(Date.now() + 600_000).toISOString())
      .build();

    await client.createSandbox(sandbox, namespace);
    await client.waitForReady(sandboxName, { timeoutMs: 120_000 });

    // Create an AgentSandboxInstance to test tmux methods
    instance = new AgentSandboxInstance(
      'e2e-tmux-id',
      sandboxName,
      'e2e-project',
      namespace,
      client
    );
  }, 130_000);

  afterAll(async () => {
    if (sandboxName) {
      try {
        await client.deleteSandbox(sandboxName, namespace);
      } catch {
        // Already deleted
      }
    }
  });

  it('should return empty list when no tmux sessions exist', async () => {
    const sessions = await instance.listTmuxSessions();
    expect(sessions).toEqual([]);
  });

  it('should create a tmux session', async () => {
    const session = await instance.createTmuxSession('test-session', 'task-1');

    expect(session.name).toBe('test-session');
    expect(session.sandboxId).toBe('e2e-tmux-id');
    expect(session.taskId).toBe('task-1');
    expect(session.windowCount).toBe(1);
    expect(session.attached).toBe(false);
  });

  it('should list the created tmux session', async () => {
    const sessions = await instance.listTmuxSessions();

    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const found = sessions.find((s) => s.name === 'test-session');
    expect(found).toBeDefined();
    expect(found!.windowCount).toBeGreaterThanOrEqual(1);
  });

  it('should send keys to a tmux session', async () => {
    await instance.sendKeysToTmux('test-session', 'echo tmux-works');

    // Wait briefly for the command to execute
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const output = await instance.captureTmuxPane('test-session', 50);
    expect(output).toContain('tmux-works');
  });

  it('should capture tmux pane output', async () => {
    const output = await instance.captureTmuxPane('test-session', 100);
    // Should contain something (at least the prompt or previous output)
    expect(typeof output).toBe('string');
  });

  it('should kill a tmux session', async () => {
    await instance.killTmuxSession('test-session');

    // Verify session is gone
    const sessions = await instance.listTmuxSessions();
    const found = sessions.find((s) => s.name === 'test-session');
    expect(found).toBeUndefined();
  });

  it('should silently handle killing a non-existent session', async () => {
    // This should not throw
    await instance.killTmuxSession('nonexistent-session');
  });
});

// ============================================================================
// 6. Warm Pool
// ============================================================================

describe.skipIf(!ENABLED)('Warm Pool', () => {
  let warmPoolName: string;
  let templateName: string;

  afterEach(async () => {
    // Cleanup warm pool and template
    if (warmPoolName) {
      try {
        await client.deleteWarmPool(warmPoolName, namespace);
      } catch {
        // Already deleted
      }
    }
    if (templateName) {
      try {
        await client.deleteTemplate(templateName, namespace);
      } catch {
        // Already deleted
      }
    }
  });

  it('should create a warm pool resource', async () => {
    templateName = generateTestName('e2e-tpl');
    warmPoolName = generateTestName('e2e-pool');

    // First create a template for the pool to reference
    const template = new SandboxTemplateBuilder(templateName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    await client.createTemplate(template, namespace);

    // Create warm pool
    const pool = new SandboxWarmPoolBuilder(warmPoolName)
      .namespace(namespace)
      .replicas(1)
      .sandboxTemplateRef(templateName)
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    const created = await client.createWarmPool(pool, namespace);
    expect(created.metadata?.name).toBe(warmPoolName);
    expect(created.spec?.replicas).toBe(1);
  });

  it('should report warm pool status with ready replicas', async () => {
    templateName = generateTestName('e2e-tpl-status');
    warmPoolName = generateTestName('e2e-pool-status');

    const template = new SandboxTemplateBuilder(templateName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    await client.createTemplate(template, namespace);

    const pool = new SandboxWarmPoolBuilder(warmPoolName)
      .namespace(namespace)
      .replicas(1)
      .sandboxTemplateRef(templateName)
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    await client.createWarmPool(pool, namespace);

    // Wait for warm pool to have at least one ready replica
    await waitForCondition(
      async () => {
        const fetched = await client.getWarmPool(warmPoolName, namespace);
        return (fetched.status?.readyReplicas ?? 0) > 0;
      },
      120_000,
      3_000
    );

    const fetched = await client.getWarmPool(warmPoolName, namespace);
    expect(fetched.status?.readyReplicas).toBeGreaterThanOrEqual(1);
  }, 130_000);

  it('should claim a sandbox from the warm pool via SandboxClaim', async () => {
    templateName = generateTestName('e2e-tpl-claim');
    warmPoolName = generateTestName('e2e-pool-claim');

    const template = new SandboxTemplateBuilder(templateName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    await client.createTemplate(template, namespace);

    const pool = new SandboxWarmPoolBuilder(warmPoolName)
      .namespace(namespace)
      .replicas(1)
      .sandboxTemplateRef(templateName)
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    await client.createWarmPool(pool, namespace);

    // Wait for the pool to have a ready sandbox
    await waitForCondition(
      async () => {
        const fetched = await client.getWarmPool(warmPoolName, namespace);
        return (fetched.status?.readyReplicas ?? 0) > 0;
      },
      120_000,
      3_000
    );

    // Create a claim to get a sandbox from the pool
    const claimName = generateTestName('e2e-claim');
    const claim = new SandboxClaimBuilder(claimName)
      .namespace(namespace)
      .templateRef(templateName)
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    const created = await client.createClaim(claim, namespace);
    expect(created.metadata?.name).toBe(claimName);

    // Wait for claim to be bound (sandbox.Name populated)
    await waitForCondition(
      async () => {
        const fetched = await client.getClaim(claimName, namespace);
        return !!fetched.status?.sandbox?.Name;
      },
      60_000,
      2_000
    );

    const bound = await client.getClaim(claimName, namespace);
    expect(bound.status?.sandbox?.Name).toBeDefined();

    // Cleanup claim
    await client.deleteClaim(claimName, namespace);
  }, 200_000);
});

// ============================================================================
// 7. Sandbox Template
// ============================================================================

describe.skipIf(!ENABLED)('Sandbox Template', () => {
  let templateName: string;
  let sandboxName: string;

  afterEach(async () => {
    if (sandboxName) {
      try {
        await client.deleteSandbox(sandboxName, namespace);
      } catch {
        // Already deleted
      }
    }
    if (templateName) {
      try {
        await client.deleteTemplate(templateName, namespace);
      } catch {
        // Already deleted
      }
    }
  });

  it('should create a sandbox template', async () => {
    templateName = generateTestName('e2e-template');

    const template = new SandboxTemplateBuilder(templateName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '512Mi', cpu: '500m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    const created = await client.createTemplate(template, namespace);
    expect(created.metadata?.name).toBe(templateName);
  });

  it('should list templates', async () => {
    templateName = generateTestName('e2e-tpl-list');

    const template = new SandboxTemplateBuilder(templateName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    await client.createTemplate(template, namespace);

    const result = await client.listTemplates(namespace);
    const names = result.items.map((t) => t.metadata?.name);
    expect(names).toContain(templateName);
  });

  it('should create a sandbox from a template and inherit spec', async () => {
    templateName = generateTestName('e2e-tpl-inherit');

    // Create template with specific resources
    const template = new SandboxTemplateBuilder(templateName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .runtimeClass('gvisor') // Template sets gvisor
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    await client.createTemplate(template, namespace);

    // Create sandbox from template via SandboxClaim
    const claimName = generateTestName('e2e-claim-tpl');

    const claim = new SandboxClaimBuilder(claimName)
      .namespace(namespace)
      .templateRef(templateName)
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    const created = await client.createClaim(claim, namespace);
    expect(created.metadata?.name).toBe(claimName);

    // Wait for claim to be bound (sandbox.Name populated)
    await waitForCondition(
      async () => {
        const fetched = await client.getClaim(claimName, namespace);
        return !!fetched.status?.sandbox?.Name;
      },
      120_000,
      3_000
    );

    const bound = await client.getClaim(claimName, namespace);
    sandboxName = bound.status?.sandbox?.Name ?? '';
    expect(sandboxName).toBeTruthy();

    // Verify the sandbox is running
    const running = await client.getSandbox(sandboxName, namespace);
    const readyCond = running.status?.conditions?.find((c: any) => c.type === 'Ready');
    expect(readyCond?.status).toBe('True');

    // Cleanup claim
    await client.deleteClaim(claimName, namespace);
  }, 130_000);

  it('should delete a template', async () => {
    templateName = generateTestName('e2e-tpl-del');

    const template = new SandboxTemplateBuilder(templateName)
      .namespace(namespace)
      .image(getTestImage())
      .resources({ memory: '256Mi', cpu: '250m' })
      .labels({ 'agentpane.io/e2e-test': 'true' })
      .build();

    await client.createTemplate(template, namespace);
    await client.deleteTemplate(templateName, namespace);

    // Verify deletion
    const result = await client.listTemplates(namespace);
    const names = result.items.map((t) => t.metadata?.name);
    expect(names).not.toContain(templateName);

    // Prevent afterEach from trying again
    templateName = '';
  });
});

// ============================================================================
// 8. Provider Integration
// ============================================================================

describe.skipIf(!ENABLED)('Provider Integration', () => {
  let provider: AgentSandboxProvider;

  beforeAll(() => {
    provider = new AgentSandboxProvider({
      namespace,
      kubeContext: getTestContext(),
      image: getTestImage(),
      readyTimeoutSeconds: 120,
    });
  });

  afterAll(async () => {
    // Cleanup all sandboxes created by the provider
    await provider.cleanup({ status: ['running', 'idle', 'stopped', 'error', 'creating'] });
  });

  it('should report healthy via provider healthCheck', async () => {
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.details?.provider).toBe('kubernetes');
    expect(health.details?.namespaceExists).toBe(true);
  });

  it('should create a sandbox through the provider', async () => {
    const sandbox = await provider.create({
      codespaceId: generateTestName('e2e-prov'),
      projectPath: '/tmp/e2e-test',
      image: getTestImage(),
      memoryMb: 256,
      cpuCores: 0.25,
      idleTimeoutMinutes: 5,
      volumeMounts: [],
    });

    expect(sandbox).toBeDefined();
    expect(sandbox.id).toBeDefined();
    expect(sandbox.status).toBe('running');
    expect(sandbox.containerId).toBeTruthy();

    // Cleanup
    await sandbox.stop();
  }, 130_000);

  it('should retrieve sandbox via provider.get()', async () => {
    const codespaceId = generateTestName('e2e-prov-get');

    const created = await provider.create({
      codespaceId,
      projectPath: '/tmp/e2e-test',
      image: getTestImage(),
      memoryMb: 256,
      cpuCores: 0.25,
      idleTimeoutMinutes: 5,
      volumeMounts: [],
    });

    const found = await provider.get(codespaceId);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);

    // Cleanup
    await created.stop();
  }, 130_000);

  it('should list sandboxes through the provider', async () => {
    const codespaceId = generateTestName('e2e-prov-list');

    const created = await provider.create({
      codespaceId,
      projectPath: '/tmp/e2e-test',
      image: getTestImage(),
      memoryMb: 256,
      cpuCores: 0.25,
      idleTimeoutMinutes: 5,
      volumeMounts: [],
    });

    const list = await provider.list();
    expect(list.length).toBeGreaterThanOrEqual(1);

    const found = list.find((s) => s.codespaceId === codespaceId);
    expect(found).toBeDefined();

    // Cleanup
    await created.stop();
  }, 130_000);

  it('should emit events during sandbox lifecycle', async () => {
    const events: string[] = [];
    const unsubscribe = provider.on((event) => {
      events.push(event.type);
    });

    const codespaceId = generateTestName('e2e-prov-evt');
    const sandbox = await provider.create({
      codespaceId,
      projectPath: '/tmp/e2e-test',
      image: getTestImage(),
      memoryMb: 256,
      cpuCores: 0.25,
      idleTimeoutMinutes: 5,
      volumeMounts: [],
    });

    expect(events).toContain('sandbox:creating');
    expect(events).toContain('sandbox:created');
    expect(events).toContain('sandbox:started');

    unsubscribe();
    await sandbox.stop();
  }, 130_000);

  it('should cleanup stopped sandboxes', async () => {
    const codespaceId = generateTestName('e2e-prov-clean');

    const sandbox = await provider.create({
      codespaceId,
      projectPath: '/tmp/e2e-test',
      image: getTestImage(),
      memoryMb: 256,
      cpuCores: 0.25,
      idleTimeoutMinutes: 5,
      volumeMounts: [],
    });

    await sandbox.stop();

    const cleaned = await provider.cleanup();
    expect(cleaned).toBeGreaterThanOrEqual(1);

    // Should no longer be retrievable
    const found = await provider.get(codespaceId);
    expect(found).toBeNull();
  }, 130_000);

  it('should exec commands through the provider sandbox instance', async () => {
    const codespaceId = generateTestName('e2e-prov-exec');

    const sandbox = await provider.create({
      codespaceId,
      projectPath: '/tmp/e2e-test',
      image: getTestImage(),
      memoryMb: 256,
      cpuCores: 0.25,
      idleTimeoutMinutes: 5,
      volumeMounts: [],
    });

    const result = await sandbox.exec('echo', ['provider-exec-test']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('provider-exec-test');

    await sandbox.stop();
  }, 130_000);

  it('should reject creating duplicate sandbox for same project', async () => {
    const codespaceId = generateTestName('e2e-prov-dup');

    const sandbox = await provider.create({
      codespaceId,
      projectPath: '/tmp/e2e-test',
      image: getTestImage(),
      memoryMb: 256,
      cpuCores: 0.25,
      idleTimeoutMinutes: 5,
      volumeMounts: [],
    });

    await expect(
      provider.create({
        codespaceId,
        projectPath: '/tmp/e2e-test',
        image: getTestImage(),
        memoryMb: 256,
        cpuCores: 0.25,
        idleTimeoutMinutes: 5,
        volumeMounts: [],
      })
    ).rejects.toThrow();

    await sandbox.stop();
  }, 130_000);
});

// ============================================================================
// 9. Cleanup
// ============================================================================

describe.skipIf(!ENABLED)('Cleanup', () => {
  it('should clean up all test sandboxes via label selector', async () => {
    const cleaned = await cleanupTestSandboxes(client, namespace);
    // cleaned could be 0 if previous tests cleaned up properly, or >0 if leftovers exist
    expect(cleaned).toBeGreaterThanOrEqual(0);
  });

  it('should verify no test sandboxes remain', async () => {
    // Wait briefly for deletions to propagate
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const result = await client.listSandboxes({
      namespace,
      labelSelector: 'agentpane.io/e2e-test=true',
    });

    expect(result.items.length).toBe(0);
  }, 30_000);
});
