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
    const projectId = c.req.query('projectId');

    if (!projectId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'projectId is required' } },
        400
      );
    }

    if (!isValidId(projectId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid projectId format' } },
        400
      );
    }

    const result = await gitService.getStatus(projectId);

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
    const projectId = c.req.query('projectId');

    if (!projectId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'projectId is required' } },
        400
      );
    }

    if (!isValidId(projectId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid projectId format' } },
        400
      );
    }

    const result = await gitService.listBranches(projectId);

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
    const projectId = c.req.query('projectId');
    const branch = c.req.query('branch');
    const limit = parseInt(c.req.query('limit') ?? '50', 10);

    if (!projectId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'projectId is required' } },
        400
      );
    }

    if (!isValidId(projectId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid projectId format' } },
        400
      );
    }

    const result = await gitService.listCommits(projectId, { branch: branch || undefined, limit });

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
    const projectId = c.req.query('projectId');

    if (!projectId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'projectId is required' } },
        400
      );
    }

    if (!isValidId(projectId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid projectId format' } },
        400
      );
    }

    const result = await gitService.listRemoteBranches(projectId);

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
