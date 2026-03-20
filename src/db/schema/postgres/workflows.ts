import { createId } from '@paralleldrive/cuid2';
import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { WorkflowEdge, WorkflowNode } from '@/lib/workflow-dsl/types';
import { templates } from './templates';

export type { WorkflowEdge, WorkflowNode };

export const WORKFLOW_STATUSES = ['draft', 'published', 'archived'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export type WorkflowViewport = {
  x: number;
  y: number;
  zoom: number;
};

export const workflows = pgTable('workflows', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  description: text('description'),
  nodes: jsonb('nodes').$type<WorkflowNode[]>(),
  edges: jsonb('edges').$type<WorkflowEdge[]>(),
  sourceTemplateId: text('source_template_id').references(() => templates.id, {
    onDelete: 'set null',
  }),
  sourceTemplateName: text('source_template_name'),
  viewport: jsonb('viewport').$type<WorkflowViewport>(),
  status: text('status').default('draft').$type<WorkflowStatus>(),
  tags: jsonb('tags').$type<string[]>(),
  thumbnail: text('thumbnail'),
  aiGenerated: boolean('ai_generated'),
  aiModel: text('ai_model'),
  aiConfidence: integer('ai_confidence'),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
