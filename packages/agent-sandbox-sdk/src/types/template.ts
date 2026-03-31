import type {
  CRDResource,
  CRDResourceList,
  NetworkPolicyManagement,
  NetworkPolicySpec,
  PodTemplate,
} from './common.js';

/**
 * SandboxTemplate spec - v0.2.1
 */
export interface SandboxTemplateSpec {
  podTemplate: PodTemplate;
  networkPolicy?: NetworkPolicySpec;
  networkPolicyManagement?: NetworkPolicyManagement; // default: 'Managed'
}

/**
 * SandboxTemplate status (empty - matches upstream)
 */
export type SandboxTemplateStatus = Record<string, never>;

/**
 * Full SandboxTemplate resource
 */
export type SandboxTemplate = CRDResource<SandboxTemplateSpec, SandboxTemplateStatus>;

/**
 * SandboxTemplate list
 */
export type SandboxTemplateList = CRDResourceList<SandboxTemplate>;
