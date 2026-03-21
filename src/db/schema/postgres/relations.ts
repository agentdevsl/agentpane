import { relations } from 'drizzle-orm';
import { agentRuns } from './agent-runs';
import { agents } from './agents';
import { apiTokens } from './api-tokens';
import { auditLogs } from './audit-logs';
import { codespaceMembers } from './codespace-members';
import { codespaceTags } from './codespace-tags';
import { codespaces } from './codespaces';
import { eventLog } from './event-log';
import { eventSources } from './event-sources';
import { eventSubscriptions } from './event-subscriptions';
import { folderMembers } from './folder-members';
import { githubInstallations, repositoryConfigs } from './github';
import { planSessions } from './plan-sessions';
import { projectFolders } from './project-folders';
import { sandboxConfigs } from './sandbox-configs';
import { sandboxInstances, sandboxTmuxSessions } from './sandboxes';
import { sessionEvents } from './session-events';
import { sessionSummaries } from './session-summaries';
import { sessions } from './sessions';
import { tags } from './tags';
import { taskTags } from './task-tags';
import { tasks } from './tasks';
import { teamInvitations } from './team-invitations';
import { teamMembers } from './team-members';
import { teamProjectFolders } from './team-project-folders';
import { teams } from './teams';
import { templateCodespaces } from './template-codespaces';
import { templates } from './templates';
import { terraformModules, terraformRegistries } from './terraform';
import { userSessions } from './user-sessions';
import { users } from './users';
import { worktrees } from './worktrees';

export const projectFoldersRelations = relations(projectFolders, ({ many }) => ({
  codespaces: many(codespaces),
  folderMembers: many(folderMembers),
  tags: many(tags),
  teamProjectFolders: many(teamProjectFolders),
}));

export const codespacesRelations = relations(codespaces, ({ one, many }) => ({
  projectFolder: one(projectFolders, {
    fields: [codespaces.projectFolderId],
    references: [projectFolders.id],
  }),
  tasks: many(tasks),
  agents: many(agents),
  sessions: many(sessions),
  worktrees: many(worktrees),
  auditLogs: many(auditLogs),
  templates: many(templates),
  templateCodespaces: many(templateCodespaces),
  planSessions: many(planSessions),
  codespaceMembers: many(codespaceMembers),
  codespaceTags: many(codespaceTags),
  eventSubscriptions: many(eventSubscriptions),
  sandboxInstance: one(sandboxInstances, {
    fields: [codespaces.id],
    references: [sandboxInstances.codespaceId],
  }),
  sandboxConfig: one(sandboxConfigs, {
    fields: [codespaces.sandboxConfigId],
    references: [sandboxConfigs.id],
  }),
}));

export const sandboxConfigsRelations = relations(sandboxConfigs, ({ many }) => ({
  codespaces: many(codespaces),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  codespace: one(codespaces, {
    fields: [tasks.codespaceId],
    references: [codespaces.id],
  }),
  agent: one(agents, {
    fields: [tasks.agentId],
    references: [agents.id],
  }),
  session: one(sessions, {
    fields: [tasks.sessionId],
    references: [sessions.id],
  }),
  worktree: one(worktrees, {
    fields: [tasks.worktreeId],
    references: [worktrees.id],
  }),
  agentRuns: many(agentRuns),
  auditLogs: many(auditLogs),
  planSessions: many(planSessions),
  tmuxSessions: many(sandboxTmuxSessions),
  taskTags: many(taskTags),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  codespace: one(codespaces, {
    fields: [agents.codespaceId],
    references: [codespaces.id],
  }),
  tasks: many(tasks),
  agentRuns: many(agentRuns),
  sessions: many(sessions),
  auditLogs: many(auditLogs),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  codespace: one(codespaces, {
    fields: [sessions.codespaceId],
    references: [codespaces.id],
  }),
  task: one(tasks, {
    fields: [sessions.taskId],
    references: [tasks.id],
  }),
  agent: one(agents, {
    fields: [sessions.agentId],
    references: [agents.id],
  }),
  events: many(sessionEvents),
  summary: one(sessionSummaries, {
    fields: [sessions.id],
    references: [sessionSummaries.sessionId],
  }),
}));

export const worktreesRelations = relations(worktrees, ({ one }) => ({
  codespace: one(codespaces, {
    fields: [worktrees.codespaceId],
    references: [codespaces.id],
  }),
  task: one(tasks, {
    fields: [worktrees.taskId],
    references: [tasks.id],
  }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  agent: one(agents, {
    fields: [agentRuns.agentId],
    references: [agents.id],
  }),
  task: one(tasks, {
    fields: [agentRuns.taskId],
    references: [tasks.id],
  }),
  codespace: one(codespaces, {
    fields: [agentRuns.codespaceId],
    references: [codespaces.id],
  }),
  session: one(sessions, {
    fields: [agentRuns.sessionId],
    references: [sessions.id],
  }),
}));

export const githubInstallationsRelations = relations(githubInstallations, ({ many }) => ({
  repositories: many(repositoryConfigs),
}));

export const repositoryConfigsRelations = relations(repositoryConfigs, ({ one }) => ({
  installation: one(githubInstallations, {
    fields: [repositoryConfigs.installationId],
    references: [githubInstallations.id],
  }),
}));

export const templatesRelations = relations(templates, ({ one, many }) => ({
  // Legacy single codespace reference (for backward compatibility)
  codespace: one(codespaces, {
    fields: [templates.codespaceId],
    references: [codespaces.id],
  }),
  // Many-to-many relationship through junction table
  templateCodespaces: many(templateCodespaces),
}));

export const templateCodespacesRelations = relations(templateCodespaces, ({ one }) => ({
  template: one(templates, {
    fields: [templateCodespaces.templateId],
    references: [templates.id],
  }),
  codespace: one(codespaces, {
    fields: [templateCodespaces.codespaceId],
    references: [codespaces.id],
  }),
}));

// Plan sessions relations
export const planSessionsRelations = relations(planSessions, ({ one }) => ({
  task: one(tasks, {
    fields: [planSessions.taskId],
    references: [tasks.id],
  }),
  codespace: one(codespaces, {
    fields: [planSessions.codespaceId],
    references: [codespaces.id],
  }),
}));

// Sandbox instances relations
export const sandboxInstancesRelations = relations(sandboxInstances, ({ one, many }) => ({
  codespace: one(codespaces, {
    fields: [sandboxInstances.codespaceId],
    references: [codespaces.id],
  }),
  tmuxSessions: many(sandboxTmuxSessions),
}));

// Sandbox tmux sessions relations
export const sandboxTmuxSessionsRelations = relations(sandboxTmuxSessions, ({ one }) => ({
  sandbox: one(sandboxInstances, {
    fields: [sandboxTmuxSessions.sandboxId],
    references: [sandboxInstances.id],
  }),
  task: one(tasks, {
    fields: [sandboxTmuxSessions.taskId],
    references: [tasks.id],
  }),
}));

// Session events relations
export const sessionEventsRelations = relations(sessionEvents, ({ one }) => ({
  session: one(sessions, {
    fields: [sessionEvents.sessionId],
    references: [sessions.id],
  }),
}));

// Session summaries relations
export const sessionSummariesRelations = relations(sessionSummaries, ({ one }) => ({
  session: one(sessions, {
    fields: [sessionSummaries.sessionId],
    references: [sessions.id],
  }),
}));

// Terraform registries relations
export const terraformRegistriesRelations = relations(terraformRegistries, ({ many }) => ({
  modules: many(terraformModules),
}));

// Terraform modules relations
export const terraformModulesRelations = relations(terraformModules, ({ one }) => ({
  registry: one(terraformRegistries, {
    fields: [terraformModules.registryId],
    references: [terraformRegistries.id],
  }),
}));

// RBAC relations

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(userSessions),
  teamMemberships: many(teamMembers),
  codespaceMemberships: many(codespaceMembers),
  folderMemberships: many(folderMembers),
  apiTokens: many(apiTokens),
  invitationsSent: many(teamInvitations),
}));

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, {
    fields: [userSessions.userId],
    references: [users.id],
  }),
}));

export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
  projectFolders: many(teamProjectFolders),
  apiTokens: many(apiTokens),
  invitations: many(teamInvitations),
  eventSources: many(eventSources),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
}));

export const teamProjectFoldersRelations = relations(teamProjectFolders, ({ one }) => ({
  team: one(teams, {
    fields: [teamProjectFolders.teamId],
    references: [teams.id],
  }),
  projectFolder: one(projectFolders, {
    fields: [teamProjectFolders.projectFolderId],
    references: [projectFolders.id],
  }),
}));

export const folderMembersRelations = relations(folderMembers, ({ one }) => ({
  projectFolder: one(projectFolders, {
    fields: [folderMembers.projectFolderId],
    references: [projectFolders.id],
  }),
  user: one(users, {
    fields: [folderMembers.userId],
    references: [users.id],
  }),
  grantedByTeam: one(teams, {
    fields: [folderMembers.grantedByTeamId],
    references: [teams.id],
  }),
}));

export const codespaceMembersRelations = relations(codespaceMembers, ({ one }) => ({
  codespace: one(codespaces, {
    fields: [codespaceMembers.codespaceId],
    references: [codespaces.id],
  }),
  user: one(users, {
    fields: [codespaceMembers.userId],
    references: [users.id],
  }),
  grantedByTeam: one(teams, {
    fields: [codespaceMembers.grantedByTeamId],
    references: [teams.id],
  }),
}));

export const tagsRelations = relations(tags, ({ one, many }) => ({
  projectFolder: one(projectFolders, {
    fields: [tags.projectFolderId],
    references: [projectFolders.id],
  }),
  codespaceTags: many(codespaceTags),
  taskTags: many(taskTags),
}));

export const codespaceTagsRelations = relations(codespaceTags, ({ one }) => ({
  codespace: one(codespaces, {
    fields: [codespaceTags.codespaceId],
    references: [codespaces.id],
  }),
  tag: one(tags, {
    fields: [codespaceTags.tagId],
    references: [tags.id],
  }),
}));

export const taskTagsRelations = relations(taskTags, ({ one }) => ({
  task: one(tasks, {
    fields: [taskTags.taskId],
    references: [tasks.id],
  }),
  tag: one(tags, {
    fields: [taskTags.tagId],
    references: [tags.id],
  }),
}));

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  user: one(users, {
    fields: [apiTokens.userId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [apiTokens.teamId],
    references: [teams.id],
  }),
  scopeCodespace: one(codespaces, {
    fields: [apiTokens.scopeCodespaceId],
    references: [codespaces.id],
  }),
}));

export const teamInvitationsRelations = relations(teamInvitations, ({ one }) => ({
  team: one(teams, {
    fields: [teamInvitations.teamId],
    references: [teams.id],
  }),
  invitedByUser: one(users, {
    fields: [teamInvitations.invitedBy],
    references: [users.id],
  }),
}));

// Event system relations

export const eventSourcesRelations = relations(eventSources, ({ one, many }) => ({
  team: one(teams, {
    fields: [eventSources.teamId],
    references: [teams.id],
  }),
  subscriptions: many(eventSubscriptions),
  eventLogs: many(eventLog),
}));

export const eventSubscriptionsRelations = relations(eventSubscriptions, ({ one }) => ({
  eventSource: one(eventSources, {
    fields: [eventSubscriptions.eventSourceId],
    references: [eventSources.id],
  }),
  targetCodespace: one(codespaces, {
    fields: [eventSubscriptions.targetCodespaceId],
    references: [codespaces.id],
  }),
}));

export const eventLogRelations = relations(eventLog, ({ one }) => ({
  eventSource: one(eventSources, {
    fields: [eventLog.eventSourceId],
    references: [eventSources.id],
  }),
}));
