/**
 * Vitest config used by Stryker mutation testing for the `orchestration` area.
 *
 * Filters to unit + integration. The `db` project is excluded for the same
 * reason as `vitest.mutation-rbac.config.ts` (Stryker SIGSEGV reusing native
 * DB handles across mutants). The integration project covers the orchestration
 * paths (agent-execution.service / plan-approval.service / task.service /
 * stream-handler) end-to-end via `tests/integration/agent-execution-*` and
 * related fixtures.
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
