import { createId } from '@paralleldrive/cuid2';
import type { Codespace, CodespaceConfig, NewCodespace } from '../../src/db/schema';
import { codespaces, projectFolders } from '../../src/db/schema';
import { getTestDb } from '../helpers/database';

/** Ensure the default project folder exists (idempotent) */
async function ensureDefaultFolder(db: ReturnType<typeof getTestDb>) {
  try {
    await db.insert(projectFolders).values({
      id: 'default-folder',
      name: 'Default',
      slug: 'default',
      description: 'Default project folder for tests',
    });
  } catch {
    // Already exists — safe to ignore
  }
}

export type ProjectFactoryOptions = Partial<NewCodespace> & {
  config?: Partial<CodespaceConfig>;
};

const DEFAULT_PROJECT_CONFIG: CodespaceConfig = {
  worktreeRoot: '.worktrees',
  defaultBranch: 'main',
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  maxTurns: 50,
};

export function buildProject(options: ProjectFactoryOptions = {}): NewCodespace {
  const id = options.id ?? createId();
  return {
    id,
    projectFolderId: options.projectFolderId ?? 'default-folder',
    name: options.name ?? `Test Project ${id.slice(0, 6)}`,
    path: options.path ?? `/tmp/test-project-${id}`,
    description: options.description ?? null,
    config: {
      ...DEFAULT_PROJECT_CONFIG,
      ...options.config,
    },
    maxConcurrentAgents: options.maxConcurrentAgents ?? 3,
    githubOwner: options.githubOwner ?? null,
    githubRepo: options.githubRepo ?? null,
    githubInstallationId: options.githubInstallationId ?? null,
    configPath: options.configPath ?? '.claude',
    sandboxConfigId: options.sandboxConfigId ?? null,
  };
}

export async function createTestProject(options: ProjectFactoryOptions = {}): Promise<Codespace> {
  const db = getTestDb();
  await ensureDefaultFolder(db);
  const data = buildProject(options);

  const [project] = await db.insert(codespaces).values(data).returning();

  if (!project) {
    throw new Error('Failed to create test project');
  }

  return project;
}

export async function createTestProjects(
  count: number,
  options: ProjectFactoryOptions = {}
): Promise<Codespace[]> {
  const createdProjects: Codespace[] = [];

  for (let i = 0; i < count; i++) {
    const project = await createTestProject({
      ...options,
      name: options.name ?? `Test Project ${i + 1}`,
    });
    createdProjects.push(project);
  }

  return createdProjects;
}
