/**
 * Memory admin routes
 *
 * CRUD endpoints for managing Honcho memory conclusions, sessions, and search.
 * All admin endpoints require memory service availability (503 if unavailable).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../lib/logging/logger.js';
import type { MemoryService } from '../../services/memory/index.js';
import { json } from '../shared.js';

const log = createLogger('MemoryRoutes');

// Validation schemas
const createConclusionSchema = z.object({
  content: z.string().min(1).max(4096),
});

const searchSchema = z.object({
  query: z.string().min(1).max(1024),
  limit: z.number().min(1).max(50).optional(),
});

interface MemoryDeps {
  memoryService: MemoryService;
}

export function createMemoryRoutes({ memoryService }: MemoryDeps) {
  const app = new Hono();

  // --- Health endpoint (does not require availability guard) ---

  // GET /api/memory/health
  app.get('/health', async () => {
    try {
      const result = await memoryService.healthCheck();
      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }
      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Health check failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Health check failed' } },
        500
      );
    }
  });

  // --- Admin endpoints (guarded by availability check) ---

  // GET /api/memory/codespaces/:codespaceId/conclusions
  app.get('/codespaces/:codespaceId/conclusions', async (c) => {
    if (!memoryService.isAvailable()) {
      return json(
        {
          ok: false,
          error: { code: 'MEMORY_UNAVAILABLE', message: 'Memory service is not available' },
        },
        503
      );
    }

    try {
      const codespaceId = c.req.param('codespaceId');
      const page = Number.parseInt(c.req.query('page') ?? '1', 10);
      const size = Number.parseInt(c.req.query('size') ?? '50', 10);

      const result = await memoryService.getConclusions(codespaceId, {
        page: Number.isNaN(page) ? 1 : page,
        size: Number.isNaN(size) ? 50 : size,
      });

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({
        ok: true,
        data: result.value,
        pagination: { page, size, hasMore: result.value.length === size },
      });
    } catch (error) {
      log.error('Failed to get conclusions', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get conclusions' } },
        500
      );
    }
  });

  // POST /api/memory/codespaces/:codespaceId/conclusions
  app.post('/codespaces/:codespaceId/conclusions', async (c) => {
    if (!memoryService.isAvailable()) {
      return json(
        {
          ok: false,
          error: { code: 'MEMORY_UNAVAILABLE', message: 'Memory service is not available' },
        },
        503
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const parsed = createConclusionSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'content is required',
          },
        },
        400
      );
    }

    try {
      const codespaceId = c.req.param('codespaceId');
      const result = await memoryService.createConclusion(codespaceId, parsed.data.content);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value }, 201);
    } catch (error) {
      log.error('Failed to create conclusion', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create conclusion' } },
        500
      );
    }
  });

  // DELETE /api/memory/conclusions/:conclusionId
  app.delete('/conclusions/:conclusionId', async (c) => {
    if (!memoryService.isAvailable()) {
      return json(
        {
          ok: false,
          error: { code: 'MEMORY_UNAVAILABLE', message: 'Memory service is not available' },
        },
        503
      );
    }

    try {
      const conclusionId = c.req.param('conclusionId');
      const codespaceId = c.req.query('codespaceId');

      if (!codespaceId) {
        return json(
          {
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: 'codespaceId query parameter is required' },
          },
          400
        );
      }

      const result = await memoryService.deleteConclusion(codespaceId, conclusionId);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: null });
    } catch (error) {
      log.error('Failed to delete conclusion', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete conclusion' } },
        500
      );
    }
  });

  // GET /api/memory/codespaces/:codespaceId/sessions
  app.get('/codespaces/:codespaceId/sessions', async (c) => {
    if (!memoryService.isAvailable()) {
      return json(
        {
          ok: false,
          error: { code: 'MEMORY_UNAVAILABLE', message: 'Memory service is not available' },
        },
        503
      );
    }

    try {
      const codespaceId = c.req.param('codespaceId');
      const page = Number.parseInt(c.req.query('page') ?? '1', 10);
      const size = Number.parseInt(c.req.query('size') ?? '50', 10);

      const result = await memoryService.getSessions(codespaceId, {
        page: Number.isNaN(page) ? 1 : page,
        size: Number.isNaN(size) ? 50 : size,
      });

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({
        ok: true,
        data: result.value,
        pagination: { page, size, hasMore: result.value.length === size },
      });
    } catch (error) {
      log.error('Failed to get sessions', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get sessions' } },
        500
      );
    }
  });

  // POST /api/memory/codespaces/:codespaceId/search
  app.post('/codespaces/:codespaceId/search', async (c) => {
    if (!memoryService.isAvailable()) {
      return json(
        {
          ok: false,
          error: { code: 'MEMORY_UNAVAILABLE', message: 'Memory service is not available' },
        },
        503
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const parsed = searchSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'query is required',
          },
        },
        400
      );
    }

    try {
      const codespaceId = c.req.param('codespaceId');
      const result = await memoryService.search(codespaceId, parsed.data.query, {
        limit: parsed.data.limit,
      });

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to search conclusions', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to search' } },
        500
      );
    }
  });

  return app;
}
