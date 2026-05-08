import { vi } from 'vitest';
import type { Result } from '../../src/lib/utils/result';
import { ok } from '../../src/lib/utils/result';
import type { DurableStreamsServer } from '../../src/services/durable-streams.service';
import type { ContainerAgentTrigger } from '../../src/services/task.service';
import type { GitDiff } from '../../src/services/worktree.service';

type InMemoryStreamEvent = {
  type: string;
  data: unknown;
  offset: number;
};

export type InMemoryStreamsServer = DurableStreamsServer & {
  getEvents: (id: string) => InMemoryStreamEvent[];
};

export function createInMemoryStreams(): InMemoryStreamsServer {
  const streams = new Map<string, InMemoryStreamEvent[]>();

  return {
    createStream: vi.fn().mockImplementation(async (id: string): Promise<void> => {
      if (!streams.has(id)) {
        streams.set(id, []);
      }
    }),
    publish: vi.fn().mockImplementation(async (id: string, type: string, data: unknown) => {
      const events = streams.get(id) ?? [];
      const offset = events.length;
      streams.set(id, [...events, { type, data, offset }]);
      return offset;
    }),
    subscribe: vi.fn().mockImplementation(async function* (
      id: string,
      options: { fromOffset?: number } = {}
    ): AsyncIterable<InMemoryStreamEvent> {
      const fromOffset = options.fromOffset ?? 0;
      const events = streams.get(id) ?? [];
      for (const event of events) {
        if (event.offset >= fromOffset) {
          yield event;
        }
      }
    }),
    deleteStream: vi.fn().mockImplementation(async (id: string) => streams.delete(id)),
    getEvents: (id: string) => [...(streams.get(id) ?? [])],
  };
}

export type MockWorktreeService = {
  getDiff: (worktreeId: string) => Promise<Result<GitDiff, unknown>>;
  merge: (worktreeId: string, targetBranch?: string) => Promise<Result<void, unknown>>;
  remove: (worktreeId: string) => Promise<Result<void, unknown>>;
};

export function createMockWorktreeService(
  overrides: Partial<MockWorktreeService> = {}
): MockWorktreeService {
  const defaultGitDiff: GitDiff = {
    files: [],
    stats: { filesChanged: 0, additions: 0, deletions: 0 },
  };

  return {
    getDiff: vi.fn().mockResolvedValue(ok(defaultGitDiff)),
    merge: vi.fn().mockResolvedValue(ok(undefined)),
    remove: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides,
  };
}

export function createMockContainerAgent(
  overrides: Partial<ContainerAgentTrigger> = {}
): ContainerAgentTrigger {
  return {
    providerName: 'docker',
    startAgent: vi.fn().mockResolvedValue(ok(undefined)),
    stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
    isAgentRunning: vi.fn().mockReturnValue(false),
    approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
    rejectPlan: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides,
  };
}

export type MockWorktreeInit = {
  cleanupWorktree: (taskId: string) => Promise<void>;
  resolveWorktree: (...args: unknown[]) => unknown;
  initializeWorkspace: (...args: unknown[]) => unknown;
};

export function createMockWorktreeInit(
  overrides: Partial<MockWorktreeInit> = {}
): MockWorktreeInit {
  return {
    cleanupWorktree: vi.fn().mockResolvedValue(undefined),
    resolveWorktree: vi.fn(),
    initializeWorkspace: vi.fn(),
    ...overrides,
  };
}
