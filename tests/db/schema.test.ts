/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUS,
  AGENT_TYPES,
  API_TOKEN_STATUS,
  EVENT_SOURCE_TYPES,
  INVITATION_STATUS,
  isValidRbacRole,
  RBAC_ROLE_LEVEL,
  RBAC_ROLES,
  resolveHighestRole,
  SANDBOX_TYPES,
  SESSION_STATUS,
  TASK_COLUMNS,
  TASK_PRIORITIES,
  WORKTREE_STATUS,
} from '@/db/schema/sqlite';
import { agents } from '@/db/schema/sqlite/agents';
import { codespaces } from '@/db/schema/sqlite/codespaces';
import { sandboxInstances, sandboxTmuxSessions } from '@/db/schema/sqlite/sandboxes';
import { sessionEvents } from '@/db/schema/sqlite/session-events';
import { sessions } from '@/db/schema/sqlite/sessions';
import { settings } from '@/db/schema/sqlite/settings';
import { tasks } from '@/db/schema/sqlite/tasks';
import { workflows } from '@/db/schema/sqlite/workflows';
import { worktrees } from '@/db/schema/sqlite/worktrees';

// =============================================================================
// Projects Table Schema
// =============================================================================

describe('Codespaces Schema', () => {
  it('has an id primary key column', () => {
    expect(codespaces.id).toBeDefined();
    expect(codespaces.id.name).toBe('id');
  });

  it('has a name column that is not null', () => {
    expect(codespaces.name).toBeDefined();
    expect(codespaces.name.name).toBe('name');
    expect(codespaces.name.notNull).toBe(true);
  });

  it('has a unique path column', () => {
    expect(codespaces.path).toBeDefined();
    expect(codespaces.path.name).toBe('path');
    expect(codespaces.path.notNull).toBe(true);
    expect(codespaces.path.isUnique).toBe(true);
  });

  it('has optional description column', () => {
    expect(codespaces.description).toBeDefined();
    expect(codespaces.description.notNull).toBe(false);
  });

  it('has config JSON column', () => {
    expect(codespaces.config).toBeDefined();
    expect(codespaces.config.name).toBe('config');
  });

  it('has maxConcurrentAgents with default 3', () => {
    expect(codespaces.maxConcurrentAgents).toBeDefined();
    expect(codespaces.maxConcurrentAgents.name).toBe('max_concurrent_agents');
  });

  it('has createdAt and updatedAt timestamp columns', () => {
    expect(codespaces.createdAt).toBeDefined();
    expect(codespaces.createdAt.notNull).toBe(true);
    expect(codespaces.updatedAt).toBeDefined();
    expect(codespaces.updatedAt.notNull).toBe(true);
  });

  it('has github-related columns', () => {
    expect(codespaces.githubOwner).toBeDefined();
    expect(codespaces.githubRepo).toBeDefined();
    expect(codespaces.githubInstallationId).toBeDefined();
  });

  it('has sandboxConfigId column', () => {
    expect(codespaces.sandboxConfigId).toBeDefined();
  });
});

// =============================================================================
// Tasks Table Schema
// =============================================================================

describe('Tasks Schema', () => {
  it('has an id primary key column', () => {
    expect(tasks.id).toBeDefined();
    expect(tasks.id.name).toBe('id');
  });

  it('has codespaceId foreign key (not null)', () => {
    expect(tasks.codespaceId).toBeDefined();
    expect(tasks.codespaceId.name).toBe('codespace_id');
    expect(tasks.codespaceId.notNull).toBe(true);
  });

  it('has title column (not null)', () => {
    expect(tasks.title).toBeDefined();
    expect(tasks.title.name).toBe('title');
    expect(tasks.title.notNull).toBe(true);
  });

  it('has column with default backlog', () => {
    expect(tasks.column).toBeDefined();
    expect(tasks.column.name).toBe('column');
    expect(tasks.column.notNull).toBe(true);
  });

  it('has position with default 0', () => {
    expect(tasks.position).toBeDefined();
    expect(tasks.position.name).toBe('position');
    expect(tasks.position.notNull).toBe(true);
  });

  it('has nullable agentId, sessionId, worktreeId columns', () => {
    expect(tasks.agentId).toBeDefined();
    expect(tasks.agentId.notNull).toBe(false);
    expect(tasks.sessionId).toBeDefined();
    expect(tasks.sessionId.notNull).toBe(false);
    expect(tasks.worktreeId).toBeDefined();
    expect(tasks.worktreeId.notNull).toBe(false);
  });

  it('has labels JSON column', () => {
    expect(tasks.labels).toBeDefined();
    expect(tasks.labels.name).toBe('labels');
  });

  it('has priority column', () => {
    expect(tasks.priority).toBeDefined();
    expect(tasks.priority.name).toBe('priority');
  });

  it('has plan-related columns', () => {
    expect(tasks.plan).toBeDefined();
    expect(tasks.planOptions).toBeDefined();
  });

  it('has modelOverride column', () => {
    expect(tasks.modelOverride).toBeDefined();
    expect(tasks.modelOverride.name).toBe('model_override');
  });

  it('has approval-related columns', () => {
    expect(tasks.approvedAt).toBeDefined();
    expect(tasks.approvedBy).toBeDefined();
    expect(tasks.rejectionCount).toBeDefined();
    expect(tasks.rejectionReason).toBeDefined();
  });

  it('has diffSummary JSON column', () => {
    expect(tasks.diffSummary).toBeDefined();
    expect(tasks.diffSummary.name).toBe('diff_summary');
  });

  it('has lastAgentStatus column', () => {
    expect(tasks.lastAgentStatus).toBeDefined();
    expect(tasks.lastAgentStatus.name).toBe('last_agent_status');
  });
});

// =============================================================================
// Agents Table Schema
// =============================================================================

describe('Agents Schema', () => {
  it('has an id primary key column', () => {
    expect(agents.id).toBeDefined();
    expect(agents.id.name).toBe('id');
  });

  it('has codespaceId foreign key (not null)', () => {
    expect(agents.codespaceId).toBeDefined();
    expect(agents.codespaceId.notNull).toBe(true);
  });

  it('has name column (not null)', () => {
    expect(agents.name).toBeDefined();
    expect(agents.name.notNull).toBe(true);
  });

  it('has type column with default task', () => {
    expect(agents.type).toBeDefined();
    expect(agents.type.notNull).toBe(true);
  });

  it('has status column with default idle', () => {
    expect(agents.status).toBeDefined();
    expect(agents.status.notNull).toBe(true);
  });

  it('has config JSON column', () => {
    expect(agents.config).toBeDefined();
  });

  it('has current task/session tracking columns', () => {
    expect(agents.currentTaskId).toBeDefined();
    expect(agents.currentSessionId).toBeDefined();
    expect(agents.currentTurn).toBeDefined();
  });

  it('has parentAgentId for team mode', () => {
    expect(agents.parentAgentId).toBeDefined();
  });
});

// =============================================================================
// Sessions Table Schema
// =============================================================================

describe('Sessions Schema', () => {
  it('has an id primary key column', () => {
    expect(sessions.id).toBeDefined();
    expect(sessions.id.name).toBe('id');
  });

  it('has codespaceId foreign key (not null)', () => {
    expect(sessions.codespaceId).toBeDefined();
    expect(sessions.codespaceId.notNull).toBe(true);
  });

  it('has url column (not null)', () => {
    expect(sessions.url).toBeDefined();
    expect(sessions.url.notNull).toBe(true);
  });

  it('has status column with default idle', () => {
    expect(sessions.status).toBeDefined();
    expect(sessions.status.notNull).toBe(true);
  });

  it('has nullable taskId and agentId', () => {
    expect(sessions.taskId).toBeDefined();
    expect(sessions.agentId).toBeDefined();
  });

  it('has sandbox-related columns', () => {
    expect(sessions.sandboxProvider).toBeDefined();
    expect(sessions.sandboxContainerId).toBeDefined();
  });

  it('has closedAt timestamp', () => {
    expect(sessions.closedAt).toBeDefined();
  });
});

// =============================================================================
// Worktrees Table Schema
// =============================================================================

describe('Worktrees Schema', () => {
  it('has an id primary key column', () => {
    expect(worktrees.id).toBeDefined();
    expect(worktrees.id.name).toBe('id');
  });

  it('has codespaceId foreign key (not null)', () => {
    expect(worktrees.codespaceId).toBeDefined();
    expect(worktrees.codespaceId.notNull).toBe(true);
  });

  it('has branch column (not null)', () => {
    expect(worktrees.branch).toBeDefined();
    expect(worktrees.branch.notNull).toBe(true);
  });

  it('has path column (not null)', () => {
    expect(worktrees.path).toBeDefined();
    expect(worktrees.path.notNull).toBe(true);
  });

  it('has baseBranch with default main', () => {
    expect(worktrees.baseBranch).toBeDefined();
    expect(worktrees.baseBranch.notNull).toBe(true);
  });

  it('has status column with default creating', () => {
    expect(worktrees.status).toBeDefined();
    expect(worktrees.status.notNull).toBe(true);
  });

  it('has nullable agentId and taskId', () => {
    expect(worktrees.agentId).toBeDefined();
    expect(worktrees.taskId).toBeDefined();
  });
});

// =============================================================================
// Settings Table Schema
// =============================================================================

describe('Settings Schema', () => {
  it('has key as primary key', () => {
    expect(settings.key).toBeDefined();
    expect(settings.key.name).toBe('key');
  });

  it('has value column (not null)', () => {
    expect(settings.value).toBeDefined();
    expect(settings.value.notNull).toBe(true);
  });

  it('has updatedAt timestamp', () => {
    expect(settings.updatedAt).toBeDefined();
    expect(settings.updatedAt.notNull).toBe(true);
  });
});

// =============================================================================
// Session Events Table Schema
// =============================================================================

describe('SessionEvents Schema', () => {
  it('has an id primary key', () => {
    expect(sessionEvents.id).toBeDefined();
    expect(sessionEvents.id.name).toBe('id');
  });

  it('has sessionId foreign key (not null)', () => {
    expect(sessionEvents.sessionId).toBeDefined();
    expect(sessionEvents.sessionId.notNull).toBe(true);
  });

  it('has offset column (not null)', () => {
    expect(sessionEvents.offset).toBeDefined();
    expect(sessionEvents.offset.notNull).toBe(true);
  });

  it('has type column (not null)', () => {
    expect(sessionEvents.type).toBeDefined();
    expect(sessionEvents.type.notNull).toBe(true);
  });

  it('has channel column (not null)', () => {
    expect(sessionEvents.channel).toBeDefined();
    expect(sessionEvents.channel.notNull).toBe(true);
  });

  it('has data JSON column (not null)', () => {
    expect(sessionEvents.data).toBeDefined();
    expect(sessionEvents.data.notNull).toBe(true);
  });

  it('has timestamp column (not null)', () => {
    expect(sessionEvents.timestamp).toBeDefined();
    expect(sessionEvents.timestamp.notNull).toBe(true);
  });
});

// =============================================================================
// Sandbox Instances Table Schema
// =============================================================================

describe('SandboxInstances Schema', () => {
  it('has an id primary key', () => {
    expect(sandboxInstances.id).toBeDefined();
  });

  it('has unique codespaceId foreign key', () => {
    expect(sandboxInstances.codespaceId).toBeDefined();
    expect(sandboxInstances.codespaceId.notNull).toBe(true);
  });

  it('has containerId (not null)', () => {
    expect(sandboxInstances.containerId).toBeDefined();
    expect(sandboxInstances.containerId.notNull).toBe(true);
  });

  it('has required numeric fields', () => {
    expect(sandboxInstances.memoryMb).toBeDefined();
    expect(sandboxInstances.memoryMb.notNull).toBe(true);
    expect(sandboxInstances.cpuCores).toBeDefined();
    expect(sandboxInstances.cpuCores.notNull).toBe(true);
    expect(sandboxInstances.idleTimeoutMinutes).toBeDefined();
    expect(sandboxInstances.idleTimeoutMinutes.notNull).toBe(true);
  });

  it('has status and image columns', () => {
    expect(sandboxInstances.status).toBeDefined();
    expect(sandboxInstances.image).toBeDefined();
    expect(sandboxInstances.image.notNull).toBe(true);
  });
});

// =============================================================================
// Sandbox Tmux Sessions Schema
// =============================================================================

describe('SandboxTmuxSessions Schema', () => {
  it('has an id primary key', () => {
    expect(sandboxTmuxSessions.id).toBeDefined();
  });

  it('has sandboxId and sessionName columns', () => {
    expect(sandboxTmuxSessions.sandboxId).toBeDefined();
    expect(sandboxTmuxSessions.sandboxId.notNull).toBe(true);
    expect(sandboxTmuxSessions.sessionName).toBeDefined();
    expect(sandboxTmuxSessions.sessionName.notNull).toBe(true);
  });

  it('has windowCount and attached columns', () => {
    expect(sandboxTmuxSessions.windowCount).toBeDefined();
    expect(sandboxTmuxSessions.attached).toBeDefined();
  });
});

// =============================================================================
// Workflows Table Schema
// =============================================================================

describe('Workflows Schema', () => {
  it('has an id primary key', () => {
    expect(workflows.id).toBeDefined();
  });

  it('has name column (not null)', () => {
    expect(workflows.name).toBeDefined();
    expect(workflows.name.notNull).toBe(true);
  });

  it('has nodes and edges JSON columns', () => {
    expect(workflows.nodes).toBeDefined();
    expect(workflows.edges).toBeDefined();
  });

  it('has AI generation metadata columns', () => {
    expect(workflows.aiGenerated).toBeDefined();
    expect(workflows.aiModel).toBeDefined();
    expect(workflows.aiConfidence).toBeDefined();
  });

  it('has status and tags columns', () => {
    expect(workflows.status).toBeDefined();
    expect(workflows.tags).toBeDefined();
  });
});

// =============================================================================
// Enum Constants Tests
// =============================================================================

describe('Enum Constants', () => {
  it('TASK_COLUMNS contains expected values', () => {
    expect(TASK_COLUMNS).toContain('backlog');
    expect(TASK_COLUMNS).toContain('queued');
    expect(TASK_COLUMNS).toContain('in_progress');
    expect(TASK_COLUMNS).toContain('waiting_approval');
    expect(TASK_COLUMNS).toContain('verified');
    expect(TASK_COLUMNS).toHaveLength(5);
  });

  it('AGENT_STATUS contains expected values', () => {
    expect(AGENT_STATUS).toContain('idle');
    expect(AGENT_STATUS).toContain('starting');
    expect(AGENT_STATUS).toContain('planning');
    expect(AGENT_STATUS).toContain('running');
    expect(AGENT_STATUS).toContain('paused');
    expect(AGENT_STATUS).toContain('error');
    expect(AGENT_STATUS).toContain('completed');
    expect(AGENT_STATUS).toHaveLength(7);
  });

  it('AGENT_TYPES contains expected values', () => {
    expect(AGENT_TYPES).toContain('task');
    expect(AGENT_TYPES).toContain('conversational');
    expect(AGENT_TYPES).toContain('background');
    expect(AGENT_TYPES).toHaveLength(3);
  });

  it('TASK_PRIORITIES contains expected values', () => {
    expect(TASK_PRIORITIES).toContain('high');
    expect(TASK_PRIORITIES).toContain('medium');
    expect(TASK_PRIORITIES).toContain('low');
    expect(TASK_PRIORITIES).toHaveLength(3);
  });

  it('WORKTREE_STATUS contains expected values', () => {
    expect(WORKTREE_STATUS).toContain('creating');
    expect(WORKTREE_STATUS).toContain('active');
    expect(WORKTREE_STATUS).toContain('merging');
    expect(WORKTREE_STATUS).toContain('removing');
    expect(WORKTREE_STATUS).toContain('removed');
    expect(WORKTREE_STATUS).toContain('error');
    expect(WORKTREE_STATUS).toHaveLength(6);
  });

  it('SESSION_STATUS contains expected values', () => {
    expect(SESSION_STATUS).toContain('idle');
    expect(SESSION_STATUS).toContain('initializing');
    expect(SESSION_STATUS).toContain('active');
    expect(SESSION_STATUS).toContain('paused');
    expect(SESSION_STATUS).toContain('closing');
    expect(SESSION_STATUS).toContain('closed');
    expect(SESSION_STATUS).toContain('error');
    expect(SESSION_STATUS).toHaveLength(7);
  });

  it('SANDBOX_TYPES contains expected values', () => {
    expect(SANDBOX_TYPES).toContain('docker');
    expect(SANDBOX_TYPES).toContain('kubernetes');
    expect(SANDBOX_TYPES).toContain('nomad');
    expect(SANDBOX_TYPES).toContain('agentcore');
    expect(SANDBOX_TYPES).toHaveLength(5);
  });

  it('RBAC_ROLES contains expected roles', () => {
    expect(RBAC_ROLES).toContain('owner');
    expect(RBAC_ROLES).toContain('admin');
    expect(RBAC_ROLES).toContain('agent_operator');
    expect(RBAC_ROLES).toContain('viewer');
    expect(RBAC_ROLES).toHaveLength(4);
  });

  it('RBAC_ROLE_LEVEL assigns increasing levels from viewer to owner', () => {
    expect(RBAC_ROLE_LEVEL.viewer).toBe(1);
    expect(RBAC_ROLE_LEVEL.agent_operator).toBe(2);
    expect(RBAC_ROLE_LEVEL.admin).toBe(3);
    expect(RBAC_ROLE_LEVEL.owner).toBe(4);
  });

  it('EVENT_SOURCE_TYPES contains expected values', () => {
    expect(EVENT_SOURCE_TYPES).toContain('github');
    expect(EVENT_SOURCE_TYPES).toContain('linear');
    expect(EVENT_SOURCE_TYPES).toContain('jira');
    expect(EVENT_SOURCE_TYPES).toContain('generic_webhook');
    expect(EVENT_SOURCE_TYPES).toContain('cron');
  });

  it('INVITATION_STATUS contains expected values', () => {
    expect(INVITATION_STATUS).toContain('pending');
    expect(INVITATION_STATUS).toContain('accepted');
    expect(INVITATION_STATUS).toContain('declined');
    expect(INVITATION_STATUS).toContain('expired');
    expect(INVITATION_STATUS).toContain('revoked');
  });

  it('API_TOKEN_STATUS contains expected values', () => {
    expect(API_TOKEN_STATUS).toContain('active');
    expect(API_TOKEN_STATUS).toContain('revoked');
    expect(API_TOKEN_STATUS).toContain('expired');
  });
});

// =============================================================================
// RBAC Helper Functions Tests
// =============================================================================

describe('isValidRbacRole', () => {
  it('returns the role for valid roles', () => {
    expect(isValidRbacRole('owner')).toBe('owner');
    expect(isValidRbacRole('admin')).toBe('admin');
    expect(isValidRbacRole('agent_operator')).toBe('agent_operator');
    expect(isValidRbacRole('viewer')).toBe('viewer');
  });

  it('returns null for invalid roles', () => {
    expect(isValidRbacRole('superadmin')).toBeNull();
    expect(isValidRbacRole('')).toBeNull();
    expect(isValidRbacRole('OWNER')).toBeNull();
  });
});

describe('resolveHighestRole', () => {
  it('returns owner when owner role is present', () => {
    const result = resolveHighestRole([{ role: 'viewer' }, { role: 'owner' }, { role: 'admin' }]);

    expect(result?.role).toBe('owner');
    expect(result?.level).toBe(4);
  });

  it('returns admin when admin is highest', () => {
    const result = resolveHighestRole([{ role: 'viewer' }, { role: 'admin' }]);

    expect(result?.role).toBe('admin');
    expect(result?.level).toBe(3);
  });

  it('returns null for empty array', () => {
    const result = resolveHighestRole([]);

    expect(result).toBeNull();
  });

  it('returns null when all roles are invalid', () => {
    const result = resolveHighestRole([{ role: 'invalid1' }, { role: 'invalid2' }]);

    expect(result).toBeNull();
  });

  it('skips invalid roles and returns highest valid one', () => {
    const result = resolveHighestRole([{ role: 'invalid' }, { role: 'viewer' }]);

    expect(result?.role).toBe('viewer');
    expect(result?.level).toBe(1);
  });
});
