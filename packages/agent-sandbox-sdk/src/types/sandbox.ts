import type { V1Condition } from '@kubernetes/client-node';
import type {
  CRDResource,
  CRDResourceList,
  PersistentVolumeClaimTemplate,
  PodTemplate,
  ShutdownPolicy,
} from './common.js';

/**
 * Sandbox spec - v0.2.1
 * NOTE: shutdownTime and shutdownPolicy are INLINED from Lifecycle (not nested)
 */
export interface SandboxSpec {
  podTemplate: PodTemplate;
  volumeClaimTemplates?: PersistentVolumeClaimTemplate[];
  // Lifecycle fields inlined (json:",inline" in Go)
  shutdownTime?: string;
  shutdownPolicy?: ShutdownPolicy;
  replicas?: number; // 0 or 1
}

/**
 * Sandbox status - v0.2.1 (condition-based, no phase field)
 */
export interface SandboxStatus {
  serviceFQDN?: string;
  service?: string;
  conditions?: V1Condition[];
  replicas: number; // NOT optional (no omitempty, no pointer in upstream)
  selector?: string; // LabelSelector string
}

/**
 * Full Sandbox resource
 */
export type Sandbox = CRDResource<SandboxSpec, SandboxStatus>;

/**
 * Sandbox list
 */
export type SandboxList = CRDResourceList<Sandbox>;
