// @vitest-environment node
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

// ── Mock node:fs/promises ──

const mockAccess = vi.fn();
const mockReaddir = vi.fn();
const mockStat = vi.fn();

vi.mock('node:fs/promises', () => ({
  access: (...args: unknown[]) => mockAccess(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
}));

// Import after mocking
const { createFilesystemRoutes } = await import('../filesystem.js');

// ── Test App Factory ──

function createTestApp() {
  const routes = createFilesystemRoutes();
  const app = new Hono();
  app.route('/api/filesystem', routes);
  return { app };
}

// ── Request Helper ──

async function request(app: Hono, method: string, path: string) {
  return app.request(path, { method });
}

// ── Tests ──

describe('Filesystem API Routes', () => {
  // ── GET /api/filesystem/discover-repos ──

  describe('GET /api/filesystem/discover-repos', () => {
    it('discovers git repositories in search directories', async () => {
      const { app } = createTestApp();

      // ~/git exists and is accessible
      mockAccess.mockImplementation(async (path: string) => {
        if (path.endsWith('/git') || path.endsWith('/my-repo/.git')) {
          return undefined;
        }
        throw new Error('ENOENT');
      });
      mockReaddir.mockResolvedValue(['my-repo']);
      mockStat.mockResolvedValue({
        isDirectory: () => true,
        mtime: new Date('2025-01-15T10:00:00Z'),
      });

      const res = await request(app, 'GET', '/api/filesystem/discover-repos');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.repos).toHaveLength(1);
      expect(json.data.repos[0].name).toBe('my-repo');
      expect(json.data.repos[0].lastModified).toBeDefined();
    });

    it('returns empty list when no search directories exist', async () => {
      const { app } = createTestApp();

      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const res = await request(app, 'GET', '/api/filesystem/discover-repos');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.repos).toHaveLength(0);
    });

    it('skips non-directory entries', async () => {
      const { app } = createTestApp();

      mockAccess.mockImplementation(async (path: string) => {
        if (path.endsWith('/git')) return undefined;
        throw new Error('ENOENT');
      });
      mockReaddir.mockResolvedValue(['file.txt']);
      mockStat.mockResolvedValue({
        isDirectory: () => false,
        mtime: new Date(),
      });

      const res = await request(app, 'GET', '/api/filesystem/discover-repos');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.repos).toHaveLength(0);
    });

    it('skips directories without .git folder', async () => {
      const { app } = createTestApp();

      mockAccess.mockImplementation(async (path: string) => {
        if (path.endsWith('/git')) return undefined;
        // .git check will fail
        throw new Error('ENOENT');
      });
      mockReaddir.mockResolvedValue(['not-a-repo']);
      mockStat.mockResolvedValue({
        isDirectory: () => true,
        mtime: new Date(),
      });

      const res = await request(app, 'GET', '/api/filesystem/discover-repos');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.repos).toHaveLength(0);
    });

    it('sorts repos by last modified descending', async () => {
      const { app } = createTestApp();

      const dates: Record<string, Date> = {
        'old-repo': new Date('2024-01-01T00:00:00Z'),
        'new-repo': new Date('2025-06-01T00:00:00Z'),
      };

      mockAccess.mockImplementation(async (path: string) => {
        if (path.endsWith('/git') || path.endsWith('/.git')) return undefined;
        throw new Error('ENOENT');
      });
      mockReaddir.mockResolvedValue(['old-repo', 'new-repo']);
      mockStat.mockImplementation(async (path: string) => {
        const name = path.split('/').pop() as string;
        return {
          isDirectory: () => true,
          mtime: dates[name] ?? new Date(),
        };
      });

      const res = await request(app, 'GET', '/api/filesystem/discover-repos');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.repos).toHaveLength(2);
      expect(json.data.repos[0].name).toBe('new-repo');
      expect(json.data.repos[1].name).toBe('old-repo');
    });

    it('includes warnings for inaccessible entries', async () => {
      const { app } = createTestApp();

      mockAccess.mockImplementation(async (path: string) => {
        if (path.endsWith('/git')) return undefined;
        throw new Error('ENOENT');
      });
      mockReaddir.mockResolvedValue(['broken-dir']);
      mockStat.mockRejectedValue(new Error('EACCES: permission denied'));

      const res = await request(app, 'GET', '/api/filesystem/discover-repos');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.repos).toHaveLength(0);
      expect(json.data.warnings).toBeDefined();
      expect(json.data.warnings.length).toBeGreaterThan(0);
      expect(json.data.warnings[0].error).toContain('EACCES');
    });

    it('limits results to 20 repos', async () => {
      const { app } = createTestApp();

      const entries = Array.from({ length: 25 }, (_, i) => `repo-${i}`);
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(entries);
      mockStat.mockResolvedValue({
        isDirectory: () => true,
        mtime: new Date(),
      });

      const res = await request(app, 'GET', '/api/filesystem/discover-repos');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.repos.length).toBeLessThanOrEqual(20);
    });
  });
});
