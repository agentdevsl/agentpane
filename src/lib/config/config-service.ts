import fs from 'node:fs/promises';
import path from 'node:path';
import { createError } from '../errors/base.js';
import { deepMerge } from '../utils/deep-merge.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import { codespaceConfigSchema } from './schemas.js';
import { type CodespaceConfig, DEFAULT_CODESPACE_CONFIG } from './types.js';
import { containsSecrets } from './validate-secrets.js';

export type CodespaceConfigResult = Result<CodespaceConfig, ReturnType<typeof createError>>;

export type LoadedConfig = {
  codespace: CodespaceConfig;
};

/**
 * Load the per-codespace `.claude/settings.json` from the given codespace path.
 *
 * arch29-W3-D (F12-06): the parameter was named `projectPath` after the
 * project→codespace rename was incomplete. Renamed to `codespacePath` to
 * match the function name and the rest of the API surface.
 */
export const loadCodespaceConfigFrom = async ({
  codespacePath,
}: {
  codespacePath: string;
}): Promise<CodespaceConfigResult> => {
  const codespaceConfigPath = path.join(codespacePath, '.claude', 'settings.json');

  try {
    const content = await fs.readFile(codespaceConfigPath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const validated = codespaceConfigSchema.parse(parsed);

    const merged = deepMerge(DEFAULT_CODESPACE_CONFIG, validated);

    return ok(merged);
    // nosemgrep: agentpane.error-masking.catch-returns-ok-helper
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok(DEFAULT_CODESPACE_CONFIG);
    }

    return err(
      createError('CODESPACE_CONFIG_INVALID', 'Invalid configuration', 400, {
        error: String(error),
      })
    );
  }
};

const parseEnvNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

/**
 * Load the codespace config from disk and merge env overrides.
 *
 * arch29-W3-D (F12-06): parameter renamed `projectPath` → `codespacePath`.
 */
export const loadCodespaceConfig = async ({
  codespacePath,
}: {
  codespacePath: string;
}): Promise<Result<LoadedConfig, ReturnType<typeof createError>>> => {
  // CB-013: ANTHROPIC_API_KEY is no longer checked at config loading time.
  // Non-agent operations (codespace listing, settings, etc.) do not require an API key.
  // The key is validated at agent execution time instead (see api.ts key resolution).

  const baseConfigResult = await loadCodespaceConfigFrom({ codespacePath });
  if (!baseConfigResult.ok) {
    return baseConfigResult;
  }

  const envOverrides: Partial<CodespaceConfig> = {
    maxTurns: parseEnvNumber(process.env.AGENTPANE_MAX_TURNS, baseConfigResult.value.maxTurns),
  };

  const merged = deepMerge(baseConfigResult.value, envOverrides);
  const envKeys = Object.keys(envOverrides).reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = envOverrides[key as keyof CodespaceConfig];
    return acc;
  }, {});

  const secrets = containsSecrets(envKeys);

  if (secrets.length > 0) {
    return err(
      createError('CONFIG_SECRET_DETECTED', 'Configuration contains secrets', 400, {
        keys: secrets,
      })
    );
  }

  return ok({ codespace: merged });
};
