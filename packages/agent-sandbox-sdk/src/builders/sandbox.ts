import type { V1Container, V1PodTemplateSpec } from '@kubernetes/client-node';
import { CRD_ANNOTATIONS, CRD_API, CRD_KINDS } from '../constants.js';
import type {
  Sandbox,
  SandboxNetworkPolicy,
  SandboxSpec,
  SandboxVolumeClaim,
} from '../types/sandbox.js';

export class SandboxBuilder {
  private resource: {
    apiVersion: string;
    kind: string;
    metadata: {
      name: string;
      namespace?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    };
    spec: Partial<SandboxSpec>;
  };

  constructor(name: string) {
    this.resource = {
      apiVersion: CRD_API.apiVersion,
      kind: CRD_KINDS.sandbox,
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

  annotations(annotations: Record<string, string>): this {
    this.resource.metadata.annotations = {
      ...this.resource.metadata.annotations,
      ...annotations,
    };
    return this;
  }

  /** Use a SandboxTemplate by name */
  fromTemplate(name: string, namespace?: string): this {
    this.resource.spec.sandboxTemplateRef = { name, namespace };
    return this;
  }

  /** Inline pod template */
  withPodTemplate(template: V1PodTemplateSpec): this {
    this.resource.spec.podTemplateSpec = template;
    return this;
  }

  /** Set container image */
  image(image: string): this {
    this.ensureSandboxContainer().image = image;
    return this;
  }

  /** Set resource limits */
  resources(limits: { cpu: string; memory: string }): this {
    const container = this.ensureSandboxContainer();
    container.resources = { ...container.resources, limits };
    return this;
  }

  /** Set runtime class (e.g., "gvisor") */
  runtimeClass(name: string): this {
    this.resource.spec.runtimeClassName = name;
    return this;
  }

  /** Add volume claim */
  addVolumeClaim(claim: SandboxVolumeClaim): this {
    this.resource.spec.volumeClaims ??= [];
    this.resource.spec.volumeClaims.push(claim);
    return this;
  }

  /** Set network policy */
  networkPolicy(policy: SandboxNetworkPolicy): this {
    this.resource.spec.networkPolicy = policy;
    return this;
  }

  /** Set replicas (0 = paused, 1 = running) */
  replicas(count: number): this {
    this.resource.spec.replicas = count;
    return this;
  }

  /** Set TTL after completion */
  ttl(seconds: number): this {
    this.resource.spec.ttlSecondsAfterFinished = seconds;
    return this;
  }

  /** Add AgentPane project/task annotations */
  agentPaneContext(ctx: { projectId: string; taskId?: string; sandboxId?: string }): this {
    const annotations: Record<string, string> = {
      [CRD_ANNOTATIONS.projectId]: ctx.projectId,
    };
    if (ctx.taskId) {
      annotations[CRD_ANNOTATIONS.taskId] = ctx.taskId;
    }
    if (ctx.sandboxId) {
      annotations[CRD_ANNOTATIONS.sandboxId] = ctx.sandboxId;
    }
    return this.annotations(annotations);
  }

  /**
   * Ensure the podTemplateSpec has a 'sandbox' container and return a mutable
   * reference to it. Creates the podTemplateSpec and container array if needed.
   */
  private ensureSandboxContainer(): V1Container {
    if (!this.resource.spec.podTemplateSpec) {
      this.resource.spec.podTemplateSpec = {
        spec: { containers: [{ name: 'sandbox' }] },
      };
    }

    const spec = this.resource.spec.podTemplateSpec.spec;
    if (!spec) {
      throw new Error('podTemplateSpec.spec is unexpectedly undefined');
    }
    if (!spec.containers || spec.containers.length === 0) {
      spec.containers = [{ name: 'sandbox' }];
    }

    const container = spec.containers[0];
    if (!container) {
      throw new Error('sandbox container is unexpectedly undefined');
    }
    return container;
  }

  /** Build the Sandbox resource */
  build(): Sandbox {
    return this.resource as Sandbox;
  }
}
