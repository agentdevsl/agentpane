/**
 * Per-team GitHub token management routes
 *
 * Mounted at /api/teams/:id/github-token
 * Provides CRUD + validation for team-scoped GitHub PATs.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { Octokit } from 'octokit';
import { z } from 'zod';
import { githubTokens } from '../../db/schema/sqlite/github.js';
import type { AuthContext } from '../../lib/api/auth-middleware.js';
import {
  decryptToken,
  encryptToken,
  isValidPATFormat,
  maskToken,
} from '../../lib/crypto/server-encryption.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { RbacService } from '../../services/rbac.service.js';
import type { Database } from '../../types/database.js';
import { isValidId, json, requireTeamRole } from '../shared.js';
import { parseJsonBody } from '../validation.js';

const log = createLogger('TeamGitHubTokenRoutes');

interface TeamGitHubTokenDeps {
  db: Database;
  rbacService: RbacService;
}

export function createTeamGitHubTokenRoutes({ db, rbacService }: TeamGitHubTokenDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET / - Get team's GitHub token info (metadata only, never the actual token)
  app.get('/', async (c) => {
    const teamId = c.req.param('id');
    const auth = c.get('auth');

    if (!teamId || !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    try {
      const token = await db.query.githubTokens.findFirst({
        where: eq(githubTokens.teamId, teamId),
      });

      if (!token) {
        return json(
          {
            ok: false,
            error: { code: 'NOT_FOUND', message: 'No GitHub token configured for this team' },
          },
          404
        );
      }

      // Decrypt to produce masked version
      let maskedToken = '****';
      try {
        const decrypted = decryptToken(token.encryptedToken);
        maskedToken = maskToken(decrypted);
      } catch {
        // If decryption fails, still return metadata
      }

      return json({
        ok: true,
        data: {
          id: token.id,
          maskedToken,
          tokenType: token.tokenType,
          scopes: token.scopes,
          githubLogin: token.githubLogin,
          githubId: token.githubId,
          isValid: token.isValid,
          lastValidatedAt: token.lastValidatedAt,
          createdAt: token.createdAt,
          updatedAt: token.updatedAt,
        },
      });
    } catch (error) {
      log.error('Failed to get team GitHub token', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get token info' } },
        500
      );
    }
  });

  // PUT / - Set/replace the team's GitHub token
  app.put('/', async (c) => {
    const teamId = c.req.param('id');
    const auth = c.get('auth');

    if (!teamId || !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    const githubTokenSchema = z.object({ token: z.string().min(1).max(500) });
    const parsed = await parseJsonBody(c, githubTokenSchema);
    if (!parsed.ok) return parsed.response;

    const { token } = parsed.data;

    // Validate PAT format
    if (!isValidPATFormat(token)) {
      return json(
        {
          ok: false,
          error: {
            code: 'INVALID_FORMAT',
            message: 'Invalid token format. GitHub PATs start with "ghp_" or "github_pat_"',
          },
        },
        400
      );
    }

    // Validate with GitHub API before saving
    let githubLogin: string | null = null;
    let githubId: string | null = null;
    try {
      const octokit = new Octokit({ auth: token });
      const { data: user } = await octokit.rest.users.getAuthenticated();
      githubLogin = user.login;
      githubId = String(user.id);
    } catch (error) {
      const status =
        error instanceof Error && 'status' in error
          ? (error as { status: number }).status
          : undefined;
      if (status === 401) {
        return json(
          {
            ok: false,
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Invalid token. Please check your token and try again.',
            },
          },
          400
        );
      }
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Failed to validate token with GitHub',
          },
        },
        400
      );
    }

    try {
      // Delete existing team token if any
      await db.delete(githubTokens).where(eq(githubTokens.teamId, teamId));

      // Encrypt and store
      const encrypted = encryptToken(token);

      const [saved] = await db
        .insert(githubTokens)
        .values({
          encryptedToken: encrypted,
          tokenType: 'pat',
          githubLogin,
          githubId,
          teamId,
          isValid: true,
          lastValidatedAt: new Date().toISOString(),
        })
        .returning();

      if (!saved) {
        return json(
          { ok: false, error: { code: 'DB_ERROR', message: 'Failed to save token' } },
          500
        );
      }

      return json({
        ok: true,
        data: {
          tokenInfo: {
            id: saved.id,
            maskedToken: maskToken(token),
            githubLogin: saved.githubLogin,
            isValid: saved.isValid ?? true,
            lastValidatedAt: saved.lastValidatedAt,
            createdAt: saved.createdAt,
          },
        },
      });
    } catch (error) {
      log.error('Failed to set team GitHub token', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to save token' } }, 500);
    }
  });

  // DELETE / - Remove the team's GitHub token
  app.delete('/', async (c) => {
    const teamId = c.req.param('id');
    const auth = c.get('auth');

    if (!teamId || !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    try {
      const result = await db
        .delete(githubTokens)
        .where(eq(githubTokens.teamId, teamId))
        .returning();

      if (result.length === 0) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'No token to delete' } },
          404
        );
      }

      return json({ ok: true, data: null });
    } catch (error) {
      log.error('Failed to delete team GitHub token', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete token' } },
        500
      );
    }
  });

  // POST /validate - Validate the team's token against GitHub API
  app.post('/validate', async (c) => {
    const teamId = c.req.param('id');
    const auth = c.get('auth');

    if (!teamId || !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    try {
      const token = await db.query.githubTokens.findFirst({
        where: eq(githubTokens.teamId, teamId),
      });

      if (!token) {
        return json(
          {
            ok: false,
            error: { code: 'NOT_FOUND', message: 'No GitHub token configured for this team' },
          },
          404
        );
      }

      // Decrypt and validate against GitHub
      const decrypted = decryptToken(token.encryptedToken);
      let isValid = false;
      let githubLogin: string | undefined;

      try {
        const octokit = new Octokit({ auth: decrypted });
        const { data: user } = await octokit.rest.users.getAuthenticated();
        isValid = true;
        githubLogin = user.login;
      } catch {
        isValid = false;
      }

      // Update validation status in database
      await db
        .update(githubTokens)
        .set({
          isValid,
          lastValidatedAt: new Date().toISOString(),
          ...(githubLogin ? { githubLogin } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(githubTokens.teamId, teamId));

      return json({ ok: true, data: { isValid } });
    } catch (error) {
      log.error('Failed to validate team GitHub token', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to validate token' } },
        500
      );
    }
  });

  return app;
}
