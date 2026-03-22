/**
 * MemoryClientService — Thin wrapper around @honcho-ai/sdk v2.
 *
 * Manages Honcho client instances (one per workspace), peer caching,
 * and maps SDK operations to AgentPane Result<T, MemoryError> returns.
 *
 * Key SDK v2 mapping:
 *   Workspace  → Honcho constructor `workspaceId` param (one client per workspace)
 *   Peer       → honcho.peer(id) — getOrCreate semantics
 *   Session    → honcho.session(id) — getOrCreate semantics
 *   Message    → peer.message(content) + session.addMessages(msg)
 *   Conclusion → peer.conclusions.list/query/create/delete
 *   Deriver    → honcho.scheduleDream({ observer, session })
 */

import { ConnectionError, Honcho, type Peer, type Session, TimeoutError } from '@honcho-ai/sdk';

import type { MemoryError } from '../../lib/errors/memory-errors.js';
import { MemoryErrors } from '../../lib/errors/memory-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { SettingsService } from '../settings.service.js';
import type { HonchoSessionRef, MemoryConclusion, PaginationOptions } from './types.js';
import { toMemoryConclusion } from './types.js';

const log = createLogger('MemoryClient');

export class MemoryClientService {
  /** One Honcho client per workspace (keyed by workspace name). */
  private clients = new Map<string, Honcho>();
  /** Cached peer objects: `${workspaceName}:${peerId}` → Peer */
  private peers = new Map<string, Peer>();
  /** Cached session objects: `${workspaceName}:${sessionId}` → Session */
  private sessions = new Map<string, Session>();
  /** Whether the service is connected and ready. */
  private available = false;
  /** Base URL for Honcho API. */
  private baseUrl = 'http://localhost:8000';
  /** API key for Honcho auth. */
  private apiKey: string | undefined;

  constructor(private settingsService: SettingsService) {}

  /**
   * Initialize the client by reading settings and pinging Honcho.
   * Non-fatal — sets available=false on any failure.
   */
  async initialize(): Promise<Result<void, MemoryError>> {
    try {
      // Read settings
      const enabledResult = await this.settingsService.get('memory.enabled');
      if (!enabledResult.ok || enabledResult.value?.value !== 'true') {
        log.info('Memory service disabled by setting');
        this.available = false;
        return ok(undefined);
      }

      const honchoResult = await this.settingsService.get('memory.honcho');
      if (honchoResult.ok && honchoResult.value?.value) {
        try {
          const parsed = JSON.parse(honchoResult.value.value);
          if (parsed.url) this.baseUrl = parsed.url;
          if (parsed.apiKey) {
            // Decrypt apiKey — settings route encrypts sensitive fields on write
            try {
              const { decryptToken } = await import('../../lib/crypto/server-encryption.js');
              this.apiKey = decryptToken(parsed.apiKey);
            } catch {
              // Fallback: might be unencrypted (e.g., set via env var migration)
              this.apiKey = parsed.apiKey;
            }
          }
        } catch {
          // Use defaults
        }
      }

      // Also check env vars as fallback
      if (process.env.HONCHO_URL) this.baseUrl = process.env.HONCHO_URL;
      if (process.env.HONCHO_API_KEY) this.apiKey = process.env.HONCHO_API_KEY;

      // Ping Honcho health endpoint
      const pingResult = await this.ping();
      if (!pingResult.ok) {
        log.warn('Honcho health check failed', { data: { error: pingResult.error.message } });
        this.available = false;
        return ok(undefined); // Non-fatal
      }

      // Ensure platform workspace exists
      const platformClient = this.getOrCreateClient('platform');
      // Trigger workspace creation via a lightweight call
      await platformClient.getMetadata();

      this.available = true;
      log.info('Memory client initialized', { data: { baseUrl: this.baseUrl } });
      return ok(undefined);
    } catch (error) {
      this.handleConnectionError(error);
      log.warn('Memory client initialization failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return ok(undefined); // Non-fatal
    }
  }

  /** Whether the client is connected and ready. */
  isAvailable(): boolean {
    return this.available;
  }

  /** Health check — ping Honcho /health endpoint via HTTP. */
  async ping(): Promise<Result<{ status: string; version: string }, MemoryError>> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return err(MemoryErrors.CONNECTION_FAILED(this.baseUrl));
      }
      const data = (await response.json()) as { status?: string; version?: string };
      return ok({
        status: data.status ?? 'unknown',
        version: data.version ?? 'unknown',
      });
    } catch {
      return err(MemoryErrors.CONNECTION_FAILED(this.baseUrl));
    }
  }

  // ---------------------------------------------------------------------------
  // Workspace / Client management
  // ---------------------------------------------------------------------------

  /** Get or create a Honcho client for a workspace. */
  private getOrCreateClient(workspaceName: string): Honcho {
    let client = this.clients.get(workspaceName);
    if (!client) {
      client = new Honcho({
        baseURL: this.baseUrl,
        apiKey: this.apiKey,
        workspaceId: workspaceName,
      });
      this.clients.set(workspaceName, client);
    }
    return client;
  }

  /** Get the Honcho client for a codespace workspace. */
  getCodespaceClient(codespaceId: string): Honcho {
    return this.getOrCreateClient(`codespace-${codespaceId}`);
  }

  /** Get the Honcho client for the platform workspace. */
  getPlatformClient(): Honcho {
    return this.getOrCreateClient('platform');
  }

  // ---------------------------------------------------------------------------
  // Peer management (cached)
  // ---------------------------------------------------------------------------

  /** Get or create a peer, with caching. */
  async ensurePeer(
    client: Honcho,
    peerId: string,
    metadata?: Record<string, unknown>
  ): Promise<Result<Peer, MemoryError>> {
    const cacheKey = `${client.workspaceId}:${peerId}`;
    const cached = this.peers.get(cacheKey);
    if (cached) return ok(cached);

    try {
      const peer = await client.peer(peerId, metadata ? { metadata } : undefined);
      this.peers.set(cacheKey, peer);
      return ok(peer);
    } catch (error) {
      this.handleConnectionError(error);
      return err(MemoryErrors.WORKSPACE_ERROR(`Failed to ensure peer ${peerId}: ${String(error)}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /** Create a Honcho session with metadata. Returns a HonchoSessionRef. */
  async createSession(
    client: Honcho,
    sessionId: string,
    agentPeer: Peer,
    userPeer: Peer,
    metadata: Record<string, unknown>
  ): Promise<Result<HonchoSessionRef, MemoryError>> {
    try {
      const session = await client.session(sessionId, { metadata });
      // Cache session for message capture
      this.sessions.set(`${client.workspaceId}:${session.id}`, session);
      // Add both peers to the session
      await session.addPeers([agentPeer, userPeer]);
      return ok({
        workspaceId: client.workspaceId,
        sessionId: session.id,
        agentPeerId: agentPeer.id,
        userPeerId: userPeer.id,
      });
    } catch (error) {
      this.handleConnectionError(error);
      return err(MemoryErrors.SESSION_ERROR(`Failed to create session: ${String(error)}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Message capture
  // ---------------------------------------------------------------------------

  /** Add a message to a session attributed to a peer. */
  async addMessage(
    client: Honcho,
    ref: HonchoSessionRef,
    peerId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<Result<void, MemoryError>> {
    try {
      // Use cached session to avoid API roundtrip per message
      const cacheKey = `${client.workspaceId}:${ref.sessionId}`;
      let session = this.sessions.get(cacheKey);
      if (!session) {
        session = await client.session(ref.sessionId);
        this.sessions.set(cacheKey, session);
      }
      const peerResult = await this.ensurePeer(client, peerId);
      if (!peerResult.ok) return peerResult;
      const msg = peerResult.value.message(content, metadata ? { metadata } : undefined);
      await session.addMessages(msg);
      return ok(undefined);
    } catch (error) {
      this.handleConnectionError(error);
      return err(MemoryErrors.CAPTURE_ERROR(`Failed to add message: ${String(error)}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Session finalization (trigger deriver)
  // ---------------------------------------------------------------------------

  /** Schedule a dream (deriver) to consolidate session observations. */
  async finalizeSession(client: Honcho, ref: HonchoSessionRef): Promise<Result<void, MemoryError>> {
    try {
      await client.scheduleDream({
        observer: ref.agentPeerId,
        session: ref.sessionId,
      });
      return ok(undefined);
    } catch (error) {
      this.handleConnectionError(error);
      return err(MemoryErrors.SESSION_ERROR(`Failed to finalize session: ${String(error)}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Conclusions
  // ---------------------------------------------------------------------------

  /** List conclusions for a peer (self-conclusions). */
  async listConclusions(
    peer: Peer,
    options?: PaginationOptions & { session?: string }
  ): Promise<Result<MemoryConclusion[], MemoryError>> {
    try {
      const page = await peer.conclusions.list({
        page: options?.page ?? 1,
        size: options?.size ?? 50,
        session: options?.session,
      });
      return ok(page.items.map(toMemoryConclusion));
    } catch (error) {
      this.handleConnectionError(error);
      return err(MemoryErrors.QUERY_ERROR(`Failed to list conclusions: ${String(error)}`));
    }
  }

  /** Semantic search conclusions for a peer. */
  async queryConclusions(
    peer: Peer,
    query: string,
    topK?: number
  ): Promise<Result<MemoryConclusion[], MemoryError>> {
    try {
      const results = await peer.conclusions.query(query, topK ?? 10);
      return ok(results.map(toMemoryConclusion));
    } catch (error) {
      this.handleConnectionError(error);
      return err(MemoryErrors.QUERY_ERROR(`Failed to query conclusions: ${String(error)}`));
    }
  }

  /** Create a manual conclusion for a peer. */
  async createConclusion(
    peer: Peer,
    content: string,
    sessionId?: string
  ): Promise<Result<MemoryConclusion, MemoryError>> {
    try {
      const created = await peer.conclusions.create({
        content,
        sessionId: sessionId ?? undefined,
      });
      // create returns Conclusion[]
      const first = created[0];
      if (!first) {
        return err(MemoryErrors.CAPTURE_ERROR('No conclusion created'));
      }
      return ok(toMemoryConclusion(first));
    } catch (error) {
      this.handleConnectionError(error);
      return err(MemoryErrors.CAPTURE_ERROR(`Failed to create conclusion: ${String(error)}`));
    }
  }

  /** Delete a conclusion by ID. */
  async deleteConclusion(peer: Peer, conclusionId: string): Promise<Result<void, MemoryError>> {
    try {
      await peer.conclusions.delete(conclusionId);
      return ok(undefined);
    } catch (error) {
      this.handleConnectionError(error);
      return err(MemoryErrors.NOT_FOUND(`conclusion:${conclusionId}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Representation (for context injection)
  // ---------------------------------------------------------------------------

  /** Get the computed representation for a peer (text summary of conclusions). */
  async getRepresentation(
    peer: Peer,
    options?: { searchQuery?: string; maxConclusions?: number }
  ): Promise<Result<string, MemoryError>> {
    try {
      const rep = await peer.representation({
        searchQuery: options?.searchQuery,
        maxConclusions: options?.maxConclusions ?? 20,
      });
      return ok(rep);
    } catch (error) {
      this.handleConnectionError(error);
      return err(MemoryErrors.QUERY_ERROR(`Failed to get representation: ${String(error)}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Sessions listing
  // ---------------------------------------------------------------------------

  /** List sessions in a workspace. Returns first page of results. */
  async listSessions(client: Honcho): Promise<Result<Session[], MemoryError>> {
    try {
      const page = await client.sessions();
      return ok(page.items);
    } catch (error) {
      this.handleConnectionError(error);
      return err(MemoryErrors.QUERY_ERROR(`Failed to list sessions: ${String(error)}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Workspace deletion
  // ---------------------------------------------------------------------------

  /** Delete a workspace (cascade all data). */
  async deleteWorkspace(workspaceName: string): Promise<Result<void, MemoryError>> {
    try {
      // Use any existing client or create a temporary one
      const client = this.getOrCreateClient(workspaceName);
      await client.deleteWorkspace(workspaceName);
      // Clean up cached clients, peers, and sessions
      this.clients.delete(workspaceName);
      for (const key of this.peers.keys()) {
        if (key.startsWith(`${workspaceName}:`)) {
          this.peers.delete(key);
        }
      }
      for (const key of this.sessions.keys()) {
        if (key.startsWith(`${workspaceName}:`)) {
          this.sessions.delete(key);
        }
      }
      return ok(undefined);
    } catch (error) {
      this.handleConnectionError(error);
      return err(MemoryErrors.WORKSPACE_ERROR(`Failed to delete workspace: ${workspaceName}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  /** Check if an error indicates connection loss and mark service unavailable. */
  private handleConnectionError(error: unknown): void {
    if (
      error instanceof ConnectionError ||
      error instanceof TimeoutError ||
      (error instanceof Error &&
        (error.message.includes('ECONNREFUSED') ||
          error.message.includes('fetch failed') ||
          error.message.includes('network')))
    ) {
      this.available = false;
      log.warn('Honcho connection lost, marking memory unavailable');
    }
  }
}
