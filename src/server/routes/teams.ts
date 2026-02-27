/**
 * Team routes
 */

import { createId } from '@paralleldrive/cuid2';
import { and, count, eq, gt, inArray, like } from 'drizzle-orm';
import { Hono } from 'hono';
import { apiTokens } from '../../db/schema/sqlite/api-tokens';
import { tags } from '../../db/schema/sqlite/tags';
import { teamInvitations } from '../../db/schema/sqlite/team-invitations';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import { teamProjects } from '../../db/schema/sqlite/team-projects';
import { teams } from '../../db/schema/sqlite/teams';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json, parsePagination, requireTeamRole } from '../shared';
import {
  createTeamSchema,
  parseJsonBody,
  transferOwnershipSchema,
  updateTeamSchema,
} from '../validation';

const log = createLogger('TeamsRoutes');

interface TeamsDeps {
  db: Database;
  rbacService: RbacService;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

export function createTeamsRoutes({ db, rbacService }: TeamsDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/teams - Create team
  app.post('/', async (c) => {
    const auth = c.get('auth');
    const parsed = await parseJsonBody(c, createTeamSchema);
    if (!parsed.ok) return parsed.response;

    const slug = parsed.data.slug ?? slugify(parsed.data.name);

    try {
      const created = await db.transaction(async (tx) => {
        // Check slug uniqueness inside transaction
        const existing = await tx.query.teams.findFirst({
          where: eq(teams.slug, slug),
        });
        if (existing) {
          return null; // Signal duplicate
        }

        const teamId = createId();
        await tx.insert(teams).values({
          id: teamId,
          name: parsed.data.name,
          slug,
          description: parsed.data.description,
        });

        // Add creator as owner
        await tx.insert(teamMembers).values({
          teamId,
          userId: auth.userId,
          role: 'owner',
        });

        return tx.query.teams.findFirst({
          where: eq(teams.id, teamId),
        });
      });

      if (!created) {
        return json(
          { ok: false, error: { code: 'TEAM_SLUG_EXISTS', message: 'Team slug already exists' } },
          409
        );
      }

      return json({
        ok: true,
        data: {
          ...created,
          membership: { userId: auth.userId, role: 'owner', joinedAt: created?.createdAt },
        },
      });
    } catch (error) {
      log.error('Failed to create team', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create team' } },
        500
      );
    }
  });

  // GET /api/teams - List user's teams
  app.get('/', async (c) => {
    const auth = c.get('auth');
    const { cursor, limit } = parsePagination(c);
    // H5: Support search query parameter
    const search = c.req.query('search');

    try {
      // Helper: batch-fetch member and project counts for a set of team IDs (H2+H7)
      async function enrichTeamCounts(teamIds: string[]) {
        if (teamIds.length === 0) return { memberMap: new Map<string, number>(), projectMap: new Map<string, number>() };
        const [memberCounts, projectCounts] = await Promise.all([
          db.select({ teamId: teamMembers.teamId, total: count() })
            .from(teamMembers).where(inArray(teamMembers.teamId, teamIds)).groupBy(teamMembers.teamId),
          db.select({ teamId: teamProjects.teamId, total: count() })
            .from(teamProjects).where(inArray(teamProjects.teamId, teamIds)).groupBy(teamProjects.teamId),
        ]);
        return {
          memberMap: new Map(memberCounts.map(r => [r.teamId, r.total])),
          projectMap: new Map(projectCounts.map(r => [r.teamId, r.total])),
        };
      }

      // For dev mode, return all teams
      if (auth.authMethod === 'dev') {
        // Build where filters
        const filters = [];
        if (cursor) filters.push(gt(teams.id, cursor));
        if (search) filters.push(like(teams.name, `%${search}%`));
        const whereClause = filters.length > 0 ? and(...filters) : undefined;

        // Total count (with search filter)
        const countWhere = search ? like(teams.name, `%${search}%`) : undefined;
        const [countResult] = await db.select({ total: count() }).from(teams).where(countWhere);
        const totalCount = countResult?.total ?? 0;

        const allTeams = await db
          .select()
          .from(teams)
          .where(whereClause)
          .orderBy(teams.id)
          .limit(limit + 1);

        const hasMore = allTeams.length > limit;
        const pagedTeams = hasMore ? allTeams.slice(0, limit) : allTeams;
        const nextCursor = hasMore ? pagedTeams[pagedTeams.length - 1]?.id : undefined;

        // H2+H7: Batch-fetch counts with GROUP BY instead of N+1
        const teamIds = pagedTeams.map(t => t.id);
        const { memberMap, projectMap } = await enrichTeamCounts(teamIds);

        const items = pagedTeams.map(team => ({
          ...team,
          memberCount: memberMap.get(team.id) ?? 0,
          projectCount: projectMap.get(team.id) ?? 0,
          myRole: null as string | null,
        }));

        return json({
          ok: true,
          data: { items, nextCursor, hasMore, totalCount },
        });
      }

      // Find teams where user is a member
      const memberships = await db
        .select({ teamId: teamMembers.teamId, role: teamMembers.role })
        .from(teamMembers)
        .where(eq(teamMembers.userId, auth.userId));

      if (memberships.length === 0) {
        return json({
          ok: true,
          data: { items: [], nextCursor: undefined, hasMore: false, totalCount: 0 },
        });
      }

      const teamIds = memberships.map((m) => m.teamId);

      // Build where clause with cursor + search support
      const filters = [inArray(teams.id, teamIds)];
      if (cursor) filters.push(gt(teams.id, cursor));
      if (search) filters.push(like(teams.name, `%${search}%`));
      const whereClause = and(...filters);

      // Total count (with search filter)
      const countFilters = [inArray(teams.id, teamIds)];
      if (search) countFilters.push(like(teams.name, `%${search}%`));
      const [countResult] = await db.select({ total: count() }).from(teams).where(and(...countFilters));
      const totalCount = countResult?.total ?? 0;

      const teamRows = await db
        .select()
        .from(teams)
        .where(whereClause)
        .orderBy(teams.id)
        .limit(limit + 1);

      const hasMore = teamRows.length > limit;
      const pagedRows = hasMore ? teamRows.slice(0, limit) : teamRows;
      const nextCursor = hasMore ? pagedRows[pagedRows.length - 1]?.id : undefined;

      const roleByTeamId = new Map(memberships.map((m) => [m.teamId, m.role]));

      // H2+H7: Batch-fetch counts with GROUP BY instead of N+1
      const pagedTeamIds = pagedRows.map(t => t.id);
      const { memberMap, projectMap } = await enrichTeamCounts(pagedTeamIds);

      const items = pagedRows.map(team => ({
        ...team,
        memberCount: memberMap.get(team.id) ?? 0,
        projectCount: projectMap.get(team.id) ?? 0,
        myRole: roleByTeamId.get(team.id) ?? null,
      }));

      return json({
        ok: true,
        data: { items, nextCursor, hasMore, totalCount },
      });
    } catch (error) {
      log.error('Failed to list teams', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to list teams' } }, 500);
    }
  });

  // GET /api/teams/:id - Get team details
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');
    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, id, 'viewer', 'Not a team member');
    if (denied) return denied;

    try {
      const team = await db.query.teams.findFirst({
        where: eq(teams.id, id),
      });
      if (!team) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Team not found' } }, 404);
      }

      // H7: Fetch both memberCount and projectCount
      const [[memberCountResult], [projectCountResult]] = await Promise.all([
        db.select({ total: count() }).from(teamMembers).where(eq(teamMembers.teamId, id)),
        db.select({ total: count() }).from(teamProjects).where(eq(teamProjects.teamId, id)),
      ]);

      // Get caller's role
      let myRole: string | null = null;
      if (auth.authMethod !== 'dev') {
        myRole = await rbacService.resolveTeamRole(auth.userId, id);
      }

      return json({
        ok: true,
        data: {
          ...team,
          memberCount: memberCountResult?.total ?? 0,
          projectCount: projectCountResult?.total ?? 0,
          myRole,
        },
      });
    } catch (error) {
      log.error('Failed to get team', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to get team' } }, 500);
    }
  });

  // PATCH /api/teams/:id - Update team
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, id, 'admin');
    if (denied) return denied;

    const parsed = await parseJsonBody(c, updateTeamSchema);
    if (!parsed.ok) return parsed.response;

    try {
      const [updated] = await db
        .update(teams)
        .set({ ...parsed.data, updatedAt: new Date().toISOString() })
        .where(eq(teams.id, id))
        .returning();

      if (!updated) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Team not found' } }, 404);
      }

      return json({ ok: true, data: updated });
    } catch (error) {
      log.error('Failed to update team', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update team' } },
        500
      );
    }
  });

  // POST /api/teams/:id/transfer-ownership - Transfer team ownership
  app.post('/:id/transfer-ownership', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const denied = await requireTeamRole(
      auth,
      rbacService,
      id,
      'owner',
      'Only team owner can transfer ownership'
    );
    if (denied) return denied;

    const parsed = await parseJsonBody(c, transferOwnershipSchema);
    if (!parsed.ok) return parsed.response;

    if (parsed.data.targetUserId === auth.userId) {
      return json(
        {
          ok: false,
          error: {
            code: 'CANNOT_TRANSFER_TO_SELF',
            message: 'Cannot transfer ownership to yourself',
          },
        },
        400
      );
    }

    try {
      const result = await db.transaction(async (tx) => {
        // Verify target is a member of the team
        const targetMember = await tx.query.teamMembers.findFirst({
          where: and(eq(teamMembers.teamId, id), eq(teamMembers.userId, parsed.data.targetUserId)),
        });
        if (!targetMember) return 'TARGET_NOT_MEMBER' as const;

        // Promote target to owner
        await tx
          .update(teamMembers)
          .set({ role: 'owner' })
          .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, parsed.data.targetUserId)));

        // Demote current owner to admin
        await tx
          .update(teamMembers)
          .set({ role: 'admin' })
          .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, auth.userId)));

        return 'OK' as const;
      });

      if (result === 'TARGET_NOT_MEMBER') {
        return json(
          {
            ok: false,
            error: { code: 'MEMBER_NOT_FOUND', message: 'Target user is not a team member' },
          },
          404
        );
      }

      return json({
        ok: true,
        data: { teamId: id, newOwnerId: parsed.data.targetUserId, previousOwnerId: auth.userId },
      });
    } catch (error) {
      log.error('Failed to transfer team ownership', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to transfer ownership' } },
        500
      );
    }
  });

  // DELETE /api/teams/:id - Delete team
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const denied = await requireTeamRole(
      auth,
      rbacService,
      id,
      'owner',
      'Only team owner can delete'
    );
    if (denied) return denied;

    try {
      const result = await db.transaction(async (tx) => {
        // Verify team exists
        const team = await tx.query.teams.findFirst({ where: eq(teams.id, id) });
        if (!team) return null;

        // Delete associated data
        await tx.delete(teamInvitations).where(eq(teamInvitations.teamId, id));
        await tx.delete(apiTokens).where(eq(apiTokens.teamId, id));
        await tx.delete(tags).where(eq(tags.teamId, id)); // cascades to project_tags and task_tags
        await tx.delete(teamProjects).where(eq(teamProjects.teamId, id));
        await tx.delete(teamMembers).where(eq(teamMembers.teamId, id));
        await tx.delete(teams).where(eq(teams.id, id));

        return team;
      });

      if (!result) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Team not found' } }, 404);
      }
      return json({ ok: true, data: { deleted: true } });
    } catch (error) {
      log.error('Failed to delete team', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete team' } },
        500
      );
    }
  });

  return app;
}
