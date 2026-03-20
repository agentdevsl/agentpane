export interface AgentExecutionContext {
  agentId: string;
  taskId: string;
  maxTurns: number;
  currentTurn: number;
}

export type RecoveryAction = 'pause' | 'fail';

export interface RecoveryResult {
  shouldRetry: boolean;
  action: RecoveryAction;
  message: string;
}

export function handleAgentError(error: Error, context: AgentExecutionContext): RecoveryResult {
  const errorMessage = error.message.toLowerCase();

  // Rate limit - pause and retry later
  if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
    return {
      shouldRetry: true,
      action: 'pause',
      message: 'Rate limited. Agent will resume after cooldown.',
    };
  }

  // Turn limit reached - expected completion
  if (context.currentTurn >= context.maxTurns) {
    return {
      shouldRetry: false,
      action: 'pause',
      message: `Turn limit reached (${context.maxTurns}). Task moved to waiting approval.`,
    };
  }

  // Unknown error - fail
  return {
    shouldRetry: false,
    action: 'fail',
    message: `Agent execution failed: ${error.message}`,
  };
}
