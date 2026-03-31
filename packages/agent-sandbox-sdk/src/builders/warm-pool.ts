import { CRD_EXTENSIONS_API, CRD_KINDS } from '../constants.js';
import type { SandboxWarmPool, SandboxWarmPoolSpec } from '../types/warm-pool.js';

export class SandboxWarmPoolBuilder {
  private resource: {
    apiVersion: string;
    kind: string;
    metadata: {
      name: string;
      namespace?: string;
      labels?: Record<string, string>;
    };
    spec: Partial<SandboxWarmPoolSpec>;
  };

  constructor(name: string) {
    this.resource = {
      apiVersion: CRD_EXTENSIONS_API.apiVersion,
      kind: CRD_KINDS.sandboxWarmPool,
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

  /** Set desired number of warm sandboxes to keep ready */
  replicas(count: number): this {
    this.resource.spec.replicas = count;
    return this;
  }

  /** Reference the sandbox template (name only, no namespace) */
  sandboxTemplateRef(name: string): this {
    this.resource.spec.sandboxTemplateRef = { name };
    return this;
  }

  /** Build the SandboxWarmPool resource */
  build(): SandboxWarmPool {
    return this.resource as SandboxWarmPool;
  }
}
