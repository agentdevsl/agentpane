import { relations } from 'drizzle-orm';
import { agentRuns } from './agent-runs';
import { agents } from './agents';
import { apiTokens } from './api-tokens';
import { auditLogs } from './audit-logs';
import { githubInstallations, repositoryConfigs } from './github';
import { planSessions } from './plan-sessions';
import { projectMembers } from './project-members';
import { projectTags } from './project-tags';
import { projects } from './projects';
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
import { teamProjects } from './team-projects';
import { teams } from './teams';
import { templateProjects } from './template-projects';
import { templates } from './templates';
import { terraformModules, terraformRegistries } from './terraform';
import { userSessions } from './user-sessions';
import { users } from './users';
import { worktrees } from './worktrees';

export const projectsRelations = relations(projects, ({ one, many }) => ({
  tasks: many(tasks),
  agents: many(agents),
  sessions: many(sessions),
  worktrees: many(worktrees),
  auditLogs: many(auditLogs),
  templates: many(templates),
  templateProjects: many(templateProjects),
  planSessions: many(planSessions),
  teamProjects: many(teamProjects),
  projectMembers: many(projectMembers),
  projectTags: many(projectTags),
  sandboxInstance: one(sandboxInstances, {
    fields: [projects.id],
    references: [sandboxInstances.projectId],
  }),
  sandboxConfig: one(sandboxConfigs, {
    fields: [projects.sandboxConfigId],
    references: [sandboxConfigs.id],
  }),
}));

export const sandboxConfigsRelations = relations(sandboxConfigs, ({ many }) => ({
  projects: many(projects),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
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
  project: one(projects, {
    fields: [agents.projectId],
    references: [projects.id],
  }),
  tasks: many(tasks),
  agentRuns: many(agentRuns),
  sessions: many(sessions),
  auditLogs: many(auditLogs),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  project: one(projects, {
    fields: [sessions.projectId],
    references: [projects.id],
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
  project: one(projects, {
    fields: [worktrees.projectId],
    references: [projects.id],
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
  project: one(projects, {
    fields: [agentRuns.projectId],
    references: [projects.id],
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
  // Legacy single project reference (for backward compatibility)
  project: one(projects, {
    fields: [templates.projectId],
    references: [projects.id],
  }),
  // Many-to-many relationship through junction table
  templateProjects: many(templateProjects),
}));

export const templateProjectsRelations = relations(templateProjects, ({ one }) => ({
  template: one(templates, {
    fields: [templateProjects.templateId],
    references: [templates.id],
  }),
  project: one(projects, {
    fields: [templateProjects.projectId],
    references: [projects.id],
  }),
}));

// Plan sessions relations
export const planSessionsRelations = relations(planSessions, ({ one }) => ({
  task: one(tasks, {
    fields: [planSessions.taskId],
    references: [tasks.id],
  }),
  project: one(projects, {
    fields: [planSessions.projectId],
    references: [projects.id],
  }),
}));

// Sandbox instances relations
export const sandboxInstancesRelations = relations(sandboxInstances, ({ one, many }) => ({
  project: one(projects, {
    fields: [sandboxInstances.projectId],
    references: [projects.id],
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
  projectMemberships: many(projectMembers),
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
  projects: many(teamProjects),
  tags: many(tags),
  apiTokens: many(apiTokens),
  invitations: many(teamInvitations),
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

export const teamProjectsRelations = relations(teamProjects, ({ one }) => ({
  team: one(teams, {
    fields: [teamProjects.teamId],
    references: [teams.id],
  }),
  project: one(projects, {
    fields: [teamProjects.projectId],
    references: [projects.id],
  }),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, {
    fields: [projectMembers.projectId],
    references: [projects.id],
  }),
  user: one(users, {
    fields: [projectMembers.userId],
    references: [users.id],
  }),
  grantedByTeam: one(teams, {
    fields: [projectMembers.grantedByTeamId],
    references: [teams.id],
  }),
}));

export const tagsRelations = relations(tags, ({ one, many }) => ({
  team: one(teams, {
    fields: [tags.teamId],
    references: [teams.id],
  }),
  projectTags: many(projectTags),
  taskTags: many(taskTags),
}));

export const projectTagsRelations = relations(projectTags, ({ one }) => ({
  project: one(projects, {
    fields: [projectTags.projectId],
    references: [projects.id],
  }),
  tag: one(tags, {
    fields: [projectTags.tagId],
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
