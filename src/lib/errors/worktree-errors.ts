import { createError } from './base.js';

export const WorktreeErrors = {
  CREATION_FAILED: (branch: string, error: string, cause?: unknown) =>
    createError(
      'WORKTREE_CREATION_FAILED',
      `Failed to create worktree for branch "${branch}"`,
      500,
      { branch, error },
      cause
    ),
  NOT_FOUND: createError('WORKTREE_NOT_FOUND', 'Worktree not found', 404),
  BRANCH_EXISTS: (branch: string) =>
    createError('WORKTREE_BRANCH_EXISTS', `Branch "${branch}" already exists`, 409, {
      branch,
    }),
  MERGE_CONFLICT: (files: string[]) =>
    createError('WORKTREE_MERGE_CONFLICT', 'Merge conflict detected', 409, {
      conflictingFiles: files,
    }),
  DIRTY: (files: string[]) =>
    createError('WORKTREE_DIRTY', 'Worktree has uncommitted changes', 400, {
      uncommittedFiles: files,
    }),
  REMOVAL_FAILED: (path: string, error: string, cause?: unknown) =>
    createError(
      'WORKTREE_REMOVAL_FAILED',
      `Failed to remove worktree at "${path}"`,
      500,
      { path, error },
      cause
    ),
  ENV_COPY_FAILED: (error: string, cause?: unknown) =>
    createError(
      'WORKTREE_ENV_COPY_FAILED',
      'Failed to copy environment file',
      500,
      { error },
      cause
    ),
  INIT_SCRIPT_FAILED: (script: string, error: string, cause?: unknown) =>
    createError(
      'WORKTREE_INIT_SCRIPT_FAILED',
      `Init script failed: ${script}`,
      500,
      { script, error },
      cause
    ),
} as const;

export type WorktreeError =
  | ReturnType<typeof WorktreeErrors.CREATION_FAILED>
  | typeof WorktreeErrors.NOT_FOUND
  | ReturnType<typeof WorktreeErrors.BRANCH_EXISTS>
  | ReturnType<typeof WorktreeErrors.MERGE_CONFLICT>
  | ReturnType<typeof WorktreeErrors.DIRTY>
  | ReturnType<typeof WorktreeErrors.REMOVAL_FAILED>
  | ReturnType<typeof WorktreeErrors.ENV_COPY_FAILED>
  | ReturnType<typeof WorktreeErrors.INIT_SCRIPT_FAILED>;
