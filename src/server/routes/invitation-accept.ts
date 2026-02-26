/**
 * Invitation accept route (separate from team-scoped routes)
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { teamInvitations } from '../../db/schema/sqlite/team-invitations';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import type { AuthContext } from '../../lib/api/auth-middleware';
import type { Database } from '../../types/database';
import { json } from '../shared';

interface InvitationAcceptDeps {
  db: Database;
}

export function createInvitationAcceptRoutes({ db }: InvitationAcceptDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/invitations/:token/accept
  app.post('/:token/accept', async (c) => {
    const token = c.req.param('token');
    const auth = c.get('auth');

    try {
      const invitation = await db
        .select()
        .from(teamInvitations)
        .where(and(eq(teamInvitations.token, token), eq(teamInvitations.status, 'pending')));

      if (invitation.length === 0) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Invalid or expired invitation' } },
          404
        );
      }

      const inv = invitation[0];
      if (!inv) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Invalid or expired invitation' } },
          404
        );
      }

      // Check expiry
      if (new Date(inv.expiresAt) < new Date()) {
        await db
          .update(teamInvitations)
          .set({ status: 'expired' })
          .where(eq(teamInvitations.id, inv.id));
        return json(
          { ok: false, error: { code: 'EXPIRED', message: 'Invitation has expired' } },
          410
        );
      }

      // Add user to team
      await db
        .insert(teamMembers)
        .values({
          teamId: inv.teamId,
          userId: auth.userId,
          role: inv.role,
        })
        .onConflictDoNothing();

      // Mark invitation as accepted
      await db
        .update(teamInvitations)
        .set({ status: 'accepted' })
        .where(eq(teamInvitations.id, inv.id));

      return json({ ok: true, data: { teamId: inv.teamId, role: inv.role } });
    } catch (error) {
      console.error('[InvitationAccept] Error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to accept invitation' } },
        500
      );
    }
  });

  return app;
}
