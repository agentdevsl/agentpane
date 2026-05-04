/**
 * RBAC API token routes
 */

import { randomBytes } from 'node:crypto';
import { and, count, eq, gt, inArray, isNotNull, lte, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { getRuntimeSchemaTables } from '../../db/schema/runtime-tables.js';
import { RBAC_ROLE_LEVEL, type RbacRole } from '../../db/schema/shared/enums';
import type { AuthContext } from '../../lib/api/auth-middleware';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { hashToken, isValidId, json, parsePagination, validateIdParam } from '../shared';
import { createApiTokenSchema, parseJsonBody } from '../validation';

const { apiTokens, codespaces, tags, teamProjectFolders, teams } = getRuntimeSchemaTables();

interface TokensDeps {
  db: Database;
  rbacService: RbacService;
}

function generateToken(): string {
  return `ap_${randomBytes(32).toString('base64url')}`;
}

const MAX_TOKENS_PER_USER = 25;

export function createRbacTokensRoutes({ db, rbacService }: TokensDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // Shared select columns for token list queries (includes teamName via left join)
  const tokenListSelect = {
    id: apiTokens.id,
    name: apiTokens.name,
    tokenPrefix: apiTokens.tokenPrefix,
    role: apiTokens.role,
    scopeTags: apiTokens.scopeTags,
    scopeCodespaceId: apiTokens.scopeCodespaceId,
    status: apiTokens.status,
    expiresAt: apiTokens.expiresAt,
    lastUsedAt: apiTokens.lastUsedAt,
    useCount: apiTokens.useCount,
    createdAt: apiTokens.createdAt,
    teamName: teams.name,
  } as const;

  // POST /api/tokens - Create token
  app.post('/', async (c) => {
    const auth = c.get('auth');

    const parsed = await parseJsonBody(c, createApiTokenSchema);
    if (!parsed.ok) return parsed.response;

    // Validate team membership and role ceiling
    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveTeamRole(auth.userId, parsed.data.teamId);
      if (!role) {
        return json(
          { ok: false, error: { code: 'FORBIDDEN', message: 'Not a member of this team' } },
          403
        );
      }
      // Token role cannot exceed user's team role
      if (RBAC_ROLE_LEVEL[parsed.data.role as RbacRole] > RBAC_ROLE_LEVEL[role]) {
        return json(
          {
            ok: false,
            error: { code: 'FORBIDDEN', message: 'Token role cannot exceed your team role' },
          },
          403
        );
      }
    }

    // Validate scopeCodespaceId belongs to the team (via project folder)
    if (parsed.data.scopeCodespaceId) {
      // Look up the codespace's project folder, then check if the folder belongs to the team
      const codespace = await db
        .select({ projectFolderId: codespaces.projectFolderId })
        .from(codespaces)
        .where(eq(codespaces.id, parsed.data.scopeCodespaceId));

      if (codespace.length === 0 || !codespace[0]?.projectFolderId) {
        return json(
          {
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: 'Codespace not found' },
          },
          400
        );
      }

      const teamFolder = await db
        .select({ teamId: teamProjectFolders.teamId })
        .from(teamProjectFolders)
        .where(
          and(
            eq(teamProjectFolders.teamId, parsed.data.teamId),
            eq(teamProjectFolders.projectFolderId, codespace[0].projectFolderId)
          )
        );

      if (teamFolder.length === 0) {
        return json(
          {
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: 'Codespace not found in this team' },
          },
          400
        );
      }
    }

    // E3: Validate scopeTags exist and belong to the specified team (via project folders)
    if (parsed.data.scopeTags && parsed.data.scopeTags.length > 0) {
      const foundTags = await db
        .select({ id: tags.id, projectFolderId: tags.projectFolderId })
        .from(tags)
        .where(inArray(tags.id, parsed.data.scopeTags));

      const foundTagIds = new Set(foundTags.map((t) => t.id));
      const missingTagIds = parsed.data.scopeTags.filter((id: string) => !foundTagIds.has(id));

      if (missingTagIds.length > 0) {
        return json(
          {
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: `Tag(s) not found: ${missingTagIds.join(', ')}`,
            },
          },
          400
        );
      }

      // Verify tags belong to folders owned by the specified team
      const teamFolders = await db
        .select({ projectFolderId: teamProjectFolders.projectFolderId })
        .from(teamProjectFolders)
        .where(eq(teamProjectFolders.teamId, parsed.data.teamId));
      const teamFolderIds = new Set(teamFolders.map((f) => f.projectFolderId));
      const wrongTeamTags = foundTags.filter((t) => !teamFolderIds.has(t.projectFolderId));
      if (wrongTeamTags.length > 0) {
        return json(
          {
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: `Tag(s) do not belong to this team: ${wrongTeamTags.map((t) => t.id).join(', ')}`,
            },
          },
          400
        );
      }
    }

    // Wrap all checks + insert in a transaction to prevent TOCTOU races
    const result = await db.transaction(async (tx) => {
      // Check token name uniqueness per user (non-revoked tokens only)
      const existingWithName = await tx
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.userId, auth.userId),
            eq(apiTokens.name, parsed.data.name),
            ne(apiTokens.status, 'revoked')
          )
        );

      if (existingWithName.length > 0) {
        return { error: 'TOKEN_NAME_EXISTS' as const };
      }

      // Check token limit
      const [countResult] = await tx
        .select({ total: count() })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, auth.userId), ne(apiTokens.status, 'revoked')));

      if ((countResult?.total ?? 0) >= MAX_TOKENS_PER_USER) {
        return { error: 'LIMIT_EXCEEDED' as const };
      }

      const rawToken = generateToken();
      const tokenHash = hashToken(rawToken);
      const tokenPrefix = rawToken.substring(0, 12);

      const expiresAt = parsed.data.expiresInDays
        ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

      const [created] = await tx
        .insert(apiTokens)
        .values({
          userId: auth.userId,
          teamId: parsed.data.teamId,
          name: parsed.data.name,
          tokenHash,
          tokenPrefix,
          role: parsed.data.role,
          scopeTags: parsed.data.scopeTags ?? null,
          scopeCodespaceId: parsed.data.scopeCodespaceId ?? null,
          expiresAt,
        })
        .returning();

      if (!created) {
        return { error: 'DB_ERROR' as const };
      }

      return { created, rawToken, tokenPrefix };
    });

    if ('error' in result) {
      if (result.error === 'TOKEN_NAME_EXISTS') {
        return json(
          {
            ok: false,
            error: {
              code: 'TOKEN_NAME_EXISTS',
              message: 'A non-revoked token with this name already exists',
            },
          },
          409
        );
      }
      if (result.error === 'LIMIT_EXCEEDED') {
        return json(
          {
            ok: false,
            error: {
              code: 'LIMIT_EXCEEDED',
              message: `Max ${MAX_TOKENS_PER_USER} active tokens`,
            },
          },
          400
        );
      }
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create token' } },
        500
      );
    }

    const { created, rawToken, tokenPrefix } = result;

    // E2: Include teamId, scopeTags, scopeCodespaceId in creation response
    // M2: Return 201 for resource creation
    return json(
      {
        ok: true,
        data: {
          id: created.id,
          name: created.name,
          tokenPrefix,
          role: created.role,
          teamId: created.teamId,
          scopeTags: created.scopeTags,
          scopeCodespaceId: created.scopeCodespaceId,
          // Return raw token ONCE - never retrievable again
          token: rawToken,
          expiresAt: created.expiresAt,
          createdAt: created.createdAt,
        },
      },
      201
    );
  });

  // GET /api/tokens - List user's tokens
  app.get('/', async (c) => {
    const auth = c.get('auth');
    const statusParam = c.req.query('status');
    if (statusParam && statusParam !== 'all') {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid status filter. Use "all" to include revoked tokens',
          },
        },
        400
      );
    }
    const showAll = statusParam === 'all';
    const teamId = c.req.query('teamId');
    const allTeam = c.req.query('allTeam') === 'true';
    const { cursor, limit } = parsePagination(c);

    if (teamId && !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    // E6: Admin team-wide token listing
    if (allTeam && teamId) {
      if (auth.authMethod !== 'dev') {
        const role = await rbacService.resolveTeamRole(auth.userId, teamId);
        if (!role || !rbacService.hasMinimumRole(role, 'admin')) {
          return json(
            {
              ok: false,
              error: {
                code: 'FORBIDDEN',
                message: 'Only team admins and owners can list all team tokens',
              },
            },
            403
          );
        }
      }

      // List all tokens for the team (not just current user's)
      const teamBaseWhere = showAll
        ? eq(apiTokens.teamId, teamId)
        : and(eq(apiTokens.teamId, teamId), eq(apiTokens.status, 'active'));

      // G2: Total count for pagination
      const [teamCountResult] = await db
        .select({ total: count() })
        .from(apiTokens)
        .where(teamBaseWhere);
      const teamTotalCount = teamCountResult?.total ?? 0;

      // G2: Apply cursor filter
      const teamWhereClause = cursor ? and(teamBaseWhere, gt(apiTokens.id, cursor)) : teamBaseWhere;

      // E5: Include teamName via left join
      const teamTokens = await db
        .select(tokenListSelect)
        .from(apiTokens)
        .leftJoin(teams, eq(apiTokens.teamId, teams.id))
        .where(teamWhereClause)
        .orderBy(apiTokens.id)
        .limit(limit + 1);

      const teamHasMore = teamTokens.length > limit;
      const teamItems = teamHasMore ? teamTokens.slice(0, limit) : teamTokens;
      const teamNextCursor = teamHasMore ? (teamItems[teamItems.length - 1]?.id ?? null) : null;

      return json({
        ok: true,
        data: {
          items: teamItems,
          nextCursor: teamNextCursor,
          hasMore: teamHasMore,
          totalCount: teamTotalCount,
        },
      });
    }

    // Standard user-scoped listing
    let baseWhere = showAll
      ? eq(apiTokens.userId, auth.userId)
      : and(eq(apiTokens.userId, auth.userId), eq(apiTokens.status, 'active'));

    if (teamId) {
      baseWhere = and(baseWhere, eq(apiTokens.teamId, teamId));
    }

    // G2: Total count for pagination
    const [countResult] = await db.select({ total: count() }).from(apiTokens).where(baseWhere);
    const totalCount = countResult?.total ?? 0;

    // G2: Apply cursor filter
    const whereClause = cursor ? and(baseWhere, gt(apiTokens.id, cursor)) : baseWhere;

    // E5: Include teamName via left join
    const tokens = await db
      .select(tokenListSelect)
      .from(apiTokens)
      .leftJoin(teams, eq(apiTokens.teamId, teams.id))
      .where(whereClause)
      .orderBy(apiTokens.id)
      .limit(limit + 1);

    const hasMore = tokens.length > limit;
    const items = hasMore ? tokens.slice(0, limit) : tokens;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return json({
      ok: true,
      data: { items, nextCursor, hasMore, totalCount },
    });
  });

  // GET /api/tokens/rotation-due - List tokens expiring soon (F06-09)
  //
  // Registered BEFORE `/:id` so Hono matches the literal path instead of
  // interpreting `rotation-due` as an :id param. Returns tokens owned by
  // the caller whose `expires_at` is in the next N days (default 30).
  // Admins can pass `?teamId=...` to see all tokens in a team they manage.
  app.get('/rotation-due', async (c) => {
    const auth = c.get('auth');
    const daysParam = c.req.query('days');
    const days = daysParam ? Math.max(1, Math.min(365, Number.parseInt(daysParam, 10))) : 30;
    if (Number.isNaN(days)) {
      return json(
        { ok: false, error: { code: 'VALIDATION_ERROR', message: '`days` must be a number' } },
        400
      );
    }
    const teamId = c.req.query('teamId');

    const windowEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    // Admin-team mode: list every token in a team the caller admins.
    if (teamId) {
      if (auth.authMethod !== 'dev') {
        const role = await rbacService.resolveTeamRole(auth.userId, teamId);
        if (!role || !rbacService.hasMinimumRole(role, 'admin')) {
          return json(
            {
              ok: false,
              error: {
                code: 'FORBIDDEN',
                message: 'Only team admins and owners can list team rotation-due tokens',
              },
            },
            403
          );
        }
      }

      const rows = await db
        .select(tokenListSelect)
        .from(apiTokens)
        .leftJoin(teams, eq(apiTokens.teamId, teams.id))
        .where(
          and(
            eq(apiTokens.teamId, teamId),
            ne(apiTokens.status, 'revoked'),
            isNotNull(apiTokens.expiresAt),
            lte(apiTokens.expiresAt, windowEnd)
          )
        )
        .orderBy(apiTokens.expiresAt);
      return json({ ok: true, data: { items: rows, windowDays: days } });
    }

    // User-scoped: only the caller's own tokens.
    const rows = await db
      .select(tokenListSelect)
      .from(apiTokens)
      .leftJoin(teams, eq(apiTokens.teamId, teams.id))
      .where(
        and(
          eq(apiTokens.userId, auth.userId),
          ne(apiTokens.status, 'revoked'),
          isNotNull(apiTokens.expiresAt),
          lte(apiTokens.expiresAt, windowEnd)
        )
      )
      .orderBy(apiTokens.expiresAt);
    return json({ ok: true, data: { items: rows, windowDays: days } });
  });

  // GET /api/tokens/:id - Get token details
  app.get('/:id', async (c) => {
    const { id, error: idError } = validateIdParam(c, 'id');
    if (idError) return idError;
    const auth = c.get('auth');

    // E5: Include teamName via left join
    // F5: Include scopeCodespaceName via left join with codespaces
    const token = await db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        tokenPrefix: apiTokens.tokenPrefix,
        role: apiTokens.role,
        scopeTags: apiTokens.scopeTags,
        scopeCodespaceId: apiTokens.scopeCodespaceId,
        status: apiTokens.status,
        expiresAt: apiTokens.expiresAt,
        lastUsedAt: apiTokens.lastUsedAt,
        createdAt: apiTokens.createdAt,
        teamName: teams.name,
        scopeCodespaceName: codespaces.name,
      })
      .from(apiTokens)
      .leftJoin(teams, eq(apiTokens.teamId, teams.id))
      .leftJoin(codespaces, eq(apiTokens.scopeCodespaceId, codespaces.id))
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, auth.userId)));

    const tokenData = token[0];
    if (!tokenData) {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Token not found' } }, 404);
    }

    // F5: Enrich scopeTags with tag details (name, color)
    let enrichedScopeTags: Array<{ id: string; name: string; color: string }> | null = null;
    if (
      tokenData.scopeTags &&
      Array.isArray(tokenData.scopeTags) &&
      tokenData.scopeTags.length > 0
    ) {
      const tagRows = await db
        .select({ id: tags.id, name: tags.name, color: tags.color })
        .from(tags)
        .where(inArray(tags.id, tokenData.scopeTags as string[]));
      enrichedScopeTags = tagRows;
    }

    return json({
      ok: true,
      data: {
        ...tokenData,
        ...(enrichedScopeTags !== null && { scopeTags: enrichedScopeTags }),
      },
    });
  });

  // DELETE /api/tokens/:id - Revoke token
  app.delete('/:id', async (c) => {
    const { id, error: idError } = validateIdParam(c, 'id');
    if (idError) return idError;
    const auth = c.get('auth');

    // Atomic revoke: only update non-revoked tokens to avoid TOCTOU race
    const result = await db
      .update(apiTokens)
      .set({ status: 'revoked', revokedAt: new Date().toISOString() })
      .where(
        and(
          eq(apiTokens.id, id),
          eq(apiTokens.userId, auth.userId),
          ne(apiTokens.status, 'revoked')
        )
      )
      .returning({ id: apiTokens.id });

    if (result.length > 0) {
      return json({ ok: true, data: { revoked: true } });
    }

    // UPDATE matched nothing — distinguish not-found from already-revoked
    const existing = await db
      .select({ status: apiTokens.status })
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, auth.userId)));

    if (existing.length === 0) {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Token not found' } }, 404);
    }

    return json(
      { ok: false, error: { code: 'ALREADY_REVOKED', message: 'Token is already revoked' } },
      409
    );
  });

  return app;
}
