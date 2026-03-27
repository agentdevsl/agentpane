/**
 * Codespace configuration service.
 *
 * Loads configuration from:
 * 1. File: .claude/settings.json in the project directory
 * 2. Environment variables (AGENTPANE_MAX_TURNS, etc.)
 * 3. Defaults from DEFAULT_CODESPACE_CONFIG
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import { codespaceConfigSchema } from './schemas.js';
import { type CodespaceConfig, DEFAULT_CODESPACE_CONFIG } from './types.js';

interface ConfigError {
  code: string;
  message: string;
}

interface LoadConfigOptions {
  projectPath: string;
}

/**
 * Load the raw codespace config from file, merged with defaults.
 * Returns the flat CodespaceConfig object.
 */
export async function loadCodespaceConfigFrom(
  options: LoadConfigOptions
): Promise<Result<CodespaceConfig, ConfigError>> {
  const settingsPath = path.join(options.projectPath, '.claude', 'settings.json');

  let fileConfig: Record<string, unknown> = {};

  try {
    const content = await fs.readFile(settingsPath, 'utf-8');
    try {
      fileConfig = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return err({
        code: 'CODESPACE_CONFIG_INVALID',
        message: 'Configuration file contains invalid JSON',
      });
    }
  } catch (error: unknown) {
    const fsError = error as { code?: string };
    if (fsError.code !== 'ENOENT') {
      return err({
        code: 'CODESPACE_CONFIG_INVALID',
        message: `Failed to read configuration file: ${String(error)}`,
      });
    }
    // File doesn't exist, use defaults only
  }

  // Merge file config with defaults
  const merged = { ...DEFAULT_CODESPACE_CONFIG, ...fileConfig };

  // Validate against schema
  const parseResult = codespaceConfigSchema.safeParse(merged);
  if (!parseResult.success) {
    return err({
      code: 'CODESPACE_CONFIG_INVALID',
      message: `Configuration validation failed: ${parseResult.error.message}`,
    });
  }

  return ok(parseResult.data as CodespaceConfig);
}

/**
 * Load full codespace config including environment variable overrides.
 * Returns a wrapper with codespace config under `.codespace`.
 */
export async function loadCodespaceConfig(
  options: LoadConfigOptions
): Promise<Result<{ codespace: CodespaceConfig }, ConfigError>> {
  const configResult = await loadCodespaceConfigFrom(options);

  if (!configResult.ok) {
    return configResult as Result<never, ConfigError>;
  }

  const config = { ...configResult.value };

  // Apply environment variable overrides
  const maxTurnsEnv = process.env.AGENTPANE_MAX_TURNS;
  if (maxTurnsEnv) {
    const parsed = Number.parseInt(maxTurnsEnv, 10);
    if (!Number.isNaN(parsed) && parsed >= 1) {
      config.maxTurns = parsed;
    }
    // If invalid, keep the file/default value
  }

  return ok({ codespace: config });
}
