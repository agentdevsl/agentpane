#!/usr/bin/env bun

/**
 * Dependency audit gate. Runs `npm audit --json --omit=dev` and fails when any
 * high or critical advisory is not listed in .github/audit-allowlist.json.
 *
 * Exit codes:
 *   0 — no findings above moderate, OR all high/critical findings are allowlisted
 *   1 — unlisted high/critical advisory found, or allowlist entry expired
 *   2 — audit tool errored in an unexpected way
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

interface AllowEntry {
  ghsaId: string;
  package: string;
  severity: Severity;
  reason: string;
  expiresAt: string;
}

interface Allowlist {
  allowed: AllowEntry[];
}

interface AuditVia {
  source?: number;
  name?: string;
  title?: string;
  url?: string;
  severity?: Severity;
}

interface AuditVuln {
  name: string;
  severity: Severity;
  via: Array<AuditVia | string>;
}

interface AuditReport {
  vulnerabilities: Record<string, AuditVuln>;
}

const ROOT = resolve(import.meta.dirname, '..');
const ALLOWLIST_PATH = resolve(ROOT, '.github/audit-allowlist.json');
const GATING_SEVERITIES: ReadonlySet<Severity> = new Set(['high', 'critical']);

function extractGhsaId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/GHSA-[a-z0-9-]+/i);
  return match ? match[0] : null;
}

// Allowlist keys are `<ghsaId>:<package>` so an entry only waives the advisory
// for the specific package it was justified against — prevents a single
// allowlist entry from silently waiving a transitive CVE in an unrelated
// package that happens to share the same GHSA ID.
function allowKey(ghsaId: string, pkg: string): string {
  return `${ghsaId}:${pkg}`;
}

function loadAllowlist(): Map<string, AllowEntry> {
  const raw = readFileSync(ALLOWLIST_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Allowlist;
  const map = new Map<string, AllowEntry>();
  for (const entry of parsed.allowed) {
    map.set(allowKey(entry.ghsaId, entry.package), entry);
  }
  return map;
}

function runAudit(): AuditReport {
  const result = spawnSync('npm', ['audit', '--json', '--omit=dev'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
  // `spawnSync` sets `.error` when the child couldn't be launched at all
  // (e.g. ENOENT — npm not installed). In that case stdout/stderr are null,
  // so check `error` before touching them.
  if (result.error) {
    console.error('[audit] could not run npm:', result.error.message);
    process.exit(2);
  }
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (stdout.length === 0 && stderr.length > 0) {
    console.error('[audit] npm audit failed:', stderr);
    process.exit(2);
  }
  try {
    return JSON.parse(stdout) as AuditReport;
  } catch (err) {
    console.error('[audit] failed to parse npm audit output:', (err as Error).message);
    process.exit(2);
  }
}

function main(): void {
  const allow = loadAllowlist();
  const report = runAudit();

  const now = new Date();
  const unlisted: Array<{ pkg: string; severity: Severity; ghsaId: string; title: string }> = [];
  const expired: AllowEntry[] = [];
  const seenKeys = new Set<string>();

  for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
    for (const via of vuln.via) {
      if (typeof via === 'string') continue;
      const severity: Severity = via.severity ?? vuln.severity;
      if (!GATING_SEVERITIES.has(severity)) continue;

      const ghsaId = extractGhsaId(via.url);
      if (!ghsaId) continue;
      const key = allowKey(ghsaId, pkg);
      seenKeys.add(key);

      const entry = allow.get(key);
      if (!entry) {
        unlisted.push({
          pkg,
          severity,
          ghsaId,
          title: via.title ?? via.name ?? pkg,
        });
      }
    }
  }

  for (const [key, entry] of allow.entries()) {
    if (!seenKeys.has(key)) continue;
    const expiry = new Date(entry.expiresAt);
    if (Number.isFinite(expiry.getTime()) && expiry < now) {
      expired.push(entry);
    }
  }

  const obsolete = [...allow.entries()]
    .filter(([key]) => !seenKeys.has(key))
    .map(([, entry]) => entry);

  if (unlisted.length === 0 && expired.length === 0) {
    console.log(
      `[audit] OK — ${seenKeys.size} gating advisories all allowlisted; ${obsolete.length} obsolete allowlist entries (remove from .github/audit-allowlist.json)`
    );
    for (const e of obsolete) {
      console.log(`  obsolete: ${e.ghsaId} (${e.package}) — reason: ${e.reason}`);
    }
    process.exit(0);
  }

  if (unlisted.length > 0) {
    console.error(`[audit] FAIL — ${unlisted.length} unlisted high/critical advisories:`);
    for (const u of unlisted) {
      console.error(`  ${u.severity.toUpperCase().padEnd(8)} ${u.pkg}  ${u.ghsaId}  ${u.title}`);
    }
    console.error(
      '\nAdd each to .github/audit-allowlist.json with a reason and expiresAt, or fix.'
    );
  }
  if (expired.length > 0) {
    console.error(`[audit] FAIL — ${expired.length} expired allowlist entries:`);
    for (const e of expired) {
      console.error(`  ${e.ghsaId}  ${e.package}  expired ${e.expiresAt}`);
    }
    console.error('\nReview and re-justify or fix the underlying dependency.');
  }
  process.exit(1);
}

main();
