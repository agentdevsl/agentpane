import type { TaskColumn } from '../db/schema';

// Strict workflow-enforced transitions between task columns.
// backlog → queued (queue for execution) or in_progress (immediate start)
// queued → in_progress (agent picks up) or backlog (dequeue)
// in_progress → waiting_approval (agent completes) or backlog (cancel)
// waiting_approval → verified (approve) or in_progress (reject) or backlog (abandon)
// verified → backlog (reopen)
export const VALID_TRANSITIONS: Record<TaskColumn, TaskColumn[]> = {
  backlog: ['queued', 'in_progress'],
  queued: ['in_progress', 'backlog'],
  in_progress: ['waiting_approval', 'backlog'],
  waiting_approval: ['verified', 'in_progress', 'backlog'],
  verified: ['backlog'],
};

export const canTransition = (from: TaskColumn, to: TaskColumn): boolean =>
  VALID_TRANSITIONS[from]?.includes(to) ?? false;

export const getValidTransitions = (from: string): TaskColumn[] =>
  VALID_TRANSITIONS[from as TaskColumn] ?? [];
