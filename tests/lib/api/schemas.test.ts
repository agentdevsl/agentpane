import { createId } from '@paralleldrive/cuid2';
import { describe, expect, it } from 'vitest';
import {
  createAgentSchema,
  createProjectSchema,
  createSessionSchema,
  createTaskSchema,
  listProjectsSchema,
  moveTaskSchema,
} from '@/lib/api/schemas';

/** Helper that generates a valid CUID for test inputs */
const validCuid = () => createId();

describe('API Schemas', () => {
  describe('createProjectSchema', () => {
    it('accepts a valid project with required fields only', () => {
      const result = createProjectSchema.safeParse({
        name: 'My Project',
        path: '/home/user/project',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid project with all optional fields', () => {
      const sandboxId = validCuid();
      const result = createProjectSchema.safeParse({
        name: 'My Project',
        path: '/home/user/project',
        description: 'A test project',
        maxConcurrentAgents: 5,
        githubOwner: 'acme',
        githubRepo: 'my-repo',
        sandboxConfigId: sandboxId,
      });
      expect(result.success).toBe(true);
    });

    it('rejects when name is empty', () => {
      const result = createProjectSchema.safeParse({
        name: '',
        path: '/home/user/project',
      });
      expect(result.success).toBe(false);
    });

    it('rejects when name exceeds 100 characters', () => {
      const result = createProjectSchema.safeParse({
        name: 'x'.repeat(101),
        path: '/some/path',
      });
      expect(result.success).toBe(false);
    });

    it('rejects when path is empty', () => {
      const result = createProjectSchema.safeParse({
        name: 'Valid Name',
        path: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects when path is missing', () => {
      const result = createProjectSchema.safeParse({ name: 'Valid' });
      expect(result.success).toBe(false);
    });

    it('rejects description over 500 characters', () => {
      const result = createProjectSchema.safeParse({
        name: 'Valid',
        path: '/path',
        description: 'x'.repeat(501),
      });
      expect(result.success).toBe(false);
    });

    it('rejects maxConcurrentAgents above 10', () => {
      const result = createProjectSchema.safeParse({
        name: 'Valid',
        path: '/path',
        maxConcurrentAgents: 11,
      });
      expect(result.success).toBe(false);
    });

    it('rejects maxConcurrentAgents below 1', () => {
      const result = createProjectSchema.safeParse({
        name: 'Valid',
        path: '/path',
        maxConcurrentAgents: 0,
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid sandboxConfigId format', () => {
      const result = createProjectSchema.safeParse({
        name: 'Valid',
        path: '/path',
        sandboxConfigId: 'not-a-cuid',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('createTaskSchema', () => {
    it('accepts a valid task with required fields', () => {
      const result = createTaskSchema.safeParse({
        projectId: validCuid(),
        title: 'Fix the login bug',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a task with optional description and labels', () => {
      const result = createTaskSchema.safeParse({
        projectId: validCuid(),
        title: 'Add feature X',
        description: 'Implement the new feature',
        labels: ['feature', 'high-priority'],
      });
      expect(result.success).toBe(true);
    });

    it('rejects when projectId is missing', () => {
      const result = createTaskSchema.safeParse({ title: 'Some task' });
      expect(result.success).toBe(false);
    });

    it('rejects invalid projectId format', () => {
      const result = createTaskSchema.safeParse({
        projectId: 'bad-id',
        title: 'Some task',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty title', () => {
      const result = createTaskSchema.safeParse({
        projectId: validCuid(),
        title: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects title exceeding 200 characters', () => {
      const result = createTaskSchema.safeParse({
        projectId: validCuid(),
        title: 'x'.repeat(201),
      });
      expect(result.success).toBe(false);
    });

    it('rejects description exceeding 5000 characters', () => {
      const result = createTaskSchema.safeParse({
        projectId: validCuid(),
        title: 'Valid title',
        description: 'x'.repeat(5001),
      });
      expect(result.success).toBe(false);
    });

    it('rejects labels array exceeding 10 items', () => {
      const result = createTaskSchema.safeParse({
        projectId: validCuid(),
        title: 'Valid',
        labels: Array.from({ length: 11 }, (_, i) => `label-${i}`),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('createAgentSchema', () => {
    it('accepts a valid agent with required fields', () => {
      const result = createAgentSchema.safeParse({
        projectId: validCuid(),
        name: 'Agent One',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('task'); // default
      }
    });

    it('accepts agent with explicit type', () => {
      const result = createAgentSchema.safeParse({
        projectId: validCuid(),
        name: 'Chat Agent',
        type: 'conversational',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('conversational');
      }
    });

    it('accepts agent with config', () => {
      const result = createAgentSchema.safeParse({
        projectId: validCuid(),
        name: 'Configured Agent',
        config: {
          maxTurns: 100,
          model: 'claude-opus-4',
          temperature: 0.5,
          allowedTools: ['Read', 'Edit'],
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid agent type', () => {
      const result = createAgentSchema.safeParse({
        projectId: validCuid(),
        name: 'Bad',
        type: 'nonexistent',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty name', () => {
      const result = createAgentSchema.safeParse({
        projectId: validCuid(),
        name: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects name exceeding 100 characters', () => {
      const result = createAgentSchema.safeParse({
        projectId: validCuid(),
        name: 'x'.repeat(101),
      });
      expect(result.success).toBe(false);
    });

    it('rejects config with maxTurns above 500', () => {
      const result = createAgentSchema.safeParse({
        projectId: validCuid(),
        name: 'Agent',
        config: { maxTurns: 501 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects config with temperature above 1', () => {
      const result = createAgentSchema.safeParse({
        projectId: validCuid(),
        name: 'Agent',
        config: { temperature: 1.5 },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('listProjectsSchema', () => {
    it('accepts empty query (all defaults)', () => {
      const result = listProjectsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
      }
    });

    it('coerces string limit to number', () => {
      const result = listProjectsSchema.safeParse({ limit: '50' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
      }
    });

    it('accepts optional search parameter', () => {
      const result = listProjectsSchema.safeParse({ search: 'my-project' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.search).toBe('my-project');
      }
    });

    it('accepts optional cursor parameter', () => {
      const result = listProjectsSchema.safeParse({ cursor: 'abc123' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cursor).toBe('abc123');
      }
    });

    it('rejects limit below 1', () => {
      const result = listProjectsSchema.safeParse({ limit: '0' });
      expect(result.success).toBe(false);
    });

    it('rejects limit above 100', () => {
      const result = listProjectsSchema.safeParse({ limit: '101' });
      expect(result.success).toBe(false);
    });
  });

  describe('moveTaskSchema', () => {
    it('accepts a valid column move', () => {
      const result = moveTaskSchema.safeParse({ column: 'in_progress' });
      expect(result.success).toBe(true);
    });

    it('accepts all valid column values', () => {
      const columns = ['backlog', 'in_progress', 'waiting_approval', 'verified'] as const;
      for (const column of columns) {
        const result = moveTaskSchema.safeParse({ column });
        expect(result.success).toBe(true);
      }
    });

    it('accepts optional position', () => {
      const result = moveTaskSchema.safeParse({ column: 'backlog', position: '3' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.position).toBe(3);
      }
    });

    it('rejects an invalid column value', () => {
      const result = moveTaskSchema.safeParse({ column: 'done' });
      expect(result.success).toBe(false);
    });

    it('rejects missing column', () => {
      const result = moveTaskSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects negative position', () => {
      const result = moveTaskSchema.safeParse({ column: 'backlog', position: '-1' });
      expect(result.success).toBe(false);
    });
  });

  describe('createSessionSchema', () => {
    it('accepts a valid session with projectId only', () => {
      const result = createSessionSchema.safeParse({
        projectId: validCuid(),
      });
      expect(result.success).toBe(true);
    });

    it('accepts all optional fields', () => {
      const result = createSessionSchema.safeParse({
        projectId: validCuid(),
        taskId: validCuid(),
        agentId: validCuid(),
        title: 'Test Session',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing projectId', () => {
      const result = createSessionSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects invalid projectId', () => {
      const result = createSessionSchema.safeParse({
        projectId: 'not-valid',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid taskId', () => {
      const result = createSessionSchema.safeParse({
        projectId: validCuid(),
        taskId: 'NOT-A-CUID!!',
      });
      expect(result.success).toBe(false);
    });

    it('rejects title exceeding 200 characters', () => {
      const result = createSessionSchema.safeParse({
        projectId: validCuid(),
        title: 'x'.repeat(201),
      });
      expect(result.success).toBe(false);
    });
  });
});
