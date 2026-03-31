import type { SandboxTemplateRef } from './claim.js';
import type { CRDResource, CRDResourceList } from './common.js';

/**
 * SandboxWarmPool spec - v0.2.1
 */
export interface SandboxWarmPoolSpec {
  replicas: number; // was desiredReady
  sandboxTemplateRef: SandboxTemplateRef; // was templateRef with namespace
}

/**
 * SandboxWarmPool status - v0.2.1
 */
export interface SandboxWarmPoolStatus {
  replicas?: number;
  readyReplicas?: number;
}

/**
 * Full SandboxWarmPool resource
 */
export type SandboxWarmPool = CRDResource<SandboxWarmPoolSpec, SandboxWarmPoolStatus>;

/**
 * SandboxWarmPool list
 */
export type SandboxWarmPoolList = CRDResourceList<SandboxWarmPool>;
