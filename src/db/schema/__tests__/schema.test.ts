import { describe, expect, it } from 'vitest';
import {
  agentRuns,
  agents,
  auditLogs,
  codespaces,
  githubInstallations,
  projectFolders,
  repositoryConfigs,
  sessions,
  tasks,
  worktrees,
} from '../index.js';

describe('schema definitions', () => {
  it('defines project_folders table', () => {
    expect(projectFolders).toBeDefined();
    expect(projectFolders.id).toBeDefined();
  });

  it('defines codespaces table', () => {
    expect(codespaces).toBeDefined();
    expect(codespaces.id).toBeDefined();
  });

  it('defines tasks table', () => {
    expect(tasks).toBeDefined();
    expect(tasks.id).toBeDefined();
  });

  it('defines agents table', () => {
    expect(agents).toBeDefined();
    expect(agents.id).toBeDefined();
  });

  it('defines agent_runs table', () => {
    expect(agentRuns).toBeDefined();
    expect(agentRuns.id).toBeDefined();
  });

  it('defines sessions table', () => {
    expect(sessions).toBeDefined();
    expect(sessions.id).toBeDefined();
  });

  it('defines worktrees table', () => {
    expect(worktrees).toBeDefined();
    expect(worktrees.id).toBeDefined();
  });

  it('defines audit_logs table', () => {
    expect(auditLogs).toBeDefined();
    expect(auditLogs.id).toBeDefined();
  });

  it('defines github_installations table', () => {
    expect(githubInstallations).toBeDefined();
    expect(githubInstallations.id).toBeDefined();
  });

  it('defines repository_configs table', () => {
    expect(repositoryConfigs).toBeDefined();
    expect(repositoryConfigs.id).toBeDefined();
  });
});
