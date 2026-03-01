/**
 * Team member routes
 */

import { and, count, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { RBAC_ROLES, type RbacRole } from '../../db/schema/shared/enums';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import { users } from '../../db/schema/sqlite/users';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import {
  isValidId,
  json,
  parsePagination,
  requireTeamRole,
  requireTeamRoleResolved,
} from '../shared';
import { addTeamMemberSchema, parseJsonBody, updateTeamMemberSchema } from '../validation';

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

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    const parsed = await parseJsonBody(c, addTeamMemberSchema);
    if (!parsed.ok) return parsed.response;

    // Only owners can add members with admin role
    if (parsed.data.role === 'admin' && auth.authMethod !== 'dev') {
      const callerRole = await rbacService.resolveTeamRole(auth.userId, teamId);
      if (callerRole !== 'owner') {
        return json(
          {
            ok: false,
            error: {
              code: 'INSUFFICIENT_ROLE',
              message: 'Only owners can add members with admin role',
            },
          },
          403
        );
      }
    }

    try {
      const result = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, parsed.data.userId)));
        if (existing.length > 0) return 'DUPLICATE' as const;

        // Verify user exists
        const userExists = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, parsed.data.userId));
        if (userExists.length === 0) return 'USER_NOT_FOUND' as const;

        await tx.insert(teamMembers).values({
          teamId,
          userId: parsed.data.userId,
          role: parsed.data.role,
        });
        return 'OK' as const;
      });

      if (result === 'DUPLICATE') {
        return json(
          {
            ok: false,
            error: { code: 'MEMBER_ALREADY_EXISTS', message: 'User is already a member' },
          },
          409
        );
      }
      if (result === 'USER_NOT_FOUND') {
        return json(
          { ok: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } },
          404
        );
      }

      return json(
        {
          ok: true,
          data: {
            teamId,
            userId: parsed.data.userId,
            role: parsed.data.role,
            joinedAt: new Date().toISOString(),
          },
        },
        201
      );
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
        return json(
          { ok: false, error: { code: 'INSUFFICIENT_ROLE', message: 'Not a team member' } },
          403
        );
      }
    }

    const { cursor, limit } = parsePagination(c);
    const rawRoleFilter = c.req.query('role');
    const roleFilter: RbacRole | undefined =
      rawRoleFilter && (RBAC_ROLES as readonly string[]).includes(rawRoleFilter)
        ? (rawRoleFilter as RbacRole)
        : undefined;

    if (rawRoleFilter && !roleFilter) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid role filter. Must be one of: ${RBAC_ROLES.join(', ')}`,
          },
        },
        400
      );
    }

    try {
      // Build base where clause (used for both count and query)
      const baseWhere = roleFilter
        ? and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, roleFilter))
        : eq(teamMembers.teamId, teamId);
      const [countResult] = await db.select({ total: count() }).from(teamMembers).where(baseWhere);
      const totalCount = countResult?.total ?? 0;

      const whereClause = cursor ? and(baseWhere, gt(teamMembers.userId, cursor)) : baseWhere;

      const members = await db
        .select({
          userId: teamMembers.userId,
          role: teamMembers.role,
          joinedAt: teamMembers.joinedAt,
          name: users.name,
          email: users.email,
          githubLogin: users.githubLogin,
          avatarUrl: users.avatarUrl,
        })
        .from(teamMembers)
        .leftJoin(users, eq(teamMembers.userId, users.id))
        .where(whereClause)
        .orderBy(teamMembers.userId)
        .limit(limit + 1);

      const hasMore = members.length > limit;
      const items = hasMore ? members.slice(0, limit) : members;
      const nextCursor = hasMore ? (items[items.length - 1]?.userId ?? null) : null;

      return json({
        ok: true,
        data: { items, nextCursor, hasMore, totalCount },
      });
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
        {
          ok: false,
          error: { code: 'CANNOT_CHANGE_OWN_ROLE', message: 'Cannot change your own role' },
        },
        400
      );
    }

    const { denied, role: callerRole } = await requireTeamRoleResolved(
      auth,
      rbacService,
      teamId,
      'admin'
    );
    if (denied) return denied;

    const parsed = await parseJsonBody(c, updateTeamMemberSchema);
    if (!parsed.ok) return parsed.response;

    // Admins cannot assign admin role — only owners can
    if (
      callerRole &&
      parsed.data.role === 'admin' &&
      !rbacService.hasMinimumRole(callerRole as RbacRole, 'owner')
    ) {
      return json(
        {
          ok: false,
          error: { code: 'INSUFFICIENT_ROLE', message: 'Only owners can assign admin role' },
        },
        403
      );
    }

    try {
      const result = await db.transaction(async (tx) => {
        // Check if demoting the last owner
        const targetMember = await tx
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, uid)));

        if (targetMember.length === 0) {
          return 'MEMBER_NOT_FOUND' as const;
        }

        // Schema already prevents assigning 'owner' via PATCH, so any change to an owner is a demotion
        if (targetMember[0]?.role === 'owner') {
          const owners = await tx
            .select()
            .from(teamMembers)
            .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'owner')));

          if (owners.length <= 1) {
            return 'CANNOT_DEMOTE_LAST_OWNER' as const;
          }
        }

        const updated = await tx
          .update(teamMembers)
          .set({ role: parsed.data.role })
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, uid)))
          .returning();

        if (updated.length === 0) {
          return 'MEMBER_NOT_FOUND' as const;
        }

        return { ok: true as const, data: updated[0] };
      });

      if (result === 'MEMBER_NOT_FOUND') {
        return json(
          { ok: false, error: { code: 'MEMBER_NOT_FOUND', message: 'Member not found' } },
          404
        );
      }
      if (result === 'CANNOT_DEMOTE_LAST_OWNER') {
        return json(
          {
            ok: false,
            error: {
              code: 'CANNOT_DEMOTE_LAST_OWNER',
              message: 'Team must have at least one owner',
            },
          },
          400
        );
      }

      return json({ ok: true, data: result.data });
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
            code: 'CANNOT_REMOVE_SELF',
            message: 'You cannot remove yourself from the team via this endpoint.',
          },
        },
        400
      );
    }

    const { denied: adminDenied, role: callerRole } = await requireTeamRoleResolved(
      auth,
      rbacService,
      teamId,
      'admin'
    );
    if (adminDenied) return adminDenied;

    try {
      const result = await db.transaction(async (tx) => {
        // Don't allow removing the last owner
        const targetMember = await tx
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, uid)));

        if (targetMember.length === 0) {
          return 'MEMBER_NOT_FOUND' as const;
        }

        if (targetMember[0]?.role === 'owner') {
          // Only owners can remove other owners
          if (callerRole && callerRole !== 'owner') {
            return 'INSUFFICIENT_ROLE' as const;
          }

          const owners = await tx
            .select()
            .from(teamMembers)
            .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'owner')));

          if (owners.length <= 1) {
            return 'CANNOT_REMOVE_LAST_OWNER' as const;
          }
        }

        await tx
          .delete(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, uid)));

        return 'OK' as const;
      });

      if (result === 'MEMBER_NOT_FOUND') {
        return json(
          { ok: false, error: { code: 'MEMBER_NOT_FOUND', message: 'Member not found' } },
          404
        );
      }
      if (result === 'INSUFFICIENT_ROLE') {
        return json(
          {
            ok: false,
            error: { code: 'INSUFFICIENT_ROLE', message: 'Only owners can remove owners' },
          },
          403
        );
      }
      if (result === 'CANNOT_REMOVE_LAST_OWNER') {
        return json(
          {
            ok: false,
            error: { code: 'CANNOT_REMOVE_LAST_OWNER', message: 'Cannot remove the last owner' },
          },
          409
        );
      }

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
