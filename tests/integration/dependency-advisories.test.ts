/**
 * F06-NEW-12 — Critical Dependabot advisory regression guards.
 *
 * Each test below pins a specific GHSA identifier and asserts the resolved version
 * in our lockfiles is no longer in the vulnerable range. The tests fail on `main`
 * (which still ships the vulnerable transitive resolutions) and pass with the
 * fix that lands in PR W3-A.
 *
 * Why we test the lockfile, not just package.json:
 *   - protobufjs is a transitive dep via dockerode → @grpc/proto-loader → protobufjs.
 *     A direct `dependencies` bump would not work; only an `overrides`/`resolutions`
 *     entry forces every node_modules entry to the patched version. Reading the
 *     lockfile is the only way to verify that override actually took effect.
 *   - aquasecurity/trivy-action is referenced in a workflow file, not a lockfile.
 *     The release-workflows.test.ts file covers that.
 *   - golang.org/x/crypto is a Go module — verified separately by go.mod parsing.
 *
 * Precedent: this is the same pattern used for schema drift suites
 * (`tests/integration/*-schema-drift.test.ts`) — read the on-disk artifact and
 * assert on its content, no service wiring needed.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/**
 * Parses semver-ish strings ("7.5.4", "v0.31.0", "0.0.0-20200820211705-...") into a
 * comparable numeric tuple. Pre-release identifiers and Go pseudo-versions sort
 * lower than any real semver release. Returns -Infinity if the input is unparseable
 * so we can fail loudly rather than silently passing.
 */
function parseVersionTuple(raw: string): [number, number, number, string] {
  const stripped = raw.trim().replace(/^v/, '');
  // Go pseudo-version like 0.0.0-20200820211705-5c72a883971a → [0, 0, 0, 'pre']
  const semverMatch = stripped.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/);
  if (!semverMatch) return [-Infinity, -Infinity, -Infinity, ''];
  const [, major, minor, patch, suffix] = semverMatch;
  return [Number(major), Number(minor), Number(patch), suffix ?? ''];
}

function compareVersions(a: string, b: string): number {
  const [aMaj, aMin, aPatch, aSuffix] = parseVersionTuple(a);
  const [bMaj, bMin, bPatch, bSuffix] = parseVersionTuple(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  if (aPatch !== bPatch) return aPatch - bPatch;
  // A non-empty suffix sorts lower than an empty one (e.g. 0.0.0-pre < 0.0.0).
  if (aSuffix === '' && bSuffix !== '') return 1;
  if (aSuffix !== '' && bSuffix === '') return -1;
  return aSuffix.localeCompare(bSuffix);
}

describe('F06-NEW-12: critical Dependabot advisory regression guards', () => {
  describe('GHSA-xq3m-2v4x-88gg — protobufjs RCE', () => {
    // Vulnerable range: < 7.5.5. Patched: 7.5.5+. Comes in transitively via
    // dockerode → @grpc/proto-loader → protobufjs.
    const PATCHED = '7.5.5';

    it('package.json has an overrides entry forcing protobufjs to the patched range', () => {
      const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
        overrides?: Record<string, string>;
        resolutions?: Record<string, string>;
      };
      // Either npm-style `overrides` or yarn-style `resolutions` is acceptable; the
      // bun and npm lockfiles both honour these. Without one, transitive resolutions
      // pick the highest 7.x satisfying the consumer's `^7.3.2` constraint, which on
      // April 29, 2026 was still 7.5.4 (vulnerable).
      const override = pkg.overrides?.protobufjs ?? pkg.resolutions?.protobufjs;
      expect(override, 'package.json must declare an override for protobufjs').toBeTruthy();
      // The override must demand at least the patched version.
      const overrideMin = (override ?? '').replace(/^[~^>=<]+/, '').trim();
      expect(compareVersions(overrideMin, PATCHED)).toBeGreaterThanOrEqual(0);
    });

    it('bun.lock resolves protobufjs to >= 7.5.5', () => {
      const lock = readFileSync(resolve(REPO_ROOT, 'bun.lock'), 'utf8');
      // Bun lockfile entry shape: `"protobufjs": ["protobufjs@<version>", ...`
      const match = lock.match(/^\s*"protobufjs":\s*\["protobufjs@([\d.]+)"/m);
      expect(match, 'bun.lock must contain a top-level protobufjs entry').toBeTruthy();
      if (!match) return;
      const resolved = match[1];
      expect(compareVersions(resolved, PATCHED)).toBeGreaterThanOrEqual(0);
    });

    it('package-lock.json resolves protobufjs to >= 7.5.5', () => {
      const lock = readFileSync(resolve(REPO_ROOT, 'package-lock.json'), 'utf8');
      // package-lock.json shape: `"node_modules/protobufjs": { "version": "<v>", ...`
      const idx = lock.indexOf('"node_modules/protobufjs"');
      expect(idx).toBeGreaterThan(0);
      const slice = lock.slice(idx, idx + 400);
      const versionMatch = slice.match(/"version":\s*"([\d.]+)"/);
      expect(versionMatch, 'package-lock.json protobufjs entry must have a version').toBeTruthy();
      if (!versionMatch) return;
      expect(compareVersions(versionMatch[1], PATCHED)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GHSA-v778-237x-gjrc — golang.org/x/crypto authorization bypass', () => {
    // Vulnerable range: < 0.31.0. Patched: 0.31.0+. The cli/ Go module pulls x/crypto
    // transitively via Masterminds/sprig (used for templating). The SSH surface is
    // not exercised by our CLI but the advisory still requires a bump because Go's
    // module graph elevates the highest pinned version per build.
    const PATCHED = '0.31.0';

    it('cli/go.mod requires golang.org/x/crypto >= 0.31.0', () => {
      const goMod = readFileSync(resolve(REPO_ROOT, 'cli/go.mod'), 'utf8');
      // Match: `golang.org/x/crypto v<version>` (with optional `// indirect` suffix).
      // Also reject pseudo-versions like `v0.0.0-<timestamp>-<sha>` — those map to
      // pre-release < any real release and are usually pre-0.31.0.
      const match = goMod.match(/^\s*golang\.org\/x\/crypto\s+v([\d.]+)(?:-[a-f0-9]+)?/m);
      expect(match, 'cli/go.mod must contain a golang.org/x/crypto require line').toBeTruthy();
      if (!match) return;
      const requested = match[1];
      // Reject Go pseudo-versions explicitly — they're 0.0.0 with a date stamp and
      // always represent a pre-0.31.0 commit.
      expect(requested).not.toBe('0.0.0');
      expect(compareVersions(requested, PATCHED)).toBeGreaterThanOrEqual(0);
    });

    it('cli/go.sum has a checksum entry for the patched version', () => {
      const goSum = readFileSync(resolve(REPO_ROOT, 'cli/go.sum'), 'utf8');
      // Look for the exact patched-version line; if `go mod tidy` was skipped after
      // editing go.mod, the build would fail at compile time but this test catches
      // the inconsistency earlier.
      expect(goSum).toMatch(new RegExp(`golang\\.org/x/crypto v${PATCHED.replace(/\./g, '\\.')}`));
    });
  });
});
