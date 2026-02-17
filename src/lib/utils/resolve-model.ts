import { AVAILABLE_MODELS, DEFAULT_AGENT_MODEL, getFullModelId } from '@/lib/constants/models';

export interface ModelResolutionContext {
  /** Model override from task */
  taskModelOverride?: string | null;
  /** Model from agent config */
  agentModel?: string | null;
  /** Model from project config */
  projectModel?: string | null;
  /** Global default from user preferences */
  globalDefault?: string | null;
}

/**
 * Resolve model ID using cascade priority:
 * Task.modelOverride → Agent.config.model → Project.config.model → Global preference → Hardcoded default
 *
 * @returns The full API model ID (e.g., 'claude-sonnet-4-6')
 */
export function resolveModel(context: ModelResolutionContext): string {
  const { taskModelOverride, agentModel, projectModel, globalDefault } = context;

  // Follow cascade priority
  const selectedModel =
    taskModelOverride || agentModel || projectModel || globalDefault || DEFAULT_AGENT_MODEL;

  // Convert short ID to full API ID
  return getFullModelId(selectedModel);
}

/**
 * Resolve model ID and return short ID (not full API ID).
 * Useful for display purposes.
 */
export function resolveModelShortId(context: ModelResolutionContext): string {
  const { taskModelOverride, agentModel, projectModel, globalDefault } = context;

  return taskModelOverride || agentModel || projectModel || globalDefault || DEFAULT_AGENT_MODEL;
}

/**
 * Get the source of the resolved model for display purposes.
 */
export function getModelSource(context: ModelResolutionContext): string {
  const { taskModelOverride, agentModel, projectModel, globalDefault } = context;

  if (taskModelOverride) return 'Task override';
  if (agentModel) return 'Agent config';
  if (projectModel) return 'Project config';
  if (globalDefault) return 'Global preference';
  return 'Default';
}

/**
 * Validate that a model ID is valid.
 */
export function isValidModelId(modelId: string): boolean {
  return AVAILABLE_MODELS.some((m) => m.id === modelId || m.fullId === modelId);
}
