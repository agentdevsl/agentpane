import { describe, expect, it } from 'vitest';
import {
  sandboxClaimSchema,
  sandboxClaimSpecSchema,
  sandboxClaimStatusSchema,
} from '../src/schemas/claim.js';
import {
  podMetadataSchema,
  podTemplateSchema,
  sandboxSchema,
  sandboxSpecSchema,
  sandboxStatusSchema,
  shutdownPolicySchema,
} from '../src/schemas/sandbox.js';
import { sandboxTemplateSchema, sandboxTemplateSpecSchema } from '../src/schemas/template.js';
import { sandboxWarmPoolSchema, sandboxWarmPoolSpecSchema } from '../src/schemas/warm-pool.js';

describe('sandboxSchema', () => {
  const validSandbox = {
    apiVersion: 'agents.x-k8s.io/v1alpha1',
    kind: 'Sandbox',
    metadata: { name: 'test-sandbox' },
    spec: {
      podTemplate: {
        spec: { containers: [{ name: 'main', image: 'ubuntu:24.04' }] },
        metadata: {},
      },
    },
  };

  it('accepts a valid minimal sandbox', () => {
    const result = sandboxSchema.safeParse(validSandbox);
    expect(result.success).toBe(true);
  });

  it('accepts a sandbox with lifecycle fields', () => {
    const result = sandboxSchema.safeParse({
      ...validSandbox,
      spec: {
        ...validSandbox.spec,
        replicas: 1,
        shutdownTime: '2026-12-31T23:59:59Z',
        shutdownPolicy: 'Delete',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects sandbox with invalid kind', () => {
    const result = sandboxSchema.safeParse({
      ...validSandbox,
      kind: 'Pod',
    });
    expect(result.success).toBe(false);
  });

  it('rejects sandbox without metadata.name', () => {
    const result = sandboxSchema.safeParse({
      ...validSandbox,
      metadata: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects sandbox without apiVersion', () => {
    const { apiVersion: _, ...noApiVersion } = validSandbox;
    const result = sandboxSchema.safeParse(noApiVersion);
    expect(result.success).toBe(false);
  });

  it('accepts sandbox with status', () => {
    const result = sandboxSchema.safeParse({
      ...validSandbox,
      status: {
        replicas: 1,
        serviceFQDN: 'sandbox.default.svc.cluster.local',
        service: 'test-service',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts sandbox with labels and annotations', () => {
    const result = sandboxSchema.safeParse({
      ...validSandbox,
      metadata: {
        name: 'test',
        namespace: 'default',
        labels: { app: 'test' },
        annotations: { note: 'hello' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts sandbox without status (optional)', () => {
    const result = sandboxSchema.safeParse(validSandbox);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBeUndefined();
    }
  });
});

describe('sandboxSpecSchema', () => {
  const minimalSpec = {
    podTemplate: {
      spec: { containers: [] },
      metadata: {},
    },
  };

  it('accepts spec with podTemplate', () => {
    const result = sandboxSpecSchema.safeParse(minimalSpec);
    expect(result.success).toBe(true);
  });

  it('accepts spec with replicas 0', () => {
    const result = sandboxSpecSchema.safeParse({ ...minimalSpec, replicas: 0 });
    expect(result.success).toBe(true);
  });

  it('accepts spec with replicas 1', () => {
    const result = sandboxSpecSchema.safeParse({ ...minimalSpec, replicas: 1 });
    expect(result.success).toBe(true);
  });

  it('rejects spec with replicas > 1', () => {
    const result = sandboxSpecSchema.safeParse({ ...minimalSpec, replicas: 2 });
    expect(result.success).toBe(false);
  });

  it('rejects spec with negative replicas', () => {
    const result = sandboxSpecSchema.safeParse({ ...minimalSpec, replicas: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects spec with non-integer replicas', () => {
    const result = sandboxSpecSchema.safeParse({ ...minimalSpec, replicas: 0.5 });
    expect(result.success).toBe(false);
  });

  it('accepts spec with shutdownPolicy', () => {
    const result = sandboxSpecSchema.safeParse({ ...minimalSpec, shutdownPolicy: 'Delete' });
    expect(result.success).toBe(true);
  });

  it('accepts spec with shutdownTime', () => {
    const result = sandboxSpecSchema.safeParse({
      ...minimalSpec,
      shutdownTime: '2026-12-31T23:59:59Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts spec with volumeClaimTemplates', () => {
    const result = sandboxSpecSchema.safeParse({
      ...minimalSpec,
      volumeClaimTemplates: [
        {
          metadata: { name: 'data' },
          spec: { accessModes: ['ReadWriteOnce'] },
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('sandboxStatusSchema', () => {
  it('requires replicas field', () => {
    const result = sandboxStatusSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts status with replicas only', () => {
    const result = sandboxStatusSchema.safeParse({ replicas: 0 });
    expect(result.success).toBe(true);
  });

  it('accepts status with all fields', () => {
    const result = sandboxStatusSchema.safeParse({
      serviceFQDN: 'sandbox.default.svc.cluster.local',
      service: 'test-service',
      conditions: [],
      replicas: 1,
      selector: 'app=sandbox',
    });
    expect(result.success).toBe(true);
  });
});

describe('shutdownPolicySchema', () => {
  it('accepts Delete', () => {
    const result = shutdownPolicySchema.safeParse('Delete');
    expect(result.success).toBe(true);
  });

  it('accepts Retain', () => {
    const result = shutdownPolicySchema.safeParse('Retain');
    expect(result.success).toBe(true);
  });

  it('rejects invalid policy', () => {
    const result = shutdownPolicySchema.safeParse('Destroy');
    expect(result.success).toBe(false);
  });
});

describe('podTemplateSchema', () => {
  it('requires metadata (not optional)', () => {
    const result = podTemplateSchema.safeParse({
      spec: { containers: [] },
    });
    expect(result.success).toBe(false);
  });

  it('accepts with metadata and spec', () => {
    const result = podTemplateSchema.safeParse({
      spec: { containers: [] },
      metadata: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts metadata with labels and annotations', () => {
    const result = podMetadataSchema.safeParse({
      labels: { app: 'test' },
      annotations: { note: 'hello' },
    });
    expect(result.success).toBe(true);
  });
});

describe('sandboxTemplateSchema', () => {
  const validTemplate = {
    apiVersion: 'agents.x-k8s.io/v1alpha1',
    kind: 'SandboxTemplate',
    metadata: { name: 'base' },
    spec: {
      podTemplate: {
        spec: { containers: [{ name: 'sandbox', image: 'ubuntu:24.04' }] },
        metadata: {},
      },
    },
  };

  it('accepts a valid template', () => {
    const result = sandboxTemplateSchema.safeParse(validTemplate);
    expect(result.success).toBe(true);
  });

  it('rejects template with wrong kind', () => {
    const result = sandboxTemplateSchema.safeParse({
      ...validTemplate,
      kind: 'Sandbox',
    });
    expect(result.success).toBe(false);
  });

  it('rejects template without metadata.name', () => {
    const result = sandboxTemplateSchema.safeParse({
      ...validTemplate,
      metadata: {},
    });
    expect(result.success).toBe(false);
  });

  it('accepts template with status', () => {
    const result = sandboxTemplateSchema.safeParse({
      ...validTemplate,
      status: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts template with networkPolicy and networkPolicyManagement', () => {
    const result = sandboxTemplateSchema.safeParse({
      ...validTemplate,
      spec: {
        ...validTemplate.spec,
        networkPolicy: { egress: [], ingress: [] },
        networkPolicyManagement: 'Managed',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('sandboxTemplateSpecSchema', () => {
  const minimalSpec = {
    podTemplate: {
      spec: { containers: [] },
      metadata: {},
    },
  };

  it('accepts spec with podTemplate', () => {
    const result = sandboxTemplateSpecSchema.safeParse(minimalSpec);
    expect(result.success).toBe(true);
  });

  it('rejects spec without podTemplate', () => {
    const result = sandboxTemplateSpecSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts spec with all optional fields', () => {
    const result = sandboxTemplateSpecSchema.safeParse({
      ...minimalSpec,
      networkPolicy: { egress: [], ingress: [] },
      networkPolicyManagement: 'Unmanaged',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid networkPolicyManagement', () => {
    const result = sandboxTemplateSpecSchema.safeParse({
      ...minimalSpec,
      networkPolicyManagement: 'Invalid',
    });
    expect(result.success).toBe(false);
  });
});

describe('sandboxClaimSchema', () => {
  const validClaim = {
    apiVersion: 'agents.x-k8s.io/v1alpha1',
    kind: 'SandboxClaim',
    metadata: { name: 'my-claim' },
    spec: {
      sandboxTemplateRef: { name: 'my-template' },
    },
  };

  it('accepts a valid claim', () => {
    const result = sandboxClaimSchema.safeParse(validClaim);
    expect(result.success).toBe(true);
  });

  it('rejects claim without sandboxTemplateRef', () => {
    const result = sandboxClaimSchema.safeParse({
      ...validClaim,
      spec: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects claim with wrong kind', () => {
    const result = sandboxClaimSchema.safeParse({
      ...validClaim,
      kind: 'Sandbox',
    });
    expect(result.success).toBe(false);
  });

  it('accepts claim with lifecycle', () => {
    const result = sandboxClaimSchema.safeParse({
      ...validClaim,
      spec: {
        sandboxTemplateRef: { name: 'my-template' },
        lifecycle: {
          shutdownTime: '2026-12-31T23:59:59Z',
          shutdownPolicy: 'Retain',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts claim with status containing sandbox Name', () => {
    const result = sandboxClaimSchema.safeParse({
      ...validClaim,
      status: {
        sandbox: { Name: 'sb-123' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts claim with status conditions', () => {
    const result = sandboxClaimSchema.safeParse({
      ...validClaim,
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('sandboxClaimSpecSchema', () => {
  it('requires sandboxTemplateRef', () => {
    const result = sandboxClaimSpecSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('requires sandboxTemplateRef.name', () => {
    const result = sandboxClaimSpecSchema.safeParse({
      sandboxTemplateRef: {},
    });
    expect(result.success).toBe(false);
  });

  it('sandboxTemplateRef has no namespace field (v0.2.1)', () => {
    const result = sandboxClaimSpecSchema.safeParse({
      sandboxTemplateRef: { name: 'tpl' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // namespace should not be in the parsed result
      expect(result.data.sandboxTemplateRef).toEqual({ name: 'tpl' });
    }
  });
});

describe('sandboxClaimStatusSchema', () => {
  it('accepts empty status', () => {
    const result = sandboxClaimStatusSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts status with sandbox Name (capital N)', () => {
    const result = sandboxClaimStatusSchema.safeParse({
      sandbox: { Name: 'my-sandbox' },
    });
    expect(result.success).toBe(true);
  });
});

describe('sandboxWarmPoolSchema', () => {
  const validPool = {
    apiVersion: 'agents.x-k8s.io/v1alpha1',
    kind: 'SandboxWarmPool',
    metadata: { name: 'my-pool' },
    spec: {
      replicas: 3,
      sandboxTemplateRef: { name: 'base' },
    },
  };

  it('accepts a valid warm pool', () => {
    const result = sandboxWarmPoolSchema.safeParse(validPool);
    expect(result.success).toBe(true);
  });

  it('rejects warm pool with wrong kind', () => {
    const result = sandboxWarmPoolSchema.safeParse({
      ...validPool,
      kind: 'Sandbox',
    });
    expect(result.success).toBe(false);
  });

  it('rejects warm pool with negative replicas', () => {
    const result = sandboxWarmPoolSchema.safeParse({
      ...validPool,
      spec: { ...validPool.spec, replicas: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts warm pool with zero replicas', () => {
    const result = sandboxWarmPoolSchema.safeParse({
      ...validPool,
      spec: { ...validPool.spec, replicas: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects warm pool with non-integer replicas', () => {
    const result = sandboxWarmPoolSchema.safeParse({
      ...validPool,
      spec: { ...validPool.spec, replicas: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts warm pool with status', () => {
    const result = sandboxWarmPoolSchema.safeParse({
      ...validPool,
      status: {
        replicas: 3,
        readyReplicas: 2,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts warm pool with labels', () => {
    const result = sandboxWarmPoolSchema.safeParse({
      ...validPool,
      metadata: { ...validPool.metadata, labels: { tier: 'warm' } },
    });
    expect(result.success).toBe(true);
  });
});

describe('sandboxWarmPoolSpecSchema', () => {
  it('requires replicas', () => {
    const result = sandboxWarmPoolSpecSchema.safeParse({
      sandboxTemplateRef: { name: 'base' },
    });
    expect(result.success).toBe(false);
  });

  it('requires sandboxTemplateRef', () => {
    const result = sandboxWarmPoolSpecSchema.safeParse({
      replicas: 3,
    });
    expect(result.success).toBe(false);
  });

  it('requires sandboxTemplateRef.name', () => {
    const result = sandboxWarmPoolSpecSchema.safeParse({
      replicas: 3,
      sandboxTemplateRef: {},
    });
    expect(result.success).toBe(false);
  });
});
