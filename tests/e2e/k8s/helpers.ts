/**
 * E2E test utilities for Kubernetes Agent Sandbox tests.
 *
 * All tests are gated behind the K8S_E2E environment variable.
 * Set K8S_E2E=true to run these tests against a live cluster.
 *
 * Optional env vars:
 *   K8S_E2E_NAMESPACE  - Namespace for test resources (default: agentpane-e2e)
 *   K8S_E2E_CONTEXT    - Kubernetes context to use (default: current context)
 *   K8S_E2E_IMAGE      - Container image for test sandboxes
 */

import { AgentSandboxClient } from '@agentpane/agent-sandbox-sdk';

/**
 * Returns true if K8S_E2E tests should run.
 */
export function isK8sE2EEnabled(): boolean {
  return process.env.K8S_E2E === 'true';
}

/**
 * Get the test namespace from env or use default.
 */
export function getTestNamespace(): string {
  return process.env.K8S_E2E_NAMESPACE ?? 'agentpane-e2e';
}

/**
 * Get the Kubernetes context from env or undefined (uses current context).
 */
export function getTestContext(): string | undefined {
  return process.env.K8S_E2E_CONTEXT || undefined;
}

/**
 * Get the test container image.
 *
 * arch29-W1-C / F04-01: the fallback is digest-pinned to match
 * `SANDBOX_DEFAULTS.image` in `src/lib/sandbox/types.ts`. CI must not pull
 * from a mutable `:latest` tag — operators can override via
 * `K8S_E2E_IMAGE=<other-image@sha256:...>` at runtime if needed.
 */
export function getTestImage(): string {
  return (
    process.env.K8S_E2E_IMAGE ??
    'docker.io/srlynch1/agent-sandbox@sha256:9b04cfd8f030360efb7fbd1023ce79b228b61edf82dbc0d82c38c867633d4126'
  );
}

/**
 * Generic polling helper. Calls `fn` repeatedly until it returns a truthy value
 * or the timeout is exceeded.
 *
 * @param fn - Async function to poll. Should return a truthy value when condition is met.
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 60000).
 * @param intervalMs - Polling interval in milliseconds (default: 2000).
 * @returns The truthy value returned by `fn`.
 * @throws Error if the timeout is exceeded.
 */
export async function waitForCondition<T>(
  fn: () => Promise<T>,
  timeoutMs = 60_000,
  intervalMs = 2_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await fn();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

/**
 * Delete all sandboxes in the given namespace that have the agentpane.io/e2e-test label.
 * Used for test cleanup to avoid leaking resources.
 */
export async function cleanupTestSandboxes(
  client: AgentSandboxClient,
  namespace: string
): Promise<number> {
  let cleaned = 0;

  try {
    const result = await client.listSandboxes({
      namespace,
      labelSelector: 'agentpane.io/e2e-test=true',
    });

    for (const sandbox of result.items) {
      const name = sandbox.metadata?.name;
      if (name) {
        try {
          await client.deleteSandbox(name, namespace);
          cleaned++;
        } catch {
          // Sandbox may already be deleted
        }
      }
    }
  } catch {
    // Namespace may not exist or no sandboxes found
  }

  return cleaned;
}

/**
 * Create an AgentSandboxClient configured for E2E testing.
 */
export function createTestClient(): AgentSandboxClient {
  return new AgentSandboxClient({
    namespace: getTestNamespace(),
    context: getTestContext(),
  });
}

/**
 * Generate a unique test resource name with the given prefix.
 * Names are DNS-1123 compliant (lowercase, alphanumeric + hyphens).
 */
export function generateTestName(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${timestamp}-${random}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63); // K8s name max length
}
