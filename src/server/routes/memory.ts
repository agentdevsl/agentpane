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
function parsePagination(
  c: { req: { query: (k: string) => string | undefined } },
  defaults = { page: 1, size: 20 }
) {
  const rawPage = Number.parseInt(c.req.query('page') ?? String(defaults.page), 10);
  const rawSize = Number.parseInt(c.req.query('size') ?? String(defaults.size), 10);
  return {
    page: Math.max(1, Number.isNaN(rawPage) ? defaults.page : rawPage),
    size: Math.min(100, Math.max(1, Number.isNaN(rawSize) ? defaults.size : rawSize)),
  };
}

interface MemoryDeps {
  memoryService: MemoryService;
  skillTrackingService: SkillTrackingService;
  dreamService: DreamService;
}

export function createMemoryRoutes({
  memoryService,
  skillTrackingService,
  dreamService,
}: MemoryDeps) {
  const app = new Hono();

  // ---------------------------------------------------------------------------
  // Shared handler helpers — global and codespace-scoped routes share logic,
  // differing only in whether codespaceId is null or extracted from the path.
  // ---------------------------------------------------------------------------

  /** Wrap a service call with standard error logging and JSON error response. */
  function wrapHandler(label: string, handler: () => Promise<Response>): Promise<Response> {
    return handler().catch((error) => {
      log.error(label, {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return json({ ok: false, error: { code: 'INTERNAL_ERROR', message: label } }, 500);
    });
  }

  /** Return a Result error as a JSON response. */
  function resultError(result: { error: { code: string; message: string; status: number } }) {
    return json(
      { ok: false, error: { code: result.error.code, message: result.error.message } },
      result.error.status
    );
  }

  async function handleGetInsights(
    c: { req: { query: (k: string) => string | undefined } },
    codespaceId: string | null
  ): Promise<Response> {
    return wrapHandler('Failed to get insights', async () => {
      const { page, size } = parsePagination(c, { page: 1, size: 50 });
      const result = await memoryService.getInsights(codespaceId, { page, size });
      if (!result.ok) return resultError(result);
      return json({
        ok: true,
        data: result.value,
        pagination: { page, size, hasMore: result.value.length === size },
      });
    });
  }

  async function handleSearch(
    c: { req: { json: () => Promise<unknown> } },
    codespaceId: string | null
  ): Promise<Response> {
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

    return wrapHandler('Failed to search', async () => {
      const result = await memoryService.search(codespaceId, parsed.data.query, parsed.data.limit);
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: result.value });
    });
  }

  async function handleGetSkillMetrics(codespaceId: string | null): Promise<Response> {
    return wrapHandler('Failed to get skill metrics', async () => {
      const result = await skillTrackingService.getMetrics(codespaceId);
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: result.value });
    });
  }

  async function handleGetDreamSessions(
    c: { req: { query: (k: string) => string | undefined } },
    codespaceId: string | null
  ): Promise<Response> {
    return wrapHandler('Failed to get dream sessions', async () => {
      const { page, size } = parsePagination(c);
      const result = await dreamService.getDreamSessions(codespaceId, { page, size });
      if (!result.ok) return resultError(result);
      return json({
        ok: true,
        data: result.value,
        pagination: { page, size, hasMore: result.value.length === size },
      });
    });
  }

  async function handleGetSuggestions(
    c: { req: { query: (k: string) => string | undefined } },
    codespaceId: string | null
  ): Promise<Response> {
    return wrapHandler('Failed to get suggestions', async () => {
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
      if (!result.ok) return resultError(result);
      return json({
        ok: true,
        data: result.value,
        pagination: { page, size, hasMore: result.value.length === size },
      });
    });
  }

  // --- Health endpoint ---

  app.get('/health', async () => {
    return wrapHandler('Health check failed', async () => {
      const result = await memoryService.healthCheck();
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: result.value });
    });
  });

  // ===========================================================================
  // Global (non-codespace-scoped) endpoints — must be registered BEFORE
  // the codespace-scoped routes to avoid Hono path conflicts.
  // ===========================================================================

  app.get('/insights', (c) => handleGetInsights(c, null));
  app.post('/search', (c) => handleSearch(c, null));
  app.get('/skill-metrics', () => handleGetSkillMetrics(null));
  app.get('/skill-metrics/:skillId/executions', (c) =>
    wrapHandler('Failed to get skill executions', async () => {
      const { page, size } = parsePagination(c);
      const result = await skillTrackingService.getExecutionHistory(null, c.req.param('skillId'), {
        page,
        size,
      });
      if (!result.ok) return resultError(result);
      return json({
        ok: true,
        data: result.value,
        pagination: { page, size, hasMore: result.value.length === size },
      });
    })
  );
  app.get('/dream-sessions', (c) => handleGetDreamSessions(c, null));
  app.get('/suggestions', (c) => handleGetSuggestions(c, null));

  // --- Per-skill dream config override endpoints ---

  app.get('/dream-config/skills', () =>
    wrapHandler('Failed to get dream skill overrides', async () => {
      const data = await dreamService.getSkillOverrides();
      return json({ ok: true, data });
    })
  );

  app.put('/dream-config/skills/:skillId', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const skillId = c.req.param('skillId');

    // null body OR empty object means clear the override (client sends {} when null
    // cannot be serialized via JSON, e.g. `override ?? {}`)
    const override =
      body === null || (typeof body === 'object' && Object.keys(body as object).length === 0)
        ? null
        : (body as { enabled?: boolean; model?: string; minRuns?: number });

    return wrapHandler('Failed to set dream skill override', async () => {
      const result = await dreamService.setSkillOverride(skillId, override);
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: null });
    });
  });

  // ===========================================================================
  // Codespace-scoped endpoints
  // ===========================================================================

  app.get('/codespaces/:codespaceId/insights', (c) =>
    handleGetInsights(c, c.req.param('codespaceId'))
  );

  // POST /api/memory/codespaces/:codespaceId/insights
  app.post('/codespaces/:codespaceId/insights', async (c) => {
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

    return wrapHandler('Failed to create insight', async () => {
      const codespaceId = c.req.param('codespaceId');
      const result = await memoryService.createInsight(
        codespaceId,
        parsed.data.content,
        parsed.data.source,
        parsed.data.metadata,
        parsed.data.tags,
        parsed.data.skillId
      );
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: result.value }, 201);
    });
  });

  app.delete('/insights/:insightId', (c) =>
    wrapHandler('Failed to delete insight', async () => {
      const result = await memoryService.deleteInsight(c.req.param('insightId'));
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: null });
    })
  );

  app.post('/codespaces/:codespaceId/search', (c) => handleSearch(c, c.req.param('codespaceId')));

  // --- Skill Metrics endpoints ---

  app.get('/codespaces/:codespaceId/skill-metrics', (c) =>
    handleGetSkillMetrics(c.req.param('codespaceId'))
  );

  app.get('/codespaces/:codespaceId/skill-metrics/:skillId', (c) =>
    wrapHandler('Failed to get skill metric', async () => {
      const result = await skillTrackingService.getMetrics(
        c.req.param('codespaceId'),
        c.req.param('skillId')
      );
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: result.value[0] ?? null });
    })
  );

  app.get('/codespaces/:codespaceId/skill-metrics/:skillId/executions', (c) =>
    wrapHandler('Failed to get skill executions', async () => {
      const { page, size } = parsePagination(c);
      const result = await skillTrackingService.getExecutionHistory(
        c.req.param('codespaceId'),
        c.req.param('skillId'),
        { page, size }
      );
      if (!result.ok) return resultError(result);
      return json({
        ok: true,
        data: result.value,
        pagination: { page, size, hasMore: result.value.length === size },
      });
    })
  );

  // --- Dream endpoints ---

  app.get('/codespaces/:codespaceId/dream-sessions', (c) =>
    handleGetDreamSessions(c, c.req.param('codespaceId'))
  );

  app.post('/codespaces/:codespaceId/dream', (c) =>
    wrapHandler('Failed to trigger dream cycle', async () => {
      const result = await dreamService.runDreamCycle(c.req.param('codespaceId'));
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: result.value }, 201);
    })
  );

  // --- Skill Suggestion endpoints ---

  app.get('/codespaces/:codespaceId/suggestions', (c) =>
    handleGetSuggestions(c, c.req.param('codespaceId'))
  );

  // Accept and reject share identical structure — only the service method differs
  async function handleSuggestionAction(
    c: { req: { param: (k: string) => string; json: () => Promise<unknown> } },
    action: 'accept' | 'reject'
  ): Promise<Response> {
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // body is optional
    }

    const parsed = suggestionActionSchema.safeParse(body);
    const userNotes = parsed.success ? parsed.data.userNotes : undefined;
    const serviceFn =
      action === 'accept'
        ? dreamService.acceptSuggestion.bind(dreamService)
        : dreamService.rejectSuggestion.bind(dreamService);

    return wrapHandler(`Failed to ${action} suggestion`, async () => {
      const result = await serviceFn(c.req.param('id'), userNotes);
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: result.value });
    });
  }

  app.patch('/suggestions/:id/accept', (c) => handleSuggestionAction(c, 'accept'));
  app.patch('/suggestions/:id/reject', (c) => handleSuggestionAction(c, 'reject'));

  app.patch('/suggestions/:id/modify', async (c) => {
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

    return wrapHandler('Failed to modify suggestion', async () => {
      const result = await dreamService.modifySuggestion(
        c.req.param('id'),
        parsed.data.modifiedContent,
        parsed.data.userNotes
      );
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: result.value });
    });
  });

  // --- Legacy compatibility routes (redirect old endpoints) ---

  // GET /api/memory/codespaces/:codespaceId/conclusions → insights
  app.get('/codespaces/:codespaceId/conclusions', async (c) => {
    const codespaceId = c.req.param('codespaceId');
    return c.redirect(`/api/memory/codespaces/${codespaceId}/insights`, 301);
  });

  return app;
}
