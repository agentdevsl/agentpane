/**
 * Git view routes
 *
 * Thin route handlers that delegate to GitService.
 */

import { Hono } from 'hono';
import type { GitService } from '../../services/git.service.js';
import { isValidId, json } from '../shared.js';

interface GitDeps {
  gitService: GitService;
}

export function createGitRoutes({ gitService }: GitDeps) {
  const app = new Hono();

  // GET /api/git/status
  app.get('/status', async (c) => {
    const codespaceId = c.req.query('codespaceId');

    if (!codespaceId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'codespaceId is required' } },
        400
      );
    }

    if (!isValidId(codespaceId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid codespaceId format' } },
        400
      );
    }

    const result = await gitService.getStatus(codespaceId);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: result.value });
  });

  // GET /api/git/branches
  app.get('/branches', async (c) => {
    const codespaceId = c.req.query('codespaceId');

    if (!codespaceId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'codespaceId is required' } },
        400
      );
    }

    if (!isValidId(codespaceId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid codespaceId format' } },
        400
      );
    }

    const result = await gitService.listBranches(codespaceId);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: result.value });
  });

  // GET /api/git/commits
  app.get('/commits', async (c) => {
    const codespaceId = c.req.query('codespaceId');
    const branch = c.req.query('branch');
    const limit = parseInt(c.req.query('limit') ?? '50', 10);

    if (!codespaceId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'codespaceId is required' } },
        400
      );
    }

    if (!isValidId(codespaceId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid codespaceId format' } },
        400
      );
    }

    const result = await gitService.listCommits(codespaceId, {
      branch: branch || undefined,
      limit,
    });

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: result.value });
  });

  // GET /api/git/remote-branches
  app.get('/remote-branches', async (c) => {
    const codespaceId = c.req.query('codespaceId');

    if (!codespaceId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'codespaceId is required' } },
        400
      );
    }

    if (!isValidId(codespaceId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid codespaceId format' } },
        400
      );
    }

    const result = await gitService.listRemoteBranches(codespaceId);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: result.value });
  });

  return app;
}
