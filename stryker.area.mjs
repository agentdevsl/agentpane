/**
 * Per-area Stryker config helper.
 *
 * Loads `stryker.config.json` as the baseline and applies per-area overrides.
 * Each per-area config (`stryker.<area>.mjs`) imports this and exports a
 * `default` config object so Stryker picks it up.
 *
 * Why per-area configs:
 *   1. Vitest project filter — `state-machines` doesn't need `db`, `integration`,
 *      `jsdom`, or `functional` projects loaded for every mutant. Cuts mutant
 *      cycle-time materially on large test suites.
 *   2. Per-area `incrementalFile` — separate caches keep matrix entries
 *      independent (a re-run of `rbac` doesn't invalidate `state-machines`).
 *   3. Per-area `timeoutMS` — orchestration mutants are larger; needs more time.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const baseConfig = JSON.parse(
  readFileSync(resolve(__dirname, 'stryker.config.json'), 'utf8')
);

/**
 * Build a per-area Stryker config by merging overrides into the base config.
 *
 * Stryker's vitest runner only allows `vitest.{configFile,dir}` per
 * https://stryker-mutator.io/docs/stryker-js/vitest-runner/, so per-area
 * project filtering happens via dedicated vitest configs
 * (`vitest.mutation-<area>.config.ts`) that re-export the base with only
 * the relevant projects loaded.
 *
 * @param {{
 *   area: string,
 *   vitestConfigFile: string,
 *   timeoutMS?: number,
 *   concurrency?: number,
 * }} opts
 * @returns {Record<string, unknown>}
 */
export function areaConfig(opts) {
  // Strip the leading `_comment*` keys from the base so the schema validator
  // doesn't choke on documentation fields.
  const cleanBase = Object.fromEntries(
    Object.entries(baseConfig).filter(([k]) => !k.startsWith('_comment'))
  );

  return {
    ...cleanBase,
    vitest: {
      configFile: opts.vitestConfigFile,
    },
    incrementalFile: `reports/mutation/stryker-incremental-${opts.area}.json`,
    timeoutMS: opts.timeoutMS ?? cleanBase.timeoutMS,
    concurrency: opts.concurrency ?? cleanBase.concurrency,
    // Restart the test runner worker after every 50 mutants — mitigates the
    // memory creep we've observed when the vitest `db` project keeps a
    // PGlite/SQLite session alive across mutations. Stryker docs:
    // https://stryker-mutator.io/docs/stryker-js/configuration/#maxtestrunnerreuse
    maxTestRunnerReuse: opts.maxTestRunnerReuse ?? 50,
  };
}
