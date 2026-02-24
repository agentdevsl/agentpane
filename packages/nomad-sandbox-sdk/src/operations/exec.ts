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
  // Nomad expects command as a single JSON-encoded array, not multiple params
  url.searchParams.set('command', JSON.stringify(command));
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
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

/**
 * Execute a command inside a Nomad allocation (buffered).
 * Collects all stdout/stderr and returns when the process exits.
 */
export async function execInAllocation(
  http: NomadHttpClient,
  options: ExecOptions
): Promise<ExecResult> {
  const { allocId, task, command, tty, timeoutMs = 60_000 } = options;
  const wsUrl = buildExecWsUrl(http, allocId, task, command, tty, http.configuredToken);

  return new Promise<ExecResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const ws = new WebSocket(wsUrl);

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new TimeoutError('exec', timeoutMs));
      }
    }, timeoutMs);

    ws.onmessage = (event) => {
      const raw = String(event.data);

      // Skip non-JSON heartbeat frames silently
      if (!raw.startsWith('{') && !raw.startsWith('[')) {
        return;
      }

      let frame: {
        stdout?: { data?: string };
        stderr?: { data?: string };
        exited?: boolean;
        result?: { exit_code?: number };
      };

      try {
        frame = JSON.parse(raw);
      } catch (err) {
        console.error(
          '[NomadSDK] Failed to parse exec frame:',
          err instanceof Error ? err.message : String(err)
        );
        return;
      }

      // Let base64 decode errors and other errors propagate naturally
      if (frame.stdout?.data) {
        stdout += decodeBase64(frame.stdout.data);
      }
      if (frame.stderr?.data) {
        stderr += decodeBase64(frame.stderr.data);
      }
      if (frame.exited && !settled) {
        settled = true;
        clearTimeout(timeoutId);
        ws.close();
        resolve({
          exitCode: frame.result?.exit_code ?? 1,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
        });
      }
    };

    ws.onerror = (event) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        reject(new ExecError(1, `WebSocket error during exec: ${String(event)}`));
      }
    };

    ws.onclose = (event) => {
      if (!event.wasClean && !settled) {
        settled = true;
        clearTimeout(timeoutId);
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

  let streamSettled = false;

  /** Safely close both stdout and stderr stream controllers (idempotent). */
  function closeControllers(): void {
    try {
      stdoutController.close();
    } catch (err) {
      if (!(err instanceof TypeError && String(err).includes('close'))) {
        console.warn('[NomadSDK] Unexpected error closing stdout controller:', err);
      }
    }
    try {
      stderrController.close();
    } catch (err) {
      if (!(err instanceof TypeError && String(err).includes('close'))) {
        console.warn('[NomadSDK] Unexpected error closing stderr controller:', err);
      }
    }
  }

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
    const raw = String(event.data);

    // Skip non-JSON heartbeat frames silently
    if (!raw.startsWith('{') && !raw.startsWith('[')) {
      return;
    }

    let frame: {
      stdout?: { data?: string };
      stderr?: { data?: string };
      exited?: boolean;
      result?: { exit_code?: number };
    };

    try {
      frame = JSON.parse(raw);
    } catch (err) {
      console.error(
        '[NomadSDK] Failed to parse exec stream frame:',
        err instanceof Error ? err.message : String(err)
      );
      return;
    }

    // Let base64 decode and controller.enqueue errors propagate naturally
    if (frame.stdout?.data) {
      stdoutController.enqueue(encoder.encode(decodeBase64(frame.stdout.data)));
    }
    if (frame.stderr?.data) {
      stderrController.enqueue(encoder.encode(decodeBase64(frame.stderr.data)));
    }
    if (frame.exited && !streamSettled) {
      streamSettled = true;
      closeControllers();
      ws.close();
      resolveWait({ exitCode: frame.result?.exit_code ?? 1 });
    }
  };

  ws.onerror = () => {
    if (!streamSettled) {
      streamSettled = true;
      const err = new ExecError(1, 'WebSocket error during streaming exec');
      closeControllers();
      rejectWait(err);
    }
  };

  ws.onclose = (event) => {
    if (!event.wasClean && !streamSettled) {
      streamSettled = true;
      closeControllers();
      rejectWait(new ExecError(1, `WebSocket closed unexpectedly: code=${event.code}`));
    }
  };

  if (timeoutMs) {
    setTimeout(() => {
      if (!streamSettled) {
        streamSettled = true;
        ws.close();
        closeControllers();
        rejectWait(new TimeoutError('exec stream', timeoutMs));
      }
    }, timeoutMs);
  }

  return {
    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: stdinStream,
    wait: () => waitPromise,
    kill: () => {
      ws.close();
      closeControllers();
    },
  };
}
