/**
 * Codespace member routes
 *
 * arch29-W3-D (F12-06): renamed from `project-members.ts`. Codespace members
 * are tracked in the `codespaceMembers` table and the route is mounted at
 * `/api/codespaces/:id/members`. Symbol names match.
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { getRuntimeSchemaTables } from '../../db/schema/runtime-tables.js';
import type { AuthContext } from '../../lib/api/auth-middleware';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { json, requireCodespaceRole, validateIdParam } from '../shared';
import {
  addCodespaceMemberSchema,
  parseJsonBody,
  updateCodespaceMemberSchema,
} from '../validation';

const { codespaceMembers, users } = getRuntimeSchemaTables();

interface CodespaceMembersDeps {
  db: Database;
  rbacService: RbacService;
}

export function createCodespaceMembersRoutes({ db, rbacService }: CodespaceMembersDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST / - Add codespace member override
  app.post('/', async (c) => {
    const { id: codespaceId, error: csError } = validateIdParam(c, 'id');
    if (csError) return csError;
    const auth = c.get('auth');

    const denied = await requireCodespaceRole(auth, rbacService, codespaceId, 'admin');
    if (denied) return denied;

    const parsed = await parseJsonBody(c, addCodespaceMemberSchema);
    if (!parsed.ok) return parsed.response;

    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(codespaceMembers)
        .where(
          and(
            eq(codespaceMembers.codespaceId, codespaceId),
            eq(codespaceMembers.userId, parsed.data.userId)
          )
        );
      if (existing.length > 0) return 'DUPLICATE' as const;

      const userExists = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, parsed.data.userId));
      if (userExists.length === 0) return 'USER_NOT_FOUND' as const;

      await tx.insert(codespaceMembers).values({
        codespaceId,
        userId: parsed.data.userId,
        role: parsed.data.role,
        grantedByTeamId: parsed.data.teamId ?? null,
      });
      return 'OK' as const;
    });

    if (result === 'DUPLICATE') {
      // arch29-W3-D: error code preserved for API stability. Renaming the route
      // file/symbols is internal; clients keying on `code` would break.
      return json(
        { ok: false, error: { code: 'PROJECT_MEMBER_EXISTS', message: 'Member already exists' } },
        409
      );
    }
    if (result === 'USER_NOT_FOUND') {
      return json({ ok: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } }, 404);
    }
    return json(
      {
        ok: true,
        data: {
          codespaceId,
          userId: parsed.data.userId,
          role: parsed.data.role,
          effectiveRole: parsed.data.role,
          grantedAt: new Date().toISOString(),
        },
      },
      201
    );
  });

  // GET / - List codespace members
  app.get('/', async (c) => {
    const { id: codespaceId, error: csError } = validateIdParam(c, 'id');
    if (csError) return csError;

    const auth = c.get('auth');
    const denied = await requireCodespaceRole(
      auth,
      rbacService,
      codespaceId,
      'viewer',
      'Not a codespace member'
    );
    if (denied) return denied;

    const members = await db
      .select({
        userId: codespaceMembers.userId,
        role: codespaceMembers.role,
        grantedByTeamId: codespaceMembers.grantedByTeamId,
        createdAt: codespaceMembers.createdAt,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(codespaceMembers)
      .leftJoin(users, eq(codespaceMembers.userId, users.id))
      .where(eq(codespaceMembers.codespaceId, codespaceId));

    // H4: Enrich with effectiveRole and source
    // arch29-W3-D (F12-06): emit both `codespaceRole` (new canonical name) and
    // `projectRole` (deprecated alias) for one release of backward compatibility.
    const enrichedMembers = await Promise.all(
      members.map(async (m) => {
        const effectiveRole = m.userId
          ? await rbacService.resolveUserRole(m.userId, codespaceId)
          : null;
        return {
          ...m,
          codespaceRole: m.role,
          /** @deprecated use `codespaceRole`. Removed in next release. */
          projectRole: m.role,
          effectiveRole: effectiveRole ?? m.role,
          source: 'direct' as const,
        };
      })
    );

    return json({ ok: true, data: { items: enrichedMembers } });
  });

  // PATCH /:uid - Update codespace member role
  app.patch('/:uid', async (c) => {
    const { id: codespaceId, error: csError } = validateIdParam(c, 'id');
    if (csError) return csError;
    const { id: uid, error: uidError } = validateIdParam(c, 'uid');
    if (uidError) return uidError;
    const auth = c.get('auth');

    if (auth.userId === uid && auth.authMethod !== 'dev') {
      return json(
        {
          ok: false,
          error: { code: 'CANNOT_CHANGE_OWN_ROLE', message: 'Cannot change your own role' },
        },
        400
      );
    }

    const adminDenied = await requireCodespaceRole(auth, rbacService, codespaceId, 'admin');
    if (adminDenied) return adminDenied;

    const parsed = await parseJsonBody(c, updateCodespaceMemberSchema);
    if (!parsed.ok) return parsed.response;

    const result = await db
      .update(codespaceMembers)
      .set({ role: parsed.data.role })
      .where(and(eq(codespaceMembers.codespaceId, codespaceId), eq(codespaceMembers.userId, uid)))
      .returning();

    if (result.length === 0) {
      return json(
        { ok: false, error: { code: 'PROJECT_MEMBER_NOT_FOUND', message: 'Member not found' } },
        404
      );
    }

    return json({ ok: true, data: result[0] });
  });

  // DELETE /:uid - Remove codespace member override
  app.delete('/:uid', async (c) => {
    const { id: codespaceId, error: csError } = validateIdParam(c, 'id');
    if (csError) return csError;
    const { id: uid, error: uidError } = validateIdParam(c, 'uid');
    if (uidError) return uidError;
    const auth = c.get('auth');

    const denied = await requireCodespaceRole(auth, rbacService, codespaceId, 'admin');
    if (denied) return denied;

    const result = await db
      .delete(codespaceMembers)
      .where(and(eq(codespaceMembers.codespaceId, codespaceId), eq(codespaceMembers.userId, uid)))
      .returning();
    if (result.length === 0) {
      return json(
        { ok: false, error: { code: 'PROJECT_MEMBER_NOT_FOUND', message: 'Member not found' } },
        404
      );
    }

    // After removing the direct override, resolve the user's inherited team role
    const revertedToTeamRole = await rbacService.resolveUserRole(uid, codespaceId);

    return json({ ok: true, data: { removed: true, revertedToTeamRole } });
  });

  return app;
}
