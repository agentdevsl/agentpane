/**
 * F11-01 / F11-08 — Release and CLI monitor publish workflow sanity.
 *
 * We can't exercise GitHub Actions from a unit test, but we can guarantee:
 *   1. The workflow files are valid YAML.
 *   2. They declare the triggers we expect (tags, workflow_dispatch).
 *   3. The secrets and commands the docs promise exist in the file.
 *
 * This prevents the most common regression — a typo in a trigger or env-var
 * name that breaks the workflow the moment it runs for real.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WORKFLOWS = resolve(import.meta.dirname, '../../.github/workflows');

function loadWorkflow(name: string): Record<string, unknown> {
  const raw = readFileSync(resolve(WORKFLOWS, name), 'utf8');
  const parsed = parse(raw);
  if (parsed == null || typeof parsed !== 'object') {
    throw new Error(`Failed to parse workflow: ${name}`);
  }
  return parsed as Record<string, unknown>;
}

describe('F11-01: release.yml workflow', () => {
  const wf = loadWorkflow('release.yml');

  it('is valid YAML with a name', () => {
    expect(wf.name).toBe('Release');
  });

  it('triggers on v* tags and manual dispatch', () => {
    // YAML parses the bareword `on` as boolean true, so check both keys.
    const on = (wf.on ?? wf.True ?? wf[true as unknown as string]) as Record<string, unknown>;
    expect(on).toBeDefined();
    const pushTags = ((on.push ?? {}) as { tags?: string[] }).tags ?? [];
    expect(pushTags).toContain('v*');
    expect(on).toHaveProperty('workflow_dispatch');
  });

  it('declares required permissions for GHCR push and release creation', () => {
    const permissions = wf.permissions as Record<string, string>;
    expect(permissions.contents).toBe('write');
    expect(permissions.packages).toBe('write');
  });

  it('builds multi-arch and scans with Trivy', () => {
    const yaml = readFileSync(resolve(WORKFLOWS, 'release.yml'), 'utf8');
    expect(yaml).toContain('linux/amd64,linux/arm64');
    expect(yaml).toContain('aquasecurity/trivy-action');
    expect(yaml).toContain("exit-code: '1'");
  });

  it('packages the Helm chart via helm package', () => {
    const yaml = readFileSync(resolve(WORKFLOWS, 'release.yml'), 'utf8');
    expect(yaml).toContain('helm package charts/agentpane');
  });
});

describe('F11-08: publish-cli-monitor.yml workflow', () => {
  const wf = loadWorkflow('publish-cli-monitor.yml');

  it('is valid YAML with a name', () => {
    expect(wf.name).toBe('Publish CLI Monitor');
  });

  it('references the NPM_PUBLISH_TOKEN repo secret (not a spec-dir file)', () => {
    const yaml = readFileSync(resolve(WORKFLOWS, 'publish-cli-monitor.yml'), 'utf8');
    expect(yaml).toContain('secrets.NPM_PUBLISH_TOKEN');
    // The token must come from a repo secret, never from a committed .env.
    expect(yaml).not.toMatch(/--\/\/registry\.npmjs\.org\/:_authToken=/);
    expect(yaml).not.toMatch(/cat\s+.*\.env/);
  });

  it('publishes with provenance', () => {
    const yaml = readFileSync(resolve(WORKFLOWS, 'publish-cli-monitor.yml'), 'utf8');
    expect(yaml).toContain('npm publish --access public --provenance');
  });

  it('uses id-token write for provenance attestation', () => {
    const permissions = wf.permissions as Record<string, string>;
    expect(permissions['id-token']).toBe('write');
  });
});
