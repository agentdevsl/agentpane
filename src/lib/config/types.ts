import type { CodespaceSandboxConfig } from '../sandbox/types.js';

export type CodespaceConfig = {
  worktreeRoot: string;
  initScript?: string;
  envFile?: string;
  defaultBranch: string;
  allowedTools: string[];
  maxTurns: number;
  maxConcurrentAgents?: number;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  /** Environment variables to pass to sandbox containers securely */
  envVars?: Record<string, string>;
  /** Sandbox configuration for Docker-based execution */
  sandbox?: CodespaceSandboxConfig;
};

export type GlobalConfig = {
  anthropicApiKey: string;
  githubToken?: string;
  databaseUrl?: string;
  appUrl?: string;
};

export const DEFAULT_CODESPACE_CONFIG: CodespaceConfig = {
  worktreeRoot: '.worktrees',
  defaultBranch: 'main',
  allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
  maxTurns: 50,
  maxConcurrentAgents: 3,
};
