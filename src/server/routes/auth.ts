/**
 * Authentication routes (GitHub OAuth + session management)
 */

import { randomBytes } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { eq, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { getRuntimeSchemaTables } from '../../db/schema/runtime-tables.js';
import { type AuthContext, SESSION_COOKIE_NAME } from '../../lib/api/auth-middleware.js';
import { isDevAuthAllowed } from '../../lib/api/dev-auth.js';
import { createLogger } from '../../lib/logging/logger';
import { RbacService } from '../../services/rbac.service.js';
import type { Database } from '../../types/database';
import { hashToken, json, requireQueryParam } from '../shared';

const log = createLogger('AuthRoutes');
const { planSessions, sandboxInstances, sessions, userSessions, users } = getRuntimeSchemaTables();
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface AuthDeps {
  db: Database;
}

/**
 * F05-23 / F06-NEW-11: Resolve a stream's underlying codespace.
 *
 * Returns the codespaceId that owns the given (kind, id), or `null` if the
 * stream's entity is unknown. This is the lookup half of per-stream tenant
 * scope enforcement at `verify-stream` — the role check itself is performed
 * by `RbacService.resolveUserRole`.
 */
async function resolveStreamCodespaceId(
  db: Database,
  streamKind: 'sessions' | 'plans' | 'sandboxes',
  streamId: string
): Promise<string | null> {
  if (streamKind === 'sessions') {
    const row = await db.query.sessions.findFirst({
      where: eq(sessions.id, streamId),
      columns: { codespaceId: true },
    });
    return row?.codespaceId ?? null;
  }
  if (streamKind === 'plans') {
    const row = await db.query.planSessions.findFirst({
      where: eq(planSessions.id, streamId),
      columns: { codespaceId: true },
    });
    return row?.codespaceId ?? null;
  }
  // streamKind === 'sandboxes'
  const row = await db.query.sandboxInstances.findFirst({
    where: eq(sandboxInstances.id, streamId),
    columns: { codespaceId: true },
  });
  return row?.codespaceId ?? null;
}

export function createAuthRoutes({ db }: AuthDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /api/auth/github — Redirect to GitHub OAuth authorization
  app.get('/github', (c) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      return json(
        { ok: false, error: { code: 'CONFIG_ERROR', message: 'GitHub OAuth not configured' } },
        500
      );
    }

    const state = randomBytes(16).toString('hex');
    const redirectUri =
      process.env.GITHUB_CALLBACK_URL ?? `${c.req.url.replace('/github', '/github/callback')}`;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
    });

    // Set state cookie for CSRF protection
    c.header(
      'Set-Cookie',
      `oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600; Secure`
    );

    return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  });

  // GET /api/auth/github/callback — Handle OAuth callback
  app.get('/github/callback', async (c) => {
    const { value: code, error: codeError } = requireQueryParam(c, 'code');
    if (codeError) return codeError;
    const { value: state, error: stateError } = requireQueryParam(c, 'state');
    if (stateError) return stateError;

    // Verify state parameter (CSRF protection)
    const cookies = c.req.header('Cookie') ?? '';
    const stateMatch = cookies.match(/oauth_state=([^;]+)/);
    if (!stateMatch || stateMatch[1] !== state) {
      return json(
        { ok: false, error: { code: 'INVALID_STATE', message: 'State parameter mismatch' } },
        400
      );
    }

    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return json(
        { ok: false, error: { code: 'CONFIG_ERROR', message: 'GitHub OAuth not configured' } },
        500
      );
    }

    // The entire OAuth flow (external HTTP + DB operations) needs error handling
    // because failures should return OAUTH_FAILED and clear the state cookie
    try {
      // Exchange code for access token
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      });

      const tokenData = (await tokenResponse.json()) as {
        access_token?: string;
        error?: string;
      };

      if (!tokenData.access_token) {
        log.error('GitHub OAuth token exchange failed', { data: { error: tokenData.error } });
        // Clear the state cookie on failure. Use `c.body(...)` so the
        // Response goes through Hono's `newResponse` and middleware-set
        // headers (e.g. X-Request-Id) survive.
        return c.body(
          JSON.stringify({
            ok: false,
            error: { code: 'OAUTH_FAILED', message: 'Failed to exchange code for token' },
          }),
          400,
          {
            'Content-Type': 'application/json',
            'Set-Cookie': 'oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
          }
        );
      }

      // Get user info from GitHub
      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github+json',
        },
      });

      const githubUser = (await userResponse.json()) as {
        id: number;
        login: string;
        name: string | null;
        email: string | null;
        avatar_url: string | null;
      };

      if (!githubUser.id) {
        // Clear the state cookie on failure — see comment above on token-exchange branch.
        return c.body(
          JSON.stringify({
            ok: false,
            error: { code: 'OAUTH_FAILED', message: 'Failed to fetch GitHub user info' },
          }),
          400,
          {
            'Content-Type': 'application/json',
            'Set-Cookie': 'oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
          }
        );
      }
      // Upsert user
      let user = await db.query.users.findFirst({
        where: eq(users.githubId, githubUser.id),
      });

      if (user) {
        // Update existing user — always update githubEmail from OAuth source
        await db
          .update(users)
          .set({
            githubLogin: githubUser.login,
            name: githubUser.name,
            email: githubUser.email,
            githubEmail: githubUser.email,
            avatarUrl: githubUser.avatar_url,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(users.id, user.id));
      } else {
        // Create new user
        const inserted = await db
          .insert(users)
          .values({
            id: createId(),
            githubId: githubUser.id,
            githubLogin: githubUser.login,
            name: githubUser.name,
            email: githubUser.email,
            githubEmail: githubUser.email,
            avatarUrl: githubUser.avatar_url,
          })
          .returning();
        user = inserted[0];
      }

      if (!user) {
        return json(
          { ok: false, error: { code: 'OAUTH_FAILED', message: 'Failed to create user record' } },
          500
        );
      }

      // Create session — store hashed token, send raw token in cookie
      const sessionToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();

      await db.insert(userSessions).values({
        id: createId(),
        userId: user.id,
        token: hashToken(sessionToken),
        expiresAt,
      });

      // Set session cookie and redirect to app
      // AR-005: Only set Secure flag in production. In development over HTTP, the Secure
      // flag causes the browser to reject the cookie, breaking local auth flow.
      const secureSuffix = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      c.header(
        'Set-Cookie',
        `${SESSION_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secureSuffix}`
      );

      // Clear OAuth state cookie
      c.header('Set-Cookie', 'oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', {
        append: true,
      });

      const redirectUrl = process.env.APP_URL ?? 'http://localhost:3000';
      return c.redirect(redirectUrl);
    } catch (error) {
      log.error('OAuth callback failed during user/session creation', { error });
      // Clear OAuth state cookie via `c.body(...)` so the Response flows
      // through Hono's `newResponse` and middleware-set headers survive.
      return c.body(
        JSON.stringify({
          ok: false,
          error: { code: 'OAUTH_FAILED', message: 'Authentication failed' },
        }),
        400,
        {
          'Content-Type': 'application/json',
          'Set-Cookie': 'oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
        }
      );
    }
  });

  // POST /api/auth/logout — End session
  app.post('/logout', async (c) => {
    const cookies = c.req.header('Cookie') ?? '';
    const sessionMatch = cookies.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));

    if (sessionMatch?.[1]) {
      try {
        // Delete the session from DB (token is stored as SHA-256 hash)
        await db.delete(userSessions).where(eq(userSessions.token, hashToken(sessionMatch[1])));
      } catch (error) {
        log.error('Failed to delete session from database', { error });
        // Use `c.body(...)` so middleware-set headers (X-Request-Id, security
        // headers) survive while still attaching the Set-Cookie clear.
        return c.body(
          JSON.stringify({
            ok: false,
            error: {
              code: 'DB_ERROR',
              message: 'Session may not be fully invalidated. Please try again.',
            },
          }),
          500,
          {
            'Content-Type': 'application/json',
            'Set-Cookie': `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
          }
        );
      }
    }

    // Clear session cookie via `c.body(...)` so middleware-set headers
    // (X-Request-Id, security headers) survive on the response.
    return c.body(JSON.stringify({ ok: true, data: null }), 200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    });
  });

  // POST /api/auth/revoke-all — SC-H1: Revoke all sessions for the current user ("log out everywhere")
  app.post('/revoke-all', async (c) => {
    const cookies = c.req.header('Cookie') ?? '';
    const sessionMatch = cookies.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));

    if (!sessionMatch?.[1]) {
      return json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'No active session' } },
        401
      );
    }

    // Look up the current session to find the user
    const hashedToken = hashToken(sessionMatch[1]);
    const session = await db.query.userSessions.findFirst({
      where: eq(userSessions.token, hashedToken),
    });

    if (!session) {
      // Use `c.body(...)` so middleware-set headers survive on the response.
      return c.body(
        JSON.stringify({
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'Session not found' },
        }),
        401,
        {
          'Content-Type': 'application/json',
          'Set-Cookie': `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        }
      );
    }

    try {
      // Delete ALL sessions for this user
      const result = await db
        .delete(userSessions)
        .where(eq(userSessions.userId, session.userId))
        .returning({ id: userSessions.id });

      log.info('Revoked all sessions for user', {
        data: { userId: session.userId, count: result.length },
      });

      // Clear current session cookie via `c.body(...)` so middleware-set
      // headers survive on the response.
      return c.body(JSON.stringify({ ok: true, data: { revokedCount: result.length } }), 200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      });
    } catch (error) {
      log.error('Failed to revoke all sessions', { error });
      return json(
        {
          ok: false,
          error: { code: 'DB_ERROR', message: 'Failed to revoke sessions' },
        },
        500
      );
    }
  });

  // F05-07 / F05-23 / F06-NEW-11: Caddy `forward_auth` hook for `/v1/stream/*`.
  //
  // Caddy sends the original request URI in the `X-Original-URI` header (or
  // `X-Forwarded-Uri` depending on the version). We validate:
  //   1. The session cookie maps to an active user session.
  //   2. The URI path matches a known stream shape (`/v1/stream/{sessions,plans,sandboxes,terraform}/{id}`).
  //   3. The authenticated user has access to the SPECIFIC stream — i.e. the
  //      requesting user is a member of the codespace that owns the session /
  //      plan / sandbox. This closes the cross-tenant subscribe gap noted in
  //      F05-23 and F06-NEW-11. Without this check, any authenticated user
  //      who knows or guesses a CUID can subscribe to another tenant's
  //      session, plan, or sandbox stream.
  //
  // A 200 response greenlights the stream connection; 401 blocks unauthenticated
  // clients; 403 blocks authenticated-but-unauthorized clients; 404 indicates the
  // stream's underlying entity does not exist.
  //
  // The kind→entity→codespaceId resolver is encapsulated in a small switch below.
  // Cli-monitor remains a singleton stream, accessible to any authenticated user.
  // Terraform compose jobs are short-lived in-memory state and are not yet
  // FK-tracked in the DB — they keep the authenticated-only guard until the
  // schema migrates (see F05-24).
  const rbacService = new RbacService(db);

  app.all('/verify-stream', async (c) => {
    const originalUri =
      c.req.header('X-Original-URI') ??
      c.req.header('X-Forwarded-Uri') ??
      c.req.header('X-Original-URL') ??
      '';
    if (!originalUri.startsWith('/v1/stream')) {
      return json({ ok: false, error: { code: 'INVALID_URI', message: 'Not a stream URI' } }, 400);
    }

    // Basic shape check — must be /v1/stream, /v1/stream/cli-monitor, or /v1/stream/{kind}/{id}
    const streamMatch = originalUri.match(
      /^\/v1\/stream(?:\/(cli-monitor|sessions|plans|sandboxes|terraform)(?:\/([A-Za-z0-9][A-Za-z0-9_-]*))?)?$/
    );
    if (!streamMatch) {
      return json(
        { ok: false, error: { code: 'INVALID_URI', message: 'Malformed stream URI' } },
        400
      );
    }

    const streamKind = streamMatch[1] ?? null;
    const streamId = streamMatch[2] ?? null;

    // F06-05: dev-mode auth bypass. Honored only when both `SKIP_AUTH=true`
    // AND `NODE_ENV !== 'production'` are set at call time. In production the
    // helper returns false unconditionally regardless of `SKIP_AUTH`.
    if (isDevAuthAllowed()) {
      return json({
        ok: true,
        data: { userId: 'dev-user', streamKind, streamId },
      });
    }

    // Cookie-based auth. We intentionally reuse the existing session cookie
    // rather than a separate stream token — Caddy forwards cookies verbatim.
    const cookies = c.req.header('Cookie') ?? '';
    const sessionMatch = cookies.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    if (!sessionMatch?.[1]) {
      return json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        401
      );
    }

    try {
      const session = await db.query.userSessions.findFirst({
        where: eq(userSessions.token, hashToken(sessionMatch[1])),
      });
      if (!session) {
        return json(
          { ok: false, error: { code: 'UNAUTHORIZED', message: 'Session not found' } },
          401
        );
      }
      if (new Date(session.expiresAt) < new Date()) {
        return json(
          { ok: false, error: { code: 'SESSION_EXPIRED', message: 'Session expired' } },
          401
        );
      }

      // F05-23 / F06-NEW-11: per-stream tenant scope check.
      //
      // For session/plan/sandbox kinds we resolve the underlying codespaceId
      // and require the requesting user to have at least viewer role on that
      // codespace via `RbacService.resolveUserRole`. The resolver walks the
      // direct → folder → team membership chain that already governs every
      // other authorization path in the app.
      //
      // For the index path (`/v1/stream`), `cli-monitor`, and the bare-kind
      // path (no `streamId`), only the cookie check is required — these are
      // either singleton, broadcast, or the IDs are not addressable. For
      // `terraform/:id` we keep the cookie-only check until the underlying
      // entity gets a DB row (tracked in F05-24).
      if (
        streamId &&
        (streamKind === 'sessions' || streamKind === 'plans' || streamKind === 'sandboxes')
      ) {
        const codespaceId = await resolveStreamCodespaceId(db, streamKind, streamId);
        if (!codespaceId) {
          // Unknown stream id — treat as not-found. A 404 here surfaces stale
          // links cleanly without leaking whether the entity exists in another
          // tenant.
          return json(
            { ok: false, error: { code: 'NOT_FOUND', message: 'Stream not found' } },
            404
          );
        }
        const role = await rbacService.resolveUserRole(session.userId, codespaceId);
        if (!role) {
          log.warn('Cross-tenant stream subscribe denied', {
            data: {
              userId: session.userId,
              streamKind,
              streamId,
              codespaceId,
            },
          });
          return json(
            {
              ok: false,
              error: { code: 'FORBIDDEN', message: 'Not authorized for this stream' },
            },
            403
          );
        }
      }

      // 200 response signals Caddy to allow the stream connection.
      return json({
        ok: true,
        data: {
          userId: session.userId,
          streamKind,
          streamId,
        },
      });
    } catch (error) {
      log.error('verify-stream failed', { error });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Verification failed' } },
        500
      );
    }
  });

  // SC-H1: Start periodic expired session cleanup (runs every hour)
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const cleanupTimer = setInterval(async () => {
    try {
      const now = new Date().toISOString();
      const result = await db
        .delete(userSessions)
        .where(lt(userSessions.expiresAt, now))
        .returning({ id: userSessions.id });

      if (result.length > 0) {
        log.info('Purged expired sessions', { data: { count: result.length } });
      }
    } catch (error) {
      log.error('Expired session cleanup failed', { error });
    }
  }, CLEANUP_INTERVAL_MS);

  // Prevent the timer from keeping the process alive
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  return app;
}
