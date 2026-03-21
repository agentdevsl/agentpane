import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/db/schema';
import { ProjectErrors } from '../../src/lib/errors/project-errors.js';
import { TaskErrors } from '../../src/lib/errors/task-errors.js';
import { err, ok } from '../../src/lib/utils/result.js';

const taskServiceMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  moveColumn: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));

vi.mock('../../src/services/worktree.service.js', () => ({
  WorktreeService: class {},
}));
vi.mock('../../src/services/task.service.js', () => ({
  TaskService: class {
    list = taskServiceMocks.list;
    create = taskServiceMocks.create;
    getById = taskServiceMocks.getById;
    update = taskServiceMocks.update;
    delete = taskServiceMocks.delete;
    moveColumn = taskServiceMocks.moveColumn;
    approve = taskServiceMocks.approve;
    reject = taskServiceMocks.reject;
  },
}));
vi.mock('../../src/db/client.js', () => ({ pglite: {}, sqlite: {}, db: {} }));

import { createTasksRoutes } from '../../src/server/routes/tasks.js';

const sampleTask: Task = {
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
  updatedAt: '2026-01-02T00:00:00Z',
  startedAt: null,
  completedAt: null,
  lastAgentStatus: null,
};

const jsonRequest = (body: unknown, init?: RequestInit) => ({
  ...init,
  method: init?.method ?? 'POST',
  headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  body: JSON.stringify(body),
});

const parseJson = async <T>(response: Response): Promise<T> => {
  return (await response.json()) as T;
};

describe('Task API', () => {
  let tasksRoute: ReturnType<typeof createTasksRoutes>;

  beforeEach(() => {
    vi.clearAllMocks();
    tasksRoute = createTasksRoutes({
      taskService: taskServiceMocks as never,
    });
  });

  it('lists tasks with counts', async () => {
    taskServiceMocks.list.mockResolvedValue(ok([sampleTask]));

    const response = await tasksRoute.request(
      'http://localhost/?codespaceId=az2h33gpcldsq0a0wdimza6m'
    );

    expect(response?.status).toBe(200);
    const data = await parseJson<{
      ok: true;
      data: { items: Task[]; totalCount: number };
    }>(response as Response);

    expect(data.ok).toBe(true);
    expect(data.data.items).toHaveLength(1);
    expect(data.data.totalCount).toBe(1);
  });

  it('validates list query', async () => {
    // Use an ID with special characters that isValidId rejects
    const response = await tasksRoute.request('http://localhost/?codespaceId=invalid$id');

    expect(response?.status).toBe(400);
    const data = await parseJson<{ ok: false; error: { code: string } }>(response as Response);
    expect(data.error.code).toBe('INVALID_ID');
  });

  it('creates task in backlog', async () => {
    taskServiceMocks.create.mockResolvedValue(ok(sampleTask));

    const response = await tasksRoute.request(
      '/',
      jsonRequest({
        codespaceId: 'az2h33gpcldsq0a0wdimza6m',
        title: 'Test Task',
      })
    );

    expect(response?.status).toBe(201);
    const data = await parseJson<{ ok: true; data: Task }>(response as Response);
    expect(data.data.column).toBe('backlog');
  });

  it('returns not found when project missing', async () => {
    taskServiceMocks.create.mockResolvedValue(err(ProjectErrors.NOT_FOUND));

    const response = await tasksRoute.request(
      '/',
      jsonRequest({
        codespaceId: 'az2h33gpcldsq0a0wdimza6m',
        title: 'Test Task',
      })
    );

    expect(response?.status).toBe(404);
    const data = await parseJson<{ ok: false; error: { code: string } }>(response as Response);
    expect(data.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('gets a task by id', async () => {
    taskServiceMocks.getById.mockResolvedValue(ok(sampleTask));

    const response = await tasksRoute.request(`http://localhost/${sampleTask.id}`);

    expect(response?.status).toBe(200);
    const data = await parseJson<{ ok: true; data: Task }>(response as Response);
    expect(data.data.id).toBe(sampleTask.id);
  });

  it('updates a task', async () => {
    taskServiceMocks.update.mockResolvedValue(ok({ ...sampleTask, title: 'Updated' }));

    const response = await tasksRoute.request(
      `/${sampleTask.id}`,
      jsonRequest({ title: 'Updated' }, { method: 'PUT' })
    );

    expect(response?.status).toBe(200);
    const data = await parseJson<{ ok: true; data: Task }>(response as Response);
    expect(data.data.title).toBe('Updated');
  });

  it('deletes a task', async () => {
    taskServiceMocks.delete.mockResolvedValue(ok(undefined));

    const response = await tasksRoute.request(`/${sampleTask.id}`, { method: 'DELETE' });

    expect(response?.status).toBe(200);
    const data = await parseJson<{ ok: true; data: null }>(response as Response);
    expect(data.data).toBeNull();
  });

  it('moves a task between columns', async () => {
    taskServiceMocks.moveColumn.mockResolvedValue(
      ok({ task: { ...sampleTask, column: 'in_progress' } })
    );

    const response = await tasksRoute.request(
      `/${sampleTask.id}/move`,
      jsonRequest({ column: 'in_progress' }, { method: 'PATCH' })
    );

    expect(response?.status).toBe(200);
    const data = await parseJson<{ ok: true; data: { task: Task } }>(response as Response);
    expect(data.data.task.column).toBe('in_progress');
  });

  it('rejects invalid task transition', async () => {
    taskServiceMocks.moveColumn.mockResolvedValue(
      err(TaskErrors.INVALID_TRANSITION('backlog', 'verified'))
    );

    const response = await tasksRoute.request(
      `/${sampleTask.id}/move`,
      jsonRequest({ column: 'verified' }, { method: 'PATCH' })
    );

    expect(response?.status).toBe(400);
    const data = await parseJson<{ ok: false; error: { code: string } }>(response as Response);
    expect(data.error.code).toBe('TASK_INVALID_TRANSITION');
  });

  it('moves a task to verified', async () => {
    taskServiceMocks.moveColumn.mockResolvedValue(
      ok({ task: { ...sampleTask, column: 'verified' } })
    );

    const response = await tasksRoute.request(
      `/${sampleTask.id}/move`,
      jsonRequest({ column: 'verified' }, { method: 'PATCH' })
    );

    expect(response?.status).toBe(200);
    const data = await parseJson<{ ok: true; data: { task: Task } }>(response as Response);
    expect(data.data.task.column).toBe('verified');
  });

  it('moves a task back to in_progress', async () => {
    taskServiceMocks.moveColumn.mockResolvedValue(
      ok({ task: { ...sampleTask, column: 'in_progress' } })
    );

    const response = await tasksRoute.request(
      `/${sampleTask.id}/move`,
      jsonRequest({ column: 'in_progress' }, { method: 'PATCH' })
    );

    expect(response?.status).toBe(200);
    const data = await parseJson<{ ok: true; data: { task: Task } }>(response as Response);
    expect(data.data.task.column).toBe('in_progress');
  });

  it('validates move body', async () => {
    const response = await tasksRoute.request(
      `/${sampleTask.id}/move`,
      jsonRequest({}, { method: 'PATCH' })
    );

    expect(response?.status).toBe(400);
    const data = await parseJson<{ ok: false; error: { code: string } }>(response as Response);
    expect(data.error.code).toBe('VALIDATION_ERROR');
  });
});
