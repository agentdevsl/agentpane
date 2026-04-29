/**
 * Vitest config used by Stryker mutation testing for the `rbac` area.
 *
 * Filters to unit + integration. We drop the `db` project even though
 * `tests/services/rbac*.test.ts` lives there: Stryker's per-mutant sandbox
 * SIGSEGVs when reusing native PGlite/SQLite handles across mutants
 * (https://github.com/stryker-mutator/stryker-js — known native-module
 * interaction). The integration project (`tests/integration/`) re-runs
 * many of the same paths against a real DB but in fresh forks per file.
 *
 * Coverage trade-off: rbac.service.ts logic is mutation-validated through
 * integration tests that exercise it end-to-end, not through the unit-level
 * `tests/services/rbac.service.test.ts`. Acceptable for PR-time mutation;
 * the cron-time baseline (`stryker.config.json`, no per-area override)
 * still uses the full config when scheduled.
 */
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

const ALLOWED = new Set(['unit', 'integration']);
const allProjects = baseConfig.test?.projects ?? [];
const filtered = allProjects.filter(
  (p) => typeof p === 'object' && 'test' in p && p.test?.name && ALLOWED.has(String(p.test.name))
);

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    projects: filtered,
  },
});
