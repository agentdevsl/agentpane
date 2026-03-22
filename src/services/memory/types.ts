import type { Conclusion as HonchoConclusion } from '@honcho-ai/sdk';

/**
 * Opaque reference to a Honcho session, used to track message capture context.
 */
export interface HonchoSessionRef {
  workspaceId: string;
  sessionId: string;
  agentPeerId: string;
  userPeerId: string;
}

/**
 * Assembled memory context for agent prompt injection.
 */
export interface MemoryContext {
  /** Assembled text block to append to agent prompt. */
  text: string;
  /** Approximate token count of the assembled context. */
  tokenCount: number;
  /** Breakdown of what was included. */
  sources: {
    conclusions: number;
    platformConclusions: number;
  };
}

/**
 * A conclusion derived by Honcho or created manually.
 */
export interface MemoryConclusion {
  id: string;
  content: string;
  observerId: string;
  observedId: string;
  sessionId: string | null;
  createdAt: string;
}

/**
 * Convert a Honcho SDK Conclusion to our domain type.
 */
export function toMemoryConclusion(c: HonchoConclusion): MemoryConclusion {
  return {
    id: c.id,
    content: c.content,
    observerId: c.observerId,
    observedId: c.observedId,
    sessionId: c.sessionId,
    createdAt: c.createdAt,
  };
}

/**
 * A Honcho session as exposed through the admin API.
 */
export interface MemorySession {
  id: string;
  metadata: Record<string, unknown>;
  createdAt?: string;
}

/**
 * Search result from semantic query.
 */
export interface SearchResult {
  id: string;
  content: string;
  score?: number;
  type: 'conclusion';
  observerId: string;
  observedId: string;
  sessionId: string | null;
  createdAt: string;
}

/**
 * Memory service health status.
 */
export interface HealthStatus {
  available: boolean;
  version: string | null;
  latencyMs: number;
  workspaceCount: number;
}

/**
 * Pagination options for list endpoints.
 */
export interface PaginationOptions {
  page?: number;
  size?: number;
}

/**
 * Empty memory context returned when memory is unavailable.
 */
export const EMPTY_CONTEXT: MemoryContext = {
  text: '',
  tokenCount: 0,
  sources: { conclusions: 0, platformConclusions: 0 },
};
