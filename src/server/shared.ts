/**
 * Shared utilities and types for API routes
 *
 * AR-018: This is the canonical location for API response types and helpers.
 * The types ApiSuccess, ApiFailure, ApiResponse, success(), and failure() were
 * consolidated here from src/lib/api/response.ts. That file is now deprecated
 * and re-exports from this module for backward compatibility.
 */

import { createHash } from 'node:crypto';
import { normalize, resolve } from 'node:path';
import type { Context } from 'hono';
import type { RbacRole } from '../db/schema/shared/enums';
import type { AppError } from '../lib/errors/base.js';
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

/**
 * Parse a `limit` query parameter with bounds checking.
 *
 * AR-013: Standardizes limit parsing across all route files that currently do
 * `parseInt(c.req.query('limit') ?? '50', 10)` without bounds checking.
 * Use this instead of inline parseInt for consistent, safe limit handling.
 *
 * @param c - Hono context
 * @param defaultLimit - Default value when param is missing (default: 50)
 * @param maxLimit - Maximum allowed value (default: 100)
 * @returns Parsed limit clamped between 1 and maxLimit
 */
export function parseLimit(c: Context, defaultLimit = 50, maxLimit = 100): number {
  const raw = c.req.query('limit');
  if (!raw) return defaultLimit;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return defaultLimit;
  return Math.max(1, Math.min(maxLimit, parsed));
}

/**
 * Parse and validate the `offset` query parameter.
 * @param c - Hono context
 * @param defaultOffset - Default value when param is missing (default: 0)
 * @returns Parsed offset, minimum 0
 */
export function parseOffset(c: Context, defaultOffset = 0): number {
  const raw = c.req.query('offset');
  if (!raw) return defaultOffset;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return defaultOffset;
  return Math.max(0, parsed);
}

// CORS headers for SSE endpoints that bypass Hono middleware
// SC-C4: Read origin from CORS_ORIGIN env var instead of hardcoding localhost
export const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
 * SC-C2: Validate that a clone/file destination path is safe.
 * Prevents path traversal attacks by ensuring the resolved path
 * is under an allowed base directory (user's home directory).
 */
export function isValidClonePath(destination: string): boolean {
  if (!destination || typeof destination !== 'string') return false;

  // Reject null bytes and other dangerous characters early, before any path processing
  if (/[\0\n\r]/.test(destination)) return false;

  // Expand ~ to home directory
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (!homeDir) return false;

  const expanded = destination.replace(/^~/, homeDir);
  const resolved = resolve(normalize(expanded));

  // Reject path traversal: resolved path must be under the home directory
  // or under /tmp (for temporary operations)
  const allowedBases = [homeDir, '/tmp'];
  const isUnderAllowed = allowedBases.some(
    (base) => resolved === base || resolved.startsWith(`${base}/`)
  );
  if (!isUnderAllowed) return false;

  return true;
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
 * Validate a route ID parameter and return an error response if invalid.
 *
 * Eliminates the repeated `isValidId` + `json(400)` boilerplate found in
 * many route handlers.
 *
 * @example
 *   const { id, error } = validateIdParam(c, 'id');
 *   if (error) return error;
 *
 * @see CQ-003 in specs/reviews/2026-03-architecture/FINDINGS-MATRIX.md
 */
export function validateIdParam(
  c: Context,
  paramName: string
): { id: string; error: null } | { id: null; error: Response } {
  const id = c.req.param(paramName) ?? c.req.query(paramName) ?? '';
  if (!isValidId(id)) {
    return {
      id: null,
      error: json(
        { ok: false, error: { code: 'INVALID_ID', message: `Invalid ${paramName} format` } },
        400
      ),
    };
  }
  return { id, error: null };
}

/**
 * Convert a service `Result` error into a standard JSON error response.
 *
 * Most route catch blocks do:
 *   `if (!result.ok) return json({ ok: false, error: result.error }, result.error.status);`
 *
 * This helper centralizes that pattern.
 *
 * @see CQ-003 in specs/reviews/2026-03-architecture/FINDINGS-MATRIX.md
 */
export function errorResponse(result: {
  error: { code: string; message: string; status: number };
}): Response {
  return json({ ok: false, error: result.error }, result.error.status || 500);
}

/**
 * Require a query parameter to be present.
 * Returns the value if present, or a 400 error response if missing.
 */
export function requireQueryParam(
  c: Context,
  paramName: string
): { value: string; error: null } | { value: null; error: Response } {
  const value = c.req.query(paramName);
  if (!value) {
    return {
      value: null,
      error: json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: `${paramName} is required` } },
        400
      ),
    };
  }
  return { value, error: null };
}

/**
 * Require a query parameter that must also be a valid ID.
 * Combines presence check + isValidId format validation.
 */
export function requireQueryId(
  c: Context,
  paramName: string
): { id: string; error: null } | { id: null; error: Response } {
  const value = c.req.query(paramName);
  if (!value) {
    return {
      id: null,
      error: json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: `${paramName} is required` } },
        400
      ),
    };
  }
  if (!isValidId(value)) {
    return {
      id: null,
      error: json(
        { ok: false, error: { code: 'INVALID_ID', message: `Invalid ${paramName} format` } },
        400
      ),
    };
  }
  return { id: value, error: null };
}

export function requireCodespaceRole(
  auth: { authMethod: 'session' | 'api_token' | 'dev'; userId: string },
  rbacService: {
    resolveUserRole(userId: string, codespaceId: string): Promise<RbacRole | null>;
    hasMinimumRole(userRole: RbacRole, minimumRole: RbacRole): boolean;
  },
  codespaceId: string,
  minimumRole: RbacRole,
  message = `Requires ${minimumRole} role`
): Promise<Response | null> {
  if (auth.authMethod === 'dev') return Promise.resolve(null);
  return rbacService
    .resolveUserRole(auth.userId, codespaceId)
    .then((role) => {
      if (!role || !rbacService.hasMinimumRole(role, minimumRole)) {
        return json({ ok: false, error: { code: 'INSUFFICIENT_ROLE', message } }, 403);
      }
      return null;
    })
    .catch((error) => {
      log.error('Failed to resolve codespace role', {
        error,
        data: { userId: auth.userId, codespaceId },
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to verify permissions' } },
        500
      );
    });
}

/** @deprecated Use requireCodespaceRole instead */
export const requireProjectRole = requireCodespaceRole;

// ---------------------------------------------------------------------------
// AR-018: API response types consolidated from src/lib/api/response.ts
// ---------------------------------------------------------------------------

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiFailure = {
  ok: false;
  error: Omit<AppError, 'status'>;
};

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export const success = <T>(data: T): ApiSuccess<T> => ({
  ok: true,
  data,
});

export const failure = (error: AppError): ApiFailure => ({
  ok: false,
  error: {
    code: error.code,
    message: error.message,
    details: error.details,
  },
});
