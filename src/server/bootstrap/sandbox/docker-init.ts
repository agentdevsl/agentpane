/**
 * Docker Sandbox Provider Initialization
 *
 * Handles Docker provider setup as the default/fallback provider.
 * Includes container recovery and default sandbox creation.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../../lib/logging/logger.js';
import { createDockerProvider } from '../../../lib/sandbox/index.js';
import type { EventEmittingSandboxProvider } from '../../../lib/sandbox/providers/sandbox-provider.js';
import { SANDBOX_DEFAULTS } from '../../../lib/sandbox/types.js';
import type { Database } from '../../../types/database.js';
import { loadSandboxDefaultsFromDb } from './sandbox-helpers.js';

const log = createLogger('DockerInit');

/**
 * Try to initialize the Docker sandbox provider.
 * Returns the provider if successful, null if Docker is unavailable.
 */
export async function initDockerProvider(
  db: Database
): Promise<EventEmittingSandboxProvider | null> {
  try {
    const dockerProvider = createDockerProvider();
    log.info('Docker provider initialized');

    // Recover existing containers from previous runs
    const { recovered, removed } = await dockerProvider.recover();
    if (recovered > 0 || removed > 0) {
      log.info(`Container recovery: ${recovered} recovered, ${removed} stale removed`);
    }

    // Create default sandbox
    try {
      const existingDefault = await dockerProvider.get('default');
      if (!existingDefault) {
        const defaults = await loadSandboxDefaultsFromDb(db);
        const defaultImage = defaults?.image ?? SANDBOX_DEFAULTS.image;
        log.info('Checking for default sandbox image', {
          data: { image: defaultImage },
        });

        const imageAvailable = await dockerProvider.isImageAvailable(defaultImage);
        log.info('Image availability check', {
          data: { imageAvailable },
        });

        if (imageAvailable) {
          try {
            const defaultWorkspacePath = path.join(
              process.cwd(),
              'data',
              'sandbox-workspaces',
              'default'
            );
            await fs.mkdir(defaultWorkspacePath, { recursive: true });

            await dockerProvider.create({
              codespaceId: 'default',
              codespacePath: defaultWorkspacePath,
              image: defaultImage,
              memoryMb: defaults?.memoryMb ?? 2048,
              cpuCores: defaults?.cpuCores ?? 2,
              idleTimeoutMinutes: defaults?.idleTimeoutMinutes ?? 30,
              volumeMounts: [],
            });
            log.info('Default global sandbox created');
          } catch (createErr) {
            log.warn('Failed to create default sandbox', {
              error: createErr,
            });
          }
        } else {
          log.info('Default sandbox image not available, skipping default sandbox creation', {
            data: { image: defaultImage },
          });
        }
      } else {
        log.info('Default global sandbox already exists');
      }
    } catch (sandboxErr) {
      log.warn('Failed to setup default sandbox (container agent still available)', {
        error: sandboxErr instanceof Error ? sandboxErr : new Error(String(sandboxErr)),
      });
    }

    return dockerProvider;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isExpectedError =
      message.includes('ENOENT') ||
      message.includes('connect ECONNREFUSED') ||
      message.includes('permission denied') ||
      message.includes('Cannot connect to Docker');

    if (isExpectedError) {
      log.info('Docker not available (expected), container agent service disabled');
    } else {
      log.error(`Docker initialization failed with unexpected error: ${message}`);
    }
    return null;
  }
}
