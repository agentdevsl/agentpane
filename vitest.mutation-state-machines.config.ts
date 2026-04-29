/**
 * Vitest config used by Stryker mutation testing for the `state-machines` area.
 *
 * Re-exports `vitest.config.ts` filtered to the projects relevant to the
 * mutator scope. Stryker's vitest runner only supports `vitest.configFile`
 * (per https://stryker-mutator.io/docs/stryker-js/vitest-runner/), so we
 * need a dedicated config that loads ONLY the unit project.
 *
 * Why filter:
 *   - `state-machines` mutators (machine.ts, guards.ts, actions.ts) are pure
 *     logic. The unit project exercises them; jsdom/db/integration/functional
 *     do not. Loading them per mutant wastes time.
 */
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

const allProjects = baseConfig.test?.projects ?? [];
const filtered = allProjects.filter(
  (p) => typeof p === 'object' && 'test' in p && String(p.test?.name) === 'unit'
);

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    projects: filtered,
  },
});
