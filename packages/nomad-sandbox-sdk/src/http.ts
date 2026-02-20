import { NOMAD_DEFAULTS } from './constants.js';
import { ConnectionError, NomadApiError, NotFoundError } from './errors.js';
import type { NomadClientOptions } from './types/common.js';

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
    this.token = options?.token;
    this.namespace = options?.namespace ?? NOMAD_DEFAULTS.namespace;
    this.region = options?.region;
  }

  /**
   * Derive the WebSocket base URL from the HTTP base URL.
   * Converts http:// → ws:// and https:// → wss:// via prefix replacement.
   */
  get wsBaseUrl(): string {
    return this.baseUrl.replace(/^http/, 'ws');
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
  ): Promise<T> {
    const url = this.buildUrl(path, options?.query);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

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
    if (!text) return null as T;

    return JSON.parse(text) as T;
  }

  /**
   * Make a blocking query request.
   * Uses Nomad's `?index=N&wait=Xs` mechanism for near-instant change detection.
   * Returns the response data along with the new modify index.
   */
  async blockingQuery<T>(
    path: string,
    index: number,
    wait?: string
  ): Promise<{ data: T; index: number }> {
    const url = this.buildUrl(path, {
      index: String(index),
      wait: wait ?? NOMAD_DEFAULTS.waitTimeout,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['X-Nomad-Token'] = this.token;
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), { method: 'GET', headers });
    } catch (error) {
      throw new ConnectionError(
        this.baseUrl,
        error instanceof Error ? error : new Error(String(error))
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new NomadApiError(
        response.status,
        `Blocking query failed: ${response.status} — ${body}`,
        body
      );
    }

    const newIndex = parseInt(response.headers.get('X-Nomad-Index') ?? '0', 10);
    const data = (await response.json()) as T;

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
