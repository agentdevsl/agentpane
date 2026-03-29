/**
 * Authentication routes (GitHub OAuth + session management)
 */

import { randomBytes } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { eq, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { userSessions } from '../../db/schema/sqlite/user-sessions';
import { users } from '../../db/schema/sqlite/users';
import { type AuthContext, SESSION_COOKIE_NAME } from '../../lib/api/auth-middleware.js';
import { createLogger } from '../../lib/logging/logger';
import type { Database } from '../../types/database';
import { hashToken, json, requireQueryParam } from '../shared';

const log = createLogger('AuthRoutes');
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface AuthDeps {
  db: Database;
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
        return json(
          {
            ok: false,
            error: { code: 'OAUTH_FAILED', message: 'Failed to exchange code for token' },
          },
          400
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
        return json(
          {
            ok: false,
            error: { code: 'OAUTH_FAILED', message: 'Failed to fetch GitHub user info' },
          },
          400
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
      // Clear OAuth state cookie even on failure
      c.header('Set-Cookie', 'oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', {
        append: true,
      });
      return json(
        { ok: false, error: { code: 'OAUTH_FAILED', message: 'Authentication failed' } },
        400
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
        // Still clear the cookie (best-effort client-side logout) but inform the user
        c.header(
          'Set-Cookie',
          `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
        );
        return json(
          {
            ok: false,
            error: {
              code: 'DB_ERROR',
              message: 'Session may not be fully invalidated. Please try again.',
            },
          },
          500
        );
      }
    }

    // Clear session cookie
    c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);

    return json({ ok: true, data: null });
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
      c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      return json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'Session not found' } },
        401
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

      // Clear current session cookie
      c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);

      return json({ ok: true, data: { revokedCount: result.length } });
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
