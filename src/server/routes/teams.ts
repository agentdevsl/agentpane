/**
 * Team routes
 */

import { createId } from '@paralleldrive/cuid2';
import { desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { teamMembers } from '../../db/schema/sqlite/team-members';
import { teams } from '../../db/schema/sqlite/teams';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json } from '../shared';
import { createTeamSchema, parseBody, updateTeamSchema } from '../validation';

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
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400);
    }

    const parsed = parseBody(createTeamSchema, body);
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
          { ok: false, error: { code: 'DUPLICATE', message: 'Team slug already exists' } },
          409
        );
      }

      return json({ ok: true, data: created });
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

    // Verify team membership (dev mode bypasses)
    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveTeamRole(auth.userId, id);
      if (!role) {
        return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not a team member' } }, 403);
      }
    }

    try {
      const team = await db.query.teams.findFirst({
        where: eq(teams.id, id),
      });
      if (!team) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Team not found' } }, 404);
      }
      return json({ ok: true, data: team });
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

    // Check admin role in team
    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveTeamRole(auth.userId, id);
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

    const parsed = parseBody(updateTeamSchema, body);
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

    // Check owner role
    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveTeamRole(auth.userId, id);
      if (!role || role !== 'owner') {
        return json(
          { ok: false, error: { code: 'FORBIDDEN', message: 'Only team owner can delete' } },
          403
        );
      }
    }

    try {
      const result = await db.delete(teams).where(eq(teams.id, id)).returning();
      if (result.length === 0) {
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
