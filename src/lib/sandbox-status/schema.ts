/**
 * Schema for sandbox status collection
 */

import { z } from 'zod';

/**
 * Sandbox status entry schema
 */
export const sandboxStatusSchema = z.object({
  /** Project ID (primary key) */
  projectId: z.string(),
  /** Sandbox mode: shared container or per-project */
  mode: z.enum(['shared', 'per-project']),
  /** Current container status */
  containerStatus: z.enum(['stopped', 'creating', 'running', 'idle', 'error', 'unavailable']),
  /** Docker container ID if available */
  containerId: z.string().nullable(),
  /** Whether a sandbox provider (Docker or K8s) is available */
  dockerAvailable: z.boolean(),
  /** Active sandbox provider type */
  provider: z.enum(['docker', 'kubernetes', 'none']).default('none'),
  /** Whether K8s CRDs are installed and ready */
  k8sCrdReady: z.boolean().optional(),
  /** Kubernetes cluster version */
  k8sClusterVersion: z.string().nullable().optional(),
  /** Total number of sandbox pods */
  k8sPodCount: z.number().optional(),
  /** Number of running sandbox pods */
  k8sPodsRunning: z.number().optional(),
  /** Last updated timestamp */
  updatedAt: z.number(),
});

export type SandboxStatus = z.infer<typeof sandboxStatusSchema>;
