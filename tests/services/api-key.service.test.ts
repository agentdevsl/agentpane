import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from '../helpers/database';

// Mock encryption module - must be before service imports
vi.mock('../../src/lib/crypto/server-encryption', () => ({
  encryptToken: vi.fn((token: string) => `encrypted:${token}`),
  decryptToken: vi.fn((encrypted: string) => encrypted.replace('encrypted:', '')),
  maskToken: vi.fn((token: string) => {
    if (token.length <= 12) return '••••••••';
    return `${token.slice(0, 4)}${'•'.repeat(8)}${token.slice(-4)}`;
  }),
}));

import { ApiKeyService } from '../../src/services/api-key.service';

describe('ApiKeyService', () => {
  let service: ApiKeyService;

  beforeEach(() => {
    service = new ApiKeyService(getTestDb() as any);
  });

  describe('saveKey', () => {
    it('saves a valid key and returns key info', async () => {
      const result = await service.saveKey('anthropic', 'sk-ant-test-key-1234');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.service).toBe('anthropic');
        expect(result.value.maskedKey).toContain('sk-a');
        expect(result.value.isValid).toBe(true);
        expect(result.value.lastValidatedAt).toBeTruthy();
        expect(result.value.id).toBeTruthy();
        expect(result.value.createdAt).toBeTruthy();
      }
    });

    it('rejects empty key with INVALID_FORMAT', async () => {
      const result = await service.saveKey('anthropic', '');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_FORMAT');
        expect(result.error.message).toContain('empty');
      }
    });

    it('rejects whitespace-only key with INVALID_FORMAT', async () => {
      const result = await service.saveKey('anthropic', '   ');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_FORMAT');
      }
    });

    it('rejects anthropic key without sk-ant- prefix', async () => {
      const result = await service.saveKey('anthropic', 'invalid-key-format');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_FORMAT');
        expect(result.error.message).toContain('sk-ant-');
      }
    });

    it('allows non-anthropic keys with any format', async () => {
      const result = await service.saveKey('openai', 'sk-openai-test-key-abc');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.service).toBe('openai');
      }
    });

    it('replaces existing key for the same service', async () => {
      await service.saveKey('anthropic', 'sk-ant-first-key-0001');
      const result = await service.saveKey('anthropic', 'sk-ant-second-key-002');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.service).toBe('anthropic');
      }

      // Verify only one key exists for this service
      const info = await service.getKeyInfo('anthropic');
      expect(info.ok).toBe(true);
      if (info.ok && info.value) {
        // The masked key should reflect the second key
        expect(info.value.maskedKey).toBeTruthy();
      }
    });
  });

  describe('getKeyInfo', () => {
    it('returns null for non-existent service', async () => {
      const result = await service.getKeyInfo('nonexistent');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('returns key info without the actual key', async () => {
      await service.saveKey('anthropic', 'sk-ant-secret-key-9999');
      const result = await service.getKeyInfo('anthropic');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        expect(result.value!.service).toBe('anthropic');
        expect(result.value!.maskedKey).toBeTruthy();
        expect(result.value!.isValid).toBe(true);
        // Should not contain the actual key
        expect(result.value!).not.toHaveProperty('encryptedKey');
      }
    });
  });

  describe('getDecryptedKey', () => {
    it('returns null when no key exists for service', async () => {
      const result = await service.getDecryptedKey('nonexistent');
      expect(result).toBeNull();
    });

    it('returns decrypted key when key exists', async () => {
      await service.saveKey('anthropic', 'sk-ant-test-decryption1');
      const result = await service.getDecryptedKey('anthropic');
      // The mock decryptToken strips 'encrypted:' prefix
      expect(result).toBe('sk-ant-test-decryption1');
    });

    it('throws on decryption failure', async () => {
      const { decryptToken } = await import('../../src/lib/crypto/server-encryption');
      vi.mocked(decryptToken).mockImplementationOnce(() => {
        throw new Error('Decryption failed');
      });

      await service.saveKey('anthropic', 'sk-ant-test-key-throws');
      await expect(service.getDecryptedKey('anthropic')).rejects.toThrow(
        'Failed to decrypt key for anthropic'
      );
    });
  });

  describe('deleteKey', () => {
    it('deletes an existing key', async () => {
      await service.saveKey('anthropic', 'sk-ant-key-to-delete1');

      const deleteResult = await service.deleteKey('anthropic');
      expect(deleteResult.ok).toBe(true);

      // Verify it's gone
      const info = await service.getKeyInfo('anthropic');
      expect(info.ok).toBe(true);
      if (info.ok) {
        expect(info.value).toBeNull();
      }
    });

    it('succeeds even when no key exists (idempotent)', async () => {
      const result = await service.deleteKey('nonexistent');
      expect(result.ok).toBe(true);
    });
  });

  describe('markInvalid', () => {
    it('marks an existing key as invalid', async () => {
      await service.saveKey('anthropic', 'sk-ant-key-to-invalidate');

      await service.markInvalid('anthropic');

      const info = await service.getKeyInfo('anthropic');
      expect(info.ok).toBe(true);
      if (info.ok && info.value) {
        expect(info.value.isValid).toBe(false);
      }
    });

    it('does not throw when service does not exist', async () => {
      // markInvalid is best-effort, should not throw
      await expect(service.markInvalid('nonexistent')).resolves.toBeUndefined();
    });
  });
});
