import { createError } from './base.js';

export const MemoryErrors = {
  UNAVAILABLE: createError('MEMORY_UNAVAILABLE', 'Memory service is not available', 503),
  CONNECTION_FAILED: (url: string) =>
    createError('MEMORY_CONNECTION_FAILED', `Failed to connect to Honcho at ${url}`, 503, {
      url,
    }),
  WORKSPACE_ERROR: (workspace: string) =>
    createError('MEMORY_WORKSPACE_ERROR', `Failed to manage workspace: ${workspace}`, 500, {
      workspace,
    }),
  SESSION_ERROR: (detail: string) =>
    createError('MEMORY_SESSION_ERROR', `Memory session error: ${detail}`, 500, { detail }),
  QUERY_ERROR: (detail: string) =>
    createError('MEMORY_QUERY_ERROR', `Memory query failed: ${detail}`, 500, { detail }),
  CAPTURE_ERROR: (detail: string) =>
    createError('MEMORY_CAPTURE_ERROR', `Memory capture failed: ${detail}`, 500, { detail }),
  NOT_FOUND: (entity: string) =>
    createError('MEMORY_NOT_FOUND', `Memory entity not found: ${entity}`, 404, { entity }),
} as const;

export type MemoryError =
  | typeof MemoryErrors.UNAVAILABLE
  | ReturnType<typeof MemoryErrors.CONNECTION_FAILED>
  | ReturnType<typeof MemoryErrors.WORKSPACE_ERROR>
  | ReturnType<typeof MemoryErrors.SESSION_ERROR>
  | ReturnType<typeof MemoryErrors.QUERY_ERROR>
  | ReturnType<typeof MemoryErrors.CAPTURE_ERROR>
  | ReturnType<typeof MemoryErrors.NOT_FOUND>;
