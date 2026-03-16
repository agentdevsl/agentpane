/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { AgentErrors } from '@/lib/errors/agent-errors';
import {
  AGENTCORE_ERROR_IDS,
  AgentCoreErrors,
  isAgentCoreError,
} from '@/lib/errors/agentcore-errors';
import { AppErrorClass, createError } from '@/lib/errors/base';
import { ConcurrencyErrors } from '@/lib/errors/concurrency-errors';
import { EventErrors, ScheduleErrors } from '@/lib/errors/event-errors';
import { GitHubErrors } from '@/lib/errors/github-errors';
import { MarketplaceErrors } from '@/lib/errors/marketplace-errors';
import { PlanModeErrors } from '@/lib/errors/plan-mode-errors';
import { ProjectErrors } from '@/lib/errors/project-errors';
import { SandboxConfigErrors } from '@/lib/errors/sandbox-config-errors';
import { SessionErrors } from '@/lib/errors/session-errors';
import { TaskErrors } from '@/lib/errors/task-errors';
import { TemplateErrors } from '@/lib/errors/template-errors';
import { TerraformErrors } from '@/lib/errors/terraform-errors';
import { ValidationErrors } from '@/lib/errors/validation-errors';
import { WorktreeErrors } from '@/lib/errors/worktree-errors';

// =============================================================================
// Base Error Tests
// =============================================================================

describe('Base Error - AppErrorClass', () => {
  it('constructs with code, message, and status', () => {
    const error = new AppErrorClass('TEST_CODE', 'Test message', 400);

    expect(error.code).toBe('TEST_CODE');
    expect(error.message).toBe('Test message');
    expect(error.status).toBe(400);
    expect(error.name).toBe('AppError');
    expect(error.details).toBeUndefined();
  });

  it('constructs with optional details', () => {
    const details = { foo: 'bar', count: 42 };
    const error = new AppErrorClass('CODE', 'msg', 500, details);

    expect(error.details).toEqual(details);
  });

  it('extends Error and is instanceof Error', () => {
    const error = new AppErrorClass('CODE', 'msg', 500);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppErrorClass);
  });

  it('toString returns the message', () => {
    const error = new AppErrorClass('CODE', 'Human readable message', 500);

    expect(error.toString()).toBe('Human readable message');
  });

  it('has a stack trace', () => {
    const error = new AppErrorClass('CODE', 'msg', 500);

    expect(error.stack).toBeDefined();
    expect(typeof error.stack).toBe('string');
  });
});

describe('Base Error - createError factory', () => {
  it('creates an AppError with the given properties', () => {
    const error = createError('MY_CODE', 'My message', 404);

    expect(error.code).toBe('MY_CODE');
    expect(error.message).toBe('My message');
    expect(error.status).toBe(404);
  });

  it('creates an AppError with details', () => {
    const error = createError('MY_CODE', 'msg', 500, { key: 'value' });

    expect(error.details).toEqual({ key: 'value' });
  });

  it('toString returns the message', () => {
    const error = createError('CODE', 'hello', 200);

    expect(error.toString()).toBe('hello');
  });
});

// =============================================================================
// Agent Errors Tests
// =============================================================================

describe('AgentErrors', () => {
  it('NOT_FOUND has code AGENT_NOT_FOUND and status 404', () => {
    expect(AgentErrors.NOT_FOUND.code).toBe('AGENT_NOT_FOUND');
    expect(AgentErrors.NOT_FOUND.status).toBe(404);
    expect(AgentErrors.NOT_FOUND.message).toBe('Agent not found');
  });

  it('ALREADY_RUNNING returns error with taskId details', () => {
    const error = AgentErrors.ALREADY_RUNNING('task-123');

    expect(error.code).toBe('AGENT_ALREADY_RUNNING');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ currentTaskId: 'task-123' });
  });

  it('ALREADY_RUNNING works without taskId', () => {
    const error = AgentErrors.ALREADY_RUNNING();

    expect(error.code).toBe('AGENT_ALREADY_RUNNING');
    expect(error.details).toEqual({ currentTaskId: undefined });
  });

  it('NOT_RUNNING has status 400', () => {
    expect(AgentErrors.NOT_RUNNING.code).toBe('AGENT_NOT_RUNNING');
    expect(AgentErrors.NOT_RUNNING.status).toBe(400);
  });

  it('TURN_LIMIT_EXCEEDED includes turn and maxTurns details', () => {
    const error = AgentErrors.TURN_LIMIT_EXCEEDED(50, 50);

    expect(error.code).toBe('AGENT_TURN_LIMIT_EXCEEDED');
    expect(error.status).toBe(200);
    expect(error.message).toContain('50');
    expect(error.details).toEqual({ turns: 50, maxTurns: 50 });
  });

  it('NO_AVAILABLE_TASK has status 400', () => {
    expect(AgentErrors.NO_AVAILABLE_TASK.code).toBe('AGENT_NO_AVAILABLE_TASK');
    expect(AgentErrors.NO_AVAILABLE_TASK.status).toBe(400);
  });

  it('TOOL_NOT_ALLOWED includes tool and allowedTools details', () => {
    const error = AgentErrors.TOOL_NOT_ALLOWED('Execute', ['Read', 'Edit']);

    expect(error.code).toBe('AGENT_TOOL_NOT_ALLOWED');
    expect(error.status).toBe(403);
    expect(error.message).toContain('Execute');
    expect(error.details).toEqual({ tool: 'Execute', allowedTools: ['Read', 'Edit'] });
  });

  it('EXECUTION_ERROR wraps the error message', () => {
    const error = AgentErrors.EXECUTION_ERROR('timeout occurred');

    expect(error.code).toBe('AGENT_EXECUTION_ERROR');
    expect(error.status).toBe(500);
    expect(error.message).toContain('timeout occurred');
    expect(error.details).toEqual({ error: 'timeout occurred' });
  });
});

// =============================================================================
// Session Errors Tests
// =============================================================================

describe('SessionErrors', () => {
  it('NOT_FOUND has code SESSION_NOT_FOUND and status 404', () => {
    expect(SessionErrors.NOT_FOUND.code).toBe('SESSION_NOT_FOUND');
    expect(SessionErrors.NOT_FOUND.status).toBe(404);
  });

  it('CLOSED has status 400', () => {
    expect(SessionErrors.CLOSED.code).toBe('SESSION_CLOSED');
    expect(SessionErrors.CLOSED.status).toBe(400);
  });

  it('CONNECTION_FAILED includes error detail', () => {
    const error = SessionErrors.CONNECTION_FAILED('network timeout');

    expect(error.code).toBe('SESSION_CONNECTION_FAILED');
    expect(error.status).toBe(502);
    expect(error.details).toEqual({ error: 'network timeout' });
  });

  it('SYNC_FAILED includes error detail', () => {
    const error = SessionErrors.SYNC_FAILED('db failure');

    expect(error.code).toBe('SESSION_SYNC_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ error: 'db failure' });
  });
});

// =============================================================================
// Task Errors Tests
// =============================================================================

describe('TaskErrors', () => {
  it('NOT_FOUND has code TASK_NOT_FOUND and status 404', () => {
    expect(TaskErrors.NOT_FOUND.code).toBe('TASK_NOT_FOUND');
    expect(TaskErrors.NOT_FOUND.status).toBe(404);
  });

  it('NOT_IN_COLUMN includes expected and actual details', () => {
    const error = TaskErrors.NOT_IN_COLUMN('in_progress', 'backlog');

    expect(error.code).toBe('TASK_NOT_IN_COLUMN');
    expect(error.status).toBe(400);
    expect(error.message).toContain('backlog');
    expect(error.message).toContain('in_progress');
    expect(error.details).toEqual({ expected: 'in_progress', actual: 'backlog' });
  });

  it('ALREADY_ASSIGNED includes agentId detail', () => {
    const error = TaskErrors.ALREADY_ASSIGNED('agent-99');

    expect(error.code).toBe('TASK_ALREADY_ASSIGNED');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ agentId: 'agent-99' });
  });

  it('NO_DIFF has status 400', () => {
    expect(TaskErrors.NO_DIFF.code).toBe('TASK_NO_DIFF');
    expect(TaskErrors.NO_DIFF.status).toBe(400);
  });

  it('ALREADY_APPROVED has status 409', () => {
    expect(TaskErrors.ALREADY_APPROVED.code).toBe('TASK_ALREADY_APPROVED');
    expect(TaskErrors.ALREADY_APPROVED.status).toBe(409);
  });

  it('NOT_WAITING_APPROVAL includes currentColumn detail', () => {
    const error = TaskErrors.NOT_WAITING_APPROVAL('backlog');

    expect(error.code).toBe('TASK_NOT_WAITING_APPROVAL');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ currentColumn: 'backlog' });
  });

  it('INVALID_TRANSITION includes from, to, and allowedTransitions', () => {
    const error = TaskErrors.INVALID_TRANSITION('backlog', 'verified');

    expect(error.code).toBe('TASK_INVALID_TRANSITION');
    expect(error.status).toBe(400);
    expect(error.details?.from).toBe('backlog');
    expect(error.details?.to).toBe('verified');
    expect(error.details?.allowedTransitions).toEqual(['in_progress']);
  });

  it('INVALID_TRANSITION from unknown column returns empty allowedTransitions', () => {
    const error = TaskErrors.INVALID_TRANSITION('nonexistent', 'backlog');

    expect(error.details?.allowedTransitions).toEqual([]);
  });

  it('POSITION_CONFLICT has status 409', () => {
    expect(TaskErrors.POSITION_CONFLICT.code).toBe('TASK_POSITION_CONFLICT');
    expect(TaskErrors.POSITION_CONFLICT.status).toBe(409);
  });

  it('AGENT_NOT_RUNNING has status 400', () => {
    expect(TaskErrors.AGENT_NOT_RUNNING.code).toBe('TASK_AGENT_NOT_RUNNING');
    expect(TaskErrors.AGENT_NOT_RUNNING.status).toBe(400);
  });

  it('AGENT_STOP_FAILED has status 500', () => {
    expect(TaskErrors.AGENT_STOP_FAILED.code).toBe('TASK_AGENT_STOP_FAILED');
    expect(TaskErrors.AGENT_STOP_FAILED.status).toBe(500);
  });
});

// =============================================================================
// Terraform Errors Tests
// =============================================================================

describe('TerraformErrors', () => {
  it('REGISTRY_NOT_FOUND has status 404', () => {
    expect(TerraformErrors.REGISTRY_NOT_FOUND.code).toBe('TERRAFORM_REGISTRY_NOT_FOUND');
    expect(TerraformErrors.REGISTRY_NOT_FOUND.status).toBe(404);
  });

  it('MODULE_NOT_FOUND has status 404', () => {
    expect(TerraformErrors.MODULE_NOT_FOUND.code).toBe('TERRAFORM_MODULE_NOT_FOUND');
    expect(TerraformErrors.MODULE_NOT_FOUND.status).toBe(404);
  });

  it('REGISTRY_ALREADY_EXISTS has status 409', () => {
    expect(TerraformErrors.REGISTRY_ALREADY_EXISTS.code).toBe('TERRAFORM_REGISTRY_ALREADY_EXISTS');
    expect(TerraformErrors.REGISTRY_ALREADY_EXISTS.status).toBe(409);
  });

  it('INVALID_TOKEN has status 401', () => {
    expect(TerraformErrors.INVALID_TOKEN.code).toBe('TERRAFORM_INVALID_TOKEN');
    expect(TerraformErrors.INVALID_TOKEN.status).toBe(401);
  });

  it('NO_MODULES_SYNCED has status 404', () => {
    expect(TerraformErrors.NO_MODULES_SYNCED.code).toBe('TERRAFORM_NO_MODULES_SYNCED');
    expect(TerraformErrors.NO_MODULES_SYNCED.status).toBe(404);
  });

  it('SYNC_FAILED includes reason detail', () => {
    const error = TerraformErrors.SYNC_FAILED('API timeout');

    expect(error.code).toBe('TERRAFORM_SYNC_FAILED');
    expect(error.status).toBe(500);
    expect(error.message).toContain('API timeout');
    expect(error.details).toEqual({ reason: 'API timeout' });
  });

  it('REGISTRY_CREATE_FAILED has status 500', () => {
    expect(TerraformErrors.REGISTRY_CREATE_FAILED.code).toBe('TERRAFORM_REGISTRY_CREATE_FAILED');
    expect(TerraformErrors.REGISTRY_CREATE_FAILED.status).toBe(500);
  });

  it('COMPOSE_FAILED includes reason detail', () => {
    const error = TerraformErrors.COMPOSE_FAILED('invalid template');

    expect(error.code).toBe('TERRAFORM_COMPOSE_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ reason: 'invalid template' });
  });
});

// =============================================================================
// Worktree Errors Tests
// =============================================================================

describe('WorktreeErrors', () => {
  it('CREATION_FAILED includes branch and error details', () => {
    const error = WorktreeErrors.CREATION_FAILED('feature/test', 'git error');

    expect(error.code).toBe('WORKTREE_CREATION_FAILED');
    expect(error.status).toBe(500);
    expect(error.message).toContain('feature/test');
    expect(error.details).toEqual({ branch: 'feature/test', error: 'git error' });
  });

  it('NOT_FOUND has status 404', () => {
    expect(WorktreeErrors.NOT_FOUND.code).toBe('WORKTREE_NOT_FOUND');
    expect(WorktreeErrors.NOT_FOUND.status).toBe(404);
  });

  it('BRANCH_EXISTS includes branch detail', () => {
    const error = WorktreeErrors.BRANCH_EXISTS('main');

    expect(error.code).toBe('WORKTREE_BRANCH_EXISTS');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ branch: 'main' });
  });

  it('MERGE_CONFLICT includes conflicting files', () => {
    const files = ['src/index.ts', 'src/app.ts'];
    const error = WorktreeErrors.MERGE_CONFLICT(files);

    expect(error.code).toBe('WORKTREE_MERGE_CONFLICT');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ conflictingFiles: files });
  });

  it('DIRTY includes uncommitted files', () => {
    const files = ['package.json'];
    const error = WorktreeErrors.DIRTY(files);

    expect(error.code).toBe('WORKTREE_DIRTY');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ uncommittedFiles: files });
  });

  it('REMOVAL_FAILED includes path and error details', () => {
    const error = WorktreeErrors.REMOVAL_FAILED('/tmp/wt', 'permission denied');

    expect(error.code).toBe('WORKTREE_REMOVAL_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ path: '/tmp/wt', error: 'permission denied' });
  });

  it('ENV_COPY_FAILED includes error detail', () => {
    const error = WorktreeErrors.ENV_COPY_FAILED('file not found');

    expect(error.code).toBe('WORKTREE_ENV_COPY_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ error: 'file not found' });
  });

  it('INIT_SCRIPT_FAILED includes script and error details', () => {
    const error = WorktreeErrors.INIT_SCRIPT_FAILED('install.sh', 'exit code 1');

    expect(error.code).toBe('WORKTREE_INIT_SCRIPT_FAILED');
    expect(error.status).toBe(500);
    expect(error.message).toContain('install.sh');
    expect(error.details).toEqual({ script: 'install.sh', error: 'exit code 1' });
  });
});

// =============================================================================
// GitHub Errors Tests
// =============================================================================

describe('GitHubErrors', () => {
  it('AUTH_FAILED has status 401', () => {
    const error = GitHubErrors.AUTH_FAILED('bad token');

    expect(error.code).toBe('GITHUB_AUTH_FAILED');
    expect(error.status).toBe(401);
    expect(error.details).toEqual({ error: 'bad token' });
  });

  it('INSTALLATION_NOT_FOUND includes installationId', () => {
    const error = GitHubErrors.INSTALLATION_NOT_FOUND('inst-123');

    expect(error.code).toBe('GITHUB_INSTALLATION_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ installationId: 'inst-123' });
  });

  it('REPO_NOT_FOUND includes owner and repo', () => {
    const error = GitHubErrors.REPO_NOT_FOUND('acme', 'widget');

    expect(error.code).toBe('GITHUB_REPO_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.message).toContain('acme/widget');
    expect(error.details).toEqual({ owner: 'acme', repo: 'widget' });
  });

  it('CONFIG_NOT_FOUND includes path', () => {
    const error = GitHubErrors.CONFIG_NOT_FOUND('.github/config.yml');

    expect(error.code).toBe('GITHUB_CONFIG_NOT_FOUND');
    expect(error.status).toBe(404);
  });

  it('CONFIG_INVALID includes validation errors', () => {
    const errors = ['missing field: name', 'invalid type for id'];
    const error = GitHubErrors.CONFIG_INVALID(errors);

    expect(error.code).toBe('GITHUB_CONFIG_INVALID');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ validationErrors: errors });
  });

  it('WEBHOOK_INVALID has status 401', () => {
    expect(GitHubErrors.WEBHOOK_INVALID.code).toBe('GITHUB_WEBHOOK_INVALID');
    expect(GitHubErrors.WEBHOOK_INVALID.status).toBe(401);
  });

  it('RATE_LIMITED includes ISO timestamp', () => {
    const resetAt = 1700000000;
    const error = GitHubErrors.RATE_LIMITED(resetAt);

    expect(error.code).toBe('GITHUB_RATE_LIMITED');
    expect(error.status).toBe(429);
    expect(error.details?.resetAt).toBe(new Date(resetAt * 1000).toISOString());
  });

  it('PR_CREATION_FAILED includes error detail', () => {
    const error = GitHubErrors.PR_CREATION_FAILED('branch not found');

    expect(error.code).toBe('GITHUB_PR_CREATION_FAILED');
    expect(error.status).toBe(500);
  });
});

// =============================================================================
// Project Errors Tests
// =============================================================================

describe('ProjectErrors', () => {
  it('NOT_FOUND has status 404', () => {
    expect(ProjectErrors.NOT_FOUND.code).toBe('PROJECT_NOT_FOUND');
    expect(ProjectErrors.NOT_FOUND.status).toBe(404);
  });

  it('PATH_EXISTS has status 409', () => {
    expect(ProjectErrors.PATH_EXISTS.code).toBe('PROJECT_PATH_EXISTS');
    expect(ProjectErrors.PATH_EXISTS.status).toBe(409);
  });

  it('PATH_INVALID includes the path', () => {
    const error = ProjectErrors.PATH_INVALID('/bad/path');

    expect(error.code).toBe('PROJECT_PATH_INVALID');
    expect(error.status).toBe(400);
    expect(error.message).toContain('/bad/path');
  });

  it('NOT_A_GIT_REPO includes the path', () => {
    const error = ProjectErrors.NOT_A_GIT_REPO('/tmp/plain');

    expect(error.code).toBe('PROJECT_NOT_A_GIT_REPO');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ path: '/tmp/plain' });
  });

  it('HAS_RUNNING_AGENTS includes count', () => {
    const error = ProjectErrors.HAS_RUNNING_AGENTS(3);

    expect(error.code).toBe('PROJECT_HAS_RUNNING_AGENTS');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ runningAgentCount: 3 });
  });

  it('CONFIG_INVALID includes validation errors', () => {
    const error = ProjectErrors.CONFIG_INVALID(['bad field']);

    expect(error.code).toBe('PROJECT_CONFIG_INVALID');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ validationErrors: ['bad field'] });
  });
});

// =============================================================================
// Validation Errors Tests
// =============================================================================

describe('ValidationErrors', () => {
  it('VALIDATION_ERROR formats issues into path/message pairs', () => {
    const issues = [
      { path: ['name'], message: 'required' },
      { path: ['config', 'maxTurns'], message: 'must be positive' },
    ];
    const error = ValidationErrors.VALIDATION_ERROR(issues);

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.status).toBe(400);
    const errors = error.details?.errors as Array<{ path: string; message: string }>;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual({ path: 'name', message: 'required' });
    expect(errors[1]).toEqual({ path: 'config.maxTurns', message: 'must be positive' });
  });

  it('INVALID_ID includes field detail', () => {
    const error = ValidationErrors.INVALID_ID('projectId');

    expect(error.code).toBe('INVALID_ID');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ field: 'projectId' });
  });

  it('MISSING_REQUIRED_FIELD includes field detail', () => {
    const error = ValidationErrors.MISSING_REQUIRED_FIELD('title');

    expect(error.code).toBe('MISSING_REQUIRED_FIELD');
    expect(error.status).toBe(400);
    expect(error.message).toContain('title');
  });

  it('INVALID_ENUM_VALUE includes field, value, and allowedValues', () => {
    const error = ValidationErrors.INVALID_ENUM_VALUE('status', 'unknown', ['active', 'inactive']);

    expect(error.code).toBe('INVALID_ENUM_VALUE');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({
      field: 'status',
      value: 'unknown',
      allowedValues: ['active', 'inactive'],
    });
  });

  it('INVALID_URL includes the url', () => {
    const error = ValidationErrors.INVALID_URL('not-a-url');

    expect(error.code).toBe('INVALID_URL');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ url: 'not-a-url' });
  });
});

// =============================================================================
// Concurrency Errors Tests
// =============================================================================

describe('ConcurrencyErrors', () => {
  it('LIMIT_EXCEEDED includes current and max agents', () => {
    const error = ConcurrencyErrors.LIMIT_EXCEEDED(5, 5);

    expect(error.code).toBe('CONCURRENCY_LIMIT_EXCEEDED');
    expect(error.status).toBe(429);
    expect(error.details).toEqual({ currentAgents: 5, maxAgents: 5 });
  });

  it('QUEUE_FULL includes queueSize and maxSize', () => {
    const error = ConcurrencyErrors.QUEUE_FULL(100, 100);

    expect(error.code).toBe('QUEUE_FULL');
    expect(error.status).toBe(429);
    expect(error.details).toEqual({ queueSize: 100, maxSize: 100 });
  });

  it('RESOURCE_LOCKED includes resource and lockedBy', () => {
    const error = ConcurrencyErrors.RESOURCE_LOCKED('worktree:abc', 'agent-1');

    expect(error.code).toBe('RESOURCE_LOCKED');
    expect(error.status).toBe(423);
    expect(error.details).toEqual({ resource: 'worktree:abc', lockedBy: 'agent-1' });
  });
});

// =============================================================================
// Event Errors Tests
// =============================================================================

describe('EventErrors', () => {
  it('SOURCE_NOT_FOUND with id includes id detail', () => {
    const error = EventErrors.SOURCE_NOT_FOUND('src-1');

    expect(error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.message).toContain('src-1');
    expect(error.details).toEqual({ id: 'src-1' });
  });

  it('SOURCE_NOT_FOUND without id omits id detail', () => {
    const error = EventErrors.SOURCE_NOT_FOUND();

    expect(error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    expect(error.details).toBeUndefined();
  });

  it('SOURCE_DISABLED with id includes id detail', () => {
    const error = EventErrors.SOURCE_DISABLED('src-2');

    expect(error.code).toBe('EVENT_SOURCE_DISABLED');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ id: 'src-2' });
  });

  it('SLUG_CONFLICT includes slug detail', () => {
    const error = EventErrors.SLUG_CONFLICT('my-webhook');

    expect(error.code).toBe('EVENT_SLUG_CONFLICT');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ slug: 'my-webhook' });
  });

  it('TEAM_NOT_FOUND returns 404', () => {
    const error = EventErrors.TEAM_NOT_FOUND();
    expect(error.code).toBe('EVENT_TEAM_NOT_FOUND');
    expect(error.status).toBe(404);
  });

  it('SUBSCRIPTION_NOT_FOUND with id includes id detail', () => {
    const error = EventErrors.SUBSCRIPTION_NOT_FOUND('sub-1');

    expect(error.code).toBe('EVENT_SUBSCRIPTION_NOT_FOUND');
    expect(error.details).toEqual({ id: 'sub-1' });
  });

  it('SIGNATURE_INVALID returns 401', () => {
    const error = EventErrors.SIGNATURE_INVALID();
    expect(error.code).toBe('EVENT_SIGNATURE_INVALID');
    expect(error.status).toBe(401);
  });

  it('PARSE_FAILED includes reason detail', () => {
    const error = EventErrors.PARSE_FAILED('malformed JSON');

    expect(error.code).toBe('EVENT_PARSE_FAILED');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ reason: 'malformed JSON' });
  });

  it('PLUGIN_NOT_FOUND includes type detail', () => {
    const error = EventErrors.PLUGIN_NOT_FOUND('slack');

    expect(error.code).toBe('EVENT_PLUGIN_NOT_FOUND');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ type: 'slack' });
  });

  it('PROCESSING_FAILED includes reason detail', () => {
    const error = EventErrors.PROCESSING_FAILED('db error');

    expect(error.code).toBe('EVENT_PROCESSING_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ reason: 'db error' });
  });

  it('SECRET_DECRYPT_FAILED returns 500', () => {
    const error = EventErrors.SECRET_DECRYPT_FAILED();
    expect(error.code).toBe('EVENT_SECRET_DECRYPT_FAILED');
    expect(error.status).toBe(500);
  });
});

// =============================================================================
// Schedule Errors Tests
// =============================================================================

describe('ScheduleErrors', () => {
  it('INVALID_CRON includes expression detail', () => {
    const error = ScheduleErrors.INVALID_CRON('bad cron');

    expect(error.code).toBe('SCHEDULE_INVALID_CRON');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ expression: 'bad cron' });
  });

  it('INVALID_INTERVAL includes interval detail', () => {
    const error = ScheduleErrors.INVALID_INTERVAL(30);

    expect(error.code).toBe('SCHEDULE_INVALID_INTERVAL');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ interval: 30 });
  });

  it('BUDGET_EXCEEDED includes sourceId and window', () => {
    const error = ScheduleErrors.BUDGET_EXCEEDED('src-1', 'hour');

    expect(error.code).toBe('SCHEDULE_BUDGET_EXCEEDED');
    expect(error.status).toBe(429);
    expect(error.details).toEqual({ sourceId: 'src-1', window: 'hour' });
  });

  it('SOURCE_PAUSED has status 422', () => {
    const error = ScheduleErrors.SOURCE_PAUSED('src-1');

    expect(error.code).toBe('SCHEDULE_SOURCE_PAUSED');
    expect(error.status).toBe(422);
  });
});

// =============================================================================
// Template Errors Tests
// =============================================================================

describe('TemplateErrors', () => {
  it('NOT_FOUND has status 404', () => {
    expect(TemplateErrors.NOT_FOUND.code).toBe('TEMPLATE_NOT_FOUND');
    expect(TemplateErrors.NOT_FOUND.status).toBe(404);
  });

  it('ALREADY_EXISTS has status 409', () => {
    expect(TemplateErrors.ALREADY_EXISTS.code).toBe('TEMPLATE_ALREADY_EXISTS');
    expect(TemplateErrors.ALREADY_EXISTS.status).toBe(409);
  });

  it('INVALID_REPO_URL includes url detail', () => {
    const error = TemplateErrors.INVALID_REPO_URL('not-a-url');

    expect(error.code).toBe('TEMPLATE_INVALID_REPO_URL');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ url: 'not-a-url' });
  });

  it('SYNC_FAILED includes reason detail', () => {
    const error = TemplateErrors.SYNC_FAILED('network error');

    expect(error.code).toBe('TEMPLATE_SYNC_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ reason: 'network error' });
  });

  it('FETCH_FAILED includes path and reason', () => {
    const error = TemplateErrors.FETCH_FAILED('README.md', '404');

    expect(error.code).toBe('TEMPLATE_FETCH_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ path: 'README.md', reason: '404' });
  });

  it('PARSE_FAILED includes path and reason', () => {
    const error = TemplateErrors.PARSE_FAILED('config.yml', 'syntax');

    expect(error.code).toBe('TEMPLATE_PARSE_FAILED');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ path: 'config.yml', reason: 'syntax' });
  });

  it('PROJECT_REQUIRED has status 400', () => {
    expect(TemplateErrors.PROJECT_REQUIRED.code).toBe('TEMPLATE_PROJECT_REQUIRED');
    expect(TemplateErrors.PROJECT_REQUIRED.status).toBe(400);
  });

  it('INVALID_SCOPE includes scope detail', () => {
    const error = TemplateErrors.INVALID_SCOPE('xyz');

    expect(error.code).toBe('TEMPLATE_INVALID_SCOPE');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ scope: 'xyz' });
  });
});

// =============================================================================
// PlanMode Errors Tests
// =============================================================================

describe('PlanModeErrors', () => {
  it('SESSION_NOT_FOUND has status 404', () => {
    expect(PlanModeErrors.SESSION_NOT_FOUND.code).toBe('PLAN_SESSION_NOT_FOUND');
    expect(PlanModeErrors.SESSION_NOT_FOUND.status).toBe(404);
  });

  it('SESSION_ALREADY_ACTIVE includes sessionId', () => {
    const error = PlanModeErrors.SESSION_ALREADY_ACTIVE('sess-1');

    expect(error.code).toBe('PLAN_SESSION_ALREADY_ACTIVE');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ sessionId: 'sess-1' });
  });

  it('CREDENTIALS_NOT_FOUND has status 401', () => {
    expect(PlanModeErrors.CREDENTIALS_NOT_FOUND.code).toBe('PLAN_CREDENTIALS_NOT_FOUND');
    expect(PlanModeErrors.CREDENTIALS_NOT_FOUND.status).toBe(401);
  });

  it('API_ERROR uses provided status or defaults to 500', () => {
    const errorWith = PlanModeErrors.API_ERROR('bad request', 400);
    expect(errorWith.status).toBe(400);

    const errorWithout = PlanModeErrors.API_ERROR('server error');
    expect(errorWithout.status).toBe(500);
  });

  it('MAX_TURNS_EXCEEDED includes maxTurns detail', () => {
    const error = PlanModeErrors.MAX_TURNS_EXCEEDED(100);

    expect(error.code).toBe('PLAN_MAX_TURNS_EXCEEDED');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ maxTurns: 100 });
  });

  it('DATABASE_ERROR includes operation detail', () => {
    const error = PlanModeErrors.DATABASE_ERROR('insert', 'constraint violation');

    expect(error.code).toBe('PLAN_DATABASE_ERROR');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ operation: 'insert' });
  });
});

// =============================================================================
// Marketplace Errors Tests
// =============================================================================

describe('MarketplaceErrors', () => {
  it('NOT_FOUND has status 404', () => {
    expect(MarketplaceErrors.NOT_FOUND.code).toBe('MARKETPLACE_NOT_FOUND');
    expect(MarketplaceErrors.NOT_FOUND.status).toBe(404);
  });

  it('ALREADY_EXISTS has status 409', () => {
    expect(MarketplaceErrors.ALREADY_EXISTS.code).toBe('MARKETPLACE_ALREADY_EXISTS');
    expect(MarketplaceErrors.ALREADY_EXISTS.status).toBe(409);
  });

  it('CANNOT_DELETE_DEFAULT has status 403', () => {
    expect(MarketplaceErrors.CANNOT_DELETE_DEFAULT.code).toBe('MARKETPLACE_CANNOT_DELETE_DEFAULT');
    expect(MarketplaceErrors.CANNOT_DELETE_DEFAULT.status).toBe(403);
  });

  it('CANNOT_DISABLE_DEFAULT has status 403', () => {
    expect(MarketplaceErrors.CANNOT_DISABLE_DEFAULT.code).toBe(
      'MARKETPLACE_CANNOT_DISABLE_DEFAULT'
    );
    expect(MarketplaceErrors.CANNOT_DISABLE_DEFAULT.status).toBe(403);
  });

  it('INVALID_URL includes url detail', () => {
    const error = MarketplaceErrors.INVALID_URL('bad://url');

    expect(error.code).toBe('MARKETPLACE_INVALID_URL');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ url: 'bad://url' });
  });

  it('SYNC_FAILED includes reason detail', () => {
    const error = MarketplaceErrors.SYNC_FAILED('timeout');

    expect(error.code).toBe('MARKETPLACE_SYNC_FAILED');
    expect(error.status).toBe(500);
    expect(error.details).toEqual({ reason: 'timeout' });
  });
});

// =============================================================================
// SandboxConfig Errors Tests
// =============================================================================

describe('SandboxConfigErrors', () => {
  it('NOT_FOUND has status 404', () => {
    expect(SandboxConfigErrors.NOT_FOUND.code).toBe('SANDBOX_CONFIG_NOT_FOUND');
    expect(SandboxConfigErrors.NOT_FOUND.status).toBe(404);
  });

  it('ALREADY_EXISTS has status 409', () => {
    expect(SandboxConfigErrors.ALREADY_EXISTS.code).toBe('SANDBOX_CONFIG_ALREADY_EXISTS');
    expect(SandboxConfigErrors.ALREADY_EXISTS.status).toBe(409);
  });

  it('IN_USE includes projectCount detail', () => {
    const error = SandboxConfigErrors.IN_USE(5);

    expect(error.code).toBe('SANDBOX_CONFIG_IN_USE');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ projectCount: 5 });
  });

  it('INVALID_MEMORY includes value, min, max', () => {
    const error = SandboxConfigErrors.INVALID_MEMORY(100);

    expect(error.code).toBe('SANDBOX_CONFIG_INVALID_MEMORY');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ value: 100, min: 512, max: 32768 });
  });

  it('INVALID_CPU includes value, min, max', () => {
    const error = SandboxConfigErrors.INVALID_CPU(0.1);

    expect(error.code).toBe('SANDBOX_CONFIG_INVALID_CPU');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ value: 0.1, min: 0.5, max: 16 });
  });

  it('INVALID_PROCESSES includes value, min, max', () => {
    const error = SandboxConfigErrors.INVALID_PROCESSES(10);

    expect(error.code).toBe('SANDBOX_CONFIG_INVALID_PROCESSES');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ value: 10, min: 32, max: 4096 });
  });

  it('INVALID_TIMEOUT includes value, min, max', () => {
    const error = SandboxConfigErrors.INVALID_TIMEOUT(0);

    expect(error.code).toBe('SANDBOX_CONFIG_INVALID_TIMEOUT');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ value: 0, min: 1, max: 1440 });
  });

  it('DEFAULT_EXISTS has status 409', () => {
    expect(SandboxConfigErrors.DEFAULT_EXISTS.code).toBe('SANDBOX_CONFIG_DEFAULT_EXISTS');
    expect(SandboxConfigErrors.DEFAULT_EXISTS.status).toBe(409);
  });
});

// =============================================================================
// AgentCore Errors Tests
// =============================================================================

describe('AgentCoreErrors', () => {
  it('AWS_CREDENTIALS_INVALID returns 401 with AGENTCORE error id', () => {
    const error = AgentCoreErrors.AWS_CREDENTIALS_INVALID('bad key');

    expect(error.code).toBe(AGENTCORE_ERROR_IDS.AWS_CREDENTIALS_INVALID);
    expect(error.status).toBe(401);
    expect(error.message).toContain('bad key');
    expect(error.details?.errorName).toBe('AGENTCORE_AWS_CREDENTIALS_INVALID');
  });

  it('AWS_CREDENTIALS_EXPIRED returns 401', () => {
    const error = AgentCoreErrors.AWS_CREDENTIALS_EXPIRED();

    expect(error.code).toBe(AGENTCORE_ERROR_IDS.AWS_CREDENTIALS_EXPIRED);
    expect(error.status).toBe(401);
  });

  it('STREAMING_ERROR returns 502', () => {
    const error = AgentCoreErrors.STREAMING_ERROR('disconnected');

    expect(error.code).toBe(AGENTCORE_ERROR_IDS.STREAMING_ERROR);
    expect(error.status).toBe(502);
  });

  it('SESSION_CREATE_FAILED returns 502', () => {
    const error = AgentCoreErrors.SESSION_CREATE_FAILED('timeout');

    expect(error.code).toBe(AGENTCORE_ERROR_IDS.SESSION_CREATE_FAILED);
    expect(error.status).toBe(502);
  });

  it('API_ERROR uses the provided statusCode', () => {
    const error = AgentCoreErrors.API_ERROR(503, 'service unavailable');

    expect(error.status).toBe(503);
    expect(error.code).toBe(AGENTCORE_ERROR_IDS.API_ERROR);
  });

  it('isAgentCoreError returns true for AgentCore errors', () => {
    const error = AgentCoreErrors.INTERNAL_ERROR('test');

    expect(isAgentCoreError(error)).toBe(true);
  });

  it('isAgentCoreError returns false for non-AppErrorClass errors', () => {
    expect(isAgentCoreError(new Error('test'))).toBe(false);
    expect(isAgentCoreError(null)).toBe(false);
    expect(isAgentCoreError('string')).toBe(false);
  });

  it('isAgentCoreError returns false for non-AGENTCORE codes', () => {
    const error = new AppErrorClass('OTHER_CODE', 'msg', 500);

    expect(isAgentCoreError(error)).toBe(false);
  });
});
