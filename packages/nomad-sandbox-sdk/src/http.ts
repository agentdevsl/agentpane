import { NOMAD_DEFAULTS } from './constants.js';
import { ConnectionError, NomadApiError, NotFoundError } from './errors.js';
import type { NomadClientOptions } from './types/common.js';

/** Parse a Nomad duration string (e.g., '30s', '5m', '1h30m', '1m30s', '500ms') to milliseconds. */
function parseNomadDuration(duration: string): number {
  let totalMs = 0;
  const msMatch = duration.match(/(\d+)ms/);
  const hourMatch = duration.match(/(\d+)h/);
  const minuteMatch = duration.match(/(\d+)m(?!s)/);
  const secondMatch = duration.match(/(\d+)s/);
  if (msMatch) totalMs += parseInt(msMatch[1] ?? '0', 10);
  if (hourMatch) totalMs += parseInt(hourMatch[1] ?? '0', 10) * 3_600_000;
  if (minuteMatch) totalMs += parseInt(minuteMatch[1] ?? '0', 10) * 60_000;
  if (secondMatch) totalMs += parseInt(secondMatch[1] ?? '0', 10) * 1_000;
  if (totalMs > 0) return totalMs;
  const fallback = parseInt(duration, 10);
  if (Number.isNaN(fallback) || fallback <= 0) {
    throw new Error(`Invalid Nomad duration string: "${duration}"`);
  }
  return fallback * 1_000;
}

/**
 * Low-level HTTP client for the Nomad API.
 * Handles authentication, namespace scoping, and error mapping.
 */
export class NomadHttpClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly namespace: string;
  private readonly region?: string;

  constructor(options?: NomadClientOptions) {
    const address = options?.address ?? NOMAD_DEFAULTS.address;
    // Strip trailing slash
    this.baseUrl = address.endsWith('/') ? address.slice(0, -1) : address;

    try {
      const parsed = new URL(address);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`Invalid Nomad address protocol: ${parsed.protocol}`);
      }
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`Invalid Nomad address URL: ${address}`);
      }
      throw error;
    }

    this.token = options?.token;
    this.namespace = options?.namespace ?? NOMAD_DEFAULTS.namespace;
    this.region = options?.region;
  }

  /**
   * Derive the WebSocket base URL from the HTTP base URL.
   * Converts http:// → ws:// and https:// → wss://.
   */
  get wsBaseUrl(): string {
    if (this.baseUrl.startsWith('https://')) {
      return this.baseUrl.replace('https://', 'wss://');
    }
    return this.baseUrl.replace('http://', 'ws://');
  }

  get configuredNamespace(): string {
    return this.namespace;
  }

  /** Get the configured ACL token (needed for WebSocket auth) */
  get configuredToken(): string | undefined {
    return this.token;
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?: Record<string, string>;
      timeout?: number;
    }
  ): Promise<T | null> {
    const url = this.buildUrl(path, options?.query);
    const headers: Record<string, string> = {};
    if (options?.body) {
      headers['Content-Type'] = 'application/json';
    }

    if (this.token) {
      headers['X-Nomad-Token'] = this.token;
    }

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (options?.timeout) {
      timeoutId = setTimeout(() => controller.abort(), options.timeout);
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: options?.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new NomadApiError(408, `Request timed out: ${method} ${path}`);
      }
      throw new ConnectionError(
        this.baseUrl,
        error instanceof Error ? error : new Error(String(error))
      );
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');

      if (response.status === 404) {
        throw new NotFoundError('resource', path);
      }

      throw new NomadApiError(
        response.status,
        `Nomad API error: ${response.status} ${response.statusText} — ${body}`,
        body
      );
    }

    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NomadApiError(
        response.status,
        `Failed to parse JSON response from ${method} ${path}: ${text.slice(0, 200)}`
      );
    }
  }

  /**
   * Make a blocking query request.
   * Uses Nomad's `?index=N&wait=Xs` mechanism for near-instant change detection.
   * Returns the response data along with the new modify index.
   */
  async blockingQuery<T>(
    path: string,
    index: number,
    wait?: string,
    signal?: AbortSignal
  ): Promise<{ data: T; index: number }> {
    const effectiveWait = wait ?? NOMAD_DEFAULTS.waitTimeout;
    const url = this.buildUrl(path, {
      index: String(index),
      wait: effectiveWait,
    });

    const headers: Record<string, string> = {};

    if (this.token) {
      headers['X-Nomad-Token'] = this.token;
    }

    // Parse wait duration and add a 10s buffer for the fetch timeout
    const waitMs = parseNomadDuration(effectiveWait);
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), waitMs + 10_000);

    // Link external signal if provided
    let abortHandler: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId);
        throw new ConnectionError(this.baseUrl, new Error(`Request aborted for ${path}`));
      }
      abortHandler = () => abortController.abort();
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers,
        signal: abortController.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ConnectionError(
          this.baseUrl,
          new Error(`Blocking query timed out after ${waitMs + 10_000}ms`)
        );
      }
      throw new ConnectionError(
        this.baseUrl,
        error instanceof Error ? error : new Error(String(error))
      );
    } finally {
      clearTimeout(timeoutId);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new NomadApiError(
        response.status,
        `Blocking query failed: ${response.status} — ${body}`,
        body
      );
    }

    const rawIndex = response.headers.get('X-Nomad-Index');
    if (rawIndex === null) {
      console.warn(
        `[NomadSDK] Missing X-Nomad-Index header on blocking query response for ${path}`
      );
    }
    const parsed = rawIndex !== null ? parseInt(rawIndex, 10) : NaN;
    const newIndex = Number.isNaN(parsed) ? index + 1 : parsed;
    const text = await response.text();

    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new NomadApiError(
        response.status,
        `Failed to parse JSON response from blocking query ${path}: ${text.slice(0, 200)}`
      );
    }

    return { data, index: newIndex };
  }

  /**
   * Build a full URL with namespace and region query parameters.
   */
  private buildUrl(path: string, extraQuery?: Record<string, string>): URL {
    const url = new URL(`${this.baseUrl}${path}`);

    // Always include namespace
    url.searchParams.set('namespace', this.namespace);

    // Include region if configured
    if (this.region) {
      url.searchParams.set('region', this.region);
    }

    // Append extra query params
    if (extraQuery) {
      for (const [key, value] of Object.entries(extraQuery)) {
        url.searchParams.set(key, value);
      }
    }

    return url;
  }
}
