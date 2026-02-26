/**
 * Team routes
 */

import { createId } from '@paralleldrive/cuid2';
import { desc, eq, inArray } from 'drizzle-orm';
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
import { isValidId, json, requireTeamRole } from '../shared';
import { createTeamSchema, parseJsonBody, updateTeamSchema } from '../validation';

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

    try {
      // For dev mode, return all teams
      if (auth.authMethod === 'dev') {
        const allTeams = await db.query.teams.findMany({
          orderBy: [desc(teams.updatedAt)],
        });
        return json({ ok: true, data: { items: allTeams ?? [] } });
      }

      // Find teams where user is a member
      const memberships = await db
        .select({ teamId: teamMembers.teamId, role: teamMembers.role })
        .from(teamMembers)
        .where(eq(teamMembers.userId, auth.userId));

      if (memberships.length === 0) {
        return json({ ok: true, data: { items: [] } });
      }

      const teamIds = memberships.map((m) => m.teamId);
      const teamRows = await db.select().from(teams).where(inArray(teams.id, teamIds));

      const roleByTeamId = new Map(memberships.map((m) => [m.teamId, m.role]));
      const userTeams = teamRows.map((team) => ({
        ...team,
        memberRole: roleByTeamId.get(team.id),
      }));

      return json({ ok: true, data: { items: userTeams } });
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

      const memberRows = await db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, id));

      // Get caller's role
      let myRole: string | null = null;
      if (auth.authMethod !== 'dev') {
        myRole = await rbacService.resolveTeamRole(auth.userId, id);
      }

      return json({ ok: true, data: { ...team, memberCount: memberRows.length, myRole } });
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
