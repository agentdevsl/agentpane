import { PassThrough, Writable } from 'node:stream';
import type { KubeConfig } from '@kubernetes/client-node';
import * as k8s from '@kubernetes/client-node';
import { ExecError, TimeoutError } from '../errors.js';
import type {
  ExecOptions,
  ExecResult,
  ExecStreamOptions,
  ExecStreamResult,
} from '../types/exec.js';

/**
 * Parse exit code from a K8s exec V1Status response.
 */
function parseExitCode(status: k8s.V1Status): number {
  if (status.status === 'Success') return 0;

  const exitCause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
  if (exitCause?.message) {
    return parseInt(exitCause.message, 10) || 1;
  }

  return 1;
}

/**
 * Execute a command inside a sandbox pod (buffered).
 * Collects all stdout/stderr and returns when the process exits.
 */
export async function execInSandbox(kc: KubeConfig, options: ExecOptions): Promise<ExecResult> {
  const { sandboxName, namespace, container, command, timeoutMs } = options;

  const podName = await resolvePodName(kc, namespace, sandboxName);

  const execPromise = new Promise<ExecResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const stdoutStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stdout += chunk.toString();
        callback();
      },
    });

    const stderrStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stderr += chunk.toString();
        callback();
      },
    });

    const exec = new k8s.Exec(kc);

    exec
      .exec(
        namespace,
        podName,
        container ?? 'sandbox',
        command,
        stdoutStream,
        stderrStream,
        null, // stdin
        false, // tty
        (status: k8s.V1Status) => {
          resolve({
            exitCode: parseExitCode(status),
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });
        }
      )
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        reject(new ExecError(command.join(' '), message));
      });
  });

  if (timeoutMs) {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError(`exec ${command.join(' ')}`, timeoutMs));
      }, timeoutMs);
    });
    return Promise.race([execPromise, timeoutPromise]);
  }

  return execPromise;
}

/**
 * Execute a command inside a sandbox pod (streaming).
 * Returns Readable streams for real-time output processing.
 */
export async function execStreamInSandbox(
  kc: KubeConfig,
  options: ExecStreamOptions
): Promise<ExecStreamResult> {
  const { sandboxName, namespace, container, command, stdin, tty } = options;

  const podName = await resolvePodName(kc, namespace, sandboxName);

  const stdoutPassThrough = new PassThrough();
  const stderrPassThrough = new PassThrough();

  let resolveWait!: (value: { exitCode: number }) => void;
  let rejectWait!: (error: Error) => void;
  const waitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  let wsConnection: Awaited<ReturnType<k8s.Exec['exec']>> | undefined;

  const exec = new k8s.Exec(kc);

  try {
    wsConnection = await exec.exec(
      namespace,
      podName,
      container ?? 'sandbox',
      command,
      stdoutPassThrough,
      stderrPassThrough,
      stdin ?? null,
      tty ?? false,
      (status: k8s.V1Status) => {
        stdoutPassThrough.end();
        stderrPassThrough.end();
        resolveWait({ exitCode: parseExitCode(status) });
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdoutPassThrough.destroy();
    stderrPassThrough.destroy();
    rejectWait?.(new ExecError(command.join(' '), message));
  }

  return {
    stdout: stdoutPassThrough,
    stderr: stderrPassThrough,
    wait: () => waitPromise,
    kill: () => {
      if (wsConnection && typeof wsConnection.close === 'function') {
        wsConnection.close();
      }
      stdoutPassThrough.destroy();
      stderrPassThrough.destroy();
    },
  };
}

/**
 * Resolve the pod name from a sandbox resource.
 * In v0.2.1, the controller stores the pod name in the annotation
 * `agents.x-k8s.io/pod-name`. Falls back to the sandbox name
 * if the annotation is absent or the CRD resource is not found (404).
 * Propagates auth, network, and other errors.
 */
async function resolvePodName(
  kc: KubeConfig,
  namespace: string,
  sandboxName: string
): Promise<string> {
  try {
    const api = kc.makeApiClient(k8s.CustomObjectsApi);
    const sandbox = (await api.getNamespacedCustomObject({
      group: 'agents.x-k8s.io',
      version: 'v1alpha1',
      namespace,
      plural: 'sandboxes',
      name: sandboxName,
    })) as { metadata?: { annotations?: Record<string, string> } };
    // v0.2.1: pod name is in annotation, not status.podName
    return sandbox.metadata?.annotations?.['agents.x-k8s.io/pod-name'] ?? sandboxName;
  } catch (error) {
    // Only fall back for 404 (sandbox CRD not found — might be using raw pods).
    // Propagate auth, network, and other real errors.
    const statusCode = (error as { response?: { statusCode?: number } }).response?.statusCode;
    if (statusCode === 404) {
      return sandboxName;
    }
    throw error;
  }
}
