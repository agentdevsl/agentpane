import type { Octokit } from 'octokit';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import { formatGitHubError } from './client.js';

// Concurrency limiter for GitHub API calls to avoid rate limiting
const MAX_CONCURRENT_REQUESTS = 5;

/**
 * Batch process items with concurrency limit
 * Processes items in chunks to avoid overwhelming the GitHub API
 */
async function batchProcess<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = MAX_CONCURRENT_REQUESTS
): Promise<R[]> {
  const results: R[] = [];

  // Process in chunks
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }

  return results;
}

// Plugin tags for filtering
export const PLUGIN_TAGS = ['official', 'external'] as const;
export type PluginTag = (typeof PLUGIN_TAGS)[number];

/**
 * Cached plugin metadata from marketplace repository
 */
export interface CachedPlugin {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  category?: string;
  readme?: string;
  tags?: PluginTag[];
}

export interface PluginPathConfig {
  path: string;
  tag: PluginTag;
}

export interface MarketplaceSyncOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pluginsPath?: string;
  /** Additional paths with tags for multi-path marketplaces (e.g., official + external) */
  additionalPaths?: PluginPathConfig[];
  ref?: string;
}

export interface MarketplaceSyncResult {
  plugins: CachedPlugin[];
  sha: string;
}

/**
 * Fetch plugins from a marketplace GitHub repository
 * Looks for plugin directories and extracts metadata from each
 * Supports multiple paths with different tags (e.g., official vs external)
 */
export async function syncMarketplaceFromGitHub(
  options: MarketplaceSyncOptions
): Promise<Result<MarketplaceSyncResult, { message: string }>> {
  const {
    octokit,
    owner,
    repo,
    pluginsPath = 'plugins',
    additionalPaths = [],
    ref = 'main',
  } = options;

  try {
    // Get the latest commit SHA
    const { data: refData } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${ref}`,
    });
    const sha = refData.object.sha;

    // Get the tree to find plugin directories
    const { data: tree } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: sha,
      recursive: 'true',
    });

    // Build list of paths to scan with their tags
    const pathConfigs: PluginPathConfig[] = [
      { path: pluginsPath, tag: 'official' },
      ...additionalPaths,
    ];

    const plugins: CachedPlugin[] = [];

    for (const { path: currentPath, tag } of pathConfigs) {
      // Find plugin directories (directories directly under currentPath)
      const pluginDirs = new Set<string>();
      const pluginsPrefix = currentPath.endsWith('/') ? currentPath : `${currentPath}/`;

      for (const item of tree.tree) {
        if (item.path?.startsWith(pluginsPrefix) && item.type === 'tree') {
          // Get the first directory segment after pluginsPath
          const relativePath = item.path.slice(pluginsPrefix.length);
          const pluginName = relativePath.split('/')[0];
          if (pluginName && !pluginName.includes('/')) {
            pluginDirs.add(pluginName);
          }
        }
      }

      // Fetch metadata for each plugin in this path (with concurrency limiting)
      const pluginIds = Array.from(pluginDirs);

      const fetchedPlugins = await batchProcess(pluginIds, (pluginId) =>
        fetchPluginMetadata(octokit, owner, repo, currentPath, pluginId, ref, tag)
      );

      for (const plugin of fetchedPlugins) {
        if (plugin) {
          plugins.push(plugin);
        }
      }
    }

    return ok({ plugins, sha });
  } catch (error) {
    const ghError = formatGitHubError(error);
    return err({
      message: `Failed to sync marketplace: ${ghError.message}`,
      status: ghError.status,
    });
  }
}

async function fetchPluginMetadata(
  octokit: Octokit,
  owner: string,
  repo: string,
  pluginsPath: string,
  pluginId: string,
  ref: string,
  tag: PluginTag
): Promise<CachedPlugin | null> {
  const basePath = `${pluginsPath}/${pluginId}`;

  let name = pluginId;
  let description: string | undefined;
  let author: string | undefined;
  let version: string | undefined;
  let category: string | undefined;
  let readme: string | undefined;

  // Try to fetch SKILL.md for frontmatter metadata
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: `${basePath}/SKILL.md`,
      ref,
    });

    if ('content' in data && data.content) {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      const metadata = parseSkillFrontmatter(content);
      if (metadata.name) name = metadata.name;
      if (metadata.description) description = metadata.description;
      if (metadata.author) author = metadata.author;
      if (metadata.version) version = metadata.version;
      if (metadata.category) category = metadata.category;
    }
  } catch (error) {
    // Only suppress 404 (file not found), log other errors
    const status = (error as { status?: number }).status;
    if (status !== 404) {
      // Non-404 error fetching metadata — unexpected but non-fatal for plugin sync
    }
  }

  // Try to fetch README.md
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: `${basePath}/README.md`,
      ref,
    });

    if ('content' in data && data.content) {
      readme = Buffer.from(data.content, 'base64').toString('utf-8');
      // Extract description from first paragraph if not set
      if (!description && readme) {
        const firstParagraph = readme.split('\n\n')[1]?.trim();
        if (firstParagraph && !firstParagraph.startsWith('#')) {
          description = firstParagraph.slice(0, 200);
        }
      }
    }
  } catch (error) {
    // Only suppress 404 (file not found), log other errors
    const status = (error as { status?: number }).status;
    if (status !== 404) {
      // Non-404 error fetching README — unexpected but non-fatal for plugin sync
    }
  }

  return {
    id: pluginId,
    name,
    description,
    author,
    version,
    category,
    readme,
    tags: [tag],
  };
}

/**
 * Parse YAML frontmatter from SKILL.md file
 * Extracts name, description, author, version, category
 */
function parseSkillFrontmatter(content: string): Partial<CachedPlugin> {
  const result: Partial<CachedPlugin> = {};

  // Check for YAML frontmatter
  if (!content.startsWith('---')) {
    return result;
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return result;
  }

  const frontmatter = content.slice(3, endIndex).trim();
  const lines = frontmatter.split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim().toLowerCase();
    let value = line.slice(colonIndex + 1).trim();

    // Remove quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    switch (key) {
      case 'name':
        result.name = value;
        break;
      case 'description':
        result.description = value;
        break;
      case 'author':
        result.author = value;
        break;
      case 'version':
        result.version = value;
        break;
      case 'category':
        result.category = value;
        break;
    }
  }

  return result;
}

/**
 * Parse GitHub URL to extract owner and repo
 */
export function parseGitHubMarketplaceUrl(
  url: string
): Result<{ owner: string; repo: string }, { message: string }> {
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^([^/]+)\/([^/]+)$/, // simple owner/repo format
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1] && match[2]) {
      return ok({ owner: match[1], repo: match[2] });
    }
  }

  return err({ message: 'Invalid GitHub URL format' });
}
