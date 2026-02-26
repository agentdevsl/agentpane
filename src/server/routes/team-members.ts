/**
 * Team member routes
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import { users } from '../../db/schema/sqlite/users';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json } from '../shared';
import { addTeamMemberSchema, parseBody, updateTeamMemberSchema } from '../validation';

const log = createLogger('TeamMembersRoutes');

interface TeamMembersDeps {
  db: Database;
  rbacService: RbacService;
}

export function createTeamMembersRoutes({ db, rbacService }: TeamMembersDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/teams/:id/members - Add member
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

    const parsed = parseBody(addTeamMemberSchema, body);
    if (!parsed.ok) return parsed.response;

    try {
      // Check if already a member
      const existing = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, parsed.data.userId)));

      if (existing.length > 0) {
        return json(
          { ok: false, error: { code: 'DUPLICATE', message: 'User is already a member' } },
          409
        );
      }

      await db.insert(teamMembers).values({
        teamId,
        userId: parsed.data.userId,
        role: parsed.data.role,
      });

      return json({
        ok: true,
        data: { teamId, userId: parsed.data.userId, role: parsed.data.role },
      });
    } catch (error) {
      log.error('Failed to add member', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to add member' } }, 500);
    }
  });

  // GET /api/teams/:id/members - List members
  app.get('/', async (c) => {
    const teamId = c.req.param('id');

    if (!teamId || !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    const auth = c.get('auth');
    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveTeamRole(auth.userId, teamId);
      if (!role) {
        return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not a team member' } }, 403);
      }
    }

    try {
      const members = await db
        .select({
          userId: teamMembers.userId,
          role: teamMembers.role,
          joinedAt: teamMembers.joinedAt,
          userName: users.name,
          githubLogin: users.githubLogin,
          avatarUrl: users.avatarUrl,
        })
        .from(teamMembers)
        .leftJoin(users, eq(teamMembers.userId, users.id))
        .where(eq(teamMembers.teamId, teamId));

      return json({ ok: true, data: { items: members } });
    } catch (error) {
      log.error('Failed to list members', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list members' } },
        500
      );
    }
  });

  // PATCH /api/teams/:id/members/:uid - Update member role
  app.patch('/:uid', async (c) => {
    const teamId = c.req.param('id');
    const uid = c.req.param('uid');
    const auth = c.get('auth');

    if (!teamId || !uid || !isValidId(teamId) || !isValidId(uid)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    // Can't change own role
    if (auth.userId === uid && auth.authMethod !== 'dev') {
      return json(
        { ok: false, error: { code: 'FORBIDDEN', message: 'Cannot change your own role' } },
        403
      );
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

    const parsed = parseBody(updateTeamMemberSchema, body);
    if (!parsed.ok) return parsed.response;

    try {
      const result = await db
        .update(teamMembers)
        .set({ role: parsed.data.role })
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, uid)))
        .returning();

      if (result.length === 0) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Member not found' } }, 404);
      }

      return json({ ok: true, data: result[0] });
    } catch (error) {
      log.error('Failed to update member', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update member' } },
        500
      );
    }
  });

  // DELETE /api/teams/:id/members/:uid - Remove member
  app.delete('/:uid', async (c) => {
    const teamId = c.req.param('id');
    const uid = c.req.param('uid');
    const auth = c.get('auth');

    if (!teamId || !uid || !isValidId(teamId) || !isValidId(uid)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    // Prevent self-removal (use "leave team" flow instead if needed)
    if (auth.userId === uid && auth.authMethod !== 'dev') {
      return json(
        {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Cannot remove yourself. Transfer ownership first.',
          },
        },
        403
      );
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
      // Don't allow removing the last owner
      const targetMember = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, uid)));

      if (targetMember.length === 0) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Member not found' } }, 404);
      }

      if (targetMember[0]?.role === 'owner') {
        // Only owners can remove other owners
        if (auth.authMethod !== 'dev') {
          const callerRole = await rbacService.resolveTeamRole(auth.userId, teamId);
          if (callerRole !== 'owner') {
            return json(
              { ok: false, error: { code: 'FORBIDDEN', message: 'Only owners can remove owners' } },
              403
            );
          }
        }

        const owners = await db
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'owner')));

        if (owners.length <= 1) {
          return json(
            { ok: false, error: { code: 'LAST_OWNER', message: 'Cannot remove the last owner' } },
            409
          );
        }
      }

      await db
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, uid)));

      return json({ ok: true, data: { removed: true } });
    } catch (error) {
      log.error('Failed to remove member', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to remove member' } },
        500
      );
    }
  });

  return app;
}
