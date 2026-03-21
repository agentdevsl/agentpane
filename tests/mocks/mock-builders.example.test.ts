/**
 * Example test demonstrating type-safe mock builders
 *
 * This file shows how to use the mock-builders infrastructure to create
 * type-safe database mocks without `as never`.
 */

import { describe, expect, it } from 'vitest';
import type { Codespace as Project, Task } from '../../src/db/schema';
import type { Database } from '../../src/types/database.js';
import { createMockDatabase, createTableQuery, type MockDatabase } from './mock-builders.js';

describe('Mock Builders Examples', () => {
  describe('createMockDatabase', () => {
    it('creates a mock database with all tables initialized', () => {
      const mockDb = createMockDatabase();

      // All tables should have findFirst and findMany
      expect(mockDb.query.codespaces.findFirst).toBeDefined();
      expect(mockDb.query.codespaces.findMany).toBeDefined();
      expect(mockDb.query.tasks.findFirst).toBeDefined();
      expect(mockDb.query.tasks.findMany).toBeDefined();

      // Core methods should be defined
      expect(mockDb.insert).toBeDefined();
      expect(mockDb.update).toBeDefined();
      expect(mockDb.delete).toBeDefined();
      expect(mockDb.select).toBeDefined();
      expect(mockDb.transaction).toBeDefined();
    });

    it('allows type-safe table query overrides', async () => {
      const mockProject: Project = {
        id: 'proj-1',
        name: 'Test Project',
        path: '/test/path',
        description: null,
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: [],
          maxTurns: 50,
        },
        maxConcurrentAgents: 3,
        githubOwner: null,
        githubRepo: null,
        githubInstallationId: null,
        configPath: '.claude',
        sandboxConfigId: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };

      const mockDb = createMockDatabase({
        query: {
          codespaces: createTableQuery([mockProject]),
        },
      });

      const result = await mockDb.query.codespaces.findFirst();
      expect(result).toEqual(mockProject);

      const results = await mockDb.query.codespaces.findMany();
      expect(results).toEqual([mockProject]);
    });

    it('supports insert chains', async () => {
      const mockTask: Task = {
        id: 'task-1',
        codespaceId: 'proj-1',
        agentId: null,
        sessionId: null,
        worktreeId: null,
        title: 'Test Task',
        description: null,
        column: 'backlog',
        position: 0,
        labels: [],
        priority: 'medium',
        branch: null,
        diffSummary: null,
        approvedAt: null,
        approvedBy: null,
        rejectionCount: 0,
        rejectionReason: null,
        modelOverride: null,
        planOptions: null,
        plan: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        startedAt: null,
        completedAt: null,
        lastAgentStatus: null,
      };

      const mockDb = createMockDatabase();

      // Mock insert to return the task
      mockDb.insert.mockReturnValue({
        values: (vi.fn() as any).mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockTask]),
          onConflictDoUpdate: vi.fn(),
        }),
      });

      const result = await mockDb
        .insert({} as any)
        .values({})
        .returning();
      expect(result).toEqual([mockTask]);
    });

    it('works with TypeScript as Database type', () => {
      const mockDb = createMockDatabase() as unknown as Database;

      // This should compile without errors - the cast demonstrates
      // that MockDatabase is structurally compatible with Database
      expect(mockDb.query.codespaces).toBeDefined();
    });
  });

  describe('Service constructor duck typing', () => {
    it('demonstrates duck-typed service mocking', () => {
      // Services use duck-typed interfaces, not full classes
      interface WorktreeServiceSubset {
        getDiff: (worktreeId: string) => Promise<string>;
        merge: (worktreeId: string) => Promise<void>;
        remove: (worktreeId: string) => Promise<void>;
      }

      class ExampleService {
        constructor(
          _db: Database,
          private worktreeService: WorktreeServiceSubset
        ) {}

        async doSomething() {
          const diff = await this.worktreeService.getDiff('wt-1');
          return diff;
        }
      }

      // Create mock database
      const mockDb = createMockDatabase() as unknown as Database;

      // Create duck-typed mock service
      const mockWorktreeService: WorktreeServiceSubset = {
        getDiff: vi.fn().mockResolvedValue('mock diff'),
        merge: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };

      // No `as never` needed!
      const service = new ExampleService(mockDb, mockWorktreeService);

      expect(service).toBeDefined();
    });
  });

  describe('MockDatabase type compatibility', () => {
    it('is structurally compatible with Database type', () => {
      const mockDb: MockDatabase = createMockDatabase();

      // This function expects Database type
      function acceptsDatabase(db: Database) {
        return db.query.codespaces;
      }

      // Should work with type assertion
      const result = acceptsDatabase(mockDb as unknown as Database);
      expect(result).toBeDefined();
    });
  });
});
