/**
 * Memory routes — Internal memory service API
 *
 * CRUD endpoints for managing memory insights, skill metrics, dream sessions,
 * and skill improvement suggestions.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../lib/logging/logger.js';
import type { DreamService } from '../../services/memory/dream.service.js';
import type { MemoryService } from '../../services/memory/index.js';
import type { SkillTrackingService } from '../../services/memory/skill-tracking.service.js';
import { json } from '../shared.js';

const log = createLogger('MemoryRoutes');

// Validation schemas
const createInsightSchema = z.object({
  content: z.string().min(1).max(4096),
  source: z.enum(['manual', 'agent_derived', 'dream']).optional().default('manual'),
  skillId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const searchSchema = z.object({
  query: z.string().min(1).max(1024),
  limit: z.number().min(1).max(50).optional(),
});

const suggestionActionSchema = z.object({
  userNotes: z.string().optional(),
});

const modifySuggestionSchema = z.object({
  modifiedContent: z.string().min(1),
  userNotes: z.string().optional(),
});

/** Parse and clamp pagination query params. */
function parsePagination(c: { req: { query: (k: string) => string | undefined } }, defaults = { page: 1, size: 20 }) {
  const rawPage = Number.parseInt(c.req.query('page') ?? String(defaults.page), 10);
  const rawSize = Number.parseInt(c.req.query('size') ?? String(defaults.size), 10);
  return {
    page: Math.max(1, Number.isNaN(rawPage) ? defaults.page : rawPage),
    size: Math.min(100, Math.max(1, Number.isNaN(rawSize) ? defaults.size : rawSize)),
  };
}

interface MemoryDeps {
  memoryService: MemoryService;
  skillTrackingService: SkillTrackingService | null;
  dreamService: DreamService | null;
}

export function createMemoryRoutes({
  memoryService,
  skillTrackingService,
  dreamService,
}: MemoryDeps) {
  const app = new Hono();

  // --- Health endpoint ---

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

  // --- Insight endpoints ---

  // GET /api/memory/codespaces/:codespaceId/insights
  app.get('/codespaces/:codespaceId/insights', async (c) => {
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
      const { page, size } = parsePagination(c, { page: 1, size: 50 });

      const result = await memoryService.getInsights(codespaceId, { page, size });

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
      log.error('Failed to get insights', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get insights' } },
        500
      );
    }
  });

  // POST /api/memory/codespaces/:codespaceId/insights
  app.post('/codespaces/:codespaceId/insights', async (c) => {
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

    const parsed = createInsightSchema.safeParse(body);
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
      const result = await memoryService.createInsight(
        codespaceId,
        parsed.data.content,
        parsed.data.source,
        parsed.data.metadata,
        parsed.data.tags,
        parsed.data.skillId
      );

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value }, 201);
    } catch (error) {
      log.error('Failed to create insight', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create insight' } },
        500
      );
    }
  });

  // DELETE /api/memory/insights/:insightId
  app.delete('/insights/:insightId', async (c) => {
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
      const insightId = c.req.param('insightId');
      const result = await memoryService.deleteInsight(insightId);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: null });
    } catch (error) {
      log.error('Failed to delete insight', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete insight' } },
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
      const result = await memoryService.search(codespaceId, parsed.data.query, parsed.data.limit);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to search', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to search' } },
        500
      );
    }
  });

  // --- Skill Metrics endpoints ---

  // GET /api/memory/codespaces/:codespaceId/skill-metrics
  app.get('/codespaces/:codespaceId/skill-metrics', async (c) => {
    if (!skillTrackingService) {
      return json(
        { ok: false, error: { code: 'NOT_AVAILABLE', message: 'Skill tracking not available' } },
        503
      );
    }

    try {
      const codespaceId = c.req.param('codespaceId');
      const result = await skillTrackingService.getMetrics(codespaceId);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to get skill metrics', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get skill metrics' } },
        500
      );
    }
  });

  // GET /api/memory/codespaces/:codespaceId/skill-metrics/:skillId
  app.get('/codespaces/:codespaceId/skill-metrics/:skillId', async (c) => {
    if (!skillTrackingService) {
      return json(
        { ok: false, error: { code: 'NOT_AVAILABLE', message: 'Skill tracking not available' } },
        503
      );
    }

    try {
      const codespaceId = c.req.param('codespaceId');
      const skillId = c.req.param('skillId');
      const result = await skillTrackingService.getMetrics(codespaceId, skillId);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value[0] ?? null });
    } catch (error) {
      log.error('Failed to get skill metric', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get skill metric' } },
        500
      );
    }
  });

  // GET /api/memory/codespaces/:codespaceId/skill-metrics/:skillId/executions
  app.get('/codespaces/:codespaceId/skill-metrics/:skillId/executions', async (c) => {
    if (!skillTrackingService) {
      return json(
        { ok: false, error: { code: 'NOT_AVAILABLE', message: 'Skill tracking not available' } },
        503
      );
    }

    try {
      const codespaceId = c.req.param('codespaceId');
      const skillId = c.req.param('skillId');
      const { page, size } = parsePagination(c);

      const result = await skillTrackingService.getExecutionHistory(codespaceId, skillId, {
        page,
        size,
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
      log.error('Failed to get skill executions', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get skill executions' } },
        500
      );
    }
  });

  // --- Dream endpoints ---

  // GET /api/memory/codespaces/:codespaceId/dream-sessions
  app.get('/codespaces/:codespaceId/dream-sessions', async (c) => {
    if (!dreamService) {
      return json(
        { ok: false, error: { code: 'NOT_AVAILABLE', message: 'Dream service not available' } },
        503
      );
    }

    try {
      const codespaceId = c.req.param('codespaceId');
      const { page, size } = parsePagination(c);

      const result = await dreamService.getDreamSessions(codespaceId, { page, size });

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
      log.error('Failed to get dream sessions', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get dream sessions' } },
        500
      );
    }
  });

  // POST /api/memory/codespaces/:codespaceId/dream — trigger manual dream cycle
  app.post('/codespaces/:codespaceId/dream', async (c) => {
    if (!dreamService) {
      return json(
        { ok: false, error: { code: 'NOT_AVAILABLE', message: 'Dream service not available' } },
        503
      );
    }

    try {
      const codespaceId = c.req.param('codespaceId');
      const result = await dreamService.runDreamCycle(codespaceId);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value }, 201);
    } catch (error) {
      log.error('Failed to trigger dream cycle', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to trigger dream cycle' } },
        500
      );
    }
  });

  // --- Skill Suggestion endpoints ---

  // GET /api/memory/codespaces/:codespaceId/suggestions
  app.get('/codespaces/:codespaceId/suggestions', async (c) => {
    if (!dreamService) {
      return json(
        { ok: false, error: { code: 'NOT_AVAILABLE', message: 'Dream service not available' } },
        503
      );
    }

    try {
      const codespaceId = c.req.param('codespaceId');
      const statusParam = c.req.query('status');
      const validStatuses = ['pending', 'accepted', 'rejected', 'modified'] as const;
      const status =
        statusParam && validStatuses.includes(statusParam as (typeof validStatuses)[number])
          ? (statusParam as (typeof validStatuses)[number])
          : undefined;
      const skillId = c.req.query('skillId');
      const { page, size } = parsePagination(c);

      const result = await dreamService.getSkillSuggestions(
        codespaceId,
        { status, skillId },
        { page, size }
      );

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
      log.error('Failed to get suggestions', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get suggestions' } },
        500
      );
    }
  });

  // PATCH /api/memory/suggestions/:id/accept
  app.patch('/suggestions/:id/accept', async (c) => {
    if (!dreamService) {
      return json(
        { ok: false, error: { code: 'NOT_AVAILABLE', message: 'Dream service not available' } },
        503
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // body is optional
    }

    const parsed = suggestionActionSchema.safeParse(body);

    try {
      const id = c.req.param('id');
      const result = await dreamService.acceptSuggestion(
        id,
        parsed.success ? parsed.data.userNotes : undefined
      );

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to accept suggestion', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to accept suggestion' } },
        500
      );
    }
  });

  // PATCH /api/memory/suggestions/:id/reject
  app.patch('/suggestions/:id/reject', async (c) => {
    if (!dreamService) {
      return json(
        { ok: false, error: { code: 'NOT_AVAILABLE', message: 'Dream service not available' } },
        503
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // body is optional
    }

    const parsed = suggestionActionSchema.safeParse(body);

    try {
      const id = c.req.param('id');
      const result = await dreamService.rejectSuggestion(
        id,
        parsed.success ? parsed.data.userNotes : undefined
      );

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to reject suggestion', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to reject suggestion' } },
        500
      );
    }
  });

  // PATCH /api/memory/suggestions/:id/modify
  app.patch('/suggestions/:id/modify', async (c) => {
    if (!dreamService) {
      return json(
        { ok: false, error: { code: 'NOT_AVAILABLE', message: 'Dream service not available' } },
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

    const parsed = modifySuggestionSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'modifiedContent is required',
          },
        },
        400
      );
    }

    try {
      const id = c.req.param('id');
      const result = await dreamService.modifySuggestion(
        id,
        parsed.data.modifiedContent,
        parsed.data.userNotes
      );

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to modify suggestion', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to modify suggestion' } },
        500
      );
    }
  });

  // --- Legacy compatibility routes (redirect old endpoints) ---

  // GET /api/memory/codespaces/:codespaceId/conclusions → insights
  app.get('/codespaces/:codespaceId/conclusions', async (c) => {
    const codespaceId = c.req.param('codespaceId');
    return c.redirect(`/api/memory/codespaces/${codespaceId}/insights`, 301);
  });

  return app;
}
