/**
 * RBAC Token Service
 *
 * Encapsulates API token operations:
 * - Token generation, hashing, validation
 * - CRUD operations (create, list, get, revoke)
 * - Token resolution from raw value
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import type { ApiTokenStatus, RbacRole } from '../db/schema/shared/enums';
import { apiTokens } from '../db/schema/sqlite/api-tokens';
import { tags } from '../db/schema/sqlite/tags';
import { createLogger } from '../lib/logging/logger';
import type { Database } from '../types/database';

const log = createLogger('RbacTokenService');

/** Token format: ap_ + 32 bytes base64url */
const TOKEN_PREFIX = 'ap_';
const TOKEN_FORMAT = /^ap_[A-Za-z0-9_-]{42,44}$/;
const DISPLAY_PREFIX_LENGTH = 12;
const MAX_TOKENS_PER_USER = 25;

export interface CreateTokenParams {
  userId: string;
  teamId: string;
  name: string;
  role: RbacRole;
  scopeTags?: string[] | null;
  scopeProjectId?: string | null;
  expiresInDays?: number;
}

export interface CreateTokenResult {
  id: string;
  name: string;
  tokenPrefix: string;
  role: RbacRole;
  teamId: string;
  scopeTags: string[] | null;
  scopeProjectId: string | null;
  token: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface TokenListItem {
  id: string;
  name: string;
  tokenPrefix: string;
  role: RbacRole;
  scopeTags: string[] | null;
  scopeProjectId: string | null;
  status: ApiTokenStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  useCount: number | null;
  createdAt: string;
  teamName: string | null;
}

export interface ResolvedToken {
  id: string;
  userId: string;
  teamId: string;
  role: RbacRole;
  scopeProjectId: string | null;
  scopeTags: string[] | null;
  status: ApiTokenStatus;
  expiresAt: string | null;
}

export class RbacTokenService {
  constructor(private db: Database) {}

  /** Generate a new raw token string */
  generateToken(): string {
    return TOKEN_PREFIX + randomBytes(32).toString('base64url');
  }

  /** Hash a raw token for storage */
  hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /** Validate raw token format */
  isValidFormat(raw: string): boolean {
    return TOKEN_FORMAT.test(raw);
  }

  /** Get display prefix for a token */
  getPrefix(raw: string): string {
    return raw.substring(0, DISPLAY_PREFIX_LENGTH);
  }

  /**
   * Create a new API token (within a transaction).
   * Returns the created token with raw value, or error code.
   */
  async create(
    params: CreateTokenParams
  ): Promise<{ ok: true; data: CreateTokenResult } | { ok: false; error: string; message: string }> {
    try {
      const result = await this.db.transaction(async (tx) => {
        // Check name uniqueness
        const existing = await tx
          .select({ id: apiTokens.id })
          .from(apiTokens)
          .where(
            and(
              eq(apiTokens.userId, params.userId),
              eq(apiTokens.name, params.name),
              ne(apiTokens.status, 'revoked')
            )
          );

        if (existing.length > 0) {
          return { error: 'TOKEN_NAME_EXISTS' as const, message: 'A non-revoked token with this name already exists' };
        }

        // Check limit
        const [countResult] = await tx
          .select({ total: count() })
          .from(apiTokens)
          .where(and(eq(apiTokens.userId, params.userId), ne(apiTokens.status, 'revoked')));

        if ((countResult?.total ?? 0) >= MAX_TOKENS_PER_USER) {
          return { error: 'LIMIT_EXCEEDED' as const, message: `Max ${MAX_TOKENS_PER_USER} active tokens` };
        }

        const rawToken = this.generateToken();
        const tokenHash = this.hashToken(rawToken);
        const tokenPrefix = this.getPrefix(rawToken);

        const expiresAt = params.expiresInDays
          ? new Date(Date.now() + params.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
          : null;

        const [created] = await tx
          .insert(apiTokens)
          .values({
            userId: params.userId,
            teamId: params.teamId,
            name: params.name,
            tokenHash,
            tokenPrefix,
            role: params.role,
            scopeTags: params.scopeTags ?? null,
            scopeProjectId: params.scopeProjectId ?? null,
            expiresAt,
          })
          .returning();

        if (!created) {
          return { error: 'DB_ERROR' as const, message: 'Failed to create token' };
        }

        return {
          created: {
            id: created.id,
            name: created.name,
            tokenPrefix,
            role: created.role as RbacRole,
            teamId: created.teamId,
            scopeTags: created.scopeTags as string[] | null,
            scopeProjectId: created.scopeProjectId,
            token: rawToken,
            expiresAt: created.expiresAt,
            createdAt: created.createdAt,
          },
        };
      });

      if ('error' in result) {
        return { ok: false, error: result.error as string, message: result.message as string };
      }

      return { ok: true, data: result.created };
    } catch (error) {
      log.error('Failed to create token', { error });
      return { ok: false, error: 'DB_ERROR', message: 'Failed to create token' };
    }
  }

  /**
   * Resolve a raw token to its stored record.
   * Returns null if not found, not active, or on DB error.
   */
  async resolveToken(rawToken: string): Promise<ResolvedToken | null> {
    if (!this.isValidFormat(rawToken)) return null;

    try {
      const tokenHash = this.hashToken(rawToken);
      const record = await this.db.query.apiTokens.findFirst({
        where: and(eq(apiTokens.tokenHash, tokenHash), eq(apiTokens.status, 'active')),
      });

      if (!record) return null;
      if (record.expiresAt && new Date(record.expiresAt) < new Date()) return null;

      return {
        id: record.id,
        userId: record.userId,
        teamId: record.teamId,
        role: record.role as RbacRole,
        scopeProjectId: record.scopeProjectId,
        scopeTags: record.scopeTags as string[] | null,
        status: record.status as ApiTokenStatus,
        expiresAt: record.expiresAt,
      };
    } catch (error) {
      log.error('Failed to resolve token', { error });
      return null;
    }
  }

  /**
   * Revoke a token.
   * Note: re-revoking an already-revoked token overwrites `revokedAt`.
   * Use the route handler's status check if you need to detect duplicates.
   */
  async revoke(
    tokenId: string,
    userId: string
  ): Promise<{ ok: true } | { ok: false; error: string; message: string; status: number }> {
    try {
      const [revoked] = await this.db
        .update(apiTokens)
        .set({ status: 'revoked', revokedAt: new Date().toISOString() })
        .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
        .returning();

      if (!revoked) {
        return { ok: false, error: 'TOKEN_NOT_FOUND', message: 'Token not found', status: 404 };
      }

      return { ok: true };
    } catch (error) {
      log.error('Failed to revoke token', { error });
      return { ok: false, error: 'DB_ERROR', message: 'Failed to revoke token', status: 500 };
    }
  }

  /**
   * Enrich token scope tags with full tag details.
   */
  async enrichScopeTags(scopeTags: string[] | null): Promise<Array<{ id: string; name: string; color: string | null }>> {
    if (!scopeTags || scopeTags.length === 0) return [];

    const tagRecords = await this.db
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(tags)
      .where(
        scopeTags.length === 1
          // biome-ignore lint/style/noNonNullAssertion: length checked above
          ? eq(tags.id, scopeTags[0]!)
          : inArray(tags.id, scopeTags)
      );

    return tagRecords;
  }
}
