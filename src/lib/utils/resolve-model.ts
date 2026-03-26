import { DEFAULT_AGENT_MODEL, getFullModelId } from '@/lib/constants/models';

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
