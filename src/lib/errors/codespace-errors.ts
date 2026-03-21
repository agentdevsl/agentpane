import { createError } from './base.js';

export const CodespaceErrors = {
  NOT_FOUND: createError('CODESPACE_NOT_FOUND', 'Codespace not found', 404),
  PATH_EXISTS: createError(
    'CODESPACE_PATH_EXISTS',
    'A codespace with this path already exists',
    409
  ),
  PATH_INVALID: (path: string) =>
    createError('CODESPACE_PATH_INVALID', `Invalid codespace path: ${path}`, 400, {
      path,
    }),
  NOT_A_GIT_REPO: (path: string) =>
    createError('CODESPACE_NOT_A_GIT_REPO', `Path is not a git repository: ${path}`, 400, {
      path,
    }),
  HAS_RUNNING_AGENTS: (count: number) =>
    createError(
      'CODESPACE_HAS_RUNNING_AGENTS',
      `Cannot delete codespace with ${count} running agent(s)`,
      409,
      { runningAgentCount: count }
    ),
  CONFIG_INVALID: (errors: string[]) =>
    createError('CODESPACE_CONFIG_INVALID', 'Invalid codespace configuration', 400, {
      validationErrors: errors,
    }),
} as const;

export type CodespaceError =
  | typeof CodespaceErrors.NOT_FOUND
  | typeof CodespaceErrors.PATH_EXISTS
  | ReturnType<typeof CodespaceErrors.PATH_INVALID>
  | ReturnType<typeof CodespaceErrors.NOT_A_GIT_REPO>
  | ReturnType<typeof CodespaceErrors.HAS_RUNNING_AGENTS>
  | ReturnType<typeof CodespaceErrors.CONFIG_INVALID>;
