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

/**
 * Default network mode for sandboxes.
 *
 * theme-04 P1-06: Operators can opt into hard network isolation by setting
 * `SANDBOX_DEFAULT_NETWORK_MODE=none`. The historical default is `bridge` so
 * agents retain outbound internet access for tool calls (npm, GitHub API,
 * Anthropic). Changing this default is a breaking change for most flows —
 * hence the env-var opt-in rather than a schema default swap.
 */
export function getDefaultSandboxNetworkMode(): 'bridge' | 'none' {
  const value = process.env.SANDBOX_DEFAULT_NETWORK_MODE;
  return value === 'none' ? 'none' : 'bridge';
}

/**
 * Default sandbox image.
 *
 * theme-04 P0-01: The default image MUST be digest-pinned (`...@sha256:...`) to
 * prevent supply-chain attacks via mutable `:latest` tags. The digest below is
 * a placeholder that needs to be replaced with the real GHCR digest once the
 * image-publish workflow lands (tracked in theme 11). Tenants who override
 * `image` in their sandbox config are validated by `SandboxConfigService`
 * which rejects tag-only references.
 *
 * Placeholder digest: all zeros. This forces CI to fail fast in any
 * environment that actually tries to pull the image before the real digest
 * is published — making the required follow-up visible.
 */
export const SANDBOX_DEFAULTS = {
  image:
    'ghcr.io/agentdevsl/agent-sandbox@sha256:0000000000000000000000000000000000000000000000000000000000000000',
  memoryMb: 8192,
  cpuCores: 4,
  idleTimeoutMinutes: 30,
  userHome: '/home/node',
} as const;

/**
 * Regex for digest-pinned image references.
 * Format: `<registry>/<path>@sha256:<64 hex chars>`
 * Examples:
 *   ghcr.io/agentdevsl/agent-sandbox@sha256:abc123... (valid)
 *   ghcr.io/agentdevsl/agent-sandbox:latest (invalid — tag only)
 *   agent-sandbox (invalid — no digest)
 *
 * theme-04 P0-01: digest-pinning prevents mutable-tag supply-chain attacks.
 */
export const DIGEST_PINNED_IMAGE_REGEX = /^[^\s@:]+(?::[^\s@]+)?@sha256:[a-f0-9]{64}$/;

/**
 * Validate that an image reference is digest-pinned.
 * Returns true for `<ref>@sha256:<64 hex>` and false for tag-only or bare refs.
 */
export function isDigestPinnedImage(image: string): boolean {
  return DIGEST_PINNED_IMAGE_REGEX.test(image);
}

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
  // theme-04 P0-01: tenant image overrides must be digest-pinned. Empty string
  // / undefined means "use the default", which is already pinned.
  image: z
    .string()
    .refine((value) => value === '' || isDigestPinnedImage(value), {
      message:
        "Sandbox image must be digest-pinned ('<image>@sha256:<64 hex>'). Tag-only refs are rejected.",
    })
    .optional(),
  additionalVolumes: z.array(volumeMountConfigSchema).optional(),
  memoryMb: z.number().positive().max(32768).optional(),
  cpuCores: z.number().positive().max(16).optional(),
  namespace: z.string().optional(),
  serviceAccount: z.string().optional(),
  nomadNamespace: z.string().optional(),
});
