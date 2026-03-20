import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { WorkflowEdge, WorkflowNode } from '@/lib/workflow-dsl/types';
import { templates } from './templates';

// Re-export DSL types for convenience
export type { WorkflowEdge, WorkflowNode };

// Workflow status enum
export const WORKFLOW_STATUSES = ['draft', 'published', 'archived'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

// Viewport type (simple, no need to import from DSL)
export type WorkflowViewport = {
  x: number;
  y: number;
  zoom: number;
};

export const workflows = sqliteTable('workflows', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  description: text('description'),

  // Workflow graph data (JSON)
  nodes: text('nodes', { mode: 'json' }).$type<WorkflowNode[]>(),
  edges: text('edges', { mode: 'json' }).$type<WorkflowEdge[]>(),

  // Source template reference
  sourceTemplateId: text('source_template_id').references(() => templates.id, {
    onDelete: 'set null',
  }),
  sourceTemplateName: text('source_template_name'),

  // Canvas state
  viewport: text('viewport', { mode: 'json' }).$type<WorkflowViewport>(),

  // Status and metadata
  status: text('status').default('draft').$type<WorkflowStatus>(),
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
  thumbnail: text('thumbnail'),

  // AI generation metadata
  aiGenerated: integer('ai_generated', { mode: 'boolean' }),
  aiModel: text('ai_model'),
  aiConfidence: integer('ai_confidence'),

  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
