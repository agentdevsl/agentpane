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
  url.searchParams.set('namespace', http.configuredNamespace);
  // Nomad expects command as repeated query parameters
  for (const arg of command) {
    url.searchParams.append('command', arg);
  }
  if (token) {
    // SECURITY: Nomad WebSocket connections do not support custom headers, so the ACL
    // token must be passed via the ?token= query parameter. This means the token is
    // visible in server access logs, proxy logs, and Nomad audit logs. Mitigation:
    // - sanitizeWsUrl() redacts the token in all error messages from this module
    // - TLS should always be enabled in production to prevent network sniffing
    // - This is an inherent limitation of the WebSocket protocol (no custom headers)
    // Accepted risk: documented and mitigated, no alternative exists for WS auth.
    url.searchParams.set('token', token);
  }
  return url.toString();
}

/** Redact the ACL token from WebSocket URLs for safe use in error messages. */
function sanitizeWsUrl(url: string): string {
  return url.replace(/([?&])token=[^&]+/, '$1token=REDACTED');
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
  for (const byte of data) {
    binary += String.fromCharCode(byte);
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
  if (command.length === 0) {
    throw new ExecError(1, 'exec command must not be empty');
  }
  const wsUrl = buildExecWsUrl(http, allocId, task, command, tty, http.configuredToken);

  return new Promise<ExecResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let consecutiveParseFailures = 0;

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
        consecutiveParseFailures++;
        console.error(
          '[NomadSDK] Failed to parse exec frame:',
          err instanceof Error ? err.message : String(err)
        );
        if (consecutiveParseFailures >= 3 && !settled) {
          settled = true;
          clearTimeout(timeoutId);
          ws.close();
          reject(new ExecError(1, `Too many unparseable frames (${consecutiveParseFailures})`));
        }
        return;
      }

      // Reset on successful parse
      consecutiveParseFailures = 0;

      try {
        if (frame.stdout?.data) {
          stdout += decodeBase64(frame.stdout.data);
        }
        if (frame.stderr?.data) {
          stderr += decodeBase64(frame.stderr.data);
        }
      } catch (decodeErr) {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          ws.close();
          reject(
            new ExecError(
              1,
              `Failed to decode exec frame: ${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)}`
            )
          );
        }
        return;
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

    ws.onerror = (_event) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        reject(new ExecError(1, `WebSocket error during exec on ${sanitizeWsUrl(wsUrl)}`));
      }
    };

    ws.onclose = (event) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        if (!event.wasClean) {
          reject(new ExecError(1, `WebSocket closed unexpectedly: code=${event.code}`));
        } else {
          reject(new ExecError(1, 'WebSocket closed without exit frame'));
        }
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
  if (command.length === 0) {
    throw new ExecError(1, 'exec command must not be empty');
  }
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

  let controllersClosed = false;

  /** Safely close both stdout and stderr stream controllers (idempotent). */
  function closeControllers(): void {
    if (controllersClosed) return;
    controllersClosed = true;
    try {
      stdoutController.close();
    } catch (err) {
      // Expected when controller is already closed; log unexpected errors
      if (err instanceof TypeError && String(err.message).includes('close')) {
        // ReadableStream controller already closed — safe to ignore
      } else {
        console.error('[NomadSDK] Unexpected error closing stdout controller:', err);
      }
    }
    try {
      stderrController.close();
    } catch (err) {
      if (err instanceof TypeError && String(err.message).includes('close')) {
        // ReadableStream controller already closed — safe to ignore
      } else {
        console.error('[NomadSDK] Unexpected error closing stderr controller:', err);
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
      } else {
        throw new Error(`Cannot write to stdin: WebSocket is not open (state=${ws.readyState})`);
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

  let consecutiveParseFailures = 0;
  let streamTimeoutId: ReturnType<typeof setTimeout> | undefined;

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
      consecutiveParseFailures++;
      console.error(
        '[NomadSDK] Failed to parse exec stream frame:',
        err instanceof Error ? err.message : String(err)
      );
      if (consecutiveParseFailures >= 3 && !streamSettled) {
        streamSettled = true;
        if (streamTimeoutId) clearTimeout(streamTimeoutId);
        ws.close();
        closeControllers();
        rejectWait(new ExecError(1, `Too many unparseable frames (${consecutiveParseFailures})`));
      }
      return;
    }

    // Reset on successful parse
    consecutiveParseFailures = 0;

    try {
      if (frame.stdout?.data) {
        stdoutController.enqueue(encoder.encode(decodeBase64(frame.stdout.data)));
      }
      if (frame.stderr?.data) {
        stderrController.enqueue(encoder.encode(decodeBase64(frame.stderr.data)));
      }
    } catch (decodeErr) {
      if (!streamSettled) {
        streamSettled = true;
        if (streamTimeoutId) clearTimeout(streamTimeoutId);
        ws.close();
        closeControllers();
        rejectWait(
          new ExecError(
            1,
            `Failed to decode exec frame: ${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)}`
          )
        );
      }
      return;
    }
    if (frame.exited && !streamSettled) {
      streamSettled = true;
      if (streamTimeoutId) clearTimeout(streamTimeoutId);
      closeControllers();
      ws.close();
      resolveWait({ exitCode: frame.result?.exit_code ?? 1 });
    }
  };

  ws.onerror = () => {
    if (!streamSettled) {
      streamSettled = true;
      if (streamTimeoutId) clearTimeout(streamTimeoutId);
      const err = new ExecError(
        1,
        `WebSocket error during streaming exec on ${sanitizeWsUrl(wsUrl)}`
      );
      closeControllers();
      rejectWait(err);
    }
  };

  ws.onclose = (event) => {
    if (!streamSettled) {
      streamSettled = true;
      if (streamTimeoutId) clearTimeout(streamTimeoutId);
      closeControllers();
      if (!event.wasClean) {
        rejectWait(new ExecError(1, `WebSocket closed unexpectedly: code=${event.code}`));
      } else {
        rejectWait(new ExecError(1, 'WebSocket closed without exit frame'));
      }
    }
  };

  if (timeoutMs) {
    streamTimeoutId = setTimeout(() => {
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
      if (!streamSettled) {
        streamSettled = true;
        ws.close();
        closeControllers();
        if (streamTimeoutId) clearTimeout(streamTimeoutId);
        rejectWait(new ExecError(1, 'Exec stream killed'));
      }
    },
  };
}
