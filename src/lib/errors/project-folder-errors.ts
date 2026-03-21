import { createError } from './base.js';

export const ProjectFolderErrors = {
  NOT_FOUND: createError('PROJECT_FOLDER_NOT_FOUND', 'Project folder not found', 404),
  SLUG_EXISTS: createError(
    'PROJECT_FOLDER_SLUG_EXISTS',
    'A project folder with this slug already exists',
    409
  ),
  HAS_CODESPACES: (count: number) =>
    createError(
      'PROJECT_FOLDER_HAS_CODESPACES',
      `Cannot delete project folder with ${count} codespace(s)`,
      409,
      { codespaceCount: count }
    ),
  INVALID_INPUT: (errors: string[]) =>
    createError('PROJECT_FOLDER_INVALID_INPUT', 'Invalid project folder input', 400, {
      validationErrors: errors,
    }),
} as const;

export type ProjectFolderError =
  | typeof ProjectFolderErrors.NOT_FOUND
  | typeof ProjectFolderErrors.SLUG_EXISTS
  | ReturnType<typeof ProjectFolderErrors.HAS_CODESPACES>
  | ReturnType<typeof ProjectFolderErrors.INVALID_INPUT>;
