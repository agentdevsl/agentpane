import { createId } from '@paralleldrive/cuid2';
import { describe, expect, it } from 'vitest';
import {
  createAgentSchema,
  createSessionSchema,
  createTaskSchema,
  createWorkflowSchema,
  moveTaskSchema,
} from '@/server/validation';

/**
 * Schema unit tests for the canonical server validation module.
 *
 * arch29-W2-P (F12-01): These tests previously lived next to the deleted
 * `src/lib/api/schemas.ts`, which redeclared 5 task/session/agent schemas
 * with tighter limits than the canonical server schemas. The canonical
 * versions in `src/server/validation.ts` are now the only source of truth;
 * these tests assert the canonical limits round-trip correctly so a future
 * refactor cannot silently re-introduce divergent limits.
 */
const validId = () => createId();

describe('Canonical API Schemas', () => {
  describe('createTaskSchema', () => {
    it('accepts a valid task with required fields', () => {
      const result = createTaskSchema.safeParse({
        codespaceId: validId(),
        title: 'Fix the login bug',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a task with optional description and labels', () => {
      const result = createTaskSchema.safeParse({
        codespaceId: validId(),
        title: 'Add feature X',
        description: 'Implement the new feature',
        labels: ['feature', 'high-priority'],
      });
      expect(result.success).toBe(true);
    });

    it('rejects when codespaceId is missing', () => {
      const result = createTaskSchema.safeParse({ title: 'Some task' });
      expect(result.success).toBe(false);
    });

    it('rejects empty title', () => {
      const result = createTaskSchema.safeParse({
        codespaceId: validId(),
        title: '',
      });
      expect(result.success).toBe(false);
    });

    it('accepts title up to 500 characters (canonical limit)', () => {
      const result = createTaskSchema.safeParse({
        codespaceId: validId(),
        title: 'x'.repeat(500),
      });
      expect(result.success).toBe(true);
    });

    it('rejects title exceeding 500 characters', () => {
      const result = createTaskSchema.safeParse({
        codespaceId: validId(),
        title: 'x'.repeat(501),
      });
      expect(result.success).toBe(false);
    });

    it('accepts description up to 10000 characters (canonical limit)', () => {
      const result = createTaskSchema.safeParse({
        codespaceId: validId(),
        title: 'Valid title',
        description: 'x'.repeat(10000),
      });
      expect(result.success).toBe(true);
    });

    it('rejects description exceeding 10000 characters', () => {
      const result = createTaskSchema.safeParse({
        codespaceId: validId(),
        title: 'Valid title',
        description: 'x'.repeat(10001),
      });
      expect(result.success).toBe(false);
    });

    it('accepts up to 20 labels (canonical limit)', () => {
      const result = createTaskSchema.safeParse({
        codespaceId: validId(),
        title: 'Valid',
        labels: Array.from({ length: 20 }, (_, i) => `label-${i}`),
      });
      expect(result.success).toBe(true);
    });

    it('rejects labels array exceeding 20 items', () => {
      const result = createTaskSchema.safeParse({
        codespaceId: validId(),
        title: 'Valid',
        labels: Array.from({ length: 21 }, (_, i) => `label-${i}`),
      });
      expect(result.success).toBe(false);
    });

    it('accepts a valid skillId', () => {
      const result = createTaskSchema.safeParse({
        codespaceId: validId(),
        title: 'Valid',
        skillId: 'review-pr',
      });
      expect(result.success).toBe(true);
    });

    it('rejects skillId with disallowed characters', () => {
      const result = createTaskSchema.safeParse({
        codespaceId: validId(),
        title: 'Valid',
        skillId: 'review pr', // space disallowed
      });
      expect(result.success).toBe(false);
    });

    it('accepts approvalMode "human" or "agent"', () => {
      for (const approvalMode of ['human', 'agent'] as const) {
        const result = createTaskSchema.safeParse({
          codespaceId: validId(),
          title: 'Valid',
          approvalMode,
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('createAgentSchema', () => {
    it('accepts a valid agent with required fields', () => {
      const result = createAgentSchema.safeParse({
        codespaceId: validId(),
        name: 'Agent One',
        type: 'task',
      });
      expect(result.success).toBe(true);
    });

    it('accepts agent with config (canonical: free-form record)', () => {
      const result = createAgentSchema.safeParse({
        codespaceId: validId(),
        name: 'Configured Agent',
        type: 'task',
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
        codespaceId: validId(),
        name: 'Bad',
        type: 'nonexistent',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty name', () => {
      const result = createAgentSchema.safeParse({
        codespaceId: validId(),
        name: '',
        type: 'task',
      });
      expect(result.success).toBe(false);
    });

    it('accepts name up to 200 characters (canonical limit)', () => {
      const result = createAgentSchema.safeParse({
        codespaceId: validId(),
        name: 'x'.repeat(200),
        type: 'task',
      });
      expect(result.success).toBe(true);
    });

    it('rejects name exceeding 200 characters', () => {
      const result = createAgentSchema.safeParse({
        codespaceId: validId(),
        name: 'x'.repeat(201),
        type: 'task',
      });
      expect(result.success).toBe(false);
    });

    it('rejects when type is missing (canonical: required)', () => {
      const result = createAgentSchema.safeParse({
        codespaceId: validId(),
        name: 'Agent',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('moveTaskSchema', () => {
    it('accepts a valid column move', () => {
      const result = moveTaskSchema.safeParse({ column: 'in_progress' });
      expect(result.success).toBe(true);
    });

    it('accepts all canonical column values (incl. "queued")', () => {
      const columns = ['backlog', 'queued', 'in_progress', 'waiting_approval', 'verified'] as const;
      for (const column of columns) {
        const result = moveTaskSchema.safeParse({ column });
        expect(result.success).toBe(true);
      }
    });

    it('accepts optional position (integer)', () => {
      const result = moveTaskSchema.safeParse({ column: 'backlog', position: 3 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.position).toBe(3);
      }
    });

    it('accepts optional startAgent flag (canonical only)', () => {
      const result = moveTaskSchema.safeParse({
        column: 'in_progress',
        startAgent: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startAgent).toBe(true);
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
      const result = moveTaskSchema.safeParse({ column: 'backlog', position: -1 });
      expect(result.success).toBe(false);
    });
  });

  describe('createSessionSchema', () => {
    it('accepts a valid session with codespaceId only', () => {
      const result = createSessionSchema.safeParse({
        codespaceId: validId(),
      });
      expect(result.success).toBe(true);
    });

    it('accepts all optional fields', () => {
      const result = createSessionSchema.safeParse({
        codespaceId: validId(),
        taskId: validId(),
        agentId: validId(),
        title: 'Test Session',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing codespaceId', () => {
      const result = createSessionSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects an id with disallowed characters', () => {
      const result = createSessionSchema.safeParse({
        codespaceId: 'NOT-A-VALID!!ID',
      });
      expect(result.success).toBe(false);
    });

    it('accepts title up to 500 characters (canonical limit)', () => {
      const result = createSessionSchema.safeParse({
        codespaceId: validId(),
        title: 'x'.repeat(500),
      });
      expect(result.success).toBe(true);
    });

    it('rejects title exceeding 500 characters', () => {
      const result = createSessionSchema.safeParse({
        codespaceId: validId(),
        title: 'x'.repeat(501),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('createWorkflowSchema', () => {
    it('accepts a valid workflow with required fields', () => {
      const result = createWorkflowSchema.safeParse({ name: 'My Workflow' });
      expect(result.success).toBe(true);
    });

    it('rejects empty name', () => {
      const result = createWorkflowSchema.safeParse({ name: '' });
      expect(result.success).toBe(false);
    });

    it('accepts name up to 200 characters', () => {
      const result = createWorkflowSchema.safeParse({ name: 'x'.repeat(200) });
      expect(result.success).toBe(true);
    });

    it('rejects name exceeding 200 characters', () => {
      const result = createWorkflowSchema.safeParse({ name: 'x'.repeat(201) });
      expect(result.success).toBe(false);
    });

    it('accepts description up to 2000 characters', () => {
      const result = createWorkflowSchema.safeParse({
        name: 'My Workflow',
        description: 'x'.repeat(2000),
      });
      expect(result.success).toBe(true);
    });

    it('rejects description exceeding 2000 characters', () => {
      const result = createWorkflowSchema.safeParse({
        name: 'My Workflow',
        description: 'x'.repeat(2001),
      });
      expect(result.success).toBe(false);
    });

    it('accepts a valid status enum', () => {
      for (const status of ['draft', 'published', 'archived'] as const) {
        const result = createWorkflowSchema.safeParse({ name: 'wf', status });
        expect(result.success).toBe(true);
      }
    });

    it('rejects an invalid status', () => {
      const result = createWorkflowSchema.safeParse({
        name: 'wf',
        status: 'invalid',
      });
      expect(result.success).toBe(false);
    });

    it('rejects too many tags (max 20)', () => {
      const result = createWorkflowSchema.safeParse({
        name: 'wf',
        tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`),
      });
      expect(result.success).toBe(false);
    });

    it('accepts an empty nodes array', () => {
      const result = createWorkflowSchema.safeParse({ name: 'wf', nodes: [] });
      expect(result.success).toBe(true);
    });

    it('accepts an empty edges array', () => {
      const result = createWorkflowSchema.safeParse({ name: 'wf', edges: [] });
      expect(result.success).toBe(true);
    });
  });
});
