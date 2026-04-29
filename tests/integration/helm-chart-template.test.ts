/**
 * F11-02 / F11-05 / F11-06 — Helm chart template shape assertions.
 *
 * Each test renders the chart with a specific set of values and then walks
 * the output YAML to check that the relevant manifest(s) exist and carry the
 * right fields. The tests are skipped if `helm` is not on the PATH so they
 * don't wedge CI environments that lack the binary — the suite is still
 * meaningful locally and in release preparation.
 */

import { spawnSync } from 'node:child_process';
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
  // Use spawnSync with positional argv (no shell interpolation) so values
  // containing characters like `*` (cron schedules) survive verbatim. This
  // also avoids the F06-NEW-01 / W1-D shell-injection class of bug in test
  // helpers — the same defence we apply in production.
  const args = ['template', 'test-release', CHART_PATH, ...values];
  const result = spawnSync('helm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `helm template failed (status=${result.status}): ${result.stderr ?? ''}\n--- stdout ---\n${result.stdout ?? ''}`
    );
  }
  const docs = parseAllDocuments(result.stdout)
    .map((d) => d.toJS() as Record<string, unknown> | null)
    .filter((d): d is Record<string, unknown> => d != null);
  return docs;
}

const describeIfHelm = hasHelm() ? describe : describe.skip;

describeIfHelm('Helm chart template shape', () => {
  it('F11-06: default render (replicaCount=1) produces no PVC and SKIPS the PDB to avoid blocking node drains', () => {
    const docs = renderChart();
    const pvcs = docs.filter(
      (d) =>
        d.kind === 'PersistentVolumeClaim' &&
        (d.metadata as { name?: string })?.name?.includes('agentpane-data')
    );
    expect(pvcs).toHaveLength(0);

    // A PDB of `maxUnavailable: 0` with a single replica makes the pod
    // unkillable during voluntary disruption — the template gates rendering on
    // an effective replica count >= 2, so the default (1) should produce none.
    const pdbs = docs.filter(
      (d) =>
        d.kind === 'PodDisruptionBudget' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane'
    );
    expect(pdbs).toHaveLength(0);
  });

  it('F11-06: replicaCount >= 2 renders the PDB with the configured maxUnavailable', () => {
    const docs = renderChart(['--set', 'replicaCount=2']);
    const pdbs = docs.filter(
      (d) =>
        d.kind === 'PodDisruptionBudget' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane'
    );
    expect(pdbs).toHaveLength(1);
    const spec = pdbs[0]?.spec as { maxUnavailable?: number };
    expect(spec?.maxUnavailable).toBe(0);
  });

  it('F11-06: autoscaling.minReplicas >= 2 renders the PDB even at replicaCount=1', () => {
    const docs = renderChart([
      '--set',
      'replicaCount=1',
      '--set',
      'autoscaling.enabled=true',
      '--set',
      'autoscaling.minReplicas=2',
    ]);
    const pdbs = docs.filter(
      (d) =>
        d.kind === 'PodDisruptionBudget' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane'
    );
    expect(pdbs).toHaveLength(1);
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

  // ---------------------------------------------------------------------------
  // F11-20: chart-side `sandbox.image` was decorative — runtime reads the
  // sandbox image from the DB `sandbox.defaults` setting, never from the chart.
  // The fix deletes the value so operators can no longer be misled into
  // thinking they can set the sandbox image via Helm. The runtime default
  // (digest-pinned) lives in `src/lib/sandbox/types.ts` and is overridable
  // via `PUT /api/settings`.
  // ---------------------------------------------------------------------------
  it('F11-20: chart values no longer expose sandbox.image (DB is the source of truth)', () => {
    // Render with the new keys we DO ship for the sandbox block — provider
    // type, namespace, etc. — but assert that no manifest references the
    // removed `sandbox.image` shape. We also assert that overriding
    // `sandbox.image.repository` is silently ignored (no template consumes it).
    const docsDefault = renderChart();
    const docsOverride = renderChart([
      '--set',
      'sandbox.image.repository=evil-attacker/sandbox',
      '--set',
      'sandbox.image.tag=latest',
    ]);

    // The two renders must be identical wrt manifests — confirming the
    // sandbox.image override changes nothing.
    const grepImage = (docs: Array<Record<string, unknown>>) =>
      JSON.stringify(docs).match(/evil-attacker/g) ?? [];
    expect(grepImage(docsDefault)).toHaveLength(0);
    expect(grepImage(docsOverride)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // F11-21: backup CronJob renders only when `backup.enabled=true`, otherwise
  // a fresh `helm install` produces zero backups and the operator has no
  // pre-migration snapshot to roll back to. The default is OFF so we don't
  // surprise-provision a PVC on every install — operators opt in.
  // ---------------------------------------------------------------------------
  it('F11-21: default render produces no backup CronJob and no backup PVC', () => {
    const docs = renderChart();
    const cron = docs.find(
      (d) =>
        d.kind === 'CronJob' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane-backup'
    );
    expect(cron).toBeUndefined();

    const backupPvc = docs.find(
      (d) =>
        d.kind === 'PersistentVolumeClaim' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane-backup'
    );
    expect(backupPvc).toBeUndefined();
  });

  it('F11-21: backup.enabled=true renders a CronJob and the matching PVC', () => {
    const docs = renderChart(['--set', 'backup.enabled=true']);
    const cron = docs.find(
      (d) =>
        d.kind === 'CronJob' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane-backup'
    );
    expect(cron).toBeDefined();

    const cronSpec = cron?.spec as {
      schedule: string;
      concurrencyPolicy: string;
      jobTemplate: {
        spec: {
          template: {
            spec: {
              restartPolicy: string;
              containers: Array<{ args: string[]; command: string[] }>;
            };
          };
        };
      };
    };
    expect(cronSpec.schedule).toBe('0 3 * * *');
    expect(cronSpec.concurrencyPolicy).toBe('Forbid');

    const podSpec = cronSpec.jobTemplate.spec.template.spec;
    expect(podSpec.restartPolicy).toBe('OnFailure');

    const container = podSpec.containers[0];
    expect(container?.command).toEqual(['/bin/sh', '-c']);
    // Postgres mode (default) should invoke the PG backup script.
    expect(container?.args.join('\n')).toContain('/app/scripts/backup-db-pg.sh /backups');

    const backupPvc = docs.find(
      (d) =>
        d.kind === 'PersistentVolumeClaim' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane-backup'
    );
    expect(backupPvc).toBeDefined();
    const pvcSpec = backupPvc?.spec as {
      accessModes: string[];
      resources: { requests: { storage: string } };
    };
    expect(pvcSpec.accessModes).toContain('ReadWriteOnce');
    expect(pvcSpec.resources.requests.storage).toBe('5Gi');
  });

  it('F11-21: SQLite mode invokes scripts/backup-db.sh, not the Postgres script', () => {
    const docs = renderChart([
      '--set',
      'backup.enabled=true',
      '--set',
      'database.mode=sqlite',
      '--set',
      'database.internal.enabled=false',
      '--set',
      'persistence.enabled=true',
    ]);
    const cron = docs.find(
      (d) =>
        d.kind === 'CronJob' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane-backup'
    );
    const args =
      (
        cron?.spec as {
          jobTemplate: {
            spec: {
              template: { spec: { containers: Array<{ args: string[] }> } };
            };
          };
        }
      ).jobTemplate.spec.template.spec.containers[0]?.args.join('\n') ?? '';
    expect(args).toContain('/app/scripts/backup-db.sh /backups');
    expect(args).not.toContain('/app/scripts/backup-db-pg.sh');
  });

  it('F11-21: backup.pvc.create=false suppresses the chart-managed PVC (operator manages volume)', () => {
    const docs = renderChart(['--set', 'backup.enabled=true', '--set', 'backup.pvc.create=false']);
    const cron = docs.find(
      (d) =>
        d.kind === 'CronJob' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane-backup'
    );
    expect(cron).toBeDefined();

    const backupPvc = docs.find(
      (d) =>
        d.kind === 'PersistentVolumeClaim' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane-backup'
    );
    expect(backupPvc).toBeUndefined();
  });

  it('F11-21: backup.schedule and retentionDays propagate to the CronJob', () => {
    // `renderChart` now uses argv (no shell interpolation), so `*` in a cron
    // schedule survives verbatim.
    const docs = renderChart([
      '--set-string',
      'backup.schedule=*/15 * * * *',
      '--set',
      'backup.enabled=true',
      '--set',
      'backup.retentionDays=14',
    ]);
    const cron = docs.find(
      (d) =>
        d.kind === 'CronJob' &&
        (d.metadata as { name?: string })?.name === 'test-release-agentpane-backup'
    );
    const cronSpec = cron?.spec as {
      schedule: string;
      jobTemplate: {
        spec: {
          template: {
            spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> };
          };
        };
      };
    };
    expect(cronSpec.schedule).toBe('*/15 * * * *');
    const env = cronSpec.jobTemplate.spec.template.spec.containers[0]?.env ?? [];
    const max = env.find((e) => e.name === 'MAX_BACKUPS');
    expect(max?.value).toBe('14');
  });
});
