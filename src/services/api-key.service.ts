import { eq } from 'drizzle-orm';
import { apiKeys } from '../db/schema';
import { decryptToken, encryptToken, maskToken } from '../lib/crypto/server-encryption.js';
import { ServiceErrors } from '../lib/errors/service-errors.js';
import { createLogger } from '../lib/logging/logger.js';
import { errorMessage } from '../lib/utils/error-message.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

const log = createLogger('ApiKeyService');

export type ApiKeyError =
  | { code: 'INVALID_FORMAT'; message: string }
  | { code: 'VALIDATION_FAILED'; message: string }
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'STORAGE_ERROR'; message: string };

export type ApiKeyInfo = {
  id: string;
  service: string;
  maskedKey: string;
  isValid: boolean;
  lastValidatedAt: string | null;
  createdAt: string;
};

export class ApiKeyService {
  constructor(private db: Database) {}

  /**
   * Save an API key for a specific service (encrypted).
   *
   * F03-09 (arch29-W2-C): when `refreshToken` is supplied (OAuth grant flow),
   * it is encrypted with the same AES-GCM key as the access token and stored
   * in `encrypted_refresh_token`. Subsequent agent-runner invocations read it
   * via {@link getDecryptedRefreshToken} and pipe it through to the SDK so the
   * access token can be silently rotated mid-run.
   */
  async saveKey(
    service: string,
    key: string,
    refreshToken?: string | null
  ): Promise<Result<ApiKeyInfo, ApiKeyError>> {
    // Basic validation
    if (!key || key.trim().length === 0) {
      return err({
        code: 'INVALID_FORMAT',
        message: 'API key cannot be empty',
      });
    }

    // Validate format for known services
    if (service === 'anthropic' && !key.startsWith('sk-ant-')) {
      return err({
        code: 'INVALID_FORMAT',
        message: 'Anthropic API keys must start with "sk-ant-"',
      });
    }

    try {
      // Delete existing key for this service
      await this.db.delete(apiKeys).where(eq(apiKeys.service, service));

      // Encrypt and store
      const encrypted = await encryptToken(key);
      const masked = maskToken(key);

      // Encrypt refresh token only when one was supplied. An empty string is
      // treated the same as null so callers cannot accidentally persist an
      // unusable empty-string token (the SDK rejects empty strings).
      const encryptedRefreshToken =
        refreshToken && refreshToken.trim().length > 0 ? await encryptToken(refreshToken) : null;

      const [saved] = await this.db
        .insert(apiKeys)
        .values({
          service,
          encryptedKey: encrypted,
          maskedKey: masked,
          isValid: true,
          lastValidatedAt: new Date().toISOString(),
          encryptedRefreshToken,
        })
        .returning();

      if (!saved) {
        return err({
          code: 'STORAGE_ERROR',
          message: 'Failed to save API key',
        });
      }

      return ok({
        id: saved.id,
        service: saved.service,
        maskedKey: saved.maskedKey,
        isValid: saved.isValid ?? true,
        lastValidatedAt: saved.lastValidatedAt,
        createdAt: saved.createdAt,
      });
    } catch (error) {
      return err({
        code: 'STORAGE_ERROR',
        message: `Failed to save API key: ${errorMessage(error)}`,
      });
    }
  }

  /**
   * Get the API key info for a service (without the actual key)
   */
  async getKeyInfo(service: string): Promise<Result<ApiKeyInfo | null, ApiKeyError>> {
    try {
      const key = await this.db.query.apiKeys.findFirst({
        where: eq(apiKeys.service, service),
      });

      if (!key) {
        return ok(null);
      }

      return ok({
        id: key.id,
        service: key.service,
        maskedKey: key.maskedKey,
        isValid: key.isValid ?? true,
        lastValidatedAt: key.lastValidatedAt,
        createdAt: key.createdAt,
      });
    } catch (error) {
      return err({
        code: 'STORAGE_ERROR',
        message: `Failed to get API key: ${errorMessage(error)}`,
      });
    }
  }

  /**
   * Get the decrypted API key for a service
   * Returns null if no key exists, throws on decryption errors
   */
  async getDecryptedKey(service: string): Promise<string | null> {
    const key = await this.db.query.apiKeys.findFirst({
      where: eq(apiKeys.service, service),
    });

    if (!key) {
      return null;
    }

    try {
      return decryptToken(key.encryptedKey);
    } catch (error) {
      log.warn('Failed to decrypt API key', { error });
      throw ServiceErrors.DECRYPT_FAILED(service);
    }
  }

  /**
   * F03-09 (arch29-W2-C): get the decrypted OAuth refresh token for a service.
   *
   * Returns `null` when:
   *   - no api_keys row exists for the service
   *   - the row has no `encrypted_refresh_token` (legacy rows, non-OAuth keys,
   *     or rows saved before this column existed).
   *
   * Decryption errors are logged and surfaced as `null` rather than throwing
   * because a missing/corrupt refresh token is recoverable: the agent-runner
   * simply runs without one (degrading silent rotation, not breaking startup).
   * The access-token equivalent throws because absence there is fatal.
   */
  async getDecryptedRefreshToken(service: string): Promise<string | null> {
    const row = await this.db.query.apiKeys.findFirst({
      where: eq(apiKeys.service, service),
    });

    if (!row?.encryptedRefreshToken) {
      return null;
    }

    try {
      return decryptToken(row.encryptedRefreshToken);
    } catch (error) {
      log.warn('Failed to decrypt OAuth refresh token (continuing without)', {
        data: { service, error: error instanceof Error ? error.message : String(error) },
      });
      return null;
    }
  }

  /**
   * Delete the API key for a service
   */
  async deleteKey(service: string): Promise<Result<void, ApiKeyError>> {
    try {
      await this.db.delete(apiKeys).where(eq(apiKeys.service, service));
      return ok(undefined);
    } catch (error) {
      return err({
        code: 'STORAGE_ERROR',
        message: `Failed to delete API key: ${errorMessage(error)}`,
      });
    }
  }

  /**
   * Mark a key as invalid (e.g., after API returns 401)
   * Logs errors but does not throw - this is a best-effort update
   */
  async markInvalid(service: string): Promise<void> {
    try {
      await this.db
        .update(apiKeys)
        .set({ isValid: false, updatedAt: new Date().toISOString() })
        .where(eq(apiKeys.service, service));
    } catch (error) {
      log.warn('Failed to mark API key as invalid', {
        error: error instanceof Error ? error.message : String(error),
        data: { service },
      });
    }
  }
}
