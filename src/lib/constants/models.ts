/**
 * Default Anthropic API base URL.
 * Can be overridden via ANTHROPIC_BASE_URL environment variable.
 */
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Get the Anthropic API base URL from environment or localStorage.
 */
export function getAnthropicBaseUrl(): string {
  // Server-side: check environment variable
  if (typeof window === 'undefined') {
    return process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL;
  }
  // Client-side: check localStorage
  return localStorage.getItem('anthropic_base_url') ?? DEFAULT_ANTHROPIC_BASE_URL;
}

/** @deprecated Use DEFAULT_ANTHROPIC_BASE_URL instead */
export const DEFAULT_API_ENDPOINT = DEFAULT_ANTHROPIC_BASE_URL;

/**
 * Available AI models for agent execution and AI features.
 */
export const AVAILABLE_MODELS = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    fullId: 'claude-opus-4-6',
    description: 'Latest and most capable, best for complex tasks',
  },
  {
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5',
    fullId: 'claude-opus-4-5-20251101',
    description: 'Highly capable, great for complex tasks',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    fullId: 'claude-sonnet-4-6',
    description: 'Smart model for complex agents and coding',
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    fullId: 'claude-haiku-4-5-20251001',
    description: 'Fastest with near-frontier intelligence',
  },
] as const;

/** Default model for agent execution */
export const DEFAULT_AGENT_MODEL = 'claude-opus-4-6';

/** Default model for workflow designer AI */
export const DEFAULT_WORKFLOW_MODEL = 'claude-haiku-4-5';

/** Default model for task creation AI */
export const DEFAULT_TASK_CREATION_MODEL = 'claude-sonnet-4-6';

/**
 * Get the task creation model from environment or localStorage.
 * This is the synchronous version for backwards compatibility.
 * Prefer using getTaskCreationModelAsync() in new code.
 */
export function getTaskCreationModel(): string {
  // Server-side or test environment: check environment variable
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    const envModel = process.env.TASK_CREATION_MODEL;
    if (envModel) return getFullModelId(envModel);
    return getFullModelId(DEFAULT_TASK_CREATION_MODEL);
  }
  // Client-side: check localStorage
  try {
    const storedModel = localStorage.getItem('task_creation_model');
    return storedModel ? getFullModelId(storedModel) : getFullModelId(DEFAULT_TASK_CREATION_MODEL);
  } catch {
    // localStorage may be blocked or unavailable
    return getFullModelId(DEFAULT_TASK_CREATION_MODEL);
  }
}

/**
 * Get the task creation model from the API (async version).
 * Falls back to localStorage/default if API call fails.
 * Use this in React components and async contexts.
 */
export async function getTaskCreationModelAsync(): Promise<string> {
  // Server-side: use environment variable
  if (typeof window === 'undefined') {
    const envModel = process.env.TASK_CREATION_MODEL;
    if (envModel) return getFullModelId(envModel);
    return getFullModelId(DEFAULT_TASK_CREATION_MODEL);
  }

  // Client-side: use the settings hook helper
  const { getTaskCreationModelAsync: fetchFromApi } = await import('@/lib/hooks/use-settings');
  return fetchFromApi();
}

/** Model ID type from available models */
export type ModelId = (typeof AVAILABLE_MODELS)[number]['id'];

/** Full model ID type for API calls */
export type FullModelId = (typeof AVAILABLE_MODELS)[number]['fullId'];

/**
 * Migration map for deprecated model IDs.
 * Maps old short/full IDs to their current replacements.
 */
const MODEL_MIGRATION_MAP: Record<string, string> = {
  'claude-sonnet-4': 'claude-sonnet-4-6',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  'claude-sonnet-4-5': 'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6',
  'claude-opus-4': 'claude-opus-4-5',
  'claude-opus-4-20250514': 'claude-opus-4-5-20251101',
  'claude-haiku-3-5': 'claude-haiku-4-5',
  'claude-haiku-4-5-20250414': 'claude-haiku-4-5-20251001',
};

/**
 * Get the full API model ID from a short model ID.
 * Handles migration of deprecated model IDs to their current replacements.
 */
export function getFullModelId(shortId: string): string {
  const migrated = MODEL_MIGRATION_MAP[shortId];
  if (migrated) {
    console.warn(`[Models] Migrating deprecated model ID '${shortId}' to '${migrated}'`);
    return getFullModelId(migrated);
  }
  const model = AVAILABLE_MODELS.find((m) => m.id === shortId);
  if (model) return model.fullId;

  // Check if it's already a known full ID
  const knownFull = AVAILABLE_MODELS.find((m) => m.fullId === shortId);
  if (knownFull) return shortId;

  console.warn(`[Models] Unknown model ID '${shortId}' — passing through as-is`);
  return shortId;
}

/**
 * Get a model by its short ID.
 */
export function getModelById(shortId: string) {
  return AVAILABLE_MODELS.find((m) => m.id === shortId);
}
