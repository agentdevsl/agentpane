import { createError } from './base.js';

export const GitErrors = {
  PROJECT_NOT_FOUND: createError('GIT_PROJECT_NOT_FOUND', 'Project not found', 404),
  INVALID_BRANCH: createError('GIT_INVALID_BRANCH', 'Invalid branch name', 400),
  COMMAND_FAILED: (message: string) => createError('GIT_COMMAND_FAILED', message, 500),
  DATABASE_ERROR: (message: string) => createError('GIT_DATABASE_ERROR', message, 500),
} as const;

export type GitError =
  | typeof GitErrors.PROJECT_NOT_FOUND
  | typeof GitErrors.INVALID_BRANCH
  | ReturnType<typeof GitErrors.COMMAND_FAILED>
  | ReturnType<typeof GitErrors.DATABASE_ERROR>;
