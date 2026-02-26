/**
 * Invitation accept route (separate from team-scoped routes)
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { teamInvitations } from '../../db/schema/sqlite/team-invitations';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { Database } from '../../types/database';
import { json } from '../shared';

const log = createLogger('InvitationAcceptRoutes');

interface InvitationAcceptDeps {
  db: Database;
}

export function createInvitationAcceptRoutes({ db }: InvitationAcceptDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/invitations/:token/accept
  app.post('/:token/accept', async (c) => {
    const token = c.req.param('token');
    const auth = c.get('auth');

    // Validate token format
    if (!token || token.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(token)) {
      return json(
        { ok: false, error: { code: 'INVALID_TOKEN', message: 'Invalid token format' } },
        400
      );
    }

    try {
      // Atomically claim the invitation (prevents TOCTOU race)
      const [claimed] = await db
        .update(teamInvitations)
        .set({ status: 'accepted' })
        .where(and(eq(teamInvitations.token, token), eq(teamInvitations.status, 'pending')))
        .returning();

      if (!claimed) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Invalid or expired invitation' } },
          404
        );
      }

      // Check expiry
      if (new Date(claimed.expiresAt) < new Date()) {
        await db
          .update(teamInvitations)
          .set({ status: 'expired' })
          .where(eq(teamInvitations.id, claimed.id));
        return json(
          { ok: false, error: { code: 'EXPIRED', message: 'Invitation has expired' } },
          410
        );
      }

      // Check if already a team member
      const existing = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, claimed.teamId), eq(teamMembers.userId, auth.userId)));

      if (existing.length > 0) {
        return json({
          ok: true,
          data: { teamId: claimed.teamId, role: existing[0]?.role, alreadyMember: true },
        });
      }

      // Add user to team
      await db.insert(teamMembers).values({
        teamId: claimed.teamId,
        userId: auth.userId,
        role: claimed.role,
      });

      return json({ ok: true, data: { teamId: claimed.teamId, role: claimed.role } });
    } catch (error) {
      log.error('Failed to accept invitation', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to accept invitation' } },
        500
      );
    }
  });

  return app;
}
