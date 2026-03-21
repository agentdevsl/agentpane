import { z } from 'zod';

export const codespaceConfigSchema = z.object({
  worktreeRoot: z.string().default('.worktrees'),
  initScript: z.string().optional(),
  envFile: z.string().optional(),
  defaultBranch: z.string().default('main'),
  maxConcurrentAgents: z.number().min(1).max(10).default(3),
  allowedTools: z.array(z.string()).default(['Read', 'Edit', 'Bash', 'Glob', 'Grep']),
  maxTurns: z.number().min(1).max(500).default(50),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
});

/**
 * CB-016: Global config schema for environment variable validation.
 * Used by `validateEnv()` in `api.ts` to validate server-level configuration.
 * anthropicApiKey is optional because non-agent operations (codespace listing,
 * settings, etc.) do not require it — it is validated at agent execution time.
 */
export const globalConfigSchema = z.object({
  anthropicApiKey: z.string().optional(),
  githubToken: z.string().optional(),
  databaseUrl: z.string().optional(),
  appUrl: z.string().optional(),
});
