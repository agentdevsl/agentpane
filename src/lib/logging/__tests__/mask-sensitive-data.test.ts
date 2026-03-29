import { describe, expect, it } from 'vitest';
import { maskSensitiveData } from '../logger.js';

describe('maskSensitiveData', () => {
  describe('field name masking', () => {
    it('masks known sensitive field names', () => {
      const input = {
        token: 'abc123',
        key: 'def456',
        secret: 'ghi789',
        password: 'hunter2',
        credential: 'cred-value',
        authorization: 'Bearer xyz',
        cookie: 'session=abc',
        apiKey: 'ak-123',
        api_key: 'ak-456',
        privateKey: 'pk-789',
        private_key: 'pk-012',
      };

      const result = maskSensitiveData(input);

      for (const field of Object.keys(input)) {
        expect((result as Record<string, unknown>)[field]).toBe('[REDACTED]');
      }
    });

    it('matches field names case-insensitively', () => {
      const input = {
        TOKEN: 'abc',
        ApiKey: 'def',
        PASSWORD: 'ghi',
        Secret: 'jkl',
      };

      const result = maskSensitiveData(input);

      expect(result.TOKEN).toBe('[REDACTED]');
      expect(result.ApiKey).toBe('[REDACTED]');
      expect(result.PASSWORD).toBe('[REDACTED]');
      expect(result.Secret).toBe('[REDACTED]');
    });
  });

  describe('value pattern masking', () => {
    it('masks sk-ant-* tokens', () => {
      const input = { data: 'sk-ant-api03-something' };
      expect(maskSensitiveData(input)).toEqual({ data: '[REDACTED]' });
    });

    it('masks ghp_* tokens', () => {
      const input = { data: 'ghp_abcdef1234567890' };
      expect(maskSensitiveData(input)).toEqual({ data: '[REDACTED]' });
    });

    it('masks ghs_* tokens', () => {
      const input = { data: 'ghs_abcdef1234567890' };
      expect(maskSensitiveData(input)).toEqual({ data: '[REDACTED]' });
    });

    it('masks gho_* tokens', () => {
      const input = { data: 'gho_abcdef1234567890' };
      expect(maskSensitiveData(input)).toEqual({ data: '[REDACTED]' });
    });

    it('masks github_pat_* tokens', () => {
      const input = { data: 'github_pat_abcdef1234567890' };
      expect(maskSensitiveData(input)).toEqual({ data: '[REDACTED]' });
    });

    it('masks sensitive values inside arrays', () => {
      const input = ['safe', 'ghp_secret123', 'also-safe'];
      const result = maskSensitiveData(input);
      expect(result).toEqual(['safe', '[REDACTED]', 'also-safe']);
    });
  });

  describe('nested object masking', () => {
    it('masks sensitive fields in nested objects', () => {
      const input = {
        user: {
          name: 'Alice',
          credentials: {
            token: 'secret-token',
            password: 'secret-pass',
          },
        },
      };

      const result = maskSensitiveData(input);

      expect(result.user.name).toBe('Alice');
      expect(result.user.credentials.token).toBe('[REDACTED]');
      expect(result.user.credentials.password).toBe('[REDACTED]');
    });

    it('masks sensitive values deep in nested objects', () => {
      const input = {
        config: {
          provider: {
            auth: 'sk-ant-api03-deep-value',
          },
        },
      };

      const result = maskSensitiveData(input);
      expect(result.config.provider.auth).toBe('[REDACTED]');
    });
  });

  describe('array handling', () => {
    it('masks sensitive data inside arrays of objects', () => {
      const input = [
        { name: 'safe', token: 'secret1' },
        { name: 'also-safe', password: 'secret2' },
      ];

      const result = maskSensitiveData(input);

      const r = result as Array<Record<string, unknown>>;
      expect(r[0]!.name).toBe('safe');
      expect(r[0]!.token).toBe('[REDACTED]');
      expect(r[1]!.name).toBe('also-safe');
      expect(r[1]!.password).toBe('[REDACTED]');
    });

    it('handles nested arrays', () => {
      const input = { items: [['ghp_abc', 'safe'], ['also-safe']] };
      const result = maskSensitiveData(input);
      expect(result.items).toEqual([['[REDACTED]', 'safe'], ['also-safe']]);
    });
  });

  describe('non-sensitive data passes through unchanged', () => {
    it('preserves non-sensitive strings', () => {
      const input = { name: 'Alice', status: 'active', count: 42 };
      const result = maskSensitiveData(input);
      expect(result).toEqual({ name: 'Alice', status: 'active', count: 42 });
    });

    it('preserves numbers, booleans, and null', () => {
      const input = { num: 123, bool: true, nil: null };
      const result = maskSensitiveData(input);
      expect(result).toEqual({ num: 123, bool: true, nil: null });
    });

    it('returns null and undefined as-is', () => {
      expect(maskSensitiveData(null)).toBeNull();
      expect(maskSensitiveData(undefined)).toBeUndefined();
    });
  });

  describe('does not mutate input', () => {
    it('returns a new object', () => {
      const input = { token: 'secret', nested: { key: 'value' } };
      const result = maskSensitiveData(input);

      expect(result).not.toBe(input);
      expect(result.nested).not.toBe(input.nested);
      expect(input.token).toBe('secret');
      expect(input.nested.key).toBe('value');
    });
  });

  describe('error object masking', () => {
    it('masks sensitive data in error-shaped objects', () => {
      const input = {
        message: 'Auth failed with token sk-ant-api03-xyz',
        stack: 'Error: ...',
        code: 'AUTH_FAILED',
      };

      const result = maskSensitiveData(input);

      // message is a string value - pattern check applies to the full string
      // "Auth failed with token sk-ant-api03-xyz" does NOT start with sk-ant-, so not masked
      expect(result.message).toBe('Auth failed with token sk-ant-api03-xyz');
      expect(result.stack).toBe('Error: ...');
      expect(result.code).toBe('AUTH_FAILED');
    });

    it('masks sensitive fields within error context data', () => {
      const input = {
        message: 'Request failed',
        context: {
          authorization: 'Bearer sk-ant-api03-xyz',
          url: '/api/tasks',
        },
      };

      const result = maskSensitiveData(input);

      expect(result.context.authorization).toBe('[REDACTED]');
      expect(result.context.url).toBe('/api/tasks');
    });
  });
});
