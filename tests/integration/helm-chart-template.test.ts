/**
 * F11-02 / F11-05 / F11-06 — Helm chart template shape assertions.
 *
 * Each test renders the chart with a specific set of values and then walks
 * the output YAML to check that the relevant manifest(s) exist and carry the
 * right fields. The tests are skipped if `helm` is not on the PATH so they
 * don't wedge CI environments that lack the binary — the suite is still
 * meaningful locally and in release preparation.
 */

import { execSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

const CHART_PATH = resolve(import.meta.dirname, '../../charts/agentpane');

function hasHelm(): boolean {
  try {
    const r = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function renderChart(values: string[] = []): Array<Record<string, unknown>> {
  const args = ['template', 'test-release', CHART_PATH, ...values];
  const output = execSync(`helm ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  const docs = parseAllDocuments(output)
    .map((d) => d.toJS() as Record<string, unknown> | null)
    .filter((d): d is Record<string, unknown> => d != null);
  return docs;
}

const describeIfHelm = hasHelm() ? describe : describe.skip;

describeIfHelm('Helm chart template shape', () => {
  it('F11-06: default render produces no PVC, no migration Job hook references to PVC, and a PDB', () => {
    const docs = renderChart();
    const pvcs = docs.filter(
      (d) =>
        d.kind === 'PersistentVolumeClaim' &&
        (d.metadata as { name?: string })?.name?.includes('agentpane-data')
    );
    expect(pvcs).toHaveLength(0);

    const pdbs = docs.filter(
      (d) =>
        d.kind === 'PodDisruptionBudget' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane'
    );
    expect(pdbs).toHaveLength(1);
    const spec = pdbs[0]?.spec as { maxUnavailable?: number };
    expect(spec?.maxUnavailable).toBe(0);
  });

  it('F11-06: persistence.enabled=true produces a PVC and mounts it', () => {
    const docs = renderChart(['--set', 'persistence.enabled=true']);
    const pvc = docs.find(
      (d) =>
        d.kind === 'PersistentVolumeClaim' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane-data'
    );
    expect(pvc).toBeDefined();

    const deployment = docs.find(
      (d) =>
        d.kind === 'Deployment' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane'
    );
    expect(deployment).toBeDefined();
    const spec = deployment?.spec as {
      template: {
        spec: {
          volumes: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }>;
        };
      };
    };
    const dataVol = spec.template.spec.volumes.find((v) => v.name === 'data');
    expect(dataVol?.persistentVolumeClaim?.claimName).toBe('test-release-agentpane-data');
  });

  it('F11-05: migrationJob.enabled=true (default) produces a pre-upgrade Job using migrate:run-only', () => {
    const docs = renderChart();
    const job = docs.find(
      (d) =>
        d.kind === 'Job' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane-migrate'
    );
    expect(job).toBeDefined();

    const annotations =
      (job?.metadata as { annotations?: Record<string, string> })?.annotations ?? {};
    expect(annotations['helm.sh/hook']).toContain('pre-upgrade');
    expect(annotations['helm.sh/hook']).toContain('pre-install');

    const spec = job?.spec as {
      template: { spec: { containers: Array<{ command: string[] }> } };
    };
    const command = spec.template.spec.containers[0]?.command ?? [];
    expect(command).toEqual(['bun', 'run', 'migrate:run-only']);
  });

  it('F11-05: migrationJob.enabled=false suppresses the Job', () => {
    const docs = renderChart(['--set', 'migrationJob.enabled=false']);
    const job = docs.find(
      (d) =>
        d.kind === 'Job' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane-migrate'
    );
    expect(job).toBeUndefined();
  });

  it('F11-02: durable-streams sidecar is exposed on the Deployment ports and Service by default', () => {
    const docs = renderChart();
    const deployment = docs.find(
      (d) =>
        d.kind === 'Deployment' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane'
    );
    const containers =
      (
        deployment?.spec as {
          template: {
            spec: {
              containers: Array<{
                ports: Array<{ name: string; containerPort: number }>;
                env: Array<{ name: string; value: string }>;
              }>;
            };
          };
        }
      )?.template.spec.containers ?? [];
    const ports = containers[0]?.ports ?? [];
    const streams = ports.find((p) => p.name === 'streams');
    expect(streams?.containerPort).toBe(3000);

    const env = containers[0]?.env ?? [];
    const streamsDataDir = env.find((e) => e.name === 'STREAMS_DATA_DIR');
    expect(streamsDataDir?.value).toBe('/app/data/streams');

    const service = docs.find(
      (d) =>
        d.kind === 'Service' && (d.metadata as { name?: string })?.name === 'test-release-agentpane'
    );
    const servicePorts =
      (service?.spec as { ports: Array<{ name: string; port: number; targetPort: string }> })
        ?.ports ?? [];
    const streamsPort = servicePorts.find((p) => p.name === 'streams');
    expect(streamsPort?.port).toBe(3000);
    expect(streamsPort?.targetPort).toBe('streams');
  });

  it('F11-03: Deployment declares terminationGracePeriodSeconds >= 30', () => {
    const docs = renderChart();
    const deployment = docs.find(
      (d) =>
        d.kind === 'Deployment' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane'
    );
    const gracePeriod = (
      deployment?.spec as { template: { spec: { terminationGracePeriodSeconds?: number } } }
    )?.template.spec.terminationGracePeriodSeconds;
    expect(gracePeriod).toBeGreaterThanOrEqual(30);
  });
});
