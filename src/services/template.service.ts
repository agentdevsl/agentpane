import { and, desc, eq, inArray } from 'drizzle-orm';
import type { NewTemplate, Template, TemplateScope } from '../db/schema';
import { githubTokens, templateCodespaces, templates } from '../db/schema';
import type { LocalConfig, MergedTemplateConfig } from '../lib/config/template-merge.js';
import { mergeTemplates } from '../lib/config/template-merge.js';
import type { TemplateError } from '../lib/errors/template-errors.js';
import { TemplateErrors } from '../lib/errors/template-errors.js';
import { formatGitHubError } from '../lib/github/client.js';
import { resolveOctokit } from '../lib/github/resolve-octokit.js';
import { parseGitHubUrl, syncTemplateFromGitHub } from '../lib/github/template-sync.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

export type CreateTemplateInput = {
  name: string;
  description?: string;
  scope: TemplateScope;
  githubUrl: string;
  branch?: string;
  configPath?: string;
  /** Codespace IDs to associate with this template (for codespace-scoped templates) */
  codespaceIds?: string[];
  /** Auto-sync interval in minutes (null = disabled, minimum 5 minutes) */
  syncIntervalMinutes?: number | null;
};

/** Template with associated codespace IDs */
export type TemplateWithProjects = Template & {
  codespaceIds: string[];
};

export type UpdateTemplateInput = {
  name?: string;
  description?: string;
  branch?: string;
  configPath?: string;
  /** Update the codespace associations (replaces existing) */
  codespaceIds?: string[];
  /** Auto-sync interval in minutes (null = disabled, minimum 5 minutes) */
  syncIntervalMinutes?: number | null;
};

export type ListTemplatesOptions = {
  scope?: TemplateScope;
  codespaceId?: string;
  limit?: number;
  offset?: number;
};

export interface SyncResult {
  templateId: string;
  skillCount: number;
  commandCount: number;
  agentCount: number;
  sha: string;
  syncedAt: string;
}

export interface SyncAllResult {
  successes: SyncResult[];
  failures: Array<{ templateId: string; templateName: string; error: TemplateError }>;
}

export class TemplateService {
  constructor(private db: Database) {}

  private updateTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Calculate the next sync time based on an interval in minutes
   */
  private calculateNextSyncAt(intervalMinutes: number): string {
    const now = new Date();
    now.setMinutes(now.getMinutes() + intervalMinutes);
    return now.toISOString();
  }

  async create(input: CreateTemplateInput): Promise<Result<TemplateWithProjects, TemplateError>> {
    // Parse GitHub URL
    const parsed = parseGitHubUrl(input.githubUrl);
    if (!parsed.ok) {
      return parsed;
    }

    const { owner, repo } = parsed.value;

    const codespaceIds = input.codespaceIds ?? [];

    // Validate codespace-scoped templates require at least one codespace
    if (input.scope === 'codespace' && codespaceIds.length === 0) {
      return err(TemplateErrors.PROJECT_REQUIRED);
    }

    // Check for duplicate template (same owner/repo in same scope)
    const existing = await this.db.query.templates.findFirst({
      where: and(
        eq(templates.githubOwner, owner),
        eq(templates.githubRepo, repo),
        eq(templates.scope, input.scope)
      ),
    });

    if (existing) {
      return err(TemplateErrors.ALREADY_EXISTS);
    }

    const now = this.updateTimestamp();

    // Calculate nextSyncAt if syncIntervalMinutes is provided
    const syncIntervalMinutes = input.syncIntervalMinutes ?? null;
    const nextSyncAt = syncIntervalMinutes ? this.calculateNextSyncAt(syncIntervalMinutes) : null;

    const [template] = await this.db
      .insert(templates)
      .values({
        name: input.name,
        description: input.description,
        scope: input.scope,
        githubOwner: owner,
        githubRepo: repo,
        branch: input.branch ?? 'main',
        configPath: input.configPath ?? '.claude',
        codespaceId: codespaceIds[0], // Keep legacy field for backward compatibility
        status: 'active',
        syncIntervalMinutes,
        nextSyncAt,
        createdAt: now,
        updatedAt: now,
      } satisfies NewTemplate)
      .returning();

    if (!template) {
      return err(TemplateErrors.NOT_FOUND);
    }

    // Insert codespace associations into junction table
    if (codespaceIds.length > 0) {
      await this.db.insert(templateCodespaces).values(
        codespaceIds.map((codespaceId) => ({
          templateId: template.id,
          codespaceId,
          createdAt: now,
        }))
      );
    }

    return ok({ ...template, codespaceIds });
  }

  async getById(id: string): Promise<Result<TemplateWithProjects, TemplateError>> {
    const template = await this.db.query.templates.findFirst({
      where: eq(templates.id, id),
    });

    if (!template) {
      return err(TemplateErrors.NOT_FOUND);
    }

    // Get associated codespace IDs
    const associations = await this.db.query.templateCodespaces.findMany({
      where: eq(templateCodespaces.templateId, id),
    });
    const codespaceIds = associations.map((a) => a.codespaceId);

    return ok({ ...template, codespaceIds });
  }

  async list(
    options?: ListTemplatesOptions
  ): Promise<Result<TemplateWithProjects[], TemplateError>> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let items: Template[];

    if (options?.codespaceId) {
      // Find templates associated with this codespace via junction table
      const associations = await this.db.query.templateCodespaces.findMany({
        where: eq(templateCodespaces.codespaceId, options.codespaceId),
      });
      const templateIds = associations.map((a) => a.templateId);

      if (templateIds.length === 0) {
        // Also check legacy codespaceId field for backward compatibility
        const conditions = [eq(templates.codespaceId, options.codespaceId)];
        if (options.scope) {
          conditions.push(eq(templates.scope, options.scope));
        }
        items = await this.db.query.templates.findMany({
          where: and(...conditions),
          orderBy: [desc(templates.updatedAt)],
          limit,
          offset,
        });
      } else {
        const conditions = [inArray(templates.id, templateIds)];
        if (options.scope) {
          conditions.push(eq(templates.scope, options.scope));
        }
        items = await this.db.query.templates.findMany({
          where: and(...conditions),
          orderBy: [desc(templates.updatedAt)],
          limit,
          offset,
        });
      }
    } else {
      const conditions = [];
      if (options?.scope) {
        conditions.push(eq(templates.scope, options.scope));
      }

      items = await this.db.query.templates.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: [desc(templates.updatedAt)],
        limit,
        offset,
      });
    }

    // Get associated codespace IDs for each template
    const result: TemplateWithProjects[] = await Promise.all(
      items.map(async (template) => {
        const associations = await this.db.query.templateCodespaces.findMany({
          where: eq(templateCodespaces.templateId, template.id),
        });
        return { ...template, codespaceIds: associations.map((a) => a.codespaceId) };
      })
    );

    return ok(result);
  }

  async update(
    id: string,
    input: UpdateTemplateInput
  ): Promise<Result<TemplateWithProjects, TemplateError>> {
    const updates: Partial<Template> = {
      updatedAt: this.updateTimestamp(),
    };

    if (input.name !== undefined) {
      updates.name = input.name;
    }
    if (input.description !== undefined) {
      updates.description = input.description;
    }
    if (input.branch !== undefined) {
      updates.branch = input.branch;
    }
    if (input.configPath !== undefined) {
      updates.configPath = input.configPath;
    }

    // Handle sync interval updates
    if (input.syncIntervalMinutes !== undefined) {
      const intervalMinutes = input.syncIntervalMinutes;
      updates.syncIntervalMinutes = intervalMinutes;
      // Update nextSyncAt: if interval is set, schedule next sync; if null, clear it
      updates.nextSyncAt = intervalMinutes ? this.calculateNextSyncAt(intervalMinutes) : null;
    }

    const [updated] = await this.db
      .update(templates)
      .set(updates)
      .where(eq(templates.id, id))
      .returning();

    if (!updated) {
      return err(TemplateErrors.NOT_FOUND);
    }

    // Update codespace associations if provided
    if (input.codespaceIds !== undefined) {
      // Delete existing associations
      await this.db.delete(templateCodespaces).where(eq(templateCodespaces.templateId, id));

      // Insert new associations
      if (input.codespaceIds.length > 0) {
        const now = this.updateTimestamp();
        await this.db.insert(templateCodespaces).values(
          input.codespaceIds.map((codespaceId) => ({
            templateId: id,
            codespaceId,
            createdAt: now,
          }))
        );
      }
    }

    // Get updated codespace associations
    const associations = await this.db.query.templateCodespaces.findMany({
      where: eq(templateCodespaces.templateId, id),
    });
    const codespaceIds = associations.map((a) => a.codespaceId);

    return ok({ ...updated, codespaceIds });
  }

  async delete(id: string): Promise<Result<void, TemplateError>> {
    const template = await this.db.query.templates.findFirst({
      where: eq(templates.id, id),
    });

    if (!template) {
      return err(TemplateErrors.NOT_FOUND);
    }

    await this.db.delete(templates).where(eq(templates.id, id));

    return ok(undefined);
  }

  /**
   * Sync a template from its GitHub repository
   * Fetches skills, commands, and agents and caches them
   */
  async sync(id: string): Promise<Result<SyncResult, TemplateError>> {
    const template = await this.db.query.templates.findFirst({
      where: eq(templates.id, id),
    });

    if (!template) {
      return err(TemplateErrors.NOT_FOUND);
    }

    // Mark as syncing
    await this.db
      .update(templates)
      .set({ status: 'syncing', updatedAt: this.updateTimestamp() })
      .where(eq(templates.id, id));

    try {
      // SL-013: Use shared resolveOctokit utility instead of inline auth resolution
      const octokitResult = await resolveOctokit(this.db);
      if (!octokitResult.ok) {
        await this.db
          .update(templates)
          .set({
            status: 'error',
            syncError: octokitResult.error.message,
            updatedAt: this.updateTimestamp(),
          })
          .where(eq(templates.id, id));
        return err(TemplateErrors.SYNC_FAILED(octokitResult.error.message));
      }
      const octokit = octokitResult.value;

      const syncResult = await syncTemplateFromGitHub({
        octokit,
        owner: template.githubOwner,
        repo: template.githubRepo,
        configPath: template.configPath ?? '.claude',
        ref: template.branch ?? 'main',
      });

      if (!syncResult.ok) {
        await this.db
          .update(templates)
          .set({
            status: 'error',
            syncError: syncResult.error.message,
            updatedAt: this.updateTimestamp(),
          })
          .where(eq(templates.id, id));
        return syncResult;
      }

      const now = this.updateTimestamp();

      // Update template with synced content
      await this.db
        .update(templates)
        .set({
          status: 'active',
          cachedSkills: syncResult.value.skills,
          cachedCommands: syncResult.value.commands,
          cachedAgents: syncResult.value.agents,
          lastSyncSha: syncResult.value.sha,
          lastSyncedAt: now,
          syncError: null,
          updatedAt: now,
        })
        .where(eq(templates.id, id));

      return ok({
        templateId: id,
        skillCount: syncResult.value.skills.length,
        commandCount: syncResult.value.commands.length,
        agentCount: syncResult.value.agents.length,
        sha: syncResult.value.sha,
        syncedAt: now,
      });
    } catch (error) {
      const ghError = formatGitHubError(error);

      // Invalidate the token if GitHub returned 401 (expired/revoked)
      if (ghError.status === 401) {
        await this.db
          .update(githubTokens)
          .set({ isValid: false })
          .where(eq(githubTokens.isValid, true));
      }

      await this.db
        .update(templates)
        .set({
          status: 'error',
          syncError: ghError.message,
          updatedAt: this.updateTimestamp(),
        })
        .where(eq(templates.id, id));
      return err(TemplateErrors.SYNC_FAILED(ghError.message));
    }
  }

  /**
   * Sync all templates of a given scope in parallel.
   * Returns both successful syncs and failed syncs for visibility.
   *
   * @param scope - The template scope to sync ('org' or 'codespace')
   * @param codespaceId - Optional project ID to filter project-scoped templates
   * @returns SyncAllResult with successes and failures arrays
   */
  async syncAll(
    scope: TemplateScope,
    codespaceId?: string
  ): Promise<Result<SyncAllResult, TemplateError>> {
    const conditions = [eq(templates.scope, scope)];

    if (codespaceId) {
      conditions.push(eq(templates.codespaceId, codespaceId));
    }

    const templateList = await this.db.query.templates.findMany({
      where: and(...conditions),
    });

    // Sync all templates in parallel using Promise.allSettled
    const syncPromises = templateList.map(async (template) => ({
      template,
      result: await this.sync(template.id),
    }));

    const results = await Promise.allSettled(syncPromises);

    const successes: SyncResult[] = [];
    const failures: Array<{ templateId: string; templateName: string; error: TemplateError }> = [];

    for (const settledResult of results) {
      if (settledResult.status === 'fulfilled') {
        const { template, result } = settledResult.value;
        if (result.ok) {
          successes.push(result.value);
        } else {
          failures.push({
            templateId: template.id,
            templateName: template.name,
            error: result.error,
          });
        }
      } else {
      }
    }

    return ok({ successes, failures });
  }

  /**
   * Get merged configuration for a codespace
   * Combines org templates, codespace templates, and local config with proper precedence
   */
  async getMergedConfig(
    codespaceId: string,
    localConfig?: LocalConfig
  ): Promise<Result<MergedTemplateConfig, TemplateError>> {
    // Fetch org templates (no codespaceId filter, scope = org)
    const orgTemplates = await this.db.query.templates.findMany({
      where: and(eq(templates.scope, 'org'), eq(templates.status, 'active')),
    });

    // Fetch codespace templates
    const projectTemplates = await this.db.query.templates.findMany({
      where: and(
        eq(templates.scope, 'codespace'),
        eq(templates.codespaceId, codespaceId),
        eq(templates.status, 'active')
      ),
    });

    const merged = mergeTemplates(orgTemplates, projectTemplates, localConfig);

    return ok(merged);
  }

  /**
   * Find templates by GitHub repository
   * Used by webhooks to trigger syncs on push events
   */
  async findByRepo(owner: string, repo: string): Promise<Result<Template[], TemplateError>> {
    const templateList = await this.db.query.templates.findMany({
      where: and(eq(templates.githubOwner, owner), eq(templates.githubRepo, repo)),
    });

    return ok(templateList);
  }
}
