/**
 * Git view routes
 *
 * Thin route handlers that delegate to GitService.
 */

import { Hono } from 'hono';
import type { GitService } from '../../services/git.service.js';
import { json, parseLimit, requireQueryId } from '../shared.js';

interface GitDeps {
  gitService: GitService;
}

export function createGitRoutes({ gitService }: GitDeps) {
  const app = new Hono();

  // GET /api/git/status
  app.get('/status', async (c) => {
    const { id: codespaceId, error: csError } = requireQueryId(c, 'codespaceId');
    if (csError) return csError;

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
    const { id: codespaceId, error: csError } = requireQueryId(c, 'codespaceId');
    if (csError) return csError;

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
    const { id: codespaceId, error: csError } = requireQueryId(c, 'codespaceId');
    if (csError) return csError;
    const branch = c.req.query('branch');
    const limit = parseLimit(c);

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
    const { id: codespaceId, error: csError } = requireQueryId(c, 'codespaceId');
    if (csError) return csError;

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
