import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFilesystemRoutes } from '../../src/server/routes/filesystem';

/**
 * Integration tests for Filesystem routes.
 *
 * The filesystem routes scan hardcoded directories under $HOME.
 * We mock the fs operations to control which repos are discovered.
 */

// Mock fs/promises to control filesystem access
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

import { access, readdir, stat } from 'node:fs/promises';

const mockAccess = vi.mocked(access);
const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);

describe('Filesystem Routes (IT-530)', () => {
  let app: ReturnType<typeof createFilesystemRoutes>;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOME = '/home/testuser';
    app = createFilesystemRoutes();

    // Default: all directories inaccessible
    mockAccess.mockRejectedValue(new Error('ENOENT'));
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  // ─── GET /discover-repos ──────────────────────

  describe('GET /discover-repos', () => {
    it('IT-531: returns empty repos when no search directories exist', async () => {
      const response = await app.request('http://localhost/discover-repos');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.repos).toEqual([]);
    });

    it('IT-532: discovers git repos in accessible directories', async () => {
      // Make ~/git accessible
      mockAccess.mockImplementation(async (path) => {
        const p = String(path);
        if (p === '/home/testuser/git') return undefined;
        if (p === '/home/testuser/git/my-repo') return undefined;
        if (p === '/home/testuser/git/my-repo/.git') return undefined;
        throw new Error('ENOENT');
      });

      mockReaddir.mockImplementation(async (path) => {
        if (String(path) === '/home/testuser/git') {
          return ['my-repo'] as unknown as ReturnType<typeof readdir>;
        }
        return [] as unknown as ReturnType<typeof readdir>;
      });

      const mtime = new Date('2026-03-15T10:00:00Z');
      mockStat.mockImplementation(async (_path) => {
        return {
          isDirectory: () => true,
          mtime,
        } as unknown as ReturnType<typeof stat>;
      });

      const response = await app.request('http://localhost/discover-repos');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.repos).toHaveLength(1);
      expect(body.data.repos[0].name).toBe('my-repo');
      expect(body.data.repos[0].path).toContain('my-repo');
      expect(body.data.repos[0].lastModified).toBe('2026-03-15T10:00:00.000Z');
    });

    it('IT-533: skips non-directory entries', async () => {
      mockAccess.mockImplementation(async (path) => {
        const p = String(path);
        if (p === '/home/testuser/git') return undefined;
        throw new Error('ENOENT');
      });

      mockReaddir.mockImplementation(async (path) => {
        if (String(path) === '/home/testuser/git') {
          return ['file.txt'] as unknown as ReturnType<typeof readdir>;
        }
        return [] as unknown as ReturnType<typeof readdir>;
      });

      mockStat.mockImplementation(async (_path) => {
        return {
          isDirectory: () => false,
          mtime: new Date(),
        } as unknown as ReturnType<typeof stat>;
      });

      const response = await app.request('http://localhost/discover-repos');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.repos).toEqual([]);
    });

    it('IT-534: skips directories without .git folder', async () => {
      mockAccess.mockImplementation(async (path) => {
        const p = String(path);
        if (p === '/home/testuser/git') return undefined;
        if (p === '/home/testuser/git/not-a-repo') return undefined;
        // .git directory does NOT exist
        throw new Error('ENOENT');
      });

      mockReaddir.mockImplementation(async (path) => {
        if (String(path) === '/home/testuser/git') {
          return ['not-a-repo'] as unknown as ReturnType<typeof readdir>;
        }
        return [] as unknown as ReturnType<typeof readdir>;
      });

      mockStat.mockImplementation(async (_path) => {
        return {
          isDirectory: () => true,
          mtime: new Date(),
        } as unknown as ReturnType<typeof stat>;
      });

      const response = await app.request('http://localhost/discover-repos');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.repos).toEqual([]);
    });

    it('IT-535: limits results to 20 most recent repos', async () => {
      const repoNames = Array.from({ length: 25 }, (_, i) => `repo-${i}`);

      mockAccess.mockImplementation(async (path) => {
        const p = String(path);
        if (p === '/home/testuser/git') return undefined;
        if (repoNames.some((name) => p.includes(name))) return undefined;
        throw new Error('ENOENT');
      });

      mockReaddir.mockImplementation(async (path) => {
        if (String(path) === '/home/testuser/git') {
          return repoNames as unknown as ReturnType<typeof readdir>;
        }
        return [] as unknown as ReturnType<typeof readdir>;
      });

      mockStat.mockImplementation(async (path) => {
        const p = String(path);
        const idx = repoNames.findIndex((name) => p.endsWith(name));
        return {
          isDirectory: () => true,
          mtime: new Date(Date.now() - idx * 1000),
        } as unknown as ReturnType<typeof stat>;
      });

      const response = await app.request('http://localhost/discover-repos');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.repos).toHaveLength(20);
    });

    it('IT-536: includes warnings for inaccessible entries', async () => {
      mockAccess.mockImplementation(async (path) => {
        const p = String(path);
        if (p === '/home/testuser/git') return undefined;
        throw new Error('ENOENT');
      });

      mockReaddir.mockImplementation(async (path) => {
        if (String(path) === '/home/testuser/git') {
          return ['broken-repo'] as unknown as ReturnType<typeof readdir>;
        }
        return [] as unknown as ReturnType<typeof readdir>;
      });

      mockStat.mockImplementation(async (_path) => {
        throw new Error('Permission denied');
      });

      const response = await app.request('http://localhost/discover-repos');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.repos).toEqual([]);
      expect(body.data.warnings).toBeDefined();
      expect(body.data.warnings.length).toBeGreaterThan(0);
    });
  });
});
