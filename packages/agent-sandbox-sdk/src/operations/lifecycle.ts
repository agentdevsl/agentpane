import { CRD_ANNOTATIONS, CRD_CONDITIONS } from '../constants.js';
import { TimeoutError } from '../errors.js';
import type { Sandbox } from '../types/sandbox.js';
import type { CustomResourceCrud } from './crud.js';

/**
 * Options for waitForReady
 */
export interface WaitForReadyOptions {
  /** Sandbox name */
  name: string;
  /** Namespace */
  namespace: string;
  /** Timeout in milliseconds (default: 120000) */
  timeoutMs?: number;
  /** Poll interval in milliseconds (default: 1000) */
  pollIntervalMs?: number;
}

/**
 * Wait for a sandbox to reach the Ready condition
 */
export async function waitForReady(
  crud: CustomResourceCrud<Sandbox>,
  options: WaitForReadyOptions
): Promise<Sandbox> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const sandbox = await crud.get(options.namespace, options.name);

    const readyCondition = sandbox.status?.conditions?.find((c) => c.type === CRD_CONDITIONS.ready);

    if (readyCondition?.status === 'True') {
      return sandbox;
    }

    // Check for terminal failure via Ready condition with False status
    if (readyCondition?.status === 'False') {
      const failMessage = readyCondition.message ?? 'Sandbox failed to become ready';
      throw new Error(failMessage);
    }

    await sleep(pollIntervalMs);
  }

  throw new TimeoutError(`waitForReady(${options.name})`, timeoutMs);
}

/**
 * Pause a sandbox (set replicas to 0)
 */
export async function pause(
  crud: CustomResourceCrud<Sandbox>,
  namespace: string,
  name: string,
  reason?: string
): Promise<Sandbox> {
  const patch: Record<string, unknown> = {
    spec: { replicas: 0 },
  };

  if (reason) {
    patch.metadata = {
      annotations: {
        [CRD_ANNOTATIONS.pauseReason]: reason,
      },
    };
  }

  return crud.patch(namespace, name, patch as Partial<Sandbox>);
}

/**
 * Resume a paused sandbox (set replicas to 1)
 */
export async function resume(
  crud: CustomResourceCrud<Sandbox>,
  namespace: string,
  name: string
): Promise<Sandbox> {
  const patch: Record<string, unknown> = {
    spec: { replicas: 1 },
    metadata: {
      annotations: {
        [CRD_ANNOTATIONS.pauseReason]: '',
      },
    },
  };
  return crud.patch(namespace, name, patch as Partial<Sandbox>);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
