import { z } from 'zod';
import { SANDBOX_TYPES } from '../../db/schema/shared/enums.js';

export type SandboxStatus = 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error';

export interface VolumeMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

export interface SandboxConfig {
  /** Pre-assigned sandbox ID. Providers use this instead of generating their own. */
  id?: string;
  codespaceId: string;
  codespacePath: string;
  image: string;
  memoryMb: number;
  cpuCores: number;
  idleTimeoutMinutes: number;
  volumeMounts: VolumeMountConfig[];
  env?: Record<string, string>;
  /** SC-006: Docker network mode. Default 'bridge'. Use 'none' for full network isolation. */
  networkMode?: 'bridge' | 'none';
}

export interface SandboxInfo {
  id: string;
  codespaceId: string;
  containerId: string;
  status: SandboxStatus;
  image: string;
  createdAt: string;
  lastActivityAt: string;
  memoryMb: number;
  cpuCores: number;
}

export interface SandboxMetrics {
  cpuUsagePercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  diskUsageMb: number;
  networkRxBytes: number;
  networkTxBytes: number;
  uptime: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TmuxSession {
  name: string;
  sandboxId: string;
  taskId?: string;
  createdAt: string;
  windowCount: number;
  attached: boolean;
}

export type { OAuthCredentials } from '../../types/credentials.js';

export type SandboxProvider = (typeof SANDBOX_TYPES)[number];

export interface CodespaceSandboxConfig {
  enabled: boolean;
  provider: SandboxProvider;
  idleTimeoutMinutes: number;
  image?: string;
  additionalVolumes?: VolumeMountConfig[];
  memoryMb?: number;
  cpuCores?: number;
  /** Kubernetes namespace. Only used when provider is 'kubernetes'. */
  namespace?: string;
  /** Kubernetes service account. Only used when provider is 'kubernetes'. */
  serviceAccount?: string;
  /** Nomad namespace. Only used when provider is 'nomad'. */
  nomadNamespace?: string;
}

export interface SandboxHealthCheck {
  healthy: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export const SANDBOX_DEFAULTS = {
  image: 'srlynch1/agent-sandbox:latest',
  memoryMb: 4096,
  cpuCores: 2,
  idleTimeoutMinutes: 30,
  userHome: '/home/node',
} as const;

export const volumeMountConfigSchema = z.object({
  hostPath: z.string(),
  containerPath: z.string(),
  readonly: z.boolean().optional(),
});

export const sandboxConfigSchema = z.object({
  id: z.string().optional(),
  codespaceId: z.string(),
  codespacePath: z.string(),
  image: z.string().default(SANDBOX_DEFAULTS.image),
  memoryMb: z.number().positive().max(32768).default(SANDBOX_DEFAULTS.memoryMb),
  cpuCores: z.number().positive().max(16).default(SANDBOX_DEFAULTS.cpuCores),
  idleTimeoutMinutes: z.number().positive().default(SANDBOX_DEFAULTS.idleTimeoutMinutes),
  volumeMounts: z.array(volumeMountConfigSchema).default([]),
  env: z.record(z.string(), z.string()).optional(),
  networkMode: z.enum(['bridge', 'none']).default('bridge'),
});

export const sandboxProviderSchema = z.enum(SANDBOX_TYPES);

export const projectSandboxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: sandboxProviderSchema.default('docker'),
  idleTimeoutMinutes: z.number().positive().default(SANDBOX_DEFAULTS.idleTimeoutMinutes),
  image: z.string().optional(),
  additionalVolumes: z.array(volumeMountConfigSchema).optional(),
  memoryMb: z.number().positive().max(32768).optional(),
  cpuCores: z.number().positive().max(16).optional(),
  namespace: z.string().optional(),
  serviceAccount: z.string().optional(),
  nomadNamespace: z.string().optional(),
});
