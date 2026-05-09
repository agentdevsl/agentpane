/**
 * Nomad Sandbox Provider Initialization
 *
 * Handles Nomad provider setup including:
 * - Loading Nomad-specific settings from database
 * - Token decryption
 * - SSRF address validation
 * - Health checks with fallback handling
 */

import { eq } from 'drizzle-orm';
import * as sqliteSchema from '../../../db/schema/sqlite/index.js';
import { decryptToken } from '../../../lib/crypto/server-encryption.js';
import { createLogger } from '../../../lib/logging/logger.js';
import type { EventEmittingSandboxProvider } from '../../../lib/sandbox/providers/sandbox-provider.js';
import type { Database } from '../../../types/database.js';
import type { SandboxState } from '../types.js';
import { ensureDefaultSandbox } from './sandbox-helpers.js';

const log = createLogger('NomadInit');

const schemaTables = { settings: sqliteSchema.settings };

/** Clear any stale `sandbox.nomad.lastError` from the settings table. */
async function clearNomadLastError(db: Database): Promise<void> {
  try {
    await db
      .delete(schemaTables.settings)
      .where(eq(schemaTables.settings.key, 'sandbox.nomad.lastError'));
  } catch (err) {
    log.debug('Failed to clear stale Nomad error (non-critical)', {
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** Persist a Nomad error message to the settings table for UI display. */
async function persistNomadLastError(db: Database, message: string): Promise<void> {
  try {
    const value = JSON.stringify({
      error: message,
      timestamp: new Date().toISOString(),
    });
    await db
      .insert(schemaTables.settings)
      .values({ key: 'sandbox.nomad.lastError', value })
      .onConflictDoUpdate({
        target: schemaTables.settings.key,
        set: { value },
      });
  } catch (persistErr) {
    log.warn('Failed to persist Nomad error', {
      error: persistErr instanceof Error ? persistErr : new Error(String(persistErr)),
    });
  }
}

/**
 * Try to initialize the Nomad sandbox provider.
 * Returns the provider if successful, null otherwise.
 */
export async function initNomadProvider(
  db: Database,
  sandboxState: SandboxState,
  nomadFallbackToDocker: boolean
): Promise<EventEmittingSandboxProvider | null> {
  try {
    // Load Nomad-specific settings
    let nomadSettings: {
      address?: string;
      token?: string;
      namespace?: string;
      region?: string;
      datacenter?: string;
      image?: string;
    } = {};

    try {
      const nomadSetting = await db.query.settings.findFirst({
        where: eq(schemaTables.settings.key, 'sandbox.nomad'),
      });
      if (nomadSetting?.value) {
        nomadSettings = JSON.parse(nomadSetting.value);
        // Decrypt the stored token (encrypted at rest)
        if (nomadSettings.token) {
          try {
            nomadSettings.token = decryptToken(nomadSettings.token);
          } catch (decryptErr) {
            log.error('Nomad token decryption failed, token must be re-entered', {
              error: decryptErr instanceof Error ? decryptErr : new Error(String(decryptErr)),
            });
            nomadSettings.token = undefined;
          }
        }
      }
    } catch (dbErr) {
      log.warn('Failed to read Nomad settings from database', {
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }

    if (!nomadSettings.address) {
      log.warn('Nomad address not configured, falling back to Docker');
      return null;
    }

    // Defense-in-depth: validate stored address at startup
    const { validateNomadAddress } = await import('../../routes/sandbox-nomad.js');
    const addrValidation = await validateNomadAddress(nomadSettings.address);
    if (!addrValidation.valid) {
      log.warn(
        `Nomad address failed SSRF validation: ${addrValidation.error}. Falling back to Docker.`
      );
      await persistNomadLastError(
        db,
        `Stored Nomad address failed security validation: ${addrValidation.error}`
      );
      return null;
    }

    const { createNomadSandboxProvider } = await import(
      '../../../lib/sandbox/providers/nomad-sandbox-provider.js'
    );
    const nomadProvider = createNomadSandboxProvider({
      address: nomadSettings.address,
      token: nomadSettings.token,
      namespace: nomadSettings.namespace,
      region: nomadSettings.region,
      datacenter: nomadSettings.datacenter,
      image: nomadSettings.image,
    });

    const health = await nomadProvider.healthCheck();
    if (health.healthy) {
      // arch29-W2-J / F04-09: when SANDBOX_DEFAULT_NETWORK_MODE=none, verify
      // the Nomad cluster supports the `network { mode = "none" }` stanza
      // before declaring the provider healthy. Fail-closed at boot so the
      // operator notices the gap rather than silently shipping sandboxes
      // with the cluster default network.
      await nomadProvider.assertNetworkIsolationSupport();

      sandboxState.nomadProvider = nomadProvider;
      log.info('Nomad sandbox provider initialized', {
        data: {
          address: nomadSettings.address,
          namespace: nomadSettings.namespace ?? 'default',
        },
      });
      await clearNomadLastError(db);
      // theme-04 P1-03: reconcile orphaned jobs before creating the default
      // sandbox so a crash-recovery doesn't leave duplicates.
      try {
        const { recovered, removed } = await nomadProvider.recover();
        if (recovered > 0 || removed > 0) {
          log.info(`Nomad sandbox recovery: ${recovered} recovered, ${removed} purged`);
        }
      } catch (recoverErr) {
        log.warn('Nomad sandbox recovery failed (continuing bootstrap)', {
          error: recoverErr instanceof Error ? recoverErr : new Error(String(recoverErr)),
        });
      }
      await ensureDefaultSandbox(nomadProvider, 'Nomad', db);
      return nomadProvider;
    }

    const diagnosis = health.message ?? 'Nomad cluster health check failed';
    const willFallback = nomadFallbackToDocker;
    const logFn = willFallback ? log.warn : log.error;
    logFn(
      `Nomad provider unhealthy: ${diagnosis}.${willFallback ? ' Falling back to Docker.' : ' No fallback configured - sandbox operations will be unavailable.'}`
    );
    await persistNomadLastError(db, diagnosis);
    return null;
  } catch (error) {
    // arch29-W2-J / F04-09: if the operator explicitly requested
    // SANDBOX_DEFAULT_NETWORK_MODE=none and Nomad cannot enforce a
    // network-mode-none stanza, re-throw so bootstrap fails loudly rather
    // than silently falling back to a no-isolation Docker provider. This is
    // intentionally fail-closed.
    if ((error as { code?: string }).code === 'NOMAD-800') {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const willFallback = nomadFallbackToDocker;

    const { NomadApiError, ConnectionError } = await import('@agentpane/nomad-sandbox-sdk');
    const isInfraError = error instanceof NomadApiError || error instanceof ConnectionError;
    const logFn = isInfraError && willFallback ? log.warn : log.error;
    logFn(
      `Nomad provider init failed: ${message}.${willFallback ? ' Falling back to Docker.' : ' No fallback configured - sandbox operations will be unavailable.'}`
    );
    await persistNomadLastError(db, message);
    return null;
  }
}
