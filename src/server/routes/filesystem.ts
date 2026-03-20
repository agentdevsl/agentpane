/**
 * Filesystem routes
 *
 * AR-017: No path traversal risk. This route is protected by admin-only RBAC
 * (see router.ts RBAC guard for /api/filesystem/*) and only searches a hardcoded
 * list of directories under the user's home directory. User input does not
 * influence the directory paths that are read.
 */

import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createLogger } from '../../lib/logging/logger.js';
import { json } from '../shared.js';

const log = createLogger('FilesystemRoutes');

export function createFilesystemRoutes() {
  const app = new Hono();

  // GET /api/filesystem/discover-repos
  app.get('/discover-repos', async (_c) => {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';

    // AR-017: These directories are hardcoded -- no user input controls which
    // directories are scanned, eliminating any path traversal risk.
    const searchDirs = [
      `${homeDir}/git`,
      `${homeDir}/projects`,
      `${homeDir}/code`,
      `${homeDir}/Developer`,
      `${homeDir}/repos`,
      `${homeDir}/workspace`,
      `${homeDir}/src`,
    ];

    const canAccess = async (path: string): Promise<boolean> => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    };

    type LocalRepo = {
      name: string;
      path: string;
      lastModified: string;
    };

    type AccessWarning = {
      path: string;
      error: string;
    };

    const repos: LocalRepo[] = [];
    const warnings: AccessWarning[] = [];

    for (const searchDir of searchDirs) {
      if (!(await canAccess(searchDir))) continue;

      try {
        const entries = await readdir(searchDir);

        for (const entry of entries) {
          const fullPath = join(searchDir, entry);

          try {
            const statInfo = await stat(fullPath);
            if (!statInfo.isDirectory()) continue;

            // Check if it's a git repo
            const gitDir = join(fullPath, '.git');
            if (await canAccess(gitDir)) {
              repos.push({
                name: entry,
                path: fullPath,
                lastModified: statInfo.mtime.toISOString(),
              });
            }
          } catch (error) {
            // Track skipped entries so user knows why repos might be missing
            const errorMsg = error instanceof Error ? error.message : 'access denied';
            log.warn('Discover skipping entry', { data: { path: fullPath, reason: errorMsg } });
            warnings.push({ path: fullPath, error: errorMsg });
          }
        }
      } catch (error) {
        // Track unreadable directories so user knows why repos might be missing
        const errorMsg = error instanceof Error ? error.message : 'access denied';
        log.warn('Discover cannot read directory', { data: { path: searchDir, reason: errorMsg } });
        warnings.push({ path: searchDir, error: errorMsg });
      }
    }

    // Sort by last modified (most recent first)
    repos.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

    // Limit to 20 most recent, include warnings if any directories were inaccessible
    return json({
      ok: true,
      data: {
        repos: repos.slice(0, 20),
        ...(warnings.length > 0 && { warnings }),
      },
    });
  });

  return app;
}
