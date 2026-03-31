import type { V1PodSpec } from '@kubernetes/client-node';
import { CRD_EXTENSIONS_API, CRD_KINDS } from '../constants.js';
import type { NetworkPolicyManagement, NetworkPolicySpec, PodTemplate } from '../types/common.js';
import type { SandboxTemplate, SandboxTemplateSpec } from '../types/template.js';

export class SandboxTemplateBuilder {
  private resource: {
    apiVersion: string;
    kind: string;
    metadata: {
      name: string;
      namespace?: string;
      labels?: Record<string, string>;
    };
    spec: Partial<SandboxTemplateSpec>;
  };

  constructor(name: string) {
    this.resource = {
      apiVersion: CRD_EXTENSIONS_API.apiVersion,
      kind: CRD_KINDS.sandboxTemplate,
      metadata: { name },
      spec: {},
    };
  }

  namespace(ns: string): this {
    this.resource.metadata.namespace = ns;
    return this;
  }

  labels(labels: Record<string, string>): this {
    this.resource.metadata.labels = {
      ...this.resource.metadata.labels,
      ...labels,
    };
    return this;
  }

  /** Set the pod template */
  podTemplate(template: PodTemplate): this {
    this.resource.spec.podTemplate = template;
    return this;
  }

  /** Set container image */
  image(image: string): this {
    const podTemplate = this.ensurePodTemplate();
    const containers = podTemplate.spec.containers;
    if (containers && containers.length > 0 && containers[0]) {
      containers[0].image = image;
    }
    return this;
  }

  /** Set resource limits */
  resources(limits: { cpu: string; memory: string }): this {
    const podTemplate = this.ensurePodTemplate();
    const containers = podTemplate.spec.containers;
    if (containers && containers.length > 0 && containers[0]) {
      containers[0].resources = { ...containers[0].resources, limits };
    }
    return this;
  }

  /** Set network policy using K8s-native NetworkPolicySpec */
  networkPolicy(policy: NetworkPolicySpec): this {
    this.resource.spec.networkPolicy = policy;
    return this;
  }

  /** Set network policy management mode */
  networkPolicyManagement(mode: NetworkPolicyManagement): this {
    this.resource.spec.networkPolicyManagement = mode;
    return this;
  }

  /**
   * Ensure the podTemplate exists and return a mutable reference to it.
   */
  private ensurePodTemplate(): PodTemplate {
    if (!this.resource.spec.podTemplate) {
      this.resource.spec.podTemplate = {
        spec: { containers: [{ name: 'sandbox' }] } as V1PodSpec,
        metadata: {},
      };
    }
    return this.resource.spec.podTemplate;
  }

  /** Build the SandboxTemplate resource */
  build(): SandboxTemplate {
    return this.resource as SandboxTemplate;
  }
}
