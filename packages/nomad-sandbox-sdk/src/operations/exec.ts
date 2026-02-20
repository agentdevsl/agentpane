import { ExecError, TimeoutError } from '../errors.js';
import type { NomadHttpClient } from '../http.js';
import type {
  ExecOptions,
  ExecResult,
  ExecStreamOptions,
  ExecStreamResult,
} from '../types/exec.js';

/**
 * Build the WebSocket URL for the Nomad exec endpoint.
 */
function buildExecWsUrl(
  http: NomadHttpClient,
  allocId: string,
  task: string,
  command: string[],
  tty?: boolean,
  token?: string
): string {
  const base = http.wsBaseUrl;
  const url = new URL(`${base}/v1/client/allocation/${encodeURIComponent(allocId)}/exec`);
  url.searchParams.set('task', task);
  url.searchParams.set('tty', tty ? 'true' : 'false');
  for (const arg of command) {
    url.searchParams.append('command', arg);
  }
  if (token) {
    url.searchParams.set('X-Nomad-Token', token);
  }
  return url.toString();
}

/**
 * Decode a base64 string to a UTF-8 string.
 */
function decodeBase64(encoded: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(encoded, 'base64').toString('utf-8');
  }
  // Browser/Deno fallback
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a Uint8Array to base64.
 */
function encodeBase64Bytes(data: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(data).toString('base64');
  }
  return btoa(String.fromCharCode(...data));
}

/**
 * Execute a command inside a Nomad allocation (buffered).
 * Collects all stdout/stderr and returns when the process exits.
 */
export async function execInAllocation(
  http: NomadHttpClient,
  options: ExecOptions
): Promise<ExecResult> {
  const { allocId, task, command, tty } = options;
  const wsUrl = buildExecWsUrl(http, allocId, task, command, tty, http.configuredToken);

  return new Promise<ExecResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as {
          stdout?: { data?: string };
          stderr?: { data?: string };
          exited?: boolean;
          result?: { exit_code?: number };
        };

        if (frame.stdout?.data) {
          stdout += decodeBase64(frame.stdout.data);
        }
        if (frame.stderr?.data) {
          stderr += decodeBase64(frame.stderr.data);
        }
        if (frame.exited) {
          ws.close();
          resolve({
            exitCode: frame.result?.exit_code ?? 1,
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
          });
        }
      } catch (err) {
        const raw = String(event.data);
        if (raw.startsWith('{') || raw.startsWith('[')) {
          // JSON that failed to parse — real error
          console.error(
            '[NomadSDK] Failed to parse exec frame:',
            err instanceof Error ? err.message : String(err)
          );
        }
        // Non-JSON heartbeat frames are expected and safe to ignore
      }
    };

    ws.onerror = (event) => {
      reject(new ExecError(1, `WebSocket error during exec: ${String(event)}`));
    };

    ws.onclose = (event) => {
      if (!event.wasClean) {
        reject(new ExecError(1, `WebSocket closed unexpectedly: code=${event.code}`));
      }
    };
  });
}

/**
 * Execute a command inside a Nomad allocation (streaming).
 * Returns ReadableStreams for stdout/stderr and a WritableStream for stdin.
 */
export function execStreamInAllocation(
  http: NomadHttpClient,
  options: ExecStreamOptions
): ExecStreamResult {
  const { allocId, task, command, tty, timeoutMs } = options;
  const wsUrl = buildExecWsUrl(http, allocId, task, command, tty, http.configuredToken);

  const ws = new WebSocket(wsUrl);

  let resolveWait: (value: { exitCode: number }) => void;
  let rejectWait: (error: Error) => void;
  const waitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;

  const stdoutStream = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });

  const stderrStream = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });

  const stdinStream = new WritableStream<Uint8Array>({
    write(chunk) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ stdin: { data: encodeBase64Bytes(chunk) } }));
      }
    },
    close() {
      // Send EOF
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ stdin: { close: true } }));
      }
    },
  });

  const encoder = new TextEncoder();

  ws.onmessage = (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as {
        stdout?: { data?: string };
        stderr?: { data?: string };
        exited?: boolean;
        result?: { exit_code?: number };
      };

      if (frame.stdout?.data) {
        stdoutController.enqueue(encoder.encode(decodeBase64(frame.stdout.data)));
      }
      if (frame.stderr?.data) {
        stderrController.enqueue(encoder.encode(decodeBase64(frame.stderr.data)));
      }
      if (frame.exited) {
        stdoutController.close();
        stderrController.close();
        ws.close();
        resolveWait({ exitCode: frame.result?.exit_code ?? 1 });
      }
    } catch (err) {
      const raw = String(event.data);
      if (raw.startsWith('{') || raw.startsWith('[')) {
        console.error(
          '[NomadSDK] Failed to parse exec stream frame:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  };

  ws.onerror = () => {
    const err = new ExecError(1, 'WebSocket error during streaming exec');
    try {
      stdoutController.close();
    } catch {
      /* already closed */
    }
    try {
      stderrController.close();
    } catch {
      /* already closed */
    }
    rejectWait(err);
  };

  ws.onclose = (event) => {
    if (!event.wasClean) {
      try {
        stdoutController.close();
      } catch {
        /* already closed */
      }
      try {
        stderrController.close();
      } catch {
        /* already closed */
      }
      rejectWait(new ExecError(1, `WebSocket closed unexpectedly: code=${event.code}`));
    }
  };

  if (timeoutMs) {
    setTimeout(() => {
      ws.close();
      try {
        stdoutController.close();
      } catch {
        /* already closed */
      }
      try {
        stderrController.close();
      } catch {
        /* already closed */
      }
      rejectWait(new TimeoutError('exec stream', timeoutMs));
    }, timeoutMs);
  }

  return {
    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: stdinStream,
    wait: () => waitPromise,
    kill: () => {
      ws.close();
      try {
        stdoutController.close();
      } catch {
        /* already closed */
      }
      try {
        stderrController.close();
      } catch {
        /* already closed */
      }
    },
  };
}
