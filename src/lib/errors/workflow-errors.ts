import { createError } from './base.js';

export const WorkflowErrors = {
  NOT_FOUND: (id: string) =>
    createError('WORKFLOW_NOT_FOUND', `Workflow with id '${id}' not found`, 404, { id }),
  CREATE_FAILED: createError('WORKFLOW_CREATE_FAILED', 'Failed to create workflow', 500),
  UPDATE_FAILED: createError('WORKFLOW_UPDATE_FAILED', 'Failed to update workflow', 500),
  DATABASE_ERROR: (message: string) => createError('WORKFLOW_DATABASE_ERROR', message, 500),
} as const;

export type WorkflowError =
  | ReturnType<typeof WorkflowErrors.NOT_FOUND>
  | typeof WorkflowErrors.CREATE_FAILED
  | typeof WorkflowErrors.UPDATE_FAILED
  | ReturnType<typeof WorkflowErrors.DATABASE_ERROR>;
