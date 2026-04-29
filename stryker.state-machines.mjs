import { areaConfig } from './stryker.area.mjs';

// State-machines area: pure logic, no DB / DOM. Only the unit project loads.
export default areaConfig({
  area: 'state-machines',
  vitestConfigFile: 'vitest.mutation-state-machines.config.ts',
});
