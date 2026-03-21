import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Codespace, ProjectFolder } from '../db/schema';
import { agents, codespaces, projectFolders, tasks, teamProjectFolders } from '../db/schema';
import type { ProjectFolderError } from '../lib/errors/project-folder-errors.js';
import { ProjectFolderErrors } from '../lib/errors/project-folder-errors.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

export type CreateProjectFolderInput = {
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  color?: string;
};

export type UpdateProjectFolderInput = Partial<{
  name: string;
  slug: string;
  description: string;
  icon: string;
  color: string;
}>;

export type ListProjectFoldersOptions = {
  teamId?: string;
};

export type FolderSummary = {
  folder: ProjectFolder;
  totalCodespaces: number;
  runningAgents: number;
  totalTasks: number;
};

export class ProjectFolderService {
  constructor(private db: Database) {}

  private updateTimestamp(): string {
    return new Date().toISOString();
  }

  async create(
    input: CreateProjectFolderInput
  ): Promise<Result<ProjectFolder, ProjectFolderError>> {
    // Check for slug uniqueness
    const existing = await this.db.query.projectFolders.findFirst({
      where: eq(projectFolders.slug, input.slug),
    });
    if (existing) {
      return err(ProjectFolderErrors.SLUG_EXISTS);
    }

    const [folder] = await this.db
      .insert(projectFolders)
      .values({
        name: input.name,
        slug: input.slug,
        description: input.description,
        icon: input.icon ?? 'Folder',
        color: input.color ?? '#6B7280',
        createdAt: this.updateTimestamp(),
        updatedAt: this.updateTimestamp(),
      })
      .returning();

    if (!folder) {
      return err(ProjectFolderErrors.NOT_FOUND);
    }

    return ok(folder);
  }

  async getById(id: string): Promise<Result<ProjectFolder, ProjectFolderError>> {
    const folder = await this.db.query.projectFolders.findFirst({
      where: eq(projectFolders.id, id),
    });

    if (!folder) {
      return err(ProjectFolderErrors.NOT_FOUND);
    }

    return ok(folder);
  }

  async list(
    options?: ListProjectFoldersOptions
  ): Promise<Result<{ items: ProjectFolder[]; total: number }, ProjectFolderError>> {
    if (options?.teamId) {
      // Filter folders linked to a specific team via team_project_folders
      const teamFolderLinks = await this.db
        .select({ projectFolderId: teamProjectFolders.projectFolderId })
        .from(teamProjectFolders)
        .where(eq(teamProjectFolders.teamId, options.teamId));

      const folderIds = teamFolderLinks.map((link) => link.projectFolderId);

      if (folderIds.length === 0) {
        return ok({ items: [], total: 0 });
      }

      const items = await this.db.query.projectFolders.findMany({
        where: inArray(projectFolders.id, folderIds),
        orderBy: [desc(projectFolders.updatedAt)],
      });

      return ok({ items, total: items.length });
    }

    // No team filter -- return all folders
    const items = await this.db.query.projectFolders.findMany({
      orderBy: [desc(projectFolders.updatedAt)],
    });

    return ok({ items, total: items.length });
  }

  async listByTeam(teamId: string): Promise<Result<ProjectFolder[], ProjectFolderError>> {
    const teamFolderLinks = await this.db
      .select({ projectFolderId: teamProjectFolders.projectFolderId })
      .from(teamProjectFolders)
      .where(eq(teamProjectFolders.teamId, teamId));

    const folderIds = teamFolderLinks.map((link) => link.projectFolderId);

    if (folderIds.length === 0) {
      return ok([]);
    }

    const items = await this.db.query.projectFolders.findMany({
      where: inArray(projectFolders.id, folderIds),
      orderBy: [desc(projectFolders.updatedAt)],
    });

    return ok(items);
  }

  async update(
    id: string,
    input: UpdateProjectFolderInput
  ): Promise<Result<ProjectFolder, ProjectFolderError>> {
    // If slug is being changed, check uniqueness
    if (input.slug !== undefined) {
      const existing = await this.db.query.projectFolders.findFirst({
        where: and(eq(projectFolders.slug, input.slug)),
      });
      if (existing && existing.id !== id) {
        return err(ProjectFolderErrors.SLUG_EXISTS);
      }
    }

    const updates: Partial<ProjectFolder> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.slug !== undefined) updates.slug = input.slug;
    if (input.description !== undefined) updates.description = input.description;
    if (input.icon !== undefined) updates.icon = input.icon;
    if (input.color !== undefined) updates.color = input.color;

    const [updated] = await this.db
      .update(projectFolders)
      .set({ ...updates, updatedAt: this.updateTimestamp() })
      .where(eq(projectFolders.id, id))
      .returning();

    if (!updated) {
      return err(ProjectFolderErrors.NOT_FOUND);
    }

    return ok(updated);
  }

  async delete(id: string): Promise<Result<void, ProjectFolderError>> {
    const folder = await this.db.query.projectFolders.findFirst({
      where: eq(projectFolders.id, id),
    });

    if (!folder) {
      return err(ProjectFolderErrors.NOT_FOUND);
    }

    // Check if the folder has codespaces
    const folderCodespaces = await this.db.query.codespaces.findMany({
      where: eq(codespaces.projectFolderId, id),
    });

    if (folderCodespaces.length > 0) {
      return err(ProjectFolderErrors.HAS_CODESPACES(folderCodespaces.length));
    }

    await this.db.delete(projectFolders).where(eq(projectFolders.id, id));

    return ok(undefined);
  }

  async listCodespaces(folderId: string): Promise<Result<Codespace[], ProjectFolderError>> {
    const folder = await this.db.query.projectFolders.findFirst({
      where: eq(projectFolders.id, folderId),
    });

    if (!folder) {
      return err(ProjectFolderErrors.NOT_FOUND);
    }

    const items = await this.db.query.codespaces.findMany({
      where: eq(codespaces.projectFolderId, folderId),
      orderBy: [desc(codespaces.updatedAt)],
    });

    return ok(items);
  }

  async getSummary(folderId: string): Promise<Result<FolderSummary, ProjectFolderError>> {
    const folder = await this.db.query.projectFolders.findFirst({
      where: eq(projectFolders.id, folderId),
    });

    if (!folder) {
      return err(ProjectFolderErrors.NOT_FOUND);
    }

    // Get all codespace IDs in this folder
    const folderCodespaces = await this.db.query.codespaces.findMany({
      where: eq(codespaces.projectFolderId, folderId),
      columns: { id: true },
    });

    const codespaceIds = folderCodespaces.map((c) => c.id);

    if (codespaceIds.length === 0) {
      return ok({
        folder,
        totalCodespaces: 0,
        runningAgents: 0,
        totalTasks: 0,
      });
    }

    // Count running agents across all codespaces in the folder
    const activeStatuses = ['starting', 'planning', 'running'] as const;
    const activeAgents = await this.db.query.agents.findMany({
      where: and(
        inArray(agents.codespaceId, codespaceIds),
        inArray(agents.status, [...activeStatuses])
      ),
      columns: { id: true },
    });

    // Count total tasks across all codespaces in the folder
    const allTasks = await this.db.query.tasks.findMany({
      where: inArray(tasks.codespaceId, codespaceIds),
      columns: { id: true },
    });

    return ok({
      folder,
      totalCodespaces: codespaceIds.length,
      runningAgents: activeAgents.length,
      totalTasks: allTasks.length,
    });
  }
}
