/**
 * Settings utilities for accessing application settings from the API.
 * Provides caching and easy access to common settings like task creation model and tools.
 */

import { apiClient } from '@/lib/api/client';
import { DEFAULT_TASK_CREATION_MODEL, getFullModelId } from '@/lib/constants/models';
import { DEFAULT_TASK_CREATION_TOOLS } from '@/lib/constants/tools';

// Setting keys
export const SETTING_KEYS = {
  TASK_CREATION_MODEL: 'task_creation_model',
  TASK_CREATION_TOOLS: 'task_creation_tools',
  AGENT_TOOLS: 'agent_tools',
  WORKFLOW_TOOLS: 'workflow_tools',
  ANTHROPIC_BASE_URL: 'anthropic_base_url',
} as const;

// Cache for settings to avoid refetching on every render
let settingsCache: Record<string, unknown> = {};
let cacheTimestamp = 0;
let cachePopulated = false;
const CACHE_TTL_MS = 30000; // 30 seconds

// Inflight request deduplication
let inflightRequest: Promise<Record<string, unknown>> | null = null;

/**
 * Check if the cache is still valid
 */
function isCacheValid(): boolean {
  return cachePopulated && Date.now() - cacheTimestamp < CACHE_TTL_MS;
}

/**
 * Fetch settings from the API (with caching)
 * Can be used outside of React components
 */
async function fetchSettings(keys?: string[]): Promise<Record<string, unknown>> {
  // Check cache first
  if (isCacheValid()) {
    if (!keys) {
      return settingsCache;
    }
    // Check if all requested keys are in cache
    const allKeysInCache = keys.every((key) => key in settingsCache);
    if (allKeysInCache) {
      return keys.reduce(
        (acc, key) => {
          acc[key] = settingsCache[key];
          return acc;
        },
        {} as Record<string, unknown>
      );
    }
  }

  // Deduplicate concurrent requests
  if (inflightRequest) {
    const cached = await inflightRequest;
    if (keys) {
      return keys.reduce(
        (acc, key) => {
          acc[key] = cached[key];
          return acc;
        },
        {} as Record<string, unknown>
      );
    }
    return cached;
  }

  inflightRequest = (async () => {
    try {
      // Fetch from API
      const result = await apiClient.settings.get(keys);
      if (!result.ok) {
        return {};
      }

      // Update cache
      if (!keys) {
        // Full fetch - replace cache entirely
        settingsCache = result.data.settings;
        cacheTimestamp = Date.now();
        cachePopulated = true;
      } else {
        // Partial fetch - merge into cache
        Object.assign(settingsCache, result.data.settings);
        cachePopulated = true;
        // Only update timestamp if this was our first fetch
        if (!cacheTimestamp) {
          cacheTimestamp = Date.now();
        }
      }

      return result.data.settings;
    } finally {
      inflightRequest = null;
    }
  })();

  return inflightRequest;
}

/**
 * Get the task creation model from API (async version)
 * Falls back to default if API call fails
 */
export async function getTaskCreationModelAsync(): Promise<string> {
  const settings = await fetchSettings([SETTING_KEYS.TASK_CREATION_MODEL]);
  const model = settings[SETTING_KEYS.TASK_CREATION_MODEL];
  if (typeof model === 'string') {
    return getFullModelId(model);
  }
  return getFullModelId(DEFAULT_TASK_CREATION_MODEL);
}

/**
 * Get the task creation tools from API (async version)
 * Falls back to default if API call fails
 */
export async function getTaskCreationToolsAsync(): Promise<string[]> {
  const settings = await fetchSettings([SETTING_KEYS.TASK_CREATION_TOOLS]);
  const tools = settings[SETTING_KEYS.TASK_CREATION_TOOLS];
  if (Array.isArray(tools)) {
    return tools as string[];
  }
  return DEFAULT_TASK_CREATION_TOOLS;
}
