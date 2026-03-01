/**
 * Shared utilities and types for API routes
 */

import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import type { RbacRole } from '../db/schema/shared/enums';
import { createLogger } from '../lib/logging/logger';

const log = createLogger('SharedHelpers');

/**
 * Hash a raw API token using SHA-256.
 * Used for storing and looking up token hashes in the database.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Cursor-based pagination parameters
 */
export interface PaginationParams {
  cursor?: string;
  limit: number;
}

/**
 * Parse cursor-based pagination parameters from query string.
 * - `cursor`: optional string ID for cursor-based pagination
 * - `limit`: integer clamped between 1 and 100, defaults to 50
 */
export function parsePagination(c: Context): PaginationParams {
  const cursor = c.req.query('cursor') || undefined;
  const rawLimit = c.req.query('limit');
  let limit = 50;
  if (rawLimit) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isNaN(parsed)) {
      limit = Math.max(1, Math.min(100, parsed));
    }
  }
  return { cursor, limit };
}

// CORS headers for SSE endpoints that bypass Hono middleware
export const corsHeaders = {
  'Access-Control-Allow-Origin': 'http://localhost:3000',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

/**
 * Create a JSON response.
 * NOTE: CORS is handled by Hono middleware in router.ts.
 * Do not add CORS headers here to avoid duplication.
 */
export function json<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Validate that an ID is safe and properly formatted
 * Accepts cuid2 IDs and kebab-case string IDs
 */
export function isValidId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  // Length check: reasonable ID lengths (1-100 chars)
  if (id.length < 1 || id.length > 100) return false;
  // Only allow alphanumeric, hyphens, underscores (safe for paths/queries)
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/**
 * Validate that a git branch name is safe for shell interpolation.
 * Prevents command injection by only allowing safe characters.
 */
export function isValidBranchName(branch: string): boolean {
  if (!branch || typeof branch !== 'string') return false;
  // Length check: git branch names should be reasonable
  if (branch.length < 1 || branch.length > 250) return false;
  // Reject path traversal sequences
  if (branch.includes('..')) return false;
  // Only allow alphanumeric, hyphens, underscores, forward slashes, dots
  // This covers standard branch naming conventions like feature/foo-bar
  return /^[a-zA-Z0-9_\-/.]+$/.test(branch);
}

/**
 * Validate that a URL is a valid GitHub HTTPS URL.
 * Prevents potential injection via malicious URLs.
 */
export function isValidGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'github.com' || parsed.hostname.endsWith('.github.com'))
    );
  } catch {
    return false;
  }
}

/**
 * Require that the authenticated user has at least the given team role.
 * Dev-mode users always pass. Returns null if authorized, or a 403 Response if role is insufficient or user has no team membership.
 */
export function requireTeamRole(
  auth: { authMethod: 'session' | 'api_token' | 'dev'; userId: string },
  rbacService: {
    resolveTeamRole(userId: string, teamId: string): Promise<RbacRole | null>;
    hasMinimumRole(userRole: RbacRole, minimumRole: RbacRole): boolean;
  },
  teamId: string,
  minimumRole: RbacRole,
  message = `Requires ${minimumRole} role`
): Promise<Response | null> {
  if (auth.authMethod === 'dev') return Promise.resolve(null);
  return rbacService
    .resolveTeamRole(auth.userId, teamId)
    .then((role) => {
      if (!role) {
        return json({ ok: false, error: { code: 'INSUFFICIENT_ROLE', message } }, 403);
      }
      if (!rbacService.hasMinimumRole(role, minimumRole)) {
        return json({ ok: false, error: { code: 'INSUFFICIENT_ROLE', message } }, 403);
      }
      return null;
    })
    .catch((error) => {
      log.error('Failed to resolve team role', { error, data: { userId: auth.userId, teamId } });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to verify permissions' } },
        500
      );
    });
}

/**
 * Like requireTeamRole, but also returns the resolved role string.
 * Useful when callers need the role for further authorization checks
 * (e.g. distinguishing admin from owner) without a redundant resolveTeamRole call.
 * Dev-mode users get role = null and denied = null.
 */
export async function requireTeamRoleResolved(
  auth: { authMethod: 'session' | 'api_token' | 'dev'; userId: string },
  rbacService: {
    resolveTeamRole(userId: string, teamId: string): Promise<RbacRole | null>;
    hasMinimumRole(userRole: RbacRole, minimumRole: RbacRole): boolean;
  },
  teamId: string,
  minimumRole: RbacRole,
  message = `Requires ${minimumRole} role`
): Promise<{ denied: Response | null; role: RbacRole | null }> {
  if (auth.authMethod === 'dev') return { denied: null, role: null };
  try {
    const role = await rbacService.resolveTeamRole(auth.userId, teamId);
    if (!role || !rbacService.hasMinimumRole(role, minimumRole)) {
      return {
        denied: json({ ok: false, error: { code: 'INSUFFICIENT_ROLE', message } }, 403),
        role,
      };
    }
    return { denied: null, role };
  } catch (error) {
    log.error('Failed to resolve team role', { error, data: { userId: auth.userId, teamId } });
    return {
      denied: json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to verify permissions' } },
        500
      ),
      role: null,
    };
  }
}

/**
 * Require that the authenticated user has at least the given project role.
 * Dev-mode users always pass. Returns null if authorized, or a 403 Response if the user lacks the required role (or has no project access).
 */
export function requireProjectRole(
  auth: { authMethod: 'session' | 'api_token' | 'dev'; userId: string },
  rbacService: {
    resolveUserRole(userId: string, projectId: string): Promise<RbacRole | null>;
    hasMinimumRole(userRole: RbacRole, minimumRole: RbacRole): boolean;
  },
  projectId: string,
  minimumRole: RbacRole,
  message = `Requires ${minimumRole} role`
): Promise<Response | null> {
  if (auth.authMethod === 'dev') return Promise.resolve(null);
  return rbacService
    .resolveUserRole(auth.userId, projectId)
    .then((role) => {
      if (!role || !rbacService.hasMinimumRole(role, minimumRole)) {
        return json({ ok: false, error: { code: 'INSUFFICIENT_ROLE', message } }, 403);
      }
      return null;
    })
    .catch((error) => {
      log.error('Failed to resolve project role', {
        error,
        data: { userId: auth.userId, projectId },
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to verify permissions' } },
        500
      );
    });
}
