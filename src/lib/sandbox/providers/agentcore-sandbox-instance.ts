/**
 * AgentCore Sandbox Instance
 *
 * Represents a connection to an AWS Bedrock AgentCore runtime.
 * Unlike Docker/K8s/Nomad sandbox instances, AgentCore is NOT a container
 * you exec into. Instead, you invoke the runtime handler with a payload
 * and receive Server-Sent Events (SSE) back.
 *
 * This class does NOT implement the Sandbox interface (sandbox-provider.ts)
 * because AgentCore has no shell, exec, or tmux capabilities.
 */

import { AgentCoreErrors, isAgentCoreError } from '../../errors/agentcore-errors.js';
import { createLogger } from '../../logging/logger.js';
import { errorMessage } from '../../utils/error-message';
import type { SandboxStatus } from '../types.js';

const log = createLogger('AgentCoreSandboxInstance');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface AgentCoreInstanceOptions {
  /** ARN of the AgentCore runtime to invoke */
  runtimeArn: string;
  /** AWS region (e.g. us-east-1) */
  region: string;
  /** AWS access key ID */
  accessKeyId: string;
  /** AWS secret access key */
  secretAccessKey: string;
  /** Project this instance belongs to */
  projectId: string;
  /** Unique sandbox identifier */
  sandboxId: string;
}

// ---------------------------------------------------------------------------
// AWS SigV4 Signing (minimal implementation for AgentCore invoke)
// ---------------------------------------------------------------------------

/**
 * SC-038: Minimal hand-rolled AWS Signature Version 4 signer for AgentCore invoke requests.
 *
 * DEFERRED: Replace with `@aws-sdk/signature-v4` or `@aws-sdk/client-bedrock-agentcore`
 * InvokeAgentRuntimeCommand once the package is added to dependencies. The SDK provides
 * automatic signing, retries, and proper error parsing. This manual approach is a stopgap
 * and should be replaced in a future iteration to reduce maintenance burden and improve
 * compliance with AWS signing edge cases (e.g. double-encoded URIs, session tokens).
 */
async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const rawKey = key instanceof ArrayBuffer ? new Uint8Array(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKey as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  let key = await hmacSha256(new TextEncoder().encode(`AWS4${secretKey}`), dateStamp);
  key = await hmacSha256(key, region);
  key = await hmacSha256(key, service);
  key = await hmacSha256(key, 'aws4_request');
  return key;
}

interface SignedHeaders {
  Authorization: string;
  'x-amz-date': string;
  'x-amz-content-sha256': string;
}

async function signRequest(opts: {
  method: string;
  url: URL;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Promise<SignedHeaders> {
  if (!globalThis.crypto?.subtle) {
    throw AgentCoreErrors.INTERNAL_ERROR(
      'Web Crypto API (crypto.subtle) is not available. AgentCore signing requires Node.js 18+ or a compatible runtime.'
    );
  }

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(opts.body);

  const canonicalHeaders =
    `host:${opts.url.host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeadersList = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalPath = opts.url.pathname || '/';
  const canonicalQueryString = opts.url.search ? opts.url.search.slice(1) : '';

  const canonicalRequest = [
    opts.method,
    canonicalPath,
    canonicalQueryString,
    canonicalHeaders,
    signedHeadersList,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await getSignatureKey(
    opts.secretAccessKey,
    dateStamp,
    opts.region,
    opts.service
  );
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = [...new Uint8Array(signatureBytes)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeadersList}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
}

// ---------------------------------------------------------------------------
// AgentCoreSandboxInstance
// ---------------------------------------------------------------------------

export class AgentCoreSandboxInstance {
  readonly runtimeArn: string;
  readonly projectId: string;
  readonly sandboxId: string;
  readonly createdAt: string;

  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private _status: SandboxStatus = 'running';

  constructor(options: AgentCoreInstanceOptions) {
    this.runtimeArn = options.runtimeArn;
    this.projectId = options.projectId;
    this.sandboxId = options.sandboxId;
    this.createdAt = new Date().toISOString();
    this.region = options.region;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
  }

  get status(): SandboxStatus {
    return this._status;
  }

  /**
   * Invoke the AgentCore runtime handler and stream SSE events.
   *
   * Each invocation targets a specific `runtimeSessionId` which maps to
   * an isolated microVM on the AgentCore side. This provides per-task
   * isolation without managing containers ourselves.
   *
   * The response body is a text/event-stream formatted as:
   *   data: {"type":"...", "data": {...}}\n\n
   *
   * TODO: Replace manual fetch + SigV4 signing with
   * `@aws-sdk/client-bedrock-agentcore` InvokeAgentRuntimeCommand once the
   * package is available. The SDK handles signing, retries, and streaming
   * natively.
   */
  async *invoke(
    payload: Record<string, unknown>,
    runtimeSessionId: string
  ): AsyncGenerator<SSEEvent> {
    if (this._status === 'stopped') {
      throw AgentCoreErrors.SESSION_INVOKE_FAILED('Instance is stopped');
    }

    const body = JSON.stringify(payload);

    // Build the AgentCore invoke URL.
    // Endpoint format: https://bedrock-agentcore.{region}.amazonaws.com
    // Path: /agentruntimes/{runtimeArn}/sessions/{sessionId}/invoke
    const runtimeId = this.extractRuntimeId(this.runtimeArn);
    const url = new URL(
      `/agentruntimes/${encodeURIComponent(runtimeId)}/sessions/${encodeURIComponent(runtimeSessionId)}/invoke`,
      `https://bedrock-agentcore.${this.region}.amazonaws.com`
    );

    try {
      const signed = await signRequest({
        method: 'POST',
        url,
        body,
        region: this.region,
        service: 'bedrock-agentcore',
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      });

      log.info('Invoking AgentCore runtime', {
        data: {
          runtimeArn: this.runtimeArn,
          runtimeSessionId,
          region: this.region,
        },
      });

      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...signed,
        },
        body,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown error');
        throw AgentCoreErrors.SESSION_INVOKE_FAILED(`HTTP ${response.status}: ${errorBody}`);
      }

      if (!response.body) {
        throw AgentCoreErrors.SESSION_INVOKE_FAILED('Response body is empty');
      }

      // Parse SSE stream from response body
      yield* this.parseSSEStream(response.body);
    } catch (error) {
      if (isAgentCoreError(error)) throw error;
      throw AgentCoreErrors.SESSION_INVOKE_FAILED(errorMessage(error));
    }
  }

  /**
   * Parse an SSE stream (text/event-stream) into typed events.
   *
   * Expected format per the SSE spec:
   *   data: {"type":"agent:turn", "data": {"content":"..."}}\n\n
   *
   * Handles:
   * - Multi-line data fields (joined with newline)
   * - Event type fields (event: ...)
   * - Comment lines (: ...)
   * - Chunked delivery where event boundaries span multiple chunks
   */
  private async *parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of this.readableStreamToAsyncIterable(body)) {
      buffer += decoder.decode(chunk, { stream: true });

      // Split on double newlines (SSE event boundary)
      const parts = buffer.split('\n\n');
      // Keep the last incomplete part in the buffer
      buffer = parts.pop() || '';

      for (const part of parts) {
        const event = this.parseSSEBlock(part);
        if (event) {
          yield event;
        }
      }
    }

    // Flush any remaining data in buffer after stream ends
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = this.parseSSEBlock(buffer);
      if (event) {
        yield event;
      }
    }
  }

  /**
   * Parse a single SSE block (text between double-newline boundaries) into
   * an SSEEvent. Returns null if the block doesn't contain valid event data.
   */
  private parseSSEBlock(block: string): SSEEvent | null {
    const lines = block.split('\n');
    const dataLines: string[] = [];
    let eventType: string | undefined;

    for (const line of lines) {
      if (line.startsWith(':')) continue;

      if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5));
      } else if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      }
    }

    if (dataLines.length === 0) return null;

    const dataStr = dataLines.join('\n');
    try {
      const parsed = JSON.parse(dataStr);

      // Support two formats:
      // 1. Wrapped: data: {"type":"...", "data": {...}}
      // 2. Unwrapped with event field: event: agent:turn\ndata: {...}
      if (typeof parsed === 'object' && parsed !== null) {
        if (parsed.type && parsed.data) {
          return parsed as SSEEvent;
        }
        if (eventType) {
          return { type: eventType, data: parsed };
        }
      }
    } catch (parseErr) {
      log.warn('Failed to parse SSE block as JSON', {
        data: {
          block: dataStr.slice(0, 200),
          error: parseErr instanceof Error ? parseErr.message : 'parse error',
        },
      });
    }

    return null;
  }

  /**
   * Convert a ReadableStream into an AsyncIterable.
   * Required because not all environments support `for await` on ReadableStream.
   */
  private async *readableStreamToAsyncIterable(
    stream: ReadableStream<Uint8Array>
  ): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Extract the runtime ID from the full ARN.
   * ARN format: arn:aws:bedrock-agentcore:{region}:{account}:runtime/{id}
   * Returns the {id} portion, or the full string if it doesn't match.
   */
  private extractRuntimeId(arn: string): string {
    const parts = arn.split('/');
    return parts.length > 1 ? (parts[parts.length - 1] ?? arn) : arn;
  }

  async stop(): Promise<void> {
    this._status = 'stopped';
    log.info('AgentCore instance stopped', {
      data: { sandboxId: this.sandboxId, projectId: this.projectId },
    });
  }

  async refreshStatus(): Promise<SandboxStatus> {
    // AgentCore runtimes are managed by AWS. There's no local container
    // to probe. The status is tracked locally based on invoke lifecycle.
    return this._status;
  }
}
