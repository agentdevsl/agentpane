import { vi } from 'vitest';

vi.stubEnv('ANTHROPIC_API_KEY', 'test-api-key');
vi.stubEnv('NODE_ENV', 'test');
