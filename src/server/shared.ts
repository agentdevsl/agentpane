/**
 * Shared utilities and types for API routes
 */

import type { Context } from 'hono';

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

// CORS headers for dev
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
 * Dev-mode users always pass. Returns a 403 Response if unauthorized, or null if authorized.
 */
export function requireTeamRole(
  auth: { authMethod: string; userId: string },
  rbacService: {
    resolveTeamRole(userId: string, teamId: string): Promise<string | null>;
    hasMinimumRole(userRole: string, minimumRole: string): boolean;
  },
  teamId: string,
  minimumRole: string,
  message = `Requires ${minimumRole} role`
): Promise<Response | null> {
  if (auth.authMethod === 'dev') return Promise.resolve(null);
  return rbacService.resolveTeamRole(auth.userId, teamId).then((role) => {
    if (!role || !rbacService.hasMinimumRole(role, minimumRole)) {
      return json({ ok: false, error: { code: 'INSUFFICIENT_ROLE', message } }, 403);
    }
    return null;
  });
}

/**
 * Require that the authenticated user has at least the given project role.
 * Dev-mode users always pass. Returns a 403 Response if unauthorized, or null if authorized.
 */
export function requireProjectRole(
  auth: { authMethod: string; userId: string },
  rbacService: {
    resolveUserRole(userId: string, projectId: string): Promise<string | null>;
    hasMinimumRole(userRole: string, minimumRole: string): boolean;
  },
  projectId: string,
  minimumRole: string,
  message = `Requires ${minimumRole} role`
): Promise<Response | null> {
  if (auth.authMethod === 'dev') return Promise.resolve(null);
  return rbacService.resolveUserRole(auth.userId, projectId).then((role) => {
    if (!role || !rbacService.hasMinimumRole(role, minimumRole)) {
      return json({ ok: false, error: { code: 'INSUFFICIENT_ROLE', message } }, 403);
    }
    return null;
  });
}

/**
 * Standard API error structure
 */
export interface ApiError {
  code: string;
  message: string;
  status?: number;
}

/**
 * Create an error response with consistent structure
 */
export function errorResponse(error: ApiError, status?: number): Response {
  return json(
    { ok: false, error: { code: error.code, message: error.message } },
    status ?? error.status ?? 400
  );
}

/**
 * Handle service result and return appropriate response
 * Returns null if result is ok, otherwise returns error Response
 */
export function handleServiceError<T>(
  result: { ok: false; error: ApiError } | { ok: true; value: T }
): Response | null {
  if (!result.ok) {
    return errorResponse(result.error, result.error.status);
  }
  return null;
}
