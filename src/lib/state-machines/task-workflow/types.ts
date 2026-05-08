export type TaskColumn = 'backlog' | 'queued' | 'in_progress' | 'waiting_approval' | 'verified';

export type TaskWorkflowState = TaskColumn;

export type TaskWorkflowContext = {
  taskId: string;
  column: TaskColumn;
  agentId?: string;
  diffSummary?: { filesChanged: number } | null;
  runningAgents: number;
  maxConcurrentAgents: number;
};

export type TaskWorkflowEvent =
  | { type: 'QUEUE' }
  | { type: 'DEQUEUE' }
  | { type: 'ASSIGN'; agentId: string }
  | { type: 'COMPLETE' }
  | { type: 'APPROVE' }
  | { type: 'REJECT'; reason?: string }
  | { type: 'CANCEL' }
  | { type: 'REOPEN' };
