/**
 * Sandbox Helper Functions
 *
 * Shared utilities for sandbox initialization across providers.
 */

import { eq } from 'drizzle-orm';
import * as sqliteSchema from '../../../db/schema/sqlite/index.js';
import { createLogger } from '../../../lib/logging/logger.js';
import type { SandboxConfig } from '../../../lib/sandbox/types.js';
import { SANDBOX_DEFAULTS } from '../../../lib/sandbox/types.js';
import type { Database } from '../../../types/database.js';

const log = createLogger('SandboxHelpers');

const schemaTables = {
  settings: sqliteSchema.settings,
};

/** Load sandbox defaults from the database settings table. */
export async function loadSandboxDefaultsFromDb(db: Database): Promise<{
  image?: string;
  memoryMb?: number;
  cpuCores?: number;
  idleTimeoutMinutes?: number;
} | null> {
  try {
    const globalDefaults = await db.query.settings.findFirst({
      where: eq(schemaTables.settings.key, 'sandbox.defaults'),
    });
    if (globalDefaults?.value) {
      return JSON.parse(globalDefaults.value) as {
        image?: string;
        memoryMb?: number;
        cpuCores?: number;
        idleTimeoutMinutes?: number;
      };
    }
  } catch (settingsErr) {
    log.warn('Failed to load sandbox settings (using defaults)', {
      error: settingsErr instanceof Error ? settingsErr : new Error(String(settingsErr)),
    });
  }
  return null;
}

/**
 * Ensure a default sandbox exists for the given provider.
 * Shared between K8s, Nomad, and Docker providers (identical lifecycle logic).
 */
export async function ensureDefaultSandbox(
  provider: {
    get(codespaceId: string): Promise<{ status: string; stop(): Promise<void> } | null>;
    create(config: SandboxConfig): Promise<unknown>;
  },
  label: string,
  db: Database
): Promise<void> {
  try {
    const existingDefault = await provider.get('default');

    if (
      existingDefault &&
      (existingDefault.status === 'error' || existingDefault.status === 'stopped')
    ) {
      log.info(`Default ${label} sandbox in terminal state, recreating`, {
        data: { status: existingDefault.status },
      });
      if (existingDefault.status === 'error') {
        try {
          await existingDefault.stop();
        } catch (stopErr) {
          log.warn(`Failed to stop error-state default ${label} sandbox during recreation`, {
            error: stopErr instanceof Error ? stopErr : new Error(String(stopErr)),
          });
        }
      }
      // Fall through to create
    } else if (existingDefault) {
      return; // Healthy default exists
    }

    const defaults = await loadSandboxDefaultsFromDb(db);
    await provider.create({
      codespaceId: 'default',
      codespacePath: '/workspace',
      image: defaults?.image ?? SANDBOX_DEFAULTS.image,
      memoryMb: defaults?.memoryMb ?? 2048,
      cpuCores: defaults?.cpuCores ?? 2,
      idleTimeoutMinutes: defaults?.idleTimeoutMinutes ?? 30,
      volumeMounts: [],
    });
    log.info(`Default ${label} sandbox created`);
  } catch (createErr) {
    log.error(`Failed to create default ${label} sandbox`, {
      error: createErr instanceof Error ? createErr : new Error(String(createErr)),
    });
  }
}
