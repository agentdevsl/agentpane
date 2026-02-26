/**
 * RBAC API token routes
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { RBAC_ROLE_LEVEL, type RbacRole } from '../../db/schema/shared/enums';
import { apiTokens } from '../../db/schema/sqlite/api-tokens';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json } from '../shared';
import { createApiTokenSchema, parseBody } from '../validation';

const log = createLogger('RbacTokensRoutes');

interface TokensDeps {
  db: Database;
  rbacService: RbacService;
}

function generateToken(): string {
  return `ap_${randomBytes(32).toString('base64url')}`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createRbacTokensRoutes({ db, rbacService }: TokensDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/tokens - Create token
  app.post('/', async (c) => {
    const auth = c.get('auth');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400);
    }

    const parsed = parseBody(createApiTokenSchema, body);
    if (!parsed.ok) return parsed.response;

    // Validate team membership and role ceiling
    if (parsed.data.teamId && auth.authMethod !== 'dev') {
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

    try {
      // Check token limit (max 25)
      const existingTokens = await db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, auth.userId), eq(apiTokens.status, 'active')));

      if (existingTokens.length >= 25) {
        return json(
          { ok: false, error: { code: 'LIMIT_EXCEEDED', message: 'Max 25 active tokens' } },
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

      return json({
        ok: true,
        data: {
          id: created.id,
          name: created.name,
          tokenPrefix,
          role: created.role,
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

    try {
      const tokens = await db
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
        })
        .from(apiTokens)
        .where(eq(apiTokens.userId, auth.userId));

      return json({ ok: true, data: { items: tokens } });
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
        })
        .from(apiTokens)
        .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, auth.userId)));

      if (token.length === 0) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Token not found' } }, 404);
      }

      return json({ ok: true, data: token[0] });
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
      const result = await db
        .update(apiTokens)
        .set({ status: 'revoked' })
        .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, auth.userId)))
        .returning();

      if (result.length === 0) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Token not found' } }, 404);
      }

      return json({ ok: true, data: { revoked: true } });
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
