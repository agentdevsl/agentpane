/**
 * Team invitation routes
 */

import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { teamInvitations } from '../../db/schema/sqlite/team-invitations';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import { users } from '../../db/schema/sqlite/users';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json, requireTeamRole } from '../shared';
import { createInvitationSchema, parseJsonBody } from '../validation';

const log = createLogger('TeamInvitationsRoutes');

interface InvitationsDeps {
  db: Database;
  rbacService: RbacService;
}

export function createTeamInvitationsRoutes({ db, rbacService }: InvitationsDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/teams/:id/invitations - Create invitation
  app.post('/', async (c) => {
    const teamId = c.req.param('id');
    const auth = c.get('auth');

    if (!teamId || !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    const parsed = await parseJsonBody(c, createInvitationSchema);
    if (!parsed.ok) return parsed.response;

    try {
      // Check for existing pending invitation
      const existing = await db
        .select()
        .from(teamInvitations)
        .where(
          and(
            eq(teamInvitations.teamId, teamId),
            eq(teamInvitations.email, parsed.data.email),
            eq(teamInvitations.status, 'pending')
          )
        );

      if (existing.length > 0) {
        return json(
          {
            ok: false,
            error: {
              code: 'INVITATION_ALREADY_EXISTS',
              message: 'Pending invitation already exists',
            },
          },
          409
        );
      }

      // Check if user with this email is already a member
      const existingMember = await db
        .select({ userId: users.id })
        .from(users)
        .innerJoin(teamMembers, eq(teamMembers.userId, users.id))
        .where(and(eq(teamMembers.teamId, teamId), eq(users.email, parsed.data.email)));

      if (existingMember.length > 0) {
        return json(
          {
            ok: false,
            error: {
              code: 'MEMBER_ALREADY_EXISTS',
              message: 'User with this email is already a team member',
            },
          },
          409
        );
      }

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const [invitation] = await db
        .insert(teamInvitations)
        .values({
          teamId,
          invitedBy: auth.userId,
          email: parsed.data.email,
          role: parsed.data.role,
          token,
          expiresAt,
        })
        .returning();

      return json({ ok: true, data: invitation }, 201);
    } catch (error) {
      log.error('Failed to create invitation', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create invitation' } },
        500
      );
    }
  });

  // GET /api/teams/:id/invitations - List pending invitations
  app.get('/', async (c) => {
    const teamId = c.req.param('id');
    const auth = c.get('auth');

    if (!teamId || !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    try {
      const invitations = await db
        .select({
          id: teamInvitations.id,
          teamId: teamInvitations.teamId,
          invitedBy: teamInvitations.invitedBy,
          invitedByName: users.name,
          email: teamInvitations.email,
          role: teamInvitations.role,
          status: teamInvitations.status,
          expiresAt: teamInvitations.expiresAt,
          createdAt: teamInvitations.createdAt,
        })
        .from(teamInvitations)
        .leftJoin(users, eq(teamInvitations.invitedBy, users.id))
        .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.status, 'pending')));

      const enrichedInvitations = invitations.map(({ invitedByName, invitedBy, ...rest }) => ({
        ...rest,
        invitedBy: { userId: invitedBy, name: invitedByName },
      }));

      return json({ ok: true, data: { items: enrichedInvitations } });
    } catch (error) {
      log.error('Failed to list invitations', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list invitations' } },
        500
      );
    }
  });

  // POST /api/teams/:id/invitations/:iid/decline - Decline an invitation
  app.post('/:iid/decline', async (c) => {
    const teamId = c.req.param('id');
    const iid = c.req.param('iid');
    const auth = c.get('auth');

    if (!teamId || !iid || !isValidId(teamId) || !isValidId(iid)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    try {
      // Find the invitation
      const invitation = await db
        .select()
        .from(teamInvitations)
        .where(
          and(
            eq(teamInvitations.id, iid),
            eq(teamInvitations.teamId, teamId),
            eq(teamInvitations.status, 'pending')
          )
        );

      if (invitation.length === 0) {
        return json(
          {
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Invitation not found or already processed' },
          },
          404
        );
      }

      // Verify the declining user is the invitee (check email match)
      if (auth.authMethod !== 'dev') {
        if (!auth.user?.email) {
          return json(
            { ok: false, error: { code: 'FORBIDDEN', message: 'Cannot verify identity without email' } },
            403
          );
        }
        if (invitation[0]?.email !== auth.user.email) {
          return json(
            { ok: false, error: { code: 'FORBIDDEN', message: 'Only the invitee can decline' } },
            403
          );
        }
      }

      const result = await db
        .update(teamInvitations)
        .set({ status: 'declined' })
        .where(
          and(
            eq(teamInvitations.id, iid),
            eq(teamInvitations.teamId, teamId),
            eq(teamInvitations.status, 'pending')
          )
        )
        .returning();

      if (result.length === 0) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Invitation not found' } },
          404
        );
      }

      return json({ ok: true, data: { declined: true } });
    } catch (error) {
      log.error('Failed to decline invitation', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to decline invitation' } },
        500
      );
    }
  });

  // DELETE /api/teams/:id/invitations/:iid - Revoke invitation
  app.delete('/:iid', async (c) => {
    const teamId = c.req.param('id');
    const iid = c.req.param('iid');
    const auth = c.get('auth');

    if (!teamId || !iid || !isValidId(teamId) || !isValidId(iid)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    try {
      const result = await db
        .update(teamInvitations)
        .set({ status: 'revoked' })
        .where(
          and(
            eq(teamInvitations.id, iid),
            eq(teamInvitations.teamId, teamId),
            eq(teamInvitations.status, 'pending')
          )
        )
        .returning();

      if (result.length === 0) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Invitation not found' } },
          404
        );
      }

      return json({ ok: true, data: { revoked: true } });
    } catch (error) {
      log.error('Failed to revoke invitation', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to revoke invitation' } },
        500
      );
    }
  });

  return app;
}
