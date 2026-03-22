/**
 * MemoryAdminService — Implements admin CRUD operations for memory conclusions and sessions.
 *
 * Delegates to MemoryClientService for all Honcho SDK interactions.
 * Used by the memory admin API routes for managing conclusions, sessions, and search.
 */

import type { MemoryError } from '../../lib/errors/memory-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import type { MemoryAdminServiceInterface } from './memory.service.js';
import type { MemoryClientService } from './memory-client.service.js';
import type { MemoryConclusion, MemorySession, PaginationOptions, SearchResult } from './types.js';

const log = createLogger('MemoryAdmin');

export class MemoryAdminService implements MemoryAdminServiceInterface {
  constructor(private client: MemoryClientService) {}

  async getConclusions(
    codespaceId: string,
    options?: PaginationOptions
  ): Promise<Result<MemoryConclusion[], MemoryError>> {
    const csClient = this.client.getCodespaceClient(codespaceId);
    const peerResult = await this.client.ensurePeer(csClient, 'agent-default');
    if (!peerResult.ok) return peerResult;

    log.debug('Listing conclusions', { data: { codespaceId, options } });
    return this.client.listConclusions(peerResult.value, options);
  }

  async createConclusion(
    codespaceId: string,
    content: string
  ): Promise<Result<MemoryConclusion, MemoryError>> {
    const csClient = this.client.getCodespaceClient(codespaceId);
    const peerResult = await this.client.ensurePeer(csClient, 'agent-default');
    if (!peerResult.ok) return peerResult;

    log.info('Creating conclusion', { data: { codespaceId, contentLength: content.length } });
    return this.client.createConclusion(peerResult.value, content);
  }

  async deleteConclusion(
    codespaceId: string,
    conclusionId: string
  ): Promise<Result<void, MemoryError>> {
    const csClient = this.client.getCodespaceClient(codespaceId);
    const peerResult = await this.client.ensurePeer(csClient, 'agent-default');
    if (!peerResult.ok) return peerResult;

    log.info('Deleting conclusion', { data: { codespaceId, conclusionId } });
    return this.client.deleteConclusion(peerResult.value, conclusionId);
  }

  async getSessions(
    codespaceId: string,
    _options?: PaginationOptions
  ): Promise<Result<MemorySession[], MemoryError>> {
    const csClient = this.client.getCodespaceClient(codespaceId);

    log.debug('Listing sessions', { data: { codespaceId } });
    const result = await this.client.listSessions(csClient);
    if (!result.ok) return result;

    // Map Honcho Session to MemorySession
    const sessions: MemorySession[] = result.value.map((s) => ({
      id: s.id,
      metadata: (s.metadata as Record<string, unknown>) ?? {},
    }));

    return { ok: true, value: sessions };
  }

  async search(
    codespaceId: string,
    query: string,
    options?: { limit?: number }
  ): Promise<Result<SearchResult[], MemoryError>> {
    const csClient = this.client.getCodespaceClient(codespaceId);
    const peerResult = await this.client.ensurePeer(csClient, 'agent-default');
    if (!peerResult.ok) return peerResult;

    log.debug('Searching conclusions', { data: { codespaceId, query, limit: options?.limit } });
    const result = await this.client.queryConclusions(peerResult.value, query, options?.limit);
    if (!result.ok) return result;

    // Map MemoryConclusion to SearchResult
    const searchResults: SearchResult[] = result.value.map((c) => ({
      id: c.id,
      content: c.content,
      type: 'conclusion' as const,
      observerId: c.observerId,
      observedId: c.observedId,
      sessionId: c.sessionId,
      createdAt: c.createdAt,
    }));

    return { ok: true, value: searchResults };
  }
}
