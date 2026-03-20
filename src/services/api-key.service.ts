import { eq } from 'drizzle-orm';
import { apiKeys } from '../db/schema';
import { decryptToken, encryptToken, maskToken } from '../lib/crypto/server-encryption.js';
import { ServiceErrors } from '../lib/errors/service-errors.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

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
   * Save an API key for a specific service (encrypted)
   */
  async saveKey(service: string, key: string): Promise<Result<ApiKeyInfo, ApiKeyError>> {
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

      const [saved] = await this.db
        .insert(apiKeys)
        .values({
          service,
          encryptedKey: encrypted,
          maskedKey: masked,
          isValid: true,
          lastValidatedAt: new Date().toISOString(),
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
      console.error(`[ApiKeyService] Failed to decrypt key for ${service}:`, error);
      throw ServiceErrors.DECRYPT_FAILED(service);
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
      console.error(`[ApiKeyService] Failed to mark key as invalid for ${service}:`, error);
    }
  }
}
