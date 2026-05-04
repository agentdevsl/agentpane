import { vi } from 'vitest';
import type { ContainerAgentTrigger } from '../../src/services/task.service';

export function createMockContainerAgent(
  overrides: Partial<ContainerAgentTrigger> = {}
): ContainerAgentTrigger {
  return {
    providerName: 'docker',
    startAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    stopAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    isAgentRunning: vi.fn().mockReturnValue(false),
    approvePlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    rejectPlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    ...overrides,
  };
}
