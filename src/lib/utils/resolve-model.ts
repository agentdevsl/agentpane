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
 * Resolve model short ID using cascade priority (no full ID conversion).
 * Returns the raw selected short ID without converting to full API ID.
 */
export function resolveModelShortId(context: ModelResolutionContext): string {
  const { taskModelOverride, agentModel, projectModel, globalDefault } = context;

  return taskModelOverride || agentModel || projectModel || globalDefault || DEFAULT_AGENT_MODEL;
}

/**
 * Get a human-readable description of where the resolved model came from.
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
 * Check if a model ID (short or full) is in AVAILABLE_MODELS.
 */
export function isValidModelId(modelId: string): boolean {
  return AVAILABLE_MODELS.some((m) => m.id === modelId || m.fullId === modelId);
}
