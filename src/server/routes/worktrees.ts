/**
 * Worktree routes
 */

import { Hono } from 'hono';
import { createLogger } from '../../lib/logging/logger.js';
import type { WorktreeService } from '../../services/worktree.service.js';
import { isValidId, json } from '../shared.js';

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
    const projectId = c.req.query('projectId');

    if (!projectId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'projectId is required' } },
        400
      );
    }

    try {
      const result = await worktreeService.list(projectId);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list worktrees' } },
          500
        );
      }

      return json({ ok: true, data: { items: result.value } });
    } catch (error) {
      log.error('List error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list worktrees' } },
        500
      );
    }
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

    try {
      const result = await worktreeService.create({
        projectId: body.projectId,
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
    } catch (error) {
      log.error('Create error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create worktree' } },
        500
      );
    }
  });

  // POST /api/worktrees/prune
  app.post('/prune', async (c) => {
    let body: { projectId?: string };
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }
    const projectId = body.projectId;

    if (!projectId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'projectId is required' } },
        400
      );
    }

    try {
      const result = await worktreeService.prune(projectId);

      if (!result.ok) {
        log.error('Prune failed', { error: result.error });
        return json(
          { ok: false, error: { code: 'DB_ERROR', message: 'Failed to prune worktrees' } },
          500
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Prune error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to prune worktrees' } },
        500
      );
    }
  });

  // POST /api/worktrees/:id/commit
  app.post('/:id/commit', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid worktree ID format' } },
        400
      );
    }

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

    try {
      const result = await worktreeService.commit(id, body.message);

      if (!result.ok) {
        log.error('Commit failed', { error: result.error });
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.code === 'NOT_FOUND' ? 404 : 400
        );
      }

      return json({ ok: true, data: { sha: result.value } });
    } catch (error) {
      log.error('Commit error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to commit changes' } },
        500
      );
    }
  });

  // POST /api/worktrees/:id/merge
  app.post('/:id/merge', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid worktree ID format' } },
        400
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      rawBody = {};
    }

    const parsed = parseBody(mergeWorktreeSchema, rawBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    try {
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
    } catch (error) {
      log.error('Merge error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to merge worktree' } },
        500
      );
    }
  });

  // GET /api/worktrees/:id/diff
  app.get('/:id/diff', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid worktree ID format' } },
        400
      );
    }

    try {
      const result = await worktreeService.getDiff(id);

      if (!result.ok) {
        log.error('Diff failed', { error: result.error });
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.code === 'NOT_FOUND' ? 404 : 400
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Diff error', { error: error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to get diff' } }, 500);
    }
  });

  // GET /api/worktrees/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid worktree ID format' } },
        400
      );
    }

    try {
      const result = await worktreeService.getStatus(id);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Worktree not found' } },
          404
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Get error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get worktree' } },
        500
      );
    }
  });

  // DELETE /api/worktrees/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid worktree ID format' } },
        400
      );
    }

    const force = c.req.query('force') === 'true';

    try {
      const result = await worktreeService.remove(id, force);

      if (!result.ok) {
        log.error('Remove failed', { error: result.error });
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.code === 'NOT_FOUND' ? 404 : 400
        );
      }

      return json({ ok: true, data: null });
    } catch (error) {
      log.error('Remove error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to remove worktree' } },
        500
      );
    }
  });

  return app;
}
