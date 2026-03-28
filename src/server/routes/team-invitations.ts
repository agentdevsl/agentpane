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
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { hashToken, json, requireTeamRole, validateIdParam } from '../shared';
import { createInvitationSchema, parseJsonBody } from '../validation';

interface InvitationsDeps {
  db: Database;
  rbacService: RbacService;
}

export function createTeamInvitationsRoutes({ db, rbacService }: InvitationsDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/teams/:id/invitations - Create invitation
  app.post('/', async (c) => {
    const auth = c.get('auth');

    const { id: teamId, error: teamIdError } = validateIdParam(c, 'id');
    if (teamIdError) return teamIdError;

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    const parsed = await parseJsonBody(c, createInvitationSchema);
    if (!parsed.ok) return parsed.response;

    // Only owners can create invitations with admin role (matches team-members.ts behavior)
    if (parsed.data.role === 'admin' && auth.authMethod !== 'dev') {
      const callerRole = await rbacService.resolveTeamRole(auth.userId, teamId);
      if (callerRole !== 'owner') {
        return json(
          {
            ok: false,
            error: {
              code: 'INSUFFICIENT_ROLE',
              message: 'Only owners can invite with admin role',
            },
          },
          403
        );
      }
    }

    const result = await db.transaction(async (tx) => {
      // Check for existing pending invitation
      const existing = await tx
        .select()
        .from(teamInvitations)
        .where(
          and(
            eq(teamInvitations.teamId, teamId),
            eq(teamInvitations.email, parsed.data.email),
            eq(teamInvitations.status, 'pending')
          )
        );

      if (existing.length > 0) return { error: 'INVITATION_ALREADY_EXISTS' as const };

      // Check if user with this email is already a member
      // Use githubEmail (immutable OAuth email) for consistency with invitation-accept.ts
      const existingMember = await tx
        .select({ userId: users.id })
        .from(users)
        .innerJoin(teamMembers, eq(teamMembers.userId, users.id))
        .where(and(eq(teamMembers.teamId, teamId), eq(users.githubEmail, parsed.data.email)));

      if (existingMember.length > 0) return { error: 'MEMBER_ALREADY_EXISTS' as const };

      const rawToken = randomBytes(32).toString('base64url');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const rows = await tx
        .insert(teamInvitations)
        .values({
          teamId,
          invitedBy: auth.userId,
          email: parsed.data.email,
          role: parsed.data.role,
          token: tokenHash,
          expiresAt,
        })
        .returning();

      const invitation = rows[0];
      if (!invitation) return { error: 'DB_ERROR' as const };

      // Return raw token (not the hash) so it can be shared with the invitee
      return { ok: true as const, invitation, rawToken };
    });

    if ('error' in result) {
      if (result.error === 'INVITATION_ALREADY_EXISTS') {
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
      if (result.error === 'DB_ERROR') {
        return json(
          { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create invitation' } },
          500
        );
      }
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

    return json(
      {
        ok: true,
        data: {
          id: result.invitation.id,
          teamId: result.invitation.teamId,
          email: result.invitation.email,
          role: result.invitation.role,
          token: result.rawToken,
          expiresAt: result.invitation.expiresAt,
          createdAt: result.invitation.createdAt,
        },
      },
      201
    );
  });

  // GET /api/teams/:id/invitations - List pending invitations
  app.get('/', async (c) => {
    const auth = c.get('auth');

    const { id: teamId, error: teamIdError } = validateIdParam(c, 'id');
    if (teamIdError) return teamIdError;

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

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
  });

  // POST /api/teams/:id/invitations/:iid/decline - Decline an invitation
  app.post('/:iid/decline', async (c) => {
    const { id: teamId, error: teamIdError } = validateIdParam(c, 'id');
    if (teamIdError) return teamIdError;
    const { id: iid, error: iidError } = validateIdParam(c, 'iid');
    if (iidError) return iidError;
    const auth = c.get('auth');

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
    // Use githubEmail (immutable OAuth email) for consistency with invitation-accept.ts
    if (auth.authMethod !== 'dev') {
      if (!auth.user?.githubEmail) {
        return json(
          {
            ok: false,
            error: {
              code: 'EMAIL_REQUIRED',
              message: 'Cannot verify invitation ownership without verified email',
            },
          },
          403
        );
      }
      if (invitation[0]?.email !== auth.user.githubEmail) {
        return json(
          { ok: false, error: { code: 'FORBIDDEN', message: 'Not your invitation' } },
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
  });

  // DELETE /api/teams/:id/invitations/:iid - Revoke invitation
  app.delete('/:iid', async (c) => {
    const { id: teamId, error: teamIdError } = validateIdParam(c, 'id');
    if (teamIdError) return teamIdError;
    const { id: iid, error: iidError } = validateIdParam(c, 'iid');
    if (iidError) return iidError;
    const auth = c.get('auth');

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

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
  });

  return app;
}
