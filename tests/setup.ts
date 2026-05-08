import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { SandboxStateManager } from '../src/services/container-agent/sandbox-state';
import { clearTestDatabase, closeTestDatabase, setupTestDatabase } from './helpers/database';
import { TEST_ENV } from './helpers/env';

vi.stubEnv('ANTHROPIC_API_KEY', TEST_ENV.ANTHROPIC_API_KEY);
vi.stubEnv('NODE_ENV', TEST_ENV.NODE_ENV);

beforeAll(async () => {
  await setupTestDatabase();
});

afterEach(async () => {
  SandboxStateManager.disposeAll();
  await clearTestDatabase();
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeTestDatabase();
});
