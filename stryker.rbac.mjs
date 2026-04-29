import { areaConfig } from './stryker.area.mjs';

// RBAC area: service is DB-backed; middleware is pure. Unit + db cover both.
//
// The `db` project keeps PGlite/SQLite sessions alive; Stryker's per-mutant
// reuse of the test runner can SIGSEGV under high concurrency. We hold
// concurrency at 2 (vs 4 default) and force runner-restart every 50 mutants
// to bound the leak.
export default areaConfig({
  area: 'rbac',
  vitestConfigFile: 'vitest.mutation-rbac.config.ts',
  concurrency: 2,
  maxTestRunnerReuse: 50,
});
