/**
 * Integration coverage for src/lib/github/marketplace-sync.ts.
 *
 * Mocks the Octokit REST API surface used by syncMarketplaceFromGitHub
 * (getRef, getTree, getContent) to drive every code path without hitting
 * GitHub.
 *
 * Run: npx vitest run --project integration tests/integration/marketplace-sync-paths-J.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseGitHubMarketplaceUrl,
  syncMarketplaceFromGitHub,
} from '../../src/lib/github/marketplace-sync';

type MockOctokit = {
  rest: {
    git: {
      getRef: ReturnType<typeof vi.fn>;
      getTree: ReturnType<typeof vi.fn>;
    };
    repos: {
      getContent: ReturnType<typeof vi.fn>;
    };
  };
};

function buildOctokit(): MockOctokit {
  return {
    rest: {
      git: {
        getRef: vi.fn(),
        getTree: vi.fn(),
      },
      repos: {
        getContent: vi.fn(),
      },
    },
  };
}

function b64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

describe('parseGitHubMarketplaceUrl', () => {
  it('parses https://github.com/owner/repo', () => {
    const r = parseGitHubMarketplaceUrl('https://github.com/octocat/hello');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ owner: 'octocat', repo: 'hello' });
  });

  it('parses https://github.com/owner/repo.git', () => {
    const r = parseGitHubMarketplaceUrl('https://github.com/octocat/hello.git');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ owner: 'octocat', repo: 'hello' });
  });

  it('parses git@github.com:owner/repo.git', () => {
    const r = parseGitHubMarketplaceUrl('git@github.com:octocat/hello.git');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ owner: 'octocat', repo: 'hello' });
  });

  it('parses simple owner/repo shorthand', () => {
    const r = parseGitHubMarketplaceUrl('octocat/hello');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ owner: 'octocat', repo: 'hello' });
  });

  it('rejects malformed URL', () => {
    const r = parseGitHubMarketplaceUrl('definitely-not-a-url');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toBe('Invalid GitHub URL format');
  });
});

describe('syncMarketplaceFromGitHub', () => {
  let octokit: MockOctokit;

  beforeEach(() => {
    octokit = buildOctokit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns plugins parsed from SKILL.md frontmatter and README', async () => {
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'sha-1' } },
    });
    octokit.rest.git.getTree.mockResolvedValueOnce({
      data: {
        tree: [
          { path: 'plugins/foo', type: 'tree' },
          { path: 'plugins/foo/SKILL.md', type: 'blob' },
          { path: 'plugins/bar', type: 'tree' },
          { path: 'plugins/baz', type: 'tree' },
        ],
      },
    });

    const skillFoo = b64(
      [
        '---',
        'name: Foo',
        'description: A foo plugin',
        'author: Octocat',
        'version: 1.0.0',
        'category: cli',
        '---',
        '# Foo',
        '',
        'Foo body',
      ].join('\n')
    );
    const readmeBar = b64('# Bar\n\nThis is the bar README first paragraph.');

    octokit.rest.repos.getContent.mockImplementation(async (args: { path: string }) => {
      if (args.path === 'plugins/foo/SKILL.md') {
        return { data: { content: skillFoo } };
      }
      if (args.path === 'plugins/bar/README.md') {
        return { data: { content: readmeBar } };
      }
      // Other lookups: 404
      throw Object.assign(new Error('Not found'), { status: 404 });
    });

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as unknown as Parameters<typeof syncMarketplaceFromGitHub>[0]['octokit'],
      owner: 'acme',
      repo: 'plugins',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sha).toBe('sha-1');
    expect(r.value.plugins).toHaveLength(3);
    const foo = r.value.plugins.find((p) => p.id === 'foo');
    expect(foo?.name).toBe('Foo');
    expect(foo?.description).toBe('A foo plugin');
    expect(foo?.author).toBe('Octocat');
    expect(foo?.version).toBe('1.0.0');
    expect(foo?.category).toBe('cli');
    expect(foo?.tags).toEqual(['official']);
    const bar = r.value.plugins.find((p) => p.id === 'bar');
    // README first-paragraph extraction populates description
    expect(bar?.description).toContain('bar README');
    expect(bar?.readme).toContain('bar');
  });

  it('respects additionalPaths and tags external plugins', async () => {
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'sha-2' } },
    });
    octokit.rest.git.getTree.mockResolvedValueOnce({
      data: {
        tree: [
          { path: 'plugins/official-1', type: 'tree' },
          { path: 'external_plugins/ext-1', type: 'tree' },
        ],
      },
    });
    octokit.rest.repos.getContent.mockImplementation(async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    });

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as never,
      owner: 'acme',
      repo: 'demo',
      additionalPaths: [{ path: 'external_plugins', tag: 'external' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.plugins).toHaveLength(2);
    const ext = r.value.plugins.find((p) => p.id === 'ext-1');
    expect(ext?.tags).toEqual(['external']);
    const official = r.value.plugins.find((p) => p.id === 'official-1');
    expect(official?.tags).toEqual(['official']);
  });

  it('honors a non-default ref/branch and pluginsPath', async () => {
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'sha-branch' } },
    });
    octokit.rest.git.getTree.mockResolvedValueOnce({
      data: { tree: [{ path: 'src/plugins/x', type: 'tree' }] },
    });
    octokit.rest.repos.getContent.mockImplementation(async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    });

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as never,
      owner: 'acme',
      repo: 'demo',
      pluginsPath: 'src/plugins',
      ref: 'develop',
    });
    expect(r.ok).toBe(true);
    expect(octokit.rest.git.getRef).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'demo',
      ref: 'heads/develop',
    });
  });

  it('returns err on getRef failure', async () => {
    octokit.rest.git.getRef.mockRejectedValueOnce(
      Object.assign(new Error('Bad credentials'), { status: 401 })
    );

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as never,
      owner: 'acme',
      repo: 'demo',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Failed to sync marketplace');
  });

  it('returns err on getTree failure', async () => {
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'sha-x' } },
    });
    octokit.rest.git.getTree.mockRejectedValueOnce(new Error('boom'));

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as never,
      owner: 'acme',
      repo: 'demo',
    });
    expect(r.ok).toBe(false);
  });

  it('plugins with neither SKILL.md nor README still produce an entry with id only', async () => {
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'sha-nameless' } },
    });
    octokit.rest.git.getTree.mockResolvedValueOnce({
      data: { tree: [{ path: 'plugins/bare', type: 'tree' }] },
    });
    octokit.rest.repos.getContent.mockImplementation(async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    });

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as never,
      owner: 'acme',
      repo: 'demo',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.plugins[0].id).toBe('bare');
    expect(r.value.plugins[0].name).toBe('bare');
  });

  it('non-404 SKILL.md errors are tolerated and plugin is still returned', async () => {
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'sha-500' } },
    });
    octokit.rest.git.getTree.mockResolvedValueOnce({
      data: { tree: [{ path: 'plugins/transient', type: 'tree' }] },
    });
    octokit.rest.repos.getContent.mockImplementation(async (args: { path: string }) => {
      if (args.path.endsWith('SKILL.md')) {
        throw Object.assign(new Error('Internal Server Error'), { status: 500 });
      }
      throw Object.assign(new Error('Not found'), { status: 404 });
    });

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as never,
      owner: 'acme',
      repo: 'demo',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.plugins[0].id).toBe('transient');
  });

  it('SKILL.md with quoted values strips the quotes', async () => {
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'sha-quotes' } },
    });
    octokit.rest.git.getTree.mockResolvedValueOnce({
      data: { tree: [{ path: 'plugins/quoted', type: 'tree' }] },
    });
    const skill = b64(
      ['---', 'name: "Quoted Name"', `author: 'Single Quoted'`, '---', '# Body'].join('\n')
    );
    octokit.rest.repos.getContent.mockImplementation(async (args: { path: string }) => {
      if (args.path.endsWith('SKILL.md')) return { data: { content: skill } };
      throw Object.assign(new Error('Not found'), { status: 404 });
    });

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as never,
      owner: 'acme',
      repo: 'demo',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value.plugins[0];
    expect(p.name).toBe('Quoted Name');
    expect(p.author).toBe('Single Quoted');
  });

  it('SKILL.md without frontmatter parses as no-metadata', async () => {
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'sha-no-fm' } },
    });
    octokit.rest.git.getTree.mockResolvedValueOnce({
      data: { tree: [{ path: 'plugins/nofm', type: 'tree' }] },
    });
    const skill = b64('# No frontmatter here\n\nJust body text.');
    octokit.rest.repos.getContent.mockImplementation(async (args: { path: string }) => {
      if (args.path.endsWith('SKILL.md')) return { data: { content: skill } };
      throw Object.assign(new Error('Not found'), { status: 404 });
    });

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as never,
      owner: 'acme',
      repo: 'demo',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value.plugins[0];
    expect(p.name).toBe('nofm'); // fallback to id
    expect(p.description).toBeUndefined();
  });

  it('SKILL.md with unterminated frontmatter returns no metadata', async () => {
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'sha-unterm' } },
    });
    octokit.rest.git.getTree.mockResolvedValueOnce({
      data: { tree: [{ path: 'plugins/unterm', type: 'tree' }] },
    });
    // Starts with --- but no closing fence
    const skill = b64('---\nname: Unfinished\n# never closed\nBody text');
    octokit.rest.repos.getContent.mockImplementation(async (args: { path: string }) => {
      if (args.path.endsWith('SKILL.md')) return { data: { content: skill } };
      throw Object.assign(new Error('Not found'), { status: 404 });
    });

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as never,
      owner: 'acme',
      repo: 'demo',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.plugins[0].name).toBe('unterm'); // fell back to id
  });

  it('processes more than concurrency-limit plugins (batch processing path)', async () => {
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'sha-many' } },
    });
    // 12 plugin dirs — exceeds the MAX_CONCURRENT_REQUESTS=5 batch size
    const tree = Array.from({ length: 12 }, (_, i) => ({
      path: `plugins/p-${i}`,
      type: 'tree',
    }));
    octokit.rest.git.getTree.mockResolvedValueOnce({ data: { tree } });
    octokit.rest.repos.getContent.mockImplementation(async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    });

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as never,
      owner: 'acme',
      repo: 'demo',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.plugins).toHaveLength(12);
  });

  it('pluginsPath that already ends with "/" is normalized to a single slash', async () => {
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'sha-slash' } },
    });
    octokit.rest.git.getTree.mockResolvedValueOnce({
      data: { tree: [{ path: 'src/plugins/x', type: 'tree' }] },
    });
    octokit.rest.repos.getContent.mockImplementation(async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    });

    const r = await syncMarketplaceFromGitHub({
      octokit: octokit as never,
      owner: 'acme',
      repo: 'demo',
      pluginsPath: 'src/plugins/',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.plugins[0].id).toBe('x');
  });
});
