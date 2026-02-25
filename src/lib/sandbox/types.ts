import { z } from 'zod';
import { SANDBOX_TYPES } from '../../db/schema/shared/enums.js';

/**
 * Sandbox status
 */
export type SandboxStatus = 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error';

/**
 * Volume mount configuration
 */
export interface VolumeMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/**
 * Sandbox configuration
 */
export interface SandboxConfig {
  projectId: string;
  projectPath: string;
  image: string;
  memoryMb: number;
  cpuCores: number;
  idleTimeoutMinutes: number;
  volumeMounts: VolumeMountConfig[];
  env?: Record<string, string>;
}

/**
 * Sandbox instance information
 */
export interface SandboxInfo {
  id: string;
  projectId: string;
  containerId: string;
  status: SandboxStatus;
  image: string;
  createdAt: string;
  lastActivityAt: string;
  memoryMb: number;
  cpuCores: number;
}

/**
 * Sandbox metrics
 */
export interface SandboxMetrics {
  cpuUsagePercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  diskUsageMb: number;
  networkRxBytes: number;
  networkTxBytes: number;
  uptime: number;
}

/**
 * Command execution result
 */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * tmux session information
 */
export interface TmuxSession {
  name: string;
  sandboxId: string;
  taskId?: string;
  createdAt: string;
  windowCount: number;
  attached: boolean;
}

// Re-export OAuthCredentials from shared location for backwards compatibility
export type { OAuthCredentials } from '../../types/credentials.js';

/**
 * Sandbox provider type — derived from the canonical SANDBOX_TYPES enum
 */
export type SandboxProvider = (typeof SANDBOX_TYPES)[number];

/**
 * Project sandbox configuration (stored in project config)
 */
export interface ProjectSandboxConfig {
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

/**
 * Sandbox provider health check result
 */
export interface SandboxHealthCheck {
  healthy: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Default values
 */
export const SANDBOX_DEFAULTS = {
  image: 'srlynch1/agent-sandbox:latest',
  memoryMb: 4096,
  cpuCores: 2,
  idleTimeoutMinutes: 30,
  userHome: '/home/node',
} as const;

// Zod schemas for validation

export const volumeMountConfigSchema = z.object({
  hostPath: z.string(),
  containerPath: z.string(),
  readonly: z.boolean().optional(),
});

export const sandboxConfigSchema = z.object({
  projectId: z.string(),
  projectPath: z.string(),
  image: z.string().default(SANDBOX_DEFAULTS.image),
  memoryMb: z.number().positive().default(SANDBOX_DEFAULTS.memoryMb),
  cpuCores: z.number().positive().default(SANDBOX_DEFAULTS.cpuCores),
  idleTimeoutMinutes: z.number().positive().default(SANDBOX_DEFAULTS.idleTimeoutMinutes),
  volumeMounts: z.array(volumeMountConfigSchema).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

export const sandboxProviderSchema = z.enum(SANDBOX_TYPES);

export const projectSandboxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: sandboxProviderSchema.default('docker'),
  idleTimeoutMinutes: z.number().positive().default(SANDBOX_DEFAULTS.idleTimeoutMinutes),
  image: z.string().optional(),
  additionalVolumes: z.array(volumeMountConfigSchema).optional(),
  memoryMb: z.number().positive().optional(),
  cpuCores: z.number().positive().optional(),
  // Kubernetes-specific settings
  namespace: z.string().optional(),
  serviceAccount: z.string().optional(),
  // Nomad-specific settings
  nomadNamespace: z.string().optional(),
});

export type SandboxConfigSchema = z.infer<typeof sandboxConfigSchema>;
export type ProjectSandboxConfigSchema = z.infer<typeof projectSandboxConfigSchema>;
