import { describe, expect, it } from 'vitest';
import { SandboxClaimBuilder } from '../src/builders/claim.js';
import { SandboxBuilder } from '../src/builders/sandbox.js';
import { SandboxTemplateBuilder } from '../src/builders/template.js';
import { SandboxWarmPoolBuilder } from '../src/builders/warm-pool.js';
import { CRD_ANNOTATIONS, CRD_API, CRD_EXTENSIONS_API, CRD_KINDS } from '../src/constants.js';

describe('SandboxBuilder', () => {
  it('builds a minimal sandbox with correct apiVersion and kind', () => {
    const sandbox = new SandboxBuilder('my-sandbox').build();

    expect(sandbox.apiVersion).toBe(CRD_API.apiVersion);
    expect(sandbox.kind).toBe(CRD_KINDS.sandbox);
    expect(sandbox.metadata.name).toBe('my-sandbox');
  });

  it('uses core API group (not extensions) for Sandbox', () => {
    const sandbox = new SandboxBuilder('test').build();

    // Sandbox is in the core group, not extensions
    expect(sandbox.apiVersion).toBe('agents.x-k8s.io/v1alpha1');
    expect(sandbox.apiVersion).not.toContain('extensions');
  });

  it('sets namespace', () => {
    const sandbox = new SandboxBuilder('test').namespace('default').build();

    expect(sandbox.metadata.namespace).toBe('default');
  });

  it('builds a sandbox with inline image', () => {
    const sandbox = new SandboxBuilder('test').image('ubuntu:24.04').build();

    const container = sandbox.spec.podTemplate?.spec?.containers?.[0];
    expect(container?.name).toBe('sandbox');
    expect(container?.image).toBe('ubuntu:24.04');
  });

  it('builds a sandbox with image and resources', () => {
    const sandbox = new SandboxBuilder('test')
      .image('ubuntu:24.04')
      .resources({ cpu: '500m', memory: '512Mi' })
      .build();

    const container = sandbox.spec.podTemplate?.spec?.containers?.[0];
    expect(container?.image).toBe('ubuntu:24.04');
    expect(container?.resources?.limits).toEqual({ cpu: '500m', memory: '512Mi' });
  });

  it('resources creates podTemplate if not present', () => {
    const sandbox = new SandboxBuilder('test').resources({ cpu: '1', memory: '1Gi' }).build();

    expect(sandbox.spec.podTemplate).toBeDefined();
    const container = sandbox.spec.podTemplate?.spec?.containers?.[0];
    expect(container?.resources?.limits).toEqual({ cpu: '1', memory: '1Gi' });
  });

  it('sets labels', () => {
    const sandbox = new SandboxBuilder('test').labels({ env: 'test', tier: 'compute' }).build();

    expect(sandbox.metadata.labels).toEqual({ env: 'test', tier: 'compute' });
  });

  it('merges labels on multiple calls', () => {
    const sandbox = new SandboxBuilder('test')
      .labels({ env: 'test' })
      .labels({ tier: 'compute' })
      .build();

    expect(sandbox.metadata.labels).toEqual({ env: 'test', tier: 'compute' });
  });

  it('sets annotations', () => {
    const sandbox = new SandboxBuilder('test').annotations({ custom: 'value' }).build();

    expect(sandbox.metadata.annotations).toEqual({ custom: 'value' });
  });

  it('merges annotations on multiple calls', () => {
    const sandbox = new SandboxBuilder('test')
      .annotations({ first: '1' })
      .annotations({ second: '2' })
      .build();

    expect(sandbox.metadata.annotations).toEqual({ first: '1', second: '2' });
  });

  it('sets agentPaneContext annotations', () => {
    const sandbox = new SandboxBuilder('test')
      .agentPaneContext({ projectId: 'proj-1', taskId: 'task-1', sandboxId: 'sb-1' })
      .build();

    expect(sandbox.metadata.annotations).toEqual({
      [CRD_ANNOTATIONS.projectId]: 'proj-1',
      [CRD_ANNOTATIONS.taskId]: 'task-1',
      [CRD_ANNOTATIONS.sandboxId]: 'sb-1',
    });
  });

  it('agentPaneContext omits optional fields when not provided', () => {
    const sandbox = new SandboxBuilder('test').agentPaneContext({ projectId: 'proj-1' }).build();

    expect(sandbox.metadata.annotations).toEqual({
      [CRD_ANNOTATIONS.projectId]: 'proj-1',
    });
    expect(sandbox.metadata.annotations).not.toHaveProperty(CRD_ANNOTATIONS.taskId);
    expect(sandbox.metadata.annotations).not.toHaveProperty(CRD_ANNOTATIONS.sandboxId);
  });

  it('agentPaneContext merges with existing annotations', () => {
    const sandbox = new SandboxBuilder('test')
      .annotations({ custom: 'value' })
      .agentPaneContext({ projectId: 'proj-1' })
      .build();

    expect(sandbox.metadata.annotations).toEqual({
      custom: 'value',
      [CRD_ANNOTATIONS.projectId]: 'proj-1',
    });
  });

  it('sets replicas', () => {
    const sandbox = new SandboxBuilder('test').replicas(0).build();

    expect(sandbox.spec.replicas).toBe(0);
  });

  it('sets shutdownTime', () => {
    const sandbox = new SandboxBuilder('test').shutdownTime('2026-04-01T00:00:00Z').build();

    expect(sandbox.spec.shutdownTime).toBe('2026-04-01T00:00:00Z');
  });

  it('sets shutdownPolicy', () => {
    const sandbox = new SandboxBuilder('test').shutdownPolicy('Retain').build();

    expect(sandbox.spec.shutdownPolicy).toBe('Retain');
  });

  it('sets runtimeClass on podTemplate.spec', () => {
    const sandbox = new SandboxBuilder('test').runtimeClass('gvisor').build();

    expect(sandbox.spec.podTemplate?.spec?.runtimeClassName).toBe('gvisor');
  });

  it('adds volume claim templates', () => {
    const sandbox = new SandboxBuilder('test')
      .addVolumeClaimTemplate({
        metadata: { name: 'data' },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '1Gi' } },
        },
      })
      .addVolumeClaimTemplate({
        metadata: { name: 'logs' },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '500Mi' } },
        },
      })
      .build();

    expect(sandbox.spec.volumeClaimTemplates).toHaveLength(2);
    expect(sandbox.spec.volumeClaimTemplates![0].metadata.name).toBe('data');
    expect(sandbox.spec.volumeClaimTemplates![1].metadata.name).toBe('logs');
  });

  it('supports fluent API chaining', () => {
    const sandbox = new SandboxBuilder('full-sandbox')
      .namespace('production')
      .labels({ env: 'prod' })
      .annotations({ note: 'test' })
      .replicas(1)
      .shutdownTime('2026-04-01T00:00:00Z')
      .shutdownPolicy('Delete')
      .runtimeClass('kata')
      .addVolumeClaimTemplate({
        metadata: { name: 'data' },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '10Gi' } },
        },
      })
      .agentPaneContext({ projectId: 'p1', taskId: 't1' })
      .build();

    expect(sandbox.metadata.name).toBe('full-sandbox');
    expect(sandbox.metadata.namespace).toBe('production');
    expect(sandbox.spec.replicas).toBe(1);
    expect(sandbox.spec.shutdownTime).toBe('2026-04-01T00:00:00Z');
    expect(sandbox.spec.shutdownPolicy).toBe('Delete');
    expect(sandbox.spec.podTemplate?.spec?.runtimeClassName).toBe('kata');
    expect(sandbox.spec.volumeClaimTemplates).toHaveLength(1);
  });

  it('image() updates existing podTemplate container', () => {
    const sandbox = new SandboxBuilder('test').image('old:v1').image('new:v2').build();

    expect(sandbox.spec.podTemplate?.spec?.containers?.[0]?.image).toBe('new:v2');
  });
});

describe('SandboxTemplateBuilder', () => {
  it('builds a template with correct apiVersion and kind', () => {
    const template = new SandboxTemplateBuilder('base-template').build();

    expect(template.apiVersion).toBe(CRD_EXTENSIONS_API.apiVersion);
    expect(template.kind).toBe(CRD_KINDS.sandboxTemplate);
    expect(template.metadata.name).toBe('base-template');
  });

  it('sets namespace', () => {
    const template = new SandboxTemplateBuilder('test').namespace('default').build();

    expect(template.metadata.namespace).toBe('default');
  });

  it('builds a template with image and resources', () => {
    const template = new SandboxTemplateBuilder('test')
      .image('node:22')
      .resources({ cpu: '1', memory: '1Gi' })
      .build();

    const container = template.spec.podTemplate?.spec?.containers?.[0];
    expect(container?.image).toBe('node:22');
    expect(container?.resources?.limits).toEqual({ cpu: '1', memory: '1Gi' });
  });

  it('sets labels', () => {
    const template = new SandboxTemplateBuilder('test').labels({ tier: 'base' }).build();

    expect(template.metadata.labels).toEqual({ tier: 'base' });
  });

  it('sets networkPolicy with K8s-native types', () => {
    const template = new SandboxTemplateBuilder('test').networkPolicy({ egress: [] }).build();

    expect(template.spec.networkPolicy).toEqual({ egress: [] });
  });

  it('sets networkPolicyManagement mode', () => {
    const template = new SandboxTemplateBuilder('test')
      .networkPolicyManagement('Unmanaged')
      .build();

    expect(template.spec.networkPolicyManagement).toBe('Unmanaged');
  });

  it('sets podTemplate directly', () => {
    const podTemplate = {
      spec: {
        containers: [{ name: 'sandbox', image: 'ubuntu:24.04' }],
      },
      metadata: {},
    };
    const template = new SandboxTemplateBuilder('test').podTemplate(podTemplate as any).build();

    expect(template.spec.podTemplate).toEqual(podTemplate);
  });

  it('supports fluent chaining', () => {
    const template = new SandboxTemplateBuilder('full-template')
      .namespace('templates')
      .labels({ version: 'v1' })
      .image('python:3.12')
      .resources({ cpu: '2', memory: '4Gi' })
      .networkPolicy({ ingress: [] })
      .networkPolicyManagement('Managed')
      .build();

    expect(template.metadata.name).toBe('full-template');
    expect(template.spec.networkPolicyManagement).toBe('Managed');
  });
});

describe('SandboxClaimBuilder', () => {
  it('builds a claim with correct apiVersion and kind', () => {
    const claim = new SandboxClaimBuilder('my-claim').build();

    expect(claim.apiVersion).toBe(CRD_EXTENSIONS_API.apiVersion);
    expect(claim.kind).toBe(CRD_KINDS.sandboxClaim);
    expect(claim.metadata.name).toBe('my-claim');
  });

  it('sets namespace', () => {
    const claim = new SandboxClaimBuilder('test').namespace('default').build();

    expect(claim.metadata.namespace).toBe('default');
  });

  it('sets template ref (name only)', () => {
    const claim = new SandboxClaimBuilder('test').templateRef('my-template').build();

    expect(claim.spec.sandboxTemplateRef).toEqual({
      name: 'my-template',
    });
  });

  it('sets lifecycle with shutdownTime and shutdownPolicy', () => {
    const claim = new SandboxClaimBuilder('test')
      .lifecycle({ shutdownTime: '2026-04-01T00:00:00Z', shutdownPolicy: 'Delete' })
      .build();

    expect(claim.spec.lifecycle).toEqual({
      shutdownTime: '2026-04-01T00:00:00Z',
      shutdownPolicy: 'Delete',
    });
  });

  it('sets lifecycle with only shutdownTime', () => {
    const claim = new SandboxClaimBuilder('test')
      .lifecycle({ shutdownTime: '2026-04-01T00:00:00Z' })
      .build();

    expect(claim.spec.lifecycle).toEqual({
      shutdownTime: '2026-04-01T00:00:00Z',
    });
  });

  it('sets lifecycle with only shutdownPolicy', () => {
    const claim = new SandboxClaimBuilder('test')
      .lifecycle({ shutdownPolicy: 'Retain' })
      .build();

    expect(claim.spec.lifecycle).toEqual({
      shutdownPolicy: 'Retain',
    });
    expect(claim.spec.lifecycle?.shutdownTime).toBeUndefined();
  });

  it('sets labels', () => {
    const claim = new SandboxClaimBuilder('test').labels({ app: 'test' }).build();

    expect(claim.metadata.labels).toEqual({ app: 'test' });
  });

  it('supports fluent chaining', () => {
    const claim = new SandboxClaimBuilder('my-claim')
      .namespace('default')
      .templateRef('my-template')
      .lifecycle({ shutdownPolicy: 'Retain' })
      .labels({ app: 'test' })
      .build();

    expect(claim.metadata.name).toBe('my-claim');
    expect(claim.metadata.namespace).toBe('default');
    expect(claim.spec.sandboxTemplateRef?.name).toBe('my-template');
    expect(claim.spec.lifecycle?.shutdownPolicy).toBe('Retain');
  });
});

describe('SandboxWarmPoolBuilder', () => {
  it('builds a warm pool with correct apiVersion and kind', () => {
    const pool = new SandboxWarmPoolBuilder('my-pool').build();

    expect(pool.apiVersion).toBe(CRD_EXTENSIONS_API.apiVersion);
    expect(pool.kind).toBe(CRD_KINDS.sandboxWarmPool);
    expect(pool.metadata.name).toBe('my-pool');
  });

  it('sets namespace', () => {
    const pool = new SandboxWarmPoolBuilder('test').namespace('default').build();

    expect(pool.metadata.namespace).toBe('default');
  });

  it('sets replicas', () => {
    const pool = new SandboxWarmPoolBuilder('test').replicas(3).build();

    expect(pool.spec.replicas).toBe(3);
  });

  it('sets sandboxTemplateRef (name only)', () => {
    const pool = new SandboxWarmPoolBuilder('test').sandboxTemplateRef('base-template').build();

    expect(pool.spec.sandboxTemplateRef).toEqual({
      name: 'base-template',
    });
  });

  it('sets labels', () => {
    const pool = new SandboxWarmPoolBuilder('test').labels({ tier: 'warm' }).build();

    expect(pool.metadata.labels).toEqual({ tier: 'warm' });
  });

  it('supports fluent chaining', () => {
    const pool = new SandboxWarmPoolBuilder('my-pool')
      .namespace('default')
      .replicas(3)
      .sandboxTemplateRef('base-template')
      .labels({ tier: 'warm' })
      .build();

    expect(pool.metadata.name).toBe('my-pool');
    expect(pool.metadata.namespace).toBe('default');
    expect(pool.spec.replicas).toBe(3);
    expect(pool.spec.sandboxTemplateRef?.name).toBe('base-template');
  });
});
