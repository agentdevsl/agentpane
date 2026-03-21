/**
 * Schema for sandbox status collection
 */

import { z } from 'zod';
import { SANDBOX_TYPES } from '../../db/schema/shared/enums.js';

/**
 * Sandbox status entry schema
 */
export const sandboxStatusSchema = z.object({
  /** Codespace ID (primary key) */
  codespaceId: z.string(),
  /** Sandbox mode: shared container or per-codespace */
  mode: z.enum(['shared', 'per-project']),
  /** Current container status */
  containerStatus: z.enum([
    'stopped',
    'creating',
    'running',
    'idle',
    'stopping',
    'error',
    'unavailable',
  ]),
  /** Docker container ID if available */
  containerId: z.string().nullable(),
  /** Whether a sandbox provider (Docker, K8s, or Nomad) is available */
  providerAvailable: z.boolean(),
  /** Active sandbox provider type */
  provider: z.enum([...SANDBOX_TYPES, 'none'] as const).default('none'),
  /** Whether K8s CRDs are installed and ready */
  k8sCrdReady: z.boolean().optional(),
  /** Kubernetes cluster version */
  k8sClusterVersion: z.string().nullable().optional(),
  /** Total number of sandbox pods */
  k8sPodCount: z.number().optional(),
  /** Number of running sandbox pods */
  k8sPodsRunning: z.number().optional(),
  /** Whether Nomad cluster is healthy */
  nomadHealthy: z.boolean().optional(),
  /** Nomad server version */
  nomadVersion: z.string().nullable().optional(),
  /** Nomad cluster leader address */
  nomadLeader: z.string().nullable().optional(),
  /** Total number of Nomad sandbox jobs */
  nomadJobCount: z.number().optional(),
  /** Last updated timestamp */
  updatedAt: z.number(),
});

export type SandboxStatus = z.infer<typeof sandboxStatusSchema>;
