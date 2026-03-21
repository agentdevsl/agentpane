/**
 * Hook for accessing application settings from the API.
 * Provides caching and easy access to common settings like task creation model and tools.
 */

import { useCallback, useState } from 'react';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
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
 * Invalidate the settings cache (call after updates)
 */
export function invalidateSettingsCache(): void {
  settingsCache = {};
  cacheTimestamp = 0;
  cachePopulated = false;
}

/**
 * Fetch settings from the API (with caching)
 * Can be used outside of React components
 */
export async function fetchSettings(keys?: string[]): Promise<Record<string, unknown>> {
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
 * Update settings via the API
 */
export async function updateSettings(settings: Record<string, unknown>): Promise<boolean> {
  const result = await apiClient.settings.update(settings);
  if (!result.ok) {
    return false;
  }

  // Update cache with new values
  Object.assign(settingsCache, settings);
  cachePopulated = true;

  return true;
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

/**
 * Set the task creation model via API
 */
export async function setTaskCreationModelAsync(model: string): Promise<boolean> {
  return updateSettings({ [SETTING_KEYS.TASK_CREATION_MODEL]: model });
}

/**
 * Set the task creation tools via API
 */
export async function setTaskCreationToolsAsync(tools: string[]): Promise<boolean> {
  return updateSettings({ [SETTING_KEYS.TASK_CREATION_TOOLS]: tools });
}

// ============================================================================
// React Hook
// ============================================================================

export interface UseSettingsState {
  /** Whether settings are being loaded */
  isLoading: boolean;
  /** Error message if loading failed */
  error: string | null;
  /** All loaded settings */
  settings: Record<string, unknown>;
  /** Task creation model (short ID) */
  taskCreationModel: string;
  /** Task creation tools */
  taskCreationTools: string[];
}

export interface UseSettingsActions {
  /** Refresh settings from the API */
  refresh: () => Promise<void>;
  /** Set the task creation model */
  setTaskCreationModel: (model: string) => Promise<boolean>;
  /** Set the task creation tools */
  setTaskCreationTools: (tools: string[]) => Promise<boolean>;
  /** Update arbitrary settings */
  updateSettings: (settings: Record<string, unknown>) => Promise<boolean>;
}

export type UseSettingsReturn = UseSettingsState & UseSettingsActions;

/**
 * React hook for accessing and updating settings
 */
export function useSettings(): UseSettingsReturn {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});

  // Load settings on mount
  useMountEffect(() => {
    const loadSettings = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await fetchSettings();
        setSettings(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load settings');
      } finally {
        setIsLoading(false);
      }
    };
    void loadSettings();
  });

  // Derived values
  const taskCreationModel =
    typeof settings[SETTING_KEYS.TASK_CREATION_MODEL] === 'string'
      ? (settings[SETTING_KEYS.TASK_CREATION_MODEL] as string)
      : DEFAULT_TASK_CREATION_MODEL;

  const taskCreationTools = Array.isArray(settings[SETTING_KEYS.TASK_CREATION_TOOLS])
    ? (settings[SETTING_KEYS.TASK_CREATION_TOOLS] as string[])
    : DEFAULT_TASK_CREATION_TOOLS;

  // Actions
  const refresh = useCallback(async () => {
    invalidateSettingsCache();
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchSettings();
      setSettings(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setTaskCreationModel = useCallback(async (model: string): Promise<boolean> => {
    const success = await setTaskCreationModelAsync(model);
    if (success) {
      setSettings((prev) => ({ ...prev, [SETTING_KEYS.TASK_CREATION_MODEL]: model }));
    }
    return success;
  }, []);

  const setTaskCreationTools = useCallback(async (tools: string[]): Promise<boolean> => {
    const success = await setTaskCreationToolsAsync(tools);
    if (success) {
      setSettings((prev) => ({ ...prev, [SETTING_KEYS.TASK_CREATION_TOOLS]: tools }));
    }
    return success;
  }, []);

  const handleUpdateSettings = useCallback(
    async (newSettings: Record<string, unknown>): Promise<boolean> => {
      const success = await updateSettings(newSettings);
      if (success) {
        setSettings((prev) => ({ ...prev, ...newSettings }));
      }
      return success;
    },
    []
  );

  return {
    isLoading,
    error,
    settings,
    taskCreationModel,
    taskCreationTools,
    refresh,
    setTaskCreationModel,
    setTaskCreationTools,
    updateSettings: handleUpdateSettings,
  };
}
