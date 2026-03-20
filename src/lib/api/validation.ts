/**
 * Client-side / service-layer parsing utilities that return Result types.
 *
 * These complement the canonical Zod schemas defined in `src/server/validation.ts`.
 * Use these utilities when you need Result-based validation outside of Hono route
 * handlers (e.g., in services or client-side code). For Hono handlers, prefer
 * `parseBody` / `parseJsonBody` from `src/server/validation.ts`.
 */
import type { z } from 'zod';
import { ValidationErrors } from '../errors/validation-errors.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';

type ValidationIssue = { path: (string | number)[]; message: string };

/**
 * Maps Zod v4 issues to ValidationIssue format.
 * Zod v4 uses PropertyKey[] (string | number | symbol) for path,
 * but ValidationIssue expects (string | number)[].
 */
const mapZodIssues = (
  issues: readonly { path: PropertyKey[]; message: string }[]
): ValidationIssue[] =>
  issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
    message: issue.message,
  }));

export const parseBody = async <T>(
  request: Request,
  schema: z.ZodType<T>
): Promise<Result<T, ReturnType<typeof ValidationErrors.VALIDATION_ERROR>>> => {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return err(ValidationErrors.VALIDATION_ERROR(mapZodIssues(parsed.error.issues)));
    }
    return ok(parsed.data);
  } catch (error) {
    return err(ValidationErrors.VALIDATION_ERROR([{ path: ['body'], message: String(error) }]));
  }
};

export const parseQuery = <T>(
  params: URLSearchParams,
  schema: z.ZodType<T>
): Result<T, ReturnType<typeof ValidationErrors.VALIDATION_ERROR>> => {
  const raw = Object.fromEntries(params.entries());
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return err(ValidationErrors.VALIDATION_ERROR(mapZodIssues(parsed.error.issues)));
  }
  return ok(parsed.data);
};
