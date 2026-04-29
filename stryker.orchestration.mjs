import { areaConfig } from './stryker.area.mjs';

// Orchestration area: agent execution + plan approval + task service +
// stream-handler. Touches DB, integration paths, but not jsdom / functional.
// Larger files (agent-execution.service.ts ~57KB) need more per-mutant
// headroom. Same concurrency cap as rbac (db + integration both keep
// long-lived sessions; restart-after-50 caps the memory leak).
export default areaConfig({
  area: 'orchestration',
  vitestConfigFile: 'vitest.mutation-orchestration.config.ts',
  timeoutMS: 60000,
  concurrency: 2,
  maxTestRunnerReuse: 50,
});
