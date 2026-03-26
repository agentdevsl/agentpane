import { and, count, desc, eq, like, or } from 'drizzle-orm';
import type { Workflow } from '../db/schema';
import { workflows } from '../db/schema';
import type { WorkflowError } from '../lib/errors/workflow-errors.js';
import { WorkflowErrors } from '../lib/errors/workflow-errors.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

export type ListWorkflowsOptions = {
  limit?: number;
  offset?: number;
  status?: 'draft' | 'published' | 'archived';
  search?: string;
};

export type ListWorkflowsResult = {
  items: Workflow[];
  totalCount: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type CreateWorkflowInput = {
  name: string;
  description?: string;
  nodes?: unknown[];
  edges?: unknown[];
  viewport?: { x: number; y: number; zoom: number };
  status?: 'draft' | 'published' | 'archived';
  tags?: string[];
  sourceTemplateId?: string;
  sourceTemplateName?: string;
  thumbnail?: string;
  aiGenerated?: boolean;
  aiModel?: string;
  aiConfidence?: number;
};

export type UpdateWorkflowInput = {
  name?: string;
  description?: string;
  nodes?: unknown[];
  edges?: unknown[];
  viewport?: { x: number; y: number; zoom: number };
  status?: 'draft' | 'published' | 'archived';
  tags?: string[];
  sourceTemplateId?: string | null;
  sourceTemplateName?: string | null;
  thumbnail?: string | null;
  aiGenerated?: boolean;
  aiModel?: string | null;
  aiConfidence?: number | null;
};

export class WorkflowService {
  constructor(private db: Database) {}

  async list(options?: ListWorkflowsOptions): Promise<Result<ListWorkflowsResult, WorkflowError>> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    try {
      // Build where conditions
      const conditions = [];

      if (options?.status && ['draft', 'published', 'archived'].includes(options.status)) {
        conditions.push(eq(workflows.status, options.status));
      }

      if (options?.search) {
        const searchPattern = `%${options.search}%`;
        conditions.push(
          or(like(workflows.name, searchPattern), like(workflows.description, searchPattern))
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Get total count
      const [countResult] = await this.db
        .select({ total: count() })
        .from(workflows)
        .where(whereClause);

      const totalCount = countResult?.total ?? 0;

      // Get paginated items
      const items = await this.db.query.workflows.findMany({
        where: whereClause,
        orderBy: [desc(workflows.updatedAt)],
        limit,
        offset,
      });

      return ok({
        items,
        totalCount,
        limit,
        offset,
        hasMore: offset + items.length < totalCount,
      });
    } catch (_error) {
      return err(WorkflowErrors.DATABASE_ERROR('Failed to list workflows'));
    }
  }

  async getById(id: string): Promise<Result<Workflow, WorkflowError>> {
    try {
      const workflow = await this.db.query.workflows.findFirst({
        where: eq(workflows.id, id),
      });

      if (!workflow) {
        return err(WorkflowErrors.NOT_FOUND(id));
      }

      return ok(workflow);
    } catch (_error) {
      return err(WorkflowErrors.DATABASE_ERROR('Failed to get workflow'));
    }
  }

  async create(input: CreateWorkflowInput): Promise<Result<Workflow, WorkflowError>> {
    try {
      const now = new Date().toISOString();

      const [created] = await this.db
        .insert(workflows)
        .values({
          name: input.name,
          description: input.description,
          nodes: input.nodes as typeof workflows.$inferInsert.nodes,
          edges: input.edges as typeof workflows.$inferInsert.edges,
          viewport: input.viewport,
          status: input.status ?? 'draft',
          tags: input.tags,
          sourceTemplateId: input.sourceTemplateId,
          sourceTemplateName: input.sourceTemplateName,
          thumbnail: input.thumbnail,
          aiGenerated: input.aiGenerated,
          aiModel: input.aiModel,
          aiConfidence: input.aiConfidence,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!created) {
        return err(WorkflowErrors.CREATE_FAILED);
      }

      return ok(created);
    } catch (_error) {
      return err(WorkflowErrors.DATABASE_ERROR('Failed to create workflow'));
    }
  }

  async update(id: string, input: UpdateWorkflowInput): Promise<Result<Workflow, WorkflowError>> {
    try {
      // Check if workflow exists
      const existing = await this.db.query.workflows.findFirst({
        where: eq(workflows.id, id),
      });

      if (!existing) {
        return err(WorkflowErrors.NOT_FOUND(id));
      }

      // Build update object with only provided fields
      const updates: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.nodes !== undefined && { nodes: input.nodes }),
        ...(input.edges !== undefined && { edges: input.edges }),
        ...(input.viewport !== undefined && { viewport: input.viewport }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(input.sourceTemplateId !== undefined && { sourceTemplateId: input.sourceTemplateId }),
        ...(input.sourceTemplateName !== undefined && {
          sourceTemplateName: input.sourceTemplateName,
        }),
        ...(input.thumbnail !== undefined && { thumbnail: input.thumbnail }),
        ...(input.aiGenerated !== undefined && { aiGenerated: input.aiGenerated }),
        ...(input.aiModel !== undefined && { aiModel: input.aiModel }),
        ...(input.aiConfidence !== undefined && { aiConfidence: input.aiConfidence }),
      };

      const [updated] = await this.db
        .update(workflows)
        .set(updates)
        .where(eq(workflows.id, id))
        .returning();

      if (!updated) {
        return err(WorkflowErrors.UPDATE_FAILED);
      }

      return ok(updated);
    } catch (_error) {
      return err(WorkflowErrors.DATABASE_ERROR('Failed to update workflow'));
    }
  }

  async delete(id: string): Promise<Result<void, WorkflowError>> {
    try {
      // Check if workflow exists
      const existing = await this.db.query.workflows.findFirst({
        where: eq(workflows.id, id),
      });

      if (!existing) {
        return err(WorkflowErrors.NOT_FOUND(id));
      }

      await this.db.delete(workflows).where(eq(workflows.id, id));

      return ok(undefined);
    } catch (_error) {
      return err(WorkflowErrors.DATABASE_ERROR('Failed to delete workflow'));
    }
  }

  async duplicate(id: string): Promise<Result<Workflow, WorkflowError>> {
    try {
      const existing = await this.db.query.workflows.findFirst({
        where: eq(workflows.id, id),
      });

      if (!existing) {
        return err(WorkflowErrors.NOT_FOUND(id));
      }

      const now = new Date().toISOString();

      const [created] = await this.db
        .insert(workflows)
        .values({
          name: `${existing.name} (copy)`,
          description: existing.description,
          nodes: existing.nodes as typeof workflows.$inferInsert.nodes,
          edges: existing.edges as typeof workflows.$inferInsert.edges,
          viewport: existing.viewport as { x: number; y: number; zoom: number } | undefined,
          status: existing.status as 'draft' | 'published' | 'archived',
          tags: existing.tags as string[] | undefined,
          sourceTemplateId: existing.sourceTemplateId,
          sourceTemplateName: existing.sourceTemplateName,
          thumbnail: existing.thumbnail,
          aiGenerated: existing.aiGenerated ?? undefined,
          aiModel: existing.aiModel,
          aiConfidence: existing.aiConfidence ?? undefined,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!created) {
        return err(WorkflowErrors.CREATE_FAILED);
      }

      return ok(created);
    } catch (_error) {
      return err(WorkflowErrors.DATABASE_ERROR('Failed to duplicate workflow'));
    }
  }
}
