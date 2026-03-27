import { createError } from './base.js';

export const MemoryErrors = {
  UNAVAILABLE: createError('MEMORY_UNAVAILABLE', 'Memory service is not available', 503),
  SESSION_ERROR: (detail: string) =>
    createError('MEMORY_SESSION_ERROR', `Memory session error: ${detail}`, 500, { detail }),
  QUERY_ERROR: (detail: string) =>
    createError('MEMORY_QUERY_ERROR', `Memory query failed: ${detail}`, 500, { detail }),
  CAPTURE_ERROR: (detail: string) =>
    createError('MEMORY_CAPTURE_ERROR', `Memory capture failed: ${detail}`, 500, { detail }),
  DERIVATION_ERROR: (detail: string) =>
    createError('MEMORY_DERIVATION_ERROR', `Insight derivation failed: ${detail}`, 500, {
      detail,
    }),
  NOT_FOUND: (entity: string) =>
    createError('MEMORY_NOT_FOUND', `Memory entity not found: ${entity}`, 404, { entity }),
} as const;

export type MemoryError =
  | typeof MemoryErrors.UNAVAILABLE
  | ReturnType<typeof MemoryErrors.SESSION_ERROR>
  | ReturnType<typeof MemoryErrors.QUERY_ERROR>
  | ReturnType<typeof MemoryErrors.CAPTURE_ERROR>
  | ReturnType<typeof MemoryErrors.DERIVATION_ERROR>
  | ReturnType<typeof MemoryErrors.NOT_FOUND>;
