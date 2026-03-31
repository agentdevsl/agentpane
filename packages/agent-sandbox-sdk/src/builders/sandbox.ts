import type { V1Container, V1PodSpec } from '@kubernetes/client-node';
import { CRD_ANNOTATIONS, CRD_API, CRD_KINDS } from '../constants.js';
import type {
  PersistentVolumeClaimTemplate,
  PodTemplate,
  ShutdownPolicy,
} from '../types/common.js';
import type { Sandbox, SandboxSpec } from '../types/sandbox.js';

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

  /** Set runtime class (e.g., "gvisor") on podTemplate.spec */
  runtimeClass(name: string): this {
    const podTemplate = this.ensurePodTemplate();
    podTemplate.spec.runtimeClassName = name;
    return this;
  }

  /** Add a volume claim template */
  addVolumeClaimTemplate(template: PersistentVolumeClaimTemplate): this {
    this.resource.spec.volumeClaimTemplates ??= [];
    this.resource.spec.volumeClaimTemplates.push(template);
    return this;
  }

  /** Set shutdown time (ISO date-time string) */
  shutdownTime(time: string): this {
    this.resource.spec.shutdownTime = time;
    return this;
  }

  /** Set shutdown policy */
  shutdownPolicy(policy: ShutdownPolicy): this {
    this.resource.spec.shutdownPolicy = policy;
    return this;
  }

  /** Set replicas (0 = paused, 1 = running) */
  replicas(count: number): this {
    this.resource.spec.replicas = count;
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

  /**
   * Ensure the podTemplate has a 'sandbox' container and return a mutable
   * reference to it. Creates the podTemplate and container array if needed.
   */
  private ensureSandboxContainer(): V1Container {
    const podTemplate = this.ensurePodTemplate();

    if (!podTemplate.spec.containers || podTemplate.spec.containers.length === 0) {
      podTemplate.spec.containers = [{ name: 'sandbox' }];
    }

    const container = podTemplate.spec.containers[0];
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
