import type {
  V1Condition,
  V1NetworkPolicyEgressRule,
  V1NetworkPolicyIngressRule,
  V1ObjectMeta,
  V1PersistentVolumeClaimSpec,
  V1PodSpec,
} from '@kubernetes/client-node';

/**
 * Base interface for all CRD resources
 */
export interface CRDResource<TSpec = unknown, TStatus = unknown> {
  apiVersion: string;
  kind: string;
  metadata: V1ObjectMeta;
  spec: TSpec;
  status?: TStatus;
}

/**
 * List wrapper for CRD resources
 */
export interface CRDResourceList<T extends CRDResource> {
  apiVersion: string;
  kind: string;
  metadata: { resourceVersion?: string; continue?: string };
  items: T[];
}

/**
 * Watch event types
 */
export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR' | 'BOOKMARK';

/**
 * Watch event
 */
export interface WatchEvent<T extends CRDResource> {
  type: WatchEventType;
  object: T;
}

/**
 * Standard condition from K8s status
 */
export type Condition = V1Condition;

/**
 * Pod metadata (labels + annotations only)
 */
export interface PodMetadata {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/**
 * Pod template used by Sandbox and SandboxTemplate specs
 */
export interface PodTemplate {
  spec: V1PodSpec;
  metadata: PodMetadata; // NOT optional - always serialized (no omitempty in upstream)
}

/**
 * Embedded metadata for PVC templates
 */
export interface EmbeddedObjectMetadata {
  name?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/**
 * PVC template for Sandbox volumeClaimTemplates
 */
export interface PersistentVolumeClaimTemplate {
  metadata: EmbeddedObjectMetadata; // NOT optional
  spec: V1PersistentVolumeClaimSpec;
}

/**
 * Shutdown policy enum
 */
export type ShutdownPolicy = 'Delete' | 'Retain';

/**
 * Lifecycle for SandboxClaim (nested object)
 * NOTE: For Sandbox, these fields are INLINED (top-level on SandboxSpec)
 */
export interface Lifecycle {
  shutdownTime?: string; // ISO date-time
  shutdownPolicy?: ShutdownPolicy;
}

/**
 * Network policy management mode
 */
export type NetworkPolicyManagement = 'Managed' | 'Unmanaged';

/**
 * Network policy spec using K8s-native types
 */
export interface NetworkPolicySpec {
  ingress?: V1NetworkPolicyIngressRule[];
  egress?: V1NetworkPolicyEgressRule[];
}

/**
 * Extensions-local SandboxStatus (used in SandboxClaim status)
 * CRITICAL: The JSON key is "Name" with capital N
 */
export interface ClaimSandboxStatus {
  Name?: string; // Capital N - matches upstream json:"Name,omitempty"
}
