/**
 * Current user profile routes
 */

import { and, eq, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import { teams } from '../../db/schema/sqlite/teams';
import { users } from '../../db/schema/sqlite/users';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { Database } from '../../types/database';
import { json } from '../shared';
import { parseJsonBody, updateProfileSchema } from '../validation';

const log = createLogger('MeRoutes');

interface MeDeps {
  db: Database;
}

export function createMeRoutes({ db }: MeDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /api/me - Get current user profile with teams
  app.get('/', async (c) => {
    const auth = c.get('auth');

    // Dev mode returns a synthetic profile
    if (auth.authMethod === 'dev') {
      return json({
        ok: true,
        data: {
          id: auth.userId,
          githubLogin: auth.userId,
          name: 'Development User',
          email: null,
          avatarUrl: null,
          authMethod: 'dev',
          teams: [],
        },
      });
    }

    try {
      const user = await db.query.users.findFirst({
        where: eq(users.id, auth.userId),
      });

      if (!user) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
      }

      // Get team memberships with team details
      const memberships = await db
        .select({
          teamId: teamMembers.teamId,
          role: teamMembers.role,
          joinedAt: teamMembers.joinedAt,
          teamName: teams.name,
          teamSlug: teams.slug,
        })
        .from(teamMembers)
        .leftJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(eq(teamMembers.userId, auth.userId));

      return json({
        ok: true,
        data: {
          id: user.id,
          githubId: user.githubId,
          githubLogin: user.githubLogin,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
          authMethod: auth.authMethod,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          teams: memberships.map((m) => ({
            teamId: m.teamId,
            role: m.role,
            joinedAt: m.joinedAt,
            name: m.teamName,
            slug: m.teamSlug,
          })),
        },
      });
    } catch (error) {
      log.error('Failed to get profile', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get profile' } },
        500
      );
    }
  });

  // PATCH /api/me - Update current user profile
  app.patch('/', async (c) => {
    const auth = c.get('auth');

    if (auth.authMethod === 'dev') {
      return json(
        { ok: false, error: { code: 'FORBIDDEN', message: 'Cannot update dev user profile' } },
        403
      );
    }

    const parsed = await parseJsonBody(c, updateProfileSchema);
    if (!parsed.ok) return parsed.response;

    try {
      // H9: Check email uniqueness before update
      if (parsed.data.email) {
        const existingEmail = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.email, parsed.data.email), ne(users.id, auth.userId)));
        if (existingEmail.length > 0) {
          return json(
            { ok: false, error: { code: 'EMAIL_ALREADY_EXISTS', message: 'Email already in use' } },
            409
          );
        }
      }

      const [updated] = await db
        .update(users)
        .set({ ...parsed.data, updatedAt: new Date().toISOString() })
        .where(eq(users.id, auth.userId))
        .returning();

      if (!updated) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
      }

      return json({
        ok: true,
        data: {
          id: updated.id,
          githubLogin: updated.githubLogin,
          name: updated.name,
          email: updated.email,
          avatarUrl: updated.avatarUrl,
        },
      });
    } catch (error) {
      log.error('Failed to update profile', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update profile' } },
        500
      );
    }
  });

  return app;
}
