/**
 * Migration v19: Project Folders tenancy model + project→codespace rename
 *
 * Creates project_folders, folder_members, team_project_folders tables.
 * Renames projects→codespaces and all FK columns from project_id→codespace_id.
 * Changes tags scope from team_id to project_folder_id.
 */

export const PROJECT_FOLDERS_MIGRATION_SQL = `
-- 1. Create project_folders table
CREATE TABLE IF NOT EXISTS project_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT NOT NULL DEFAULT 'Folder',
  color TEXT NOT NULL DEFAULT '#6B7280',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Create a default project folder for existing data
INSERT OR IGNORE INTO project_folders (id, name, slug, description, icon, color)
VALUES ('default-folder', 'Default', 'default', 'Default project folder for migrated codespaces', 'Folder', '#6B7280');

-- 3. Rename projects → codespaces (SQLite: create new, copy, drop old)
CREATE TABLE IF NOT EXISTS codespaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  description TEXT,
  config TEXT,
  max_concurrent_agents INTEGER DEFAULT 3,
  github_owner TEXT,
  github_repo TEXT,
  github_installation_id TEXT REFERENCES github_installations(id) ON DELETE SET NULL,
  config_path TEXT DEFAULT '.claude',
  sandbox_config_id TEXT REFERENCES sandbox_configs(id),
  project_folder_id TEXT NOT NULL DEFAULT 'default-folder' REFERENCES project_folders(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO codespaces (id, name, path, description, config, max_concurrent_agents, github_owner, github_repo, github_installation_id, config_path, sandbox_config_id, project_folder_id, created_at, updated_at)
SELECT id, name, path, description, config, max_concurrent_agents, github_owner, github_repo, github_installation_id, config_path, sandbox_config_id, 'default-folder', created_at, updated_at
FROM projects;

-- 4. Create folder_members table
CREATE TABLE IF NOT EXISTS folder_members (
  project_folder_id TEXT NOT NULL REFERENCES project_folders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  granted_by_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_folder_id, user_id)
);

-- 5. Create team_project_folders table
CREATE TABLE IF NOT EXISTS team_project_folders (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_folder_id TEXT NOT NULL REFERENCES project_folders(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, project_folder_id)
);

-- 6. Migrate team_projects → team_project_folders (assign default folder to each team)
INSERT OR IGNORE INTO team_project_folders (team_id, project_folder_id, assigned_at)
SELECT DISTINCT team_id, 'default-folder', assigned_at FROM team_projects;

-- 7. Create codespace_members from project_members
CREATE TABLE IF NOT EXISTS codespace_members (
  codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  granted_by_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (codespace_id, user_id)
);

INSERT OR IGNORE INTO codespace_members (codespace_id, user_id, role, granted_by_team_id, created_at)
SELECT project_id, user_id, role, granted_by_team_id, created_at FROM project_members;

-- 8. Create codespace_tags from project_tags
CREATE TABLE IF NOT EXISTS codespace_tags (
  codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (codespace_id, tag_id)
);

INSERT OR IGNORE INTO codespace_tags (codespace_id, tag_id)
SELECT project_id, tag_id FROM project_tags;

-- 9. Create template_codespaces from template_projects
CREATE TABLE IF NOT EXISTS template_codespaces (
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  codespace_id TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (template_id, codespace_id)
);

INSERT OR IGNORE INTO template_codespaces (template_id, codespace_id)
SELECT template_id, project_id FROM template_projects;
`;

/**
 * Individual ALTER TABLE statements for renaming FK columns.
 * Each is executed separately with try/catch for idempotency.
 */
export const PROJECT_FOLDERS_ALTER_STATEMENTS = [
  // Agents: add codespace_id column, copy data, (can't drop old in SQLite)
  `ALTER TABLE agents ADD COLUMN codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE`,
  `UPDATE agents SET codespace_id = project_id WHERE codespace_id IS NULL`,

  // Tasks
  `ALTER TABLE tasks ADD COLUMN codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE`,
  `UPDATE tasks SET codespace_id = project_id WHERE codespace_id IS NULL`,

  // Sessions
  `ALTER TABLE sessions ADD COLUMN codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE`,
  `UPDATE sessions SET codespace_id = project_id WHERE codespace_id IS NULL`,

  // Worktrees (SQLite disallows NOT NULL in ALTER TABLE ADD COLUMN with REFERENCES)
  `ALTER TABLE worktrees ADD COLUMN codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE`,
  `UPDATE worktrees SET codespace_id = project_id WHERE codespace_id IS NULL`,

  // Agent runs
  `ALTER TABLE agent_runs ADD COLUMN codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE`,
  `UPDATE agent_runs SET codespace_id = project_id WHERE codespace_id IS NULL`,

  // Audit logs
  `ALTER TABLE audit_logs ADD COLUMN codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE`,
  `UPDATE audit_logs SET codespace_id = project_id WHERE codespace_id IS NULL`,

  // Plan sessions (table may not exist in all installations)
  `CREATE TABLE IF NOT EXISTS plan_sessions (id TEXT PRIMARY KEY, codespace_id TEXT, project_id TEXT, task_id TEXT, session_id TEXT, status TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`,
  `ALTER TABLE plan_sessions ADD COLUMN codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE`,
  `UPDATE plan_sessions SET codespace_id = project_id WHERE codespace_id IS NULL`,

  // Sandboxes (table may not exist in all installations)
  `CREATE TABLE IF NOT EXISTS sandboxes (id TEXT PRIMARY KEY, codespace_id TEXT, project_id TEXT, type TEXT, status TEXT, container_id TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`,
  `ALTER TABLE sandboxes ADD COLUMN codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE`,
  `UPDATE sandboxes SET codespace_id = project_id WHERE codespace_id IS NULL`,

  // Event subscriptions
  `ALTER TABLE event_subscriptions ADD COLUMN target_codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE`,
  `UPDATE event_subscriptions SET target_codespace_id = target_project_id WHERE target_codespace_id IS NULL`,

  // API tokens
  `ALTER TABLE api_tokens ADD COLUMN scope_codespace_id TEXT REFERENCES codespaces(id) ON DELETE CASCADE`,
  `UPDATE api_tokens SET scope_codespace_id = scope_project_id WHERE scope_codespace_id IS NULL`,

  // Templates
  `ALTER TABLE templates ADD COLUMN codespace_id TEXT REFERENCES codespaces(id) ON DELETE SET NULL`,
  `UPDATE templates SET codespace_id = project_id WHERE codespace_id IS NULL`,

  // Tags: add project_folder_id column, assign default folder
  `ALTER TABLE tags ADD COLUMN project_folder_id TEXT REFERENCES project_folders(id) ON DELETE CASCADE`,
  `UPDATE tags SET project_folder_id = 'default-folder' WHERE project_folder_id IS NULL`,

  // Indexes for new columns
  `CREATE INDEX IF NOT EXISTS idx_codespaces_folder ON codespaces(project_folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agents_codespace ON agents(codespace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_codespace ON tasks(codespace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_codespace ON sessions(codespace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_worktrees_codespace ON worktrees(codespace_id)`,
];
