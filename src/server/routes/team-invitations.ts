/**
 * Team invitation routes
 */

import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { teamInvitations } from '../../db/schema/sqlite/team-invitations';
import type { AuthContext } from '../../lib/api/auth-middleware';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json } from '../shared';
import { createInvitationSchema, parseBody } from '../validation';

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

    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveTeamRole(auth.userId, teamId);
      if (!role || !rbacService.hasMinimumRole(role, 'admin')) {
        return json(
          { ok: false, error: { code: 'FORBIDDEN', message: 'Requires admin role' } },
          403
        );
      }
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400);
    }

    const parsed = parseBody(createInvitationSchema, body);
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
          { ok: false, error: { code: 'DUPLICATE', message: 'Pending invitation already exists' } },
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

      return json({ ok: true, data: invitation });
    } catch (error) {
      console.error('[Invitations] Create error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create invitation' } },
        500
      );
    }
  });

  // GET /api/teams/:id/invitations - List pending invitations
  app.get('/', async (c) => {
    const teamId = c.req.param('id');

    if (!teamId || !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    try {
      const invitations = await db
        .select()
        .from(teamInvitations)
        .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.status, 'pending')));

      return json({ ok: true, data: { items: invitations } });
    } catch (error) {
      console.error('[Invitations] List error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list invitations' } },
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

    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveTeamRole(auth.userId, teamId);
      if (!role || !rbacService.hasMinimumRole(role, 'admin')) {
        return json(
          { ok: false, error: { code: 'FORBIDDEN', message: 'Requires admin role' } },
          403
        );
      }
    }

    try {
      const result = await db
        .update(teamInvitations)
        .set({ status: 'revoked' })
        .where(and(eq(teamInvitations.id, iid), eq(teamInvitations.teamId, teamId)))
        .returning();

      if (result.length === 0) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Invitation not found' } },
          404
        );
      }

      return json({ ok: true, data: { revoked: true } });
    } catch (error) {
      console.error('[Invitations] Revoke error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to revoke invitation' } },
        500
      );
    }
  });

  return app;
}
