import type { Octokit } from 'octokit';
import { z } from 'zod';
import type { CodespaceConfig } from '../../db/schema';
import { ALLOW_ALL_TOOLS } from '../constants/tools.js';
import { GitHubErrors } from '../errors/github-errors.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';

export interface SyncConfigOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  configPath?: string;
  ref?: string;
}

export interface SyncConfigResult {
  config: CodespaceConfig;
  sha: string;
  path: string;
}

const configFileSchema = z.object({
  worktreeRoot: z.string().optional(),
  initScript: z.string().optional(),
  envFile: z.string().optional(),
  defaultBranch: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  temperature: z.number().optional(),
});

export async function syncConfigFromGitHub(
  options: SyncConfigOptions
): Promise<Result<SyncConfigResult, ReturnType<typeof GitHubErrors.CONFIG_INVALID>>> {
  const { octokit, owner, repo, configPath = '.claude', ref } = options;

  const configFilePath = `${configPath}/config.json`;

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: configFilePath,
      ref,
    });

    // getContent returns an array for directories, single object for files
    if (Array.isArray(data)) {
      return err(GitHubErrors.CONFIG_NOT_FOUND(configFilePath));
    }

    if (data.type !== 'file' || !('content' in data)) {
      return err(GitHubErrors.CONFIG_NOT_FOUND(configFilePath));
    }

    // Decode base64 content
    const content = Buffer.from(data.content, 'base64').toString('utf-8');

    let parsedConfig: unknown;
    try {
      parsedConfig = JSON.parse(content);
    } catch {
      return err(GitHubErrors.CONFIG_INVALID(['Invalid JSON in config file']));
    }

    // Validate config structure
    const validationResult = configFileSchema.safeParse(parsedConfig);
    if (!validationResult.success) {
      return err(
        GitHubErrors.CONFIG_INVALID(
          validationResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
        )
      );
    }

    // Convert to full CodespaceConfig with defaults
    const fullConfig: CodespaceConfig = {
      worktreeRoot: validationResult.data.worktreeRoot ?? '.worktrees',
      initScript: validationResult.data.initScript,
      envFile: validationResult.data.envFile ?? '.env',
      defaultBranch: validationResult.data.defaultBranch ?? 'main',
      // F06-06: `[]` fails closed. Preserve pre-F06-06 default when user omits the field.
      allowedTools: validationResult.data.allowedTools ?? ALLOW_ALL_TOOLS,
      maxTurns: validationResult.data.maxTurns ?? 50,
      model: validationResult.data.model,
      systemPrompt: validationResult.data.systemPrompt,
      temperature: validationResult.data.temperature,
    };

    return ok({
      config: fullConfig,
      sha: data.sha,
      path: configFilePath,
    });
  } catch (error) {
    const statusCode = (error as { status?: number }).status;

    if (statusCode === 404) {
      return err(GitHubErrors.CONFIG_NOT_FOUND(configFilePath));
    }

    if (statusCode === 401 || statusCode === 403) {
      return err(GitHubErrors.AUTH_FAILED(String(error)));
    }

    if (statusCode === 429) {
      const resetAt = (error as { response?: { headers?: { 'x-ratelimit-reset'?: string } } })
        .response?.headers?.['x-ratelimit-reset'];
      return err(GitHubErrors.RATE_LIMITED(resetAt ? Number.parseInt(resetAt, 10) : 0));
    }

    return err(GitHubErrors.CONFIG_INVALID([String(error)]));
  }
}

export async function checkConfigExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  configPath = '.claude'
): Promise<boolean> {
  try {
    await octokit.rest.repos.getContent({
      owner,
      repo,
      path: `${configPath}/config.json`,
    });
    return true;
  } catch {
    return false;
  }
}
