import type { Octokit } from 'octokit';
import type { CachedAgent, CachedCommand, CachedSkill } from '../../db/schema';
import type { TemplateError } from '../errors/template-errors.js';
import { TemplateErrors } from '../errors/template-errors.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import { formatGitHubError } from './client.js';

export interface TemplateSyncOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  configPath?: string;
  ref?: string;
}

export interface TemplateSyncResult {
  skills: CachedSkill[];
  commands: CachedCommand[];
  agents: CachedAgent[];
  sha: string;
}

interface GitHubContentFile {
  type: 'file';
  name: string;
  path: string;
  sha: string;
  content?: string;
  encoding?: string;
}

interface GitHubContentDir {
  type: 'dir';
  name: string;
  path: string;
}

type GitHubContent = GitHubContentFile | GitHubContentDir;

/**
 * Parse simple YAML frontmatter from markdown content.
 * Supports single-line key: value pairs and block-style list arrays
 * (lines starting with `  - `). Does not support nested objects or multi-line values.
 *
 * @returns The parsed frontmatter as key-value pairs and the remaining content
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const [, frontmatterStr, body] = match;
  const frontmatter: Record<string, unknown> = {};

  if (!frontmatterStr) {
    return { frontmatter: {}, body: body ?? content };
  }

  const lines = frontmatterStr.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    // Block-style list item: "  - value"
    if (/^\s+-\s/.test(line) && currentKey && currentArray) {
      const item = line.replace(/^\s+-\s*/, '').trim();
      // Strip quotes from list items
      if (
        (item.startsWith('"') && item.endsWith('"')) ||
        (item.startsWith("'") && item.endsWith("'"))
      ) {
        currentArray.push(item.slice(1, -1));
      } else {
        currentArray.push(item);
      }
      continue;
    }

    // Flush any pending array before processing the next key
    if (currentKey && currentArray) {
      frontmatter[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const rawValue = line.slice(colonIndex + 1).trim();

      // Empty value after colon → start collecting a list
      if (rawValue === '') {
        currentKey = key;
        currentArray = [];
        continue;
      }

      // Flow-style array: [item1, item2]
      if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        frontmatter[key] = rawValue
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        continue;
      }

      let value: string | boolean | number = rawValue;

      // Handle quoted strings
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else if (value === 'true') {
        value = true;
      } else if (value === 'false') {
        value = false;
      } else if (value !== '' && !Number.isNaN(Number(value))) {
        value = Number(value);
      }

      frontmatter[key] = value;
    }
  }

  // Flush trailing array
  if (currentKey && currentArray) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, body: body ?? content };
}

/**
 * Fetch directory contents from GitHub
 */
async function fetchDirectoryContents(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<Result<GitHubContent[], TemplateError>> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if (!Array.isArray(data)) {
      return ok([]);
    }

    return ok(data as GitHubContent[]);
    // nosemgrep: agentpane.error-masking.catch-returns-ok-helper
  } catch (error) {
    const statusCode = (error as { status?: number }).status;
    if (statusCode === 404) {
      return ok([]);
    }
    return err(TemplateErrors.FETCH_FAILED(path, formatGitHubError(error).message));
  }
}

/**
 * Fetch file content from GitHub
 */
async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<Result<{ content: string; sha: string }, TemplateError>> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
      return err(TemplateErrors.FETCH_FAILED(path, 'Not a file'));
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return ok({ content, sha: data.sha });
  } catch (error) {
    const statusCode = (error as { status?: number }).status;
    if (statusCode === 404) {
      return err(TemplateErrors.FETCH_FAILED(path, 'File not found'));
    }
    return err(TemplateErrors.FETCH_FAILED(path, formatGitHubError(error).message));
  }
}

/**
 * Fetch skills from .claude/skills/ directory.
 * Each skill is a directory containing a SKILL.md file.
 * Directories without SKILL.md are silently skipped with a warning log.
 */
async function fetchSkills(
  octokit: Octokit,
  owner: string,
  repo: string,
  configPath: string,
  ref?: string
): Promise<Result<CachedSkill[], TemplateError>> {
  const skillsPath = `${configPath}/skills`;
  const dirResult = await fetchDirectoryContents(octokit, owner, repo, skillsPath, ref);

  if (!dirResult.ok) {
    return dirResult;
  }

  const skills: CachedSkill[] = [];

  for (const item of dirResult.value) {
    if (item.type !== 'dir') continue;

    const skillFilePath = `${skillsPath}/${item.name}/SKILL.md`;
    const fileResult = await fetchFileContent(octokit, owner, repo, skillFilePath, ref);

    if (!fileResult.ok) {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(fileResult.value.content);

    // Parse tags: comma-separated string → string[]
    const rawTags = frontmatter.tags;
    const tags =
      typeof rawTags === 'string' && rawTags.length > 0
        ? rawTags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;

    skills.push({
      id: item.name,
      name: (frontmatter.name as string) ?? item.name,
      description: frontmatter.description as string | undefined,
      tags,
      content: body,
      executionSkill: (frontmatter.executionSkill as string) || undefined,
    });
  }

  return ok(skills);
}

/**
 * Fetch commands from .claude/commands/ directory
 * Each command is a .md file
 */
async function fetchCommands(
  octokit: Octokit,
  owner: string,
  repo: string,
  configPath: string,
  ref?: string
): Promise<Result<CachedCommand[], TemplateError>> {
  const commandsPath = `${configPath}/commands`;
  const dirResult = await fetchDirectoryContents(octokit, owner, repo, commandsPath, ref);

  if (!dirResult.ok) {
    return dirResult;
  }

  const commands: CachedCommand[] = [];

  for (const item of dirResult.value) {
    if (item.type !== 'file' || !item.name.endsWith('.md')) continue;

    const fileResult = await fetchFileContent(octokit, owner, repo, item.path, ref);

    if (!fileResult.ok) {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(fileResult.value.content);
    const commandName = item.name.replace(/\.md$/, '');

    commands.push({
      name: (frontmatter.name as string) ?? commandName,
      description: frontmatter.description as string | undefined,
      content: body,
    });
  }

  return ok(commands);
}

/**
 * Fetch agents from .claude/agents/ directory
 * Each agent is a .md file
 */
async function fetchAgents(
  octokit: Octokit,
  owner: string,
  repo: string,
  configPath: string,
  ref?: string
): Promise<Result<CachedAgent[], TemplateError>> {
  const agentsPath = `${configPath}/agents`;
  const dirResult = await fetchDirectoryContents(octokit, owner, repo, agentsPath, ref);

  if (!dirResult.ok) {
    return dirResult;
  }

  const agents: CachedAgent[] = [];

  for (const item of dirResult.value) {
    if (item.type !== 'file' || !item.name.endsWith('.md')) continue;

    const fileResult = await fetchFileContent(octokit, owner, repo, item.path, ref);

    if (!fileResult.ok) {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(fileResult.value.content);
    const agentName = item.name.replace(/\.md$/, '');

    agents.push({
      name: (frontmatter.name as string) ?? agentName,
      description: frontmatter.description as string | undefined,
      content: body,
      model: frontmatter.model as string | undefined,
      color: frontmatter.color as string | undefined,
      skills: Array.isArray(frontmatter.skills) ? (frontmatter.skills as string[]) : undefined,
      tools: Array.isArray(frontmatter.tools) ? (frontmatter.tools as string[]) : undefined,
    });
  }

  return ok(agents);
}

/**
 * Get the latest commit SHA for the repository
 */
async function getLatestSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref?: string
): Promise<Result<string, TemplateError>> {
  try {
    const { data } = await octokit.rest.repos.getCommit({
      owner,
      repo,
      ref: ref ?? 'HEAD',
    });
    return ok(data.sha);
  } catch (error) {
    return err(TemplateErrors.FETCH_FAILED('commit', formatGitHubError(error).message));
  }
}

/**
 * Sync template content from a GitHub repository
 * Fetches skills, commands, and agents from the .claude directory
 */
export async function syncTemplateFromGitHub(
  options: TemplateSyncOptions
): Promise<Result<TemplateSyncResult, TemplateError>> {
  const { octokit, owner, repo, configPath = '.claude', ref } = options;

  // Get latest commit SHA
  const shaResult = await getLatestSha(octokit, owner, repo, ref);
  if (!shaResult.ok) {
    return shaResult;
  }

  // Fetch all content in parallel
  const [skillsResult, commandsResult, agentsResult] = await Promise.all([
    fetchSkills(octokit, owner, repo, configPath, ref),
    fetchCommands(octokit, owner, repo, configPath, ref),
    fetchAgents(octokit, owner, repo, configPath, ref),
  ]);

  if (!skillsResult.ok) {
    return skillsResult;
  }
  if (!commandsResult.ok) {
    return commandsResult;
  }
  if (!agentsResult.ok) {
    return agentsResult;
  }

  return ok({
    skills: skillsResult.value,
    commands: commandsResult.value,
    agents: agentsResult.value,
    sha: shaResult.value,
  });
}

/**
 * Parse a GitHub repository URL into owner and repo
 * Supports formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - owner/repo
 */
export function parseGitHubUrl(
  url: string
): Result<{ owner: string; repo: string }, TemplateError> {
  // Try simple owner/repo format first
  const simpleMatch = url.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (simpleMatch?.[1] && simpleMatch[2]) {
    return ok({ owner: simpleMatch[1], repo: simpleMatch[2].replace(/\.git$/, '') });
  }

  // Try HTTPS URL
  const httpsMatch = url.match(/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return ok({ owner: httpsMatch[1], repo: httpsMatch[2].replace(/\.git$/, '') });
  }

  // Try SSH URL
  const sshMatch = url.match(/github\.com:([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return ok({ owner: sshMatch[1], repo: sshMatch[2].replace(/\.git$/, '') });
  }

  return err(TemplateErrors.INVALID_REPO_URL(url));
}
