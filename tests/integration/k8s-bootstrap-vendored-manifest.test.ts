/**
 * arch29-W1-C / F04-11 — vendored agent-sandbox manifest regression tests.
 *
 * Before the fix, `attemptCrdAutoInstall` shelled out to:
 *   kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml
 *
 * That URL is a moving pointer; a compromise of the upstream repository or
 * release process lands a malicious controller in every cluster running
 * auto-install. After the fix, the bootstrap applies a vendored copy of the
 * upstream manifest checked into `k8s/vendored/`, and verifies the file's
 * SHA-256 against a constant in `src/server/bootstrap/sandbox/k8s-init.ts`
 * before each apply.
 *
 * These tests verify:
 *   1. The vendored manifest file exists at the path the bootstrap reads
 *      from.
 *   2. The file's SHA-256 matches the expected constant (i.e. the vendored
 *      copy has not been tampered with).
 *   3. The file is parseable YAML (sanity check — a corrupt manifest would
 *      not be applicable).
 *   4. The bootstrap module exports the constants used to apply the
 *      manifest, so consumers (route handlers etc.) reuse the same SHA.
 *
 * On `main` (before the fix) `VENDORED_AGENT_SANDBOX_MANIFEST` does not
 * exist as an export, the file is not vendored, and the bootstrap still
 * uses the live URL — all four assertions fail.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('arch29-W1-C / F04-11 — vendored agent-sandbox manifest', () => {
  it('exports VENDORED_AGENT_SANDBOX_MANIFEST + VENDORED_AGENT_SANDBOX_SHA256 from k8s-init', async () => {
    const k8sInit = await import('../../src/server/bootstrap/sandbox/k8s-init.js');
    expect(typeof k8sInit.VENDORED_AGENT_SANDBOX_MANIFEST).toBe('string');
    expect(k8sInit.VENDORED_AGENT_SANDBOX_MANIFEST).toMatch(/^k8s[\\/]vendored[\\/]/);
    expect(typeof k8sInit.VENDORED_AGENT_SANDBOX_SHA256).toBe('string');
    expect(k8sInit.VENDORED_AGENT_SANDBOX_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('vendored manifest file exists at the documented path', async () => {
    const { VENDORED_AGENT_SANDBOX_MANIFEST } = await import(
      '../../src/server/bootstrap/sandbox/k8s-init.js'
    );
    const fullPath = path.join(process.cwd(), VENDORED_AGENT_SANDBOX_MANIFEST);
    expect(existsSync(fullPath)).toBe(true);
    // Sanity: file must be non-empty (a 0-byte vendored file would still
    // satisfy SHA verification of an all-zero digest, which is meaningless).
    const stat = statSync(fullPath);
    expect(stat.size).toBeGreaterThan(1024);
  });

  it('vendored manifest SHA-256 matches the expected constant (no tampering)', async () => {
    const { VENDORED_AGENT_SANDBOX_MANIFEST, VENDORED_AGENT_SANDBOX_SHA256 } = await import(
      '../../src/server/bootstrap/sandbox/k8s-init.js'
    );
    const fullPath = path.join(process.cwd(), VENDORED_AGENT_SANDBOX_MANIFEST);
    const bytes = readFileSync(fullPath);
    const actualSha = createHash('sha256').update(bytes).digest('hex');
    expect(actualSha).toBe(VENDORED_AGENT_SANDBOX_SHA256);
  });

  it('vendored manifest is parseable as a YAML stream (multi-document)', async () => {
    const { VENDORED_AGENT_SANDBOX_MANIFEST } = await import(
      '../../src/server/bootstrap/sandbox/k8s-init.js'
    );
    const fullPath = path.join(process.cwd(), VENDORED_AGENT_SANDBOX_MANIFEST);
    const text = readFileSync(fullPath, 'utf-8');
    const yaml = await import('yaml');
    // The upstream `manifest.yaml` is a multi-document YAML stream
    // (Namespace, ServiceAccount, RBAC, Deployment, etc.). `parseAllDocuments`
    // returns one Document per `---` separator. We expect at least 5
    // documents in a real install manifest.
    const docs = yaml.parseAllDocuments(text);
    expect(docs.length).toBeGreaterThanOrEqual(5);
    // Every document must parse without errors.
    for (const doc of docs) {
      expect(doc.errors).toEqual([]);
    }
  });

  it('vendored manifest contains the controller Deployment (not an empty file)', async () => {
    const { VENDORED_AGENT_SANDBOX_MANIFEST } = await import(
      '../../src/server/bootstrap/sandbox/k8s-init.js'
    );
    const fullPath = path.join(process.cwd(), VENDORED_AGENT_SANDBOX_MANIFEST);
    const text = readFileSync(fullPath, 'utf-8');
    // The upstream install manifest defines a Deployment for the sandbox
    // controller. A blank or stripped file would lack this token.
    expect(text).toContain('kind: Deployment');
    expect(text).toContain('agent-sandbox-controller');
  });

  it('k8s-init no longer applies the live releases/latest URL via kubectl (regression fixture)', async () => {
    // Static read of the source file: ensure the previous live URL is no
    // longer wired through to `kubectl apply -f`. The docstring at the top
    // of the module references the removed URL by design (so the rotation
    // procedure stays discoverable), so we look specifically for the
    // `kubectl apply -f "https://...` invocation pattern that previously
    // executed the URL.
    const k8sInitPath = path.join(
      process.cwd(),
      'src',
      'server',
      'bootstrap',
      'sandbox',
      'k8s-init.ts'
    );
    const source = readFileSync(k8sInitPath, 'utf-8');
    expect(source).not.toMatch(/kubectl apply -f ["']https?:\/\//);
    // Positive assertion: the vendored apply path is wired in.
    expect(source).toContain('VENDORED_AGENT_SANDBOX_MANIFEST');
    expect(source).toContain('VENDORED_AGENT_SANDBOX_SHA256');
  });
});
