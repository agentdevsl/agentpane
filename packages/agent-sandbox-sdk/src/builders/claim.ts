import { CRD_EXTENSIONS_API, CRD_KINDS } from '../constants.js';
import type { SandboxClaim, SandboxClaimSpec } from '../types/claim.js';
import type { Lifecycle, ShutdownPolicy } from '../types/common.js';

export class SandboxClaimBuilder {
  private resource: {
    apiVersion: string;
    kind: string;
    metadata: {
      name: string;
      namespace?: string;
      labels?: Record<string, string>;
    };
    spec: Partial<SandboxClaimSpec>;
  };

  constructor(name: string) {
    this.resource = {
      apiVersion: CRD_EXTENSIONS_API.apiVersion,
      kind: CRD_KINDS.sandboxClaim,
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

  /** Reference the sandbox template (name only, no namespace) */
  templateRef(name: string): this {
    this.resource.spec.sandboxTemplateRef = { name };
    return this;
  }

  /** Set lifecycle options (shutdown time and/or policy) */
  lifecycle(opts: { shutdownTime?: string; shutdownPolicy?: ShutdownPolicy }): this {
    const lc: Lifecycle = {};
    if (opts.shutdownTime !== undefined) {
      lc.shutdownTime = opts.shutdownTime;
    }
    if (opts.shutdownPolicy !== undefined) {
      lc.shutdownPolicy = opts.shutdownPolicy;
    }
    this.resource.spec.lifecycle = lc;
    return this;
  }

  /** Build the SandboxClaim resource */
  build(): SandboxClaim {
    return this.resource as SandboxClaim;
  }
}
