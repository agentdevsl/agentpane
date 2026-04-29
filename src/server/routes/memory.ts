/**
 * Memory routes — Internal memory service API
 *
 * CRUD endpoints for managing memory insights, skill metrics, dream sessions,
 * and skill improvement suggestions.
 */

import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { codespaces, sessionEvents, tasks } from '../../db/schema/index.js';
import { jsonExtractText } from '../../lib/db/dialect.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { DreamService } from '../../services/memory/dream.service.js';
import type { MemoryService } from '../../services/memory/index.js';
import type { SkillTrackingService } from '../../services/memory/skill-tracking.service.js';
import type { Database } from '../../types/database.js';
import { json } from '../shared.js';
import {
  createMemoryInsightSchema,
  dreamSkillOverrideSchema,
  memoryModifySuggestionSchema,
  memorySearchSchema,
  memorySuggestionActionSchema,
  parseJsonBody,
} from '../validation.js';

const log = createLogger('MemoryRoutes');

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
  db: Database;
}

export function createMemoryRoutes({
  memoryService,
  skillTrackingService,
  dreamService,
  db,
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

      // Parse optional filters
      const statusParam = c.req.query('status');
      const validStatuses = ['active', 'pending_review', 'rejected'] as const;
      type InsightStatus = (typeof validStatuses)[number];
      const status: InsightStatus | undefined =
        statusParam && validStatuses.includes(statusParam as InsightStatus)
          ? (statusParam as InsightStatus)
          : undefined;

      const validCategories = [
        'pattern',
        'anti_pattern',
        'decision',
        'architecture',
        'error_lesson',
      ] as const;
      type InsightCategory = (typeof validCategories)[number];
      const categoryParam = c.req.query('category');
      const category: InsightCategory | undefined =
        categoryParam && validCategories.includes(categoryParam as InsightCategory)
          ? (categoryParam as InsightCategory)
          : undefined;

      const result = await memoryService.getInsights(
        codespaceId,
        { page, size },
        { status, category }
      );
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
    const parsed = await parseJsonBody(c, memorySearchSchema);
    if (!parsed.ok) return parsed.response;

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
    // Body shape: either `null`, `{}` (clear override), or
    // `{ enabled?, model?, minRuns? }`. Use the structured zod schema to
    // validate populated payloads; the null/empty-object case is treated as
    // "clear the override" (matching the previous behaviour).
    //
    // HONO-ALLOW-UNTYPED: zod cannot represent a JSON literal `null` at the
    // root of a request body. We accept null/{}/object here, then validate
    // the populated case via `dreamSkillOverrideSchema.safeParse` below.
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (err) {
      if (err instanceof SyntaxError) {
        return json(
          { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } },
          400
        );
      }
      return json(
        {
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'Failed to read request body' },
        },
        400
      );
    }

    const skillId = c.req.param('skillId');

    // null body OR empty object means clear the override (client sends {} when null
    // cannot be serialized via JSON, e.g. `override ?? {}`).
    const isClearOverride =
      rawBody === null ||
      (typeof rawBody === 'object' &&
        rawBody !== null &&
        !Array.isArray(rawBody) &&
        Object.keys(rawBody as object).length === 0);

    let override: { enabled?: boolean; model?: string; minRuns?: number } | null = null;
    if (!isClearOverride) {
      const parsed = dreamSkillOverrideSchema.safeParse(rawBody);
      if (!parsed.success) {
        return json(
          {
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: parsed.error.issues[0]?.message ?? 'Invalid skill override',
            },
          },
          400
        );
      }
      override = parsed.data ?? null;
    }

    return wrapHandler('Failed to set dream skill override', async () => {
      const result = await dreamService.setSkillOverride(skillId, override);
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: null });
    });
  });

  // --- Insight injection history endpoint ---

  app.get('/insights/:insightId/injections', (c) =>
    wrapHandler('Failed to get insight injections', async () => {
      const insightId = c.req.param('insightId');
      if (!insightId || !/^[a-z0-9]{20,30}$/.test(insightId)) {
        return json(
          { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid insightId' } },
          400
        );
      }
      const { page, size } = parsePagination(c);
      const offset = (page - 1) * size;

      // F02-15: portable JSON-path text extraction. SQLite renders the
      // array as `'["abc","def"]'`; Postgres `#>>` on a `jsonb` column
      // renders `'["abc", "def"]'` (with spaces). The downstream
      // `filtered` step does an exact array-includes check after parsing
      // the row's JSON column, so the LIKE filter is a coarse pre-filter.
      const rows = await db
        .select({
          id: sessionEvents.id,
          sessionId: sessionEvents.sessionId,
          data: sessionEvents.data,
          timestamp: sessionEvents.timestamp,
        })
        .from(sessionEvents)
        .where(
          and(
            eq(sessionEvents.type, 'memory:insights_injected'),
            sql`${jsonExtractText(sessionEvents.data, 'insightIds')} LIKE ${`%${insightId}%`}`
          )
        )
        .orderBy(sql`${sessionEvents.timestamp} DESC`)
        .limit(size)
        .offset(offset);

      // Filter to rows that actually contain the insightId in the array
      const filtered = rows.filter((row) => {
        const data = row.data as Record<string, unknown> | null;
        const ids = data?.insightIds;
        return Array.isArray(ids) && ids.includes(insightId);
      });

      // Resolve codespace names and task titles
      const codespaceIds = new Set<string>();
      const taskIds = new Set<string>();
      for (const row of filtered) {
        const data = row.data as Record<string, unknown>;
        if (typeof data.codespaceId === 'string') codespaceIds.add(data.codespaceId);
        if (typeof data.taskId === 'string') taskIds.add(data.taskId);
      }

      const codespaceNames = new Map<string, string>();
      if (codespaceIds.size > 0) {
        try {
          const csRows = await db
            .select({ id: codespaces.id, name: codespaces.name })
            .from(codespaces)
            .where(
              sql`${codespaces.id} IN (${sql.join(
                [...codespaceIds].map((id) => sql`${id}`),
                sql`, `
              )})`
            );
          for (const cs of csRows) codespaceNames.set(cs.id, cs.name);
        } catch (err) {
          log.warn('Failed to resolve codespace names for injection history', { error: err });
        }
      }

      const taskTitles = new Map<string, string>();
      if (taskIds.size > 0) {
        try {
          const taskRows = await db
            .select({ id: tasks.id, title: tasks.title })
            .from(tasks)
            .where(
              sql`${tasks.id} IN (${sql.join(
                [...taskIds].map((id) => sql`${id}`),
                sql`, `
              )})`
            );
          for (const t of taskRows) taskTitles.set(t.id, t.title);
        } catch (err) {
          log.warn('Failed to resolve task titles for injection history', { error: err });
        }
      }

      const injections = filtered.map((row) => {
        const data = row.data as Record<string, unknown>;
        const csId = typeof data.codespaceId === 'string' ? data.codespaceId : null;
        const tId = typeof data.taskId === 'string' ? data.taskId : null;
        return {
          sessionId: row.sessionId,
          agentId: typeof data.agentId === 'string' ? data.agentId : '',
          taskId: tId,
          taskTitle: tId ? (taskTitles.get(tId) ?? null) : null,
          codespaceId: csId,
          codespaceName: csId ? (codespaceNames.get(csId) ?? null) : null,
          insightCount: typeof data.insightCount === 'number' ? data.insightCount : 0,
          tokenCount: typeof data.tokenCount === 'number' ? data.tokenCount : 0,
          timestamp: row.timestamp,
        };
      });

      return json({
        ok: true,
        data: injections,
        pagination: { page, size, hasMore: filtered.length === size },
      });
    })
  );

  // ===========================================================================
  // Codespace-scoped endpoints
  // ===========================================================================

  app.get('/codespaces/:codespaceId/insights', (c) =>
    handleGetInsights(c, c.req.param('codespaceId'))
  );

  // POST /api/memory/codespaces/:codespaceId/insights
  app.post('/codespaces/:codespaceId/insights', async (c) => {
    const parsed = await parseJsonBody(c, createMemoryInsightSchema);
    if (!parsed.ok) return parsed.response;

    return wrapHandler('Failed to create insight', async () => {
      const codespaceId = c.req.param('codespaceId');
      const result = await memoryService.createInsight(
        codespaceId,
        parsed.data.content,
        parsed.data.source,
        parsed.data.metadata,
        parsed.data.tags,
        parsed.data.skillId,
        undefined, // status — use service default
        parsed.data.category
      );
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: result.value }, 201);
    });
  });

  app.delete('/insights/:insightId', (c) =>
    wrapHandler('Failed to delete insight', async () => {
      const insightId = c.req.param('insightId');
      if (!insightId || !/^[a-z0-9]{20,30}$/.test(insightId)) {
        return json(
          { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid insightId' } },
          400
        );
      }
      const result = await memoryService.deleteInsight(insightId);
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: null });
    })
  );

  // Approve insight (set status to active)
  app.patch('/insights/:insightId/approve', (c) =>
    wrapHandler('Failed to approve insight', async () => {
      const insightId = c.req.param('insightId');
      if (!insightId || !/^[a-z0-9]{20,30}$/.test(insightId)) {
        return json(
          { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid insightId' } },
          400
        );
      }
      const result = await memoryService.approveInsight(insightId);
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: result.value });
    })
  );

  // Reject insight (set status to rejected)
  app.patch('/insights/:insightId/reject', (c) =>
    wrapHandler('Failed to reject insight', async () => {
      const insightId = c.req.param('insightId');
      if (!insightId || !/^[a-z0-9]{20,30}$/.test(insightId)) {
        return json(
          { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid insightId' } },
          400
        );
      }
      const result = await memoryService.rejectInsight(insightId);
      if (!result.ok) return resultError(result);
      return json({ ok: true, data: result.value });
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

  // Accept and reject share identical structure — only the service method differs.
  // Body is optional; userNotes is the only valid field. When Content-Type is
  // not application/json (or omitted), we treat the body as missing and skip
  // validation — matching the previous behaviour.
  async function handleSuggestionAction(
    c: {
      req: {
        param: (k: string) => string;
        header: (name: string) => string | undefined;
        json: () => Promise<unknown>;
      };
    },
    action: 'accept' | 'reject'
  ): Promise<Response> {
    let userNotes: string | undefined;
    if (c.req.header('Content-Type')?.includes('application/json')) {
      const parsed = await parseJsonBody(c, memorySuggestionActionSchema);
      if (!parsed.ok) return parsed.response;
      userNotes = parsed.data.userNotes;
    }

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
    const parsed = await parseJsonBody(c, memoryModifySuggestionSchema);
    if (!parsed.ok) return parsed.response;

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
