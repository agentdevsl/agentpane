/**
 * GitHub routes
 */

import { Hono } from 'hono';
import { z } from 'zod';
    return false;
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { data: commits } = await octokit.rest.repos.listCommits({
        owner,
        repo,
        per_page: 1,
      });

      if (commits.length > 0) {
        log.info(`Repo ${repoFullName} ready after ${attempt + 1} attempts`);
        return true;
      }
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 409) {
        log.info(`Waiting for repo... attempt ${attempt + 1}`, { data: { status } });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return false;
}

export function createGitHubRoutes({ githubService }: GitHubDeps) {
  const app = new Hono();

  // GET /api/github/orgs
  app.get('/orgs', async (_c) => {
    const result = await githubService.listUserOrgs();
    if (!result.ok) {
      log.error('List orgs error', { error: result.error });
      return json({ ok: false, error: result.error }, 401);
    }
    return json({ ok: true, data: { orgs: result.value } });
  });

  // POST /api/github/clone
  app.post('/clone', async (c) => {
    const parsed = await parseJsonBody(c, cloneSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // Validate URL is a proper GitHub HTTPS URL (prevents injection)
    if (!isValidGitHubUrl(body.url)) {
      return json(
        {
          ok: false,
          error: { code: 'INVALID_URL', message: 'URL must be a valid GitHub HTTPS URL' },
        },
        400
      );
    }

    // Expand ~ to home directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const destination = body.destination.replace(/^~/, homeDir);

    // Get the repo name from URL for the final path
    const repoName = body.url.split('/').pop()?.replace('.git', '') || 'repo';
    const fullPath = `${destination}/${repoName}`;

    try {
      const { existsSync, mkdirSync } = await import('node:fs');

      // Check if target folder already exists - fail if it does
      if (existsSync(fullPath)) {
        return json(
          {
            ok: false,
            error: {
              code: 'FOLDER_EXISTS',
              message: `Folder "${repoName}" already exists at ${destination}`,
            },
          },
          400
        );
      }

      // Create parent destination directory if needed
      if (!existsSync(destination)) {
        mkdirSync(destination, { recursive: true });
      }

      // Get token for private repos
      const token = await githubService.getDecryptedToken();

      // Build clone URL with token for authentication (if available)
      let cloneUrl = body.url;
      if (token && body.url.startsWith('https://github.com/')) {
        cloneUrl = body.url.replace('https://github.com/', `https://${token}@github.com/`);
      }

      // Run git clone
      const proc = Bun.spawn(['git', 'clone', cloneUrl, fullPath], {
        cwd: destination,
        stderr: 'pipe',
        stdout: 'pipe',
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        let stderr = await new Response(proc.stderr).text();
        // Redact token from error message to prevent leaking secrets
        if (token) {
          stderr = stderr.replace(new RegExp(token, 'g'), '*****');
        }
        log.error('Clone failed', { data: { stderr } });
        return json(
          {
            ok: false,
            error: { code: 'CLONE_FAILED', message: 'Failed to clone repository' },
          },
          500
        );
      }

      return json({ ok: true, data: { path: fullPath } });
    } catch (error) {
      log.error('Clone error', { error });
      return json(
        {
          ok: false,
          error: {
            code: 'CLONE_ERROR',
            message: error instanceof Error ? error.message : 'Clone failed',
          },
        },
        500
      );
    }
  });

  // POST /api/github/create-from-template
  app.post('/create-from-template', async (c) => {
    const parsed = await parseJsonBody(c, createFromTemplateSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // Step 1: Create the repo from template
    const createResult = await githubService.createRepoFromTemplate({
      templateOwner: body.templateOwner,
      templateRepo: body.templateRepo,
      name: body.name,
      owner: body.owner,
      description: body.description,
      isPrivate: body.isPrivate,
    });

    if (!createResult.ok) {
      return json({ ok: false, error: createResult.error }, 400);
    }

    // Step 2: Wait for the repo to be ready
    const fullName = createResult.value?.fullName;
    if (!fullName) {
      return json(
        {
          ok: false,
          error: {
            code: 'INVALID_RESPONSE',
            message: 'GitHub API response missing fullName',
          },
        },
        500
      );
    }

    log.info(`Waiting for repo ${fullName} to be ready...`);
    const isReady = await waitForRepoReady(githubService, fullName);

    if (!isReady) {
      log.error('Repo not ready after max attempts');
      return json(
        {
          ok: false,
          error: {
            code: 'REPO_NOT_READY',
            message:
              'Repository was created but files are still being copied. Please try cloning manually.',
          },
        },
        500
      );
    }

    // Step 3: Clone the newly created repo
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const destination = body.clonePath.replace(/^~/, homeDir);
    const destFullPath = `${destination}/${body.name}`;

    try {
      const { existsSync, mkdirSync } = await import('node:fs');

      if (existsSync(destFullPath)) {
        return json(
          {
            ok: false,
            error: {
              code: 'FOLDER_EXISTS',
              message: `Folder "${body.name}" already exists at ${destination}`,
            },
          },
          400
        );
      }

      if (!existsSync(destination)) {
        mkdirSync(destination, { recursive: true });
      }

      const token = await githubService.getDecryptedToken();
      let cloneUrl = createResult.value?.cloneUrl;
      if (!cloneUrl) {
        return json(
          {
            ok: false,
            error: {
              code: 'INVALID_RESPONSE',
              message: 'GitHub API response missing cloneUrl',
            },
          },
          500
        );
      }

      if (token && cloneUrl.startsWith('https://github.com/')) {
        cloneUrl = cloneUrl.replace('https://github.com/', `https://${token}@github.com/`);
      }

      const proc = Bun.spawn(['git', 'clone', cloneUrl, destFullPath], {
        cwd: destination,
        stderr: 'pipe',
        stdout: 'pipe',
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        let stderr = await new Response(proc.stderr).text();
        // Redact token from error message to prevent leaking secrets
        if (token) {
          stderr = stderr.replace(new RegExp(token, 'g'), '*****');
        }
        log.error('Clone from template failed', { data: { stderr } });
        return json(
          {
            ok: false,
            error: { code: 'CLONE_FAILED', message: 'Repository created but failed to clone' },
          },
          500
        );
      }

      return json({
        ok: true,
        data: {
          path: destFullPath,
          repoFullName: createResult.value.fullName,
          cloneUrl: createResult.value.cloneUrl,
        },
      });
    } catch (error) {
      log.error('Clone from template error', { error });
      return json(
        {
          ok: false,
          error: {
            code: 'CLONE_ERROR',
            message: error instanceof Error ? error.message : 'Clone failed',
          },
        },
        500
      );
    }
  });

  // GET /api/github/repos/:owner
  app.get('/repos/:owner', async (c) => {
    const owner = c.req.param('owner');
    const result = await githubService.listReposForOwner(owner);
    if (!result.ok) {
      log.error('List repos for owner error', { error: result.error });
      return json({ ok: false, error: result.error }, 401);
    }
    return json({ ok: true, data: { repos: result.value } });
  });

  // GET /api/github/repos
  app.get('/repos', async (_c) => {
    const result = await githubService.listUserRepos();
    if (!result.ok) {
      log.error('List user repos error', { error: result.error });
      return json({ ok: false, error: result.error }, 401);
    }
    return json({ ok: true, data: { repos: result.value } });
  });

  // GET /api/github/token
  app.get('/token', async (_c) => {
    const result = await githubService.getTokenInfo();
    if (!result.ok) {
      // AR-019: Map error codes to proper HTTP status codes
      const status = result.error.code === 'NOT_FOUND' ? 404 : 500;
      log.error('Get token info error', { error: result.error });
      return json({ ok: false, error: result.error }, status);
    }
    return json({ ok: true, data: { tokenInfo: result.value } });
  });

  // POST /api/github/token
  app.post('/token', async (c) => {
    const parsed = await parseJsonBody(c, setTokenSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await githubService.saveToken(body.token);
    if (!result.ok) {
      return json({ ok: false, error: result.error }, 400);
    }
    return json({ ok: true, data: { tokenInfo: result.value } });
  });

  // DELETE /api/github/token
  app.delete('/token', async (_c) => {
    const result = await githubService.deleteToken();
    if (!result.ok) {
      // AR-019: STORAGE_ERROR is the only failure mode for delete, which is a true 500
      log.error('Delete token error', { error: result.error });
      return json({ ok: false, error: result.error }, 500);
    }
    return json({ ok: true, data: null });
  });

  // POST /api/github/revalidate
  app.post('/revalidate', async (_c) => {
    const result = await githubService.revalidateToken();
    if (!result.ok) {
      // AR-019: Map error codes to proper HTTP status codes
      const status =
        result.error.code === 'NOT_FOUND'
          ? 404
          : result.error.code === 'VALIDATION_FAILED'
            ? 400
            : 500;
      log.error('Revalidate token error', { error: result.error });
      return json({ ok: false, error: result.error }, status);
    }
    return json({ ok: true, data: { isValid: result.value } });
  });

  return app;
}
