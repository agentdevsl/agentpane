/**
 * RBAC API token routes
 */

import { randomBytes } from 'node:crypto';
import { and, count, eq, gt, inArray, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { RBAC_ROLE_LEVEL, type RbacRole } from '../../db/schema/shared/enums';
import { apiTokens } from '../../db/schema/sqlite/api-tokens';
import { projects } from '../../db/schema/sqlite/projects';
import { tags } from '../../db/schema/sqlite/tags';
import { teamProjects } from '../../db/schema/sqlite/team-projects';
import { teams } from '../../db/schema/sqlite/teams';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { hashToken, isValidId, json, parsePagination } from '../shared';
import { createApiTokenSchema, parseJsonBody } from '../validation';

const log = createLogger('RbacTokensRoutes');

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

  // Shared select columns for token list queries (E5: includes teamName via left join)
  const tokenListSelect = {
    id: apiTokens.id,
    name: apiTokens.name,
    tokenPrefix: apiTokens.tokenPrefix,
    role: apiTokens.role,
    scopeTags: apiTokens.scopeTags,
    scopeProjectId: apiTokens.scopeProjectId,
    status: apiTokens.status,
    expiresAt: apiTokens.expiresAt,
    lastUsedAt: apiTokens.lastUsedAt,
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

    // Validate scopeProjectId belongs to the team
    if (parsed.data.scopeProjectId) {
      const teamProject = await db
        .select({ teamId: teamProjects.teamId })
        .from(teamProjects)
        .where(
          and(
            eq(teamProjects.teamId, parsed.data.teamId),
            eq(teamProjects.projectId, parsed.data.scopeProjectId)
          )
        );

      if (teamProject.length === 0) {
        return json(
          {
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: 'Project not found in this team' },
          },
          400
        );
      }
    }

    // E3: Validate scopeTags exist and belong to the specified team
    if (parsed.data.scopeTags && parsed.data.scopeTags.length > 0) {
      const foundTags = await db
        .select({ id: tags.id, teamId: tags.teamId })
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

      const wrongTeamTags = foundTags.filter((t) => t.teamId !== parsed.data.teamId);
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

    try {
      // E4 + limit check: Single query to fetch all non-revoked tokens for name uniqueness and count limit
      const existingTokens = await db
        .select({ id: apiTokens.id, name: apiTokens.name })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, auth.userId), ne(apiTokens.status, 'revoked')));

      if (existingTokens.some((t) => t.name === parsed.data.name)) {
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

      if (existingTokens.length >= MAX_TOKENS_PER_USER) {
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

      const rawToken = generateToken();
      const tokenHash = hashToken(rawToken);
      const tokenPrefix = rawToken.substring(0, 12);

      const expiresAt = parsed.data.expiresInDays
        ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

      const [created] = await db
        .insert(apiTokens)
        .values({
          userId: auth.userId,
          teamId: parsed.data.teamId,
          name: parsed.data.name,
          tokenHash,
          tokenPrefix,
          role: parsed.data.role,
          scopeTags: parsed.data.scopeTags ?? null,
          scopeProjectId: parsed.data.scopeProjectId ?? null,
          expiresAt,
        })
        .returning();

      if (!created) {
        return json(
          { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create token' } },
          500
        );
      }

      // E2: Include teamId, scopeTags, scopeProjectId in creation response
      return json({
        ok: true,
        data: {
          id: created.id,
          name: created.name,
          tokenPrefix,
          role: created.role,
          teamId: created.teamId,
          scopeTags: created.scopeTags,
          scopeProjectId: created.scopeProjectId,
          // Return raw token ONCE - never retrievable again
          token: rawToken,
          expiresAt: created.expiresAt,
          createdAt: created.createdAt,
        },
      });
    } catch (error) {
      log.error('Failed to create token', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create token' } },
        500
      );
    }
  });

  // GET /api/tokens - List user's tokens
  app.get('/', async (c) => {
    const auth = c.get('auth');
    const showAll = c.req.query('status') === 'all';
    const teamId = c.req.query('teamId');
    const allTeam = c.req.query('allTeam') === 'true';
    const { cursor, limit } = parsePagination(c);

    if (teamId && !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    try {
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
        const teamWhereClause = cursor
          ? and(teamBaseWhere, gt(apiTokens.id, cursor))
          : teamBaseWhere;

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
        const teamNextCursor = teamHasMore ? teamItems[teamItems.length - 1]?.id : undefined;

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
      const nextCursor = hasMore ? items[items.length - 1]?.id : undefined;

      return json({
        ok: true,
        data: { items, nextCursor, hasMore, totalCount },
      });
    } catch (error) {
      log.error('Failed to list tokens', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list tokens' } },
        500
      );
    }
  });

  // GET /api/tokens/:id - Get token details
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    try {
      // E5: Include teamName via left join
      // F5: Include scopeProjectName via left join with projects
      const token = await db
        .select({
          id: apiTokens.id,
          name: apiTokens.name,
          tokenPrefix: apiTokens.tokenPrefix,
          role: apiTokens.role,
          scopeTags: apiTokens.scopeTags,
          scopeProjectId: apiTokens.scopeProjectId,
          status: apiTokens.status,
          expiresAt: apiTokens.expiresAt,
          lastUsedAt: apiTokens.lastUsedAt,
          createdAt: apiTokens.createdAt,
          teamName: teams.name,
          scopeProjectName: projects.name,
        })
        .from(apiTokens)
        .leftJoin(teams, eq(apiTokens.teamId, teams.id))
        .leftJoin(projects, eq(apiTokens.scopeProjectId, projects.id))
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
    } catch (error) {
      log.error('Failed to get token', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to get token' } }, 500);
    }
  });

  // DELETE /api/tokens/:id - Revoke token
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    try {
      // E1: Single UPDATE with status guard - only revokes non-revoked tokens
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

      // UPDATE matched nothing - distinguish not-found from already-revoked
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
    } catch (error) {
      log.error('Failed to revoke token', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to revoke token' } },
        500
      );
    }
  });

  return app;
}
