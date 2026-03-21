import type { ProjectSandboxConfig } from '../../../lib/sandbox/types';

export type CodespaceConfig = {
  worktreeRoot: string;
  initScript?: string;
  envFile?: string;
  defaultBranch: string;
  allowedTools: string[];
  maxTurns: number;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  envVars?: Record<string, string>;
  sandbox?: ProjectSandboxConfig | null;
};

export type AgentConfig = {
  allowedTools: string[];
  maxTurns: number;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
};

export type SandboxStatus = 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error';

export interface VolumeMountRecord {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}
