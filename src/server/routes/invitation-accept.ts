/**
 * Invitation accept route (separate from team-scoped routes)
 */

import { and, eq, gt } from 'drizzle-orm';
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
      const result = await db.transaction(async (tx) => {
        // Atomically claim the invitation
        const [claimed] = await tx
          .update(teamInvitations)
          .set({ status: 'accepted' })
          .where(
            and(
              eq(teamInvitations.token, token),
              eq(teamInvitations.status, 'pending'),
              gt(teamInvitations.expiresAt, new Date().toISOString())
            )
          )
          .returning();

        if (!claimed) return { status: 'not_found' } as const;

        // Fail-closed email check: if invitation has a target email, verify it matches
        if (claimed.email) {
          if (!auth.user?.email) {
            // Cannot verify email — roll back within transaction
            await tx
              .update(teamInvitations)
              .set({ status: 'pending' })
              .where(eq(teamInvitations.id, claimed.id));
            return { status: 'no_email' } as const;
          }
          if (auth.user.email !== claimed.email) {
            await tx
              .update(teamInvitations)
              .set({ status: 'pending' })
              .where(eq(teamInvitations.id, claimed.id));
            return { status: 'email_mismatch' } as const;
          }
        }

        // Check if already a team member
        const existing = await tx
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, claimed.teamId), eq(teamMembers.userId, auth.userId)));

        if (existing.length > 0) {
          return {
            status: 'already_member',
            teamId: claimed.teamId,
            role: existing[0]?.role,
          } as const;
        }

        // Add user to team
        await tx.insert(teamMembers).values({
          teamId: claimed.teamId,
          userId: auth.userId,
          role: claimed.role,
        });

        return {
          status: 'ok',
          teamId: claimed.teamId,
          role: claimed.role,
          joinedAt: new Date().toISOString(),
        } as const;
      });

      switch (result.status) {
        case 'not_found':
          return json(
            {
              ok: false,
              error: {
                code: 'INVITATION_NOT_FOUND',
                message: 'Invalid, expired, or already used invitation',
              },
            },
            404
          );
        case 'no_email':
          return json(
            {
              ok: false,
              error: {
                code: 'FORBIDDEN',
                message: 'Cannot verify email address. Please set your email first.',
              },
            },
            403
          );
        case 'email_mismatch':
          return json(
            {
              ok: false,
              error: {
                code: 'INVITATION_EMAIL_MISMATCH',
                message: 'Invitation was sent to a different email address',
              },
            },
            403
          );
        case 'already_member':
          return json(
            {
              ok: false,
              error: { code: 'MEMBER_ALREADY_EXISTS', message: 'Already a member of this team' },
            },
            409
          );
        case 'ok':
          return json({
            ok: true,
            data: { teamId: result.teamId, role: result.role, joinedAt: result.joinedAt },
          });
      }
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
