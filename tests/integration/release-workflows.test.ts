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

  // F06-NEW-12: Critical Dependabot advisory GHSA-69fq-xp46-6x23 (Trivy supply chain compromise).
  // The trivy-action repo had 76 of 77 version tags force-pushed to malicious commits during
  // the March 19-22, 2026 incident. Only v0.35.0 onward (protected by GitHub immutable releases)
  // is safe; tags 0.0.1 - 0.34.2 are forever compromised. We pin to a SHA for defense-in-depth
  // because the safe tags themselves remain mutable in principle. Failing on `main` (which uses
  // `@0.30.0` tag — vulnerable) and passing here proves the regression test bar.
  it('pins trivy-action to a SHA for v0.35.0+ (GHSA-69fq-xp46-6x23)', () => {
    const yaml = readFileSync(resolve(WORKFLOWS, 'release.yml'), 'utf8');
    // Reject any vulnerable tag form (anything ≤ 0.34.x without v-prefix; bare `@0.x.y` form).
    // The safe forms are: `@<40-char SHA>` or `@v0.35.0+` (v-prefix) or `@v0.34.x` (re-pinned).
    expect(yaml).not.toMatch(/aquasecurity\/trivy-action@0\.(?:[12]\d|3[0-4])\.\d+/);
    // Require either a 40-char SHA pin OR an explicit v0.35.0+ tag.
    const trivyPin = yaml.match(/aquasecurity\/trivy-action@([\w.-]+)/);
    expect(trivyPin).toBeTruthy();
    if (!trivyPin) return;
    const ref = trivyPin[1];
    // Either a full SHA (40 hex chars) or a v0.35+ tag.
    const sha40 = /^[a-f0-9]{40}$/.test(ref);
    const safeTag = /^v0\.(3[5-9]|[4-9]\d)\.\d+$/.test(ref) || /^v[1-9]\d*\.\d+\.\d+$/.test(ref);
    expect(sha40 || safeTag).toBe(true);
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
