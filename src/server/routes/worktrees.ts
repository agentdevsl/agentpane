/**
 * Worktree routes
 */

import { Hono } from 'hono';
import { createLogger } from '../../lib/logging/logger.js';
import type { WorktreeService } from '../../services/worktree.service.js';
import { json, validateIdParam } from '../shared.js';

const log = createLogger('worktree-routes');

import {
  commitWorktreeSchema,
  createWorktreeSchema,
  mergeWorktreeSchema,
  parseBody,
} from '../validation.js';

interface WorktreesDeps {
  worktreeService: WorktreeService;
}

export function createWorktreesRoutes({ worktreeService }: WorktreesDeps) {
  const app = new Hono();

  // GET /api/worktrees
  app.get('/', async (c) => {
    const codespaceId = c.req.query('codespaceId');

    if (!codespaceId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'codespaceId is required' } },
        400
      );
    }

    const result = await worktreeService.list(codespaceId);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list worktrees' } },
        500
      );
    }

    return json({ ok: true, data: { items: result.value } });
  });

  // POST /api/worktrees
  app.post('/', async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const parsed = parseBody(createWorktreeSchema, rawBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await worktreeService.create({
      codespaceId: body.codespaceId,
      agentId: body.agentId,
      taskId: body.taskId,
      taskTitle: body.taskTitle,
      baseBranch: body.baseBranch,
    });

    if (!result.ok) {
      log.error('Create failed', { error: result.error });
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        400
      );
    }

    return json({ ok: true, data: result.value });
  });

  // POST /api/worktrees/prune
  app.post('/prune', async (c) => {
    let body: { codespaceId?: string };
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }
    const codespaceId = body.codespaceId;

    if (!codespaceId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'codespaceId is required' } },
        400
      );
    }

    const result = await worktreeService.prune(codespaceId);

    if (!result.ok) {
      log.error('Prune failed', { error: result.error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to prune worktrees' } },
        500
      );
    }

    return json({ ok: true, data: result.value });
  });

  // POST /api/worktrees/:id/commit
  app.post('/:id/commit', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const parsed = parseBody(commitWorktreeSchema, rawBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await worktreeService.commit(id, body.message);

    if (!result.ok) {
      log.error('Commit failed', { error: result.error });
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.code === 'NOT_FOUND' ? 404 : 400
      );
    }

    return json({ ok: true, data: { sha: result.value } });
  });

  // POST /api/worktrees/:id/merge
  app.post('/:id/merge', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      rawBody = {};
    }

    const parsed = parseBody(mergeWorktreeSchema, rawBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await worktreeService.merge(id, body.targetBranch);

    if (!result.ok) {
      log.error('Merge failed', { error: result.error });
      // Check for merge conflict
      if (result.error.code === 'MERGE_CONFLICT') {
        return json(
          {
            ok: false,
            error: { code: 'MERGE_CONFLICT', message: result.error.message },
            conflicts: result.error.details?.files ?? [],
          },
          409
        );
      }
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.code === 'NOT_FOUND' ? 404 : 400
      );
    }

    // If deleteAfterMerge is requested, remove the worktree
    if (body.deleteAfterMerge) {
      const removeResult = await worktreeService.remove(id, true);
      if (!removeResult.ok) {
        log.error('Post-merge cleanup failed', { error: removeResult.error });
        // Return success for merge but indicate cleanup failed
        return json({
          ok: true,
          data: { merged: true, cleanupFailed: true, cleanupError: removeResult.error.message },
        });
      }
    }

    return json({ ok: true, data: { merged: true } });
  });

  // GET /api/worktrees/:id/diff
  app.get('/:id/diff', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await worktreeService.getDiff(id);

    if (!result.ok) {
      log.error('Diff failed', { error: result.error });
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.code === 'NOT_FOUND' ? 404 : 400
      );
    }

    return json({ ok: true, data: result.value });
  });

  // GET /api/worktrees/:id
  app.get('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await worktreeService.getStatus(id);

    if (!result.ok) {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Worktree not found' } }, 404);
    }

    return json({ ok: true, data: result.value });
  });

  // DELETE /api/worktrees/:id
  app.delete('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const force = c.req.query('force') === 'true';

    const result = await worktreeService.remove(id, force);

    if (!result.ok) {
      log.error('Remove failed', { error: result.error });
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.code === 'NOT_FOUND' ? 404 : 400
      );
    }

    return json({ ok: true, data: null });
  });

  return app;
}
