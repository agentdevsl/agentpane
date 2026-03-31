import type { V1Condition } from '@kubernetes/client-node';
import type { ClaimSandboxStatus, CRDResource, CRDResourceList, Lifecycle } from './common.js';

/**
 * SandboxTemplateRef - name only, no namespace
 */
export interface SandboxTemplateRef {
  name: string;
}

/**
 * SandboxClaim spec - v0.2.1
 */
export interface SandboxClaimSpec {
  sandboxTemplateRef: SandboxTemplateRef;
  lifecycle?: Lifecycle; // nested (not inlined)
}

/**
 * SandboxClaim status - v0.2.1
 */
export interface SandboxClaimStatus {
  conditions?: V1Condition[];
  sandbox?: ClaimSandboxStatus; // { Name?: string } with capital N
}

/**
 * Full SandboxClaim resource
 */
export type SandboxClaim = CRDResource<SandboxClaimSpec, SandboxClaimStatus>;

/**
 * SandboxClaim list
 */
export type SandboxClaimList = CRDResourceList<SandboxClaim>;
