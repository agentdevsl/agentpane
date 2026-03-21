import { describe, expect, it } from 'vitest';
import { AgentCrudService } from '../../src/services/agent/agent-crud.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { getTestDb } from '../helpers/database';

describe('AgentCrudService', () => {
  function createService() {
    return new AgentCrudService(getTestDb() as any);
  }

  describe('create', () => {
    it('creates an agent for a valid project', async () => {
      const service = createService();
      const project = await createTestProject();

      const result = await service.create({
        codespaceId: project.id,
        name: 'My Agent',
        type: 'task',
        status: 'idle',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('My Agent');
        expect(result.value.codespaceId).toBe(project.id);
        expect(result.value.status).toBe('idle');
        expect(result.value.type).toBe('task');
        expect(result.value.id).toBeTruthy();
      }
    });

    it('inherits config defaults from the project', async () => {
      const service = createService();
      const project = await createTestProject({
        config: {
          maxTurns: 100,
          allowedTools: ['Read', 'Bash'],
          defaultBranch: 'main',
          worktreeRoot: '.worktrees',
        },
      });

      const result = await service.create({
        codespaceId: project.id,
        name: 'Inheriting Agent',
        type: 'task',
        status: 'idle',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.config?.maxTurns).toBe(100);
        expect(result.value.config?.allowedTools).toEqual(['Read', 'Bash']);
      }
    });

    it('agent config overrides project config', async () => {
      const service = createService();
      const project = await createTestProject({
        config: {
          maxTurns: 100,
          allowedTools: ['Read'],
          defaultBranch: 'main',
          worktreeRoot: '.worktrees',
        },
      });

      const result = await service.create({
        codespaceId: project.id,
        name: 'Override Agent',
        type: 'task',
        status: 'idle',
        config: {
          maxTurns: 25,
          allowedTools: ['Read', 'Write', 'Edit'],
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.config?.maxTurns).toBe(25);
        expect(result.value.config?.allowedTools).toEqual(['Read', 'Write', 'Edit']);
      }
    });

    it('returns INVALID_ID error for non-existent project', async () => {
      const service = createService();

      const result = await service.create({
        codespaceId: 'nonexistent-project-id',
        name: 'Orphan Agent',
        type: 'task',
        status: 'idle',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_ID');
      }
    });
  });

  describe('getById', () => {
    it('returns an agent by ID', async () => {
      const service = createService();
      const project = await createTestProject();
      const agent = await createTestAgent(project.id, { name: 'Find Me' });

      const result = await service.getById(agent.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(agent.id);
        expect(result.value.name).toBe('Find Me');
      }
    });

    it('returns AGENT_NOT_FOUND for non-existent ID', async () => {
      const service = createService();

      const result = await service.getById('nonexistent-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_FOUND');
      }
    });
  });

  describe('list', () => {
    it('returns agents for a specific project', async () => {
      const service = createService();
      const project1 = await createTestProject({ name: 'Project A' });
      const project2 = await createTestProject({ name: 'Project B' });

      await createTestAgent(project1.id, { name: 'Agent A1' });
      await createTestAgent(project1.id, { name: 'Agent A2' });
      await createTestAgent(project2.id, { name: 'Agent B1' });

      const result = await service.list(project1.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
        const names = result.value.map((a) => a.name);
        expect(names).toContain('Agent A1');
        expect(names).toContain('Agent A2');
        // Should not include agents from other projects
        expect(names).not.toContain('Agent B1');
      }
    });

    it('returns empty array for project with no agents', async () => {
      const service = createService();
      const project = await createTestProject();

      const result = await service.list(project.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  describe('listAll', () => {
    it('returns agents across all projects', async () => {
      const service = createService();
      const project1 = await createTestProject({ name: 'Project X' });
      const project2 = await createTestProject({ name: 'Project Y' });

      await createTestAgent(project1.id, { name: 'Agent X1' });
      await createTestAgent(project2.id, { name: 'Agent Y1' });

      const result = await service.listAll();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    it('returns empty array when no agents exist', async () => {
      const service = createService();

      const result = await service.listAll();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  describe('getRunningCount', () => {
    it('returns 0 when no running agents', async () => {
      const service = createService();
      const project = await createTestProject();
      await createTestAgent(project.id, { status: 'idle' });

      const result = await service.getRunningCount(project.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it('counts only running agents for the given project', async () => {
      const service = createService();
      const project1 = await createTestProject({ name: 'Count P1' });
      const project2 = await createTestProject({ name: 'Count P2' });

      await createTestAgent(project1.id, { status: 'running' });
      await createTestAgent(project1.id, { status: 'running' });
      await createTestAgent(project1.id, { status: 'idle' });
      await createTestAgent(project2.id, { status: 'running' });

      const result = await service.getRunningCount(project1.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2);
      }
    });
  });

  describe('getRunningCountAll', () => {
    it('counts running agents across all projects', async () => {
      const service = createService();
      const project1 = await createTestProject({ name: 'All P1' });
      const project2 = await createTestProject({ name: 'All P2' });

      await createTestAgent(project1.id, { status: 'running' });
      await createTestAgent(project2.id, { status: 'running' });
      await createTestAgent(project2.id, { status: 'idle' });

      const result = await service.getRunningCountAll();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2);
      }
    });
  });

  describe('update', () => {
    it('updates agent config fields', async () => {
      const service = createService();
      const project = await createTestProject();
      const agent = await createTestAgent(project.id, {
        config: { maxTurns: 50, allowedTools: ['Read'] },
      });

      const result = await service.update(agent.id, { maxTurns: 100 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.config?.maxTurns).toBe(100);
        // Existing config values should be preserved
        expect(result.value.config?.allowedTools).toEqual(['Read']);
      }
    });

    it('returns AGENT_NOT_FOUND for non-existent agent', async () => {
      const service = createService();

      const result = await service.update('nonexistent-id', { maxTurns: 10 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_FOUND');
      }
    });

    it('prevents updating allowedTools while agent is running', async () => {
      const service = createService();
      const project = await createTestProject();
      const agent = await createTestAgent(project.id, { status: 'running' });

      const result = await service.update(agent.id, {
        allowedTools: ['Read', 'Write'],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_ALREADY_RUNNING');
      }
    });

    it('prevents updating model while agent is running', async () => {
      const service = createService();
      const project = await createTestProject();
      const agent = await createTestAgent(project.id, { status: 'running' });

      const result = await service.update(agent.id, {
        model: 'claude-sonnet-4-6',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_ALREADY_RUNNING');
      }
    });

    it('allows updating non-critical config while agent is running', async () => {
      const service = createService();
      const project = await createTestProject();
      const agent = await createTestAgent(project.id, { status: 'running' });

      const result = await service.update(agent.id, { maxTurns: 75 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.config?.maxTurns).toBe(75);
      }
    });
  });

  describe('delete', () => {
    it('deletes an existing agent', async () => {
      const service = createService();
      const project = await createTestProject();
      const agent = await createTestAgent(project.id);

      const deleteResult = await service.delete(agent.id);
      expect(deleteResult.ok).toBe(true);

      // Verify it's gone
      const getResult = await service.getById(agent.id);
      expect(getResult.ok).toBe(false);
      if (!getResult.ok) {
        expect(getResult.error.code).toBe('AGENT_NOT_FOUND');
      }
    });

    it('returns AGENT_NOT_FOUND for non-existent agent', async () => {
      const service = createService();

      const result = await service.delete('nonexistent-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('AGENT_NOT_FOUND');
      }
    });
  });
});
