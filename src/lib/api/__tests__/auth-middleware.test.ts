import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthOptions, getAuthContext, validateUserIdMatch } from '../auth-middleware.js';

/**
 * Helper to create a Request with specific headers.
 */
function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/test', { headers });
}

describe('getAuthContext', () => {
  let originalNodeEnv: string | undefined;
  let originalSkipAuth: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalSkipAuth = process.env.SKIP_AUTH;
  });

  afterEach(() => {
    // Restore environment
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalSkipAuth === undefined) {
      delete process.env.SKIP_AUTH;
    } else {
      process.env.SKIP_AUTH = originalSkipAuth;
    }
  });

  // ─── Cookie extraction ────────────────────────────────────────────

  describe('cookie extraction', () => {
    it('should reject session cookie when no validator is provided, even in dev mode', async () => {
      process.env.NODE_ENV = 'development';
      const request = makeRequest({
        Cookie: 'agentpane_session=abc123',
      });

      const result = await getAuthContext(request);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
        expect(result.error.message).toContain('Session validation not configured');
      }
    });

    it('should reject session cookie in production when no validator is provided', async () => {
      process.env.NODE_ENV = 'production';
      const request = makeRequest({
        Cookie: 'agentpane_session=abc123',
      });

      const result = await getAuthContext(request);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
        expect(result.error.message).toContain('Session validation not configured');
      }
    });

    it('should extract session cookie when multiple cookies are present and validator succeeds', async () => {
      process.env.NODE_ENV = 'development';
      const options: AuthOptions = {
        validateSessionToken: vi.fn().mockResolvedValue('user-from-session'),
      };
      const request = makeRequest({
        Cookie: 'other=xyz; agentpane_session=mytoken99; another=123',
      });

      const result = await getAuthContext(request, options);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.authMethod).toBe('session');
        expect(result.value.userId).toBe('user-from-session');
      }
      expect(options.validateSessionToken).toHaveBeenCalledWith('mytoken99');
    });
  });

  // ─── Bearer token ─────────────────────────────────────────────────

  describe('bearer token', () => {
    it('should reject Bearer token when no validator is provided, even in dev mode', async () => {
      process.env.NODE_ENV = 'development';
      const request = makeRequest({
        Authorization: 'Bearer token123',
      });

      const result = await getAuthContext(request);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
        expect(result.error.message).toContain('API key validation not configured');
      }
    });

    it('should accept Bearer token when validator returns a userId', async () => {
      process.env.NODE_ENV = 'development';
      const options: AuthOptions = {
        validateApiKey: vi.fn().mockResolvedValue('user-from-api'),
      };
      const request = makeRequest({
        Authorization: 'Bearer valid-key',
      });

      const result = await getAuthContext(request, options);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.authMethod).toBe('api_token');
        expect(result.value.userId).toBe('user-from-api');
      }
      expect(options.validateApiKey).toHaveBeenCalledWith('valid-key');
    });

    it('should prefer session cookie over Bearer token when both are present and validators provided', async () => {
      process.env.NODE_ENV = 'development';
      const options: AuthOptions = {
        validateSessionToken: vi.fn().mockResolvedValue('session-user'),
        validateApiKey: vi.fn().mockResolvedValue('api-user'),
      };
      const request = makeRequest({
        Cookie: 'agentpane_session=sesstoken',
        Authorization: 'Bearer apitoken',
      });

      const result = await getAuthContext(request, options);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.authMethod).toBe('session');
        expect(result.value.userId).toBe('session-user');
      }
      // Only session validator should have been called
      expect(options.validateSessionToken).toHaveBeenCalledWith('sesstoken');
      expect(options.validateApiKey).not.toHaveBeenCalled();
    });

    it('should not match Authorization header without Bearer prefix', async () => {
      process.env.NODE_ENV = 'production';

      const request = makeRequest({
        Authorization: 'Basic sometoken',
      });

      const result = await getAuthContext(request);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
      }
    });
  });

  // ─── Dev mode bypass ──────────────────────────────────────────────

  describe('dev mode bypass', () => {
    it('should reject unauthenticated requests in dev mode without SKIP_AUTH=true', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.SKIP_AUTH;

      const request = makeRequest();

      const result = await getAuthContext(request);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
        expect(result.error.message).toContain('Authentication required');
      }
    });

    it('should allow unauthenticated requests in dev mode with SKIP_AUTH=true', async () => {
      process.env.NODE_ENV = 'development';
      process.env.SKIP_AUTH = 'true';

      const request = makeRequest();

      const result = await getAuthContext(request);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.authMethod).toBe('dev');
        expect(result.value.userId).toBe('dev-user');
      }
    });
  });

  // ─── Production rejection ─────────────────────────────────────────

  describe('production rejection', () => {
    it('should return UNAUTHORIZED error for unauthenticated requests in production', async () => {
      process.env.NODE_ENV = 'production';

      const request = makeRequest();

      const result = await getAuthContext(request);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
        expect(result.error.status).toBe(401);
        expect(result.error.message).toContain('Authentication required');
      }
    });

    it('should return UNAUTHORIZED when NODE_ENV is not development and no credentials', async () => {
      process.env.NODE_ENV = 'test';

      const request = makeRequest();

      const result = await getAuthContext(request);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
      }
    });
  });

  // ─── validateSessionToken option ──────────────────────────────────

  describe('validateSessionToken', () => {
    it('should reject when validateSessionToken returns null', async () => {
      const options: AuthOptions = {
        validateSessionToken: vi.fn().mockResolvedValue(null),
      };

      const request = makeRequest({
        Cookie: 'agentpane_session=badtoken',
      });

      const result = await getAuthContext(request, options);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
        expect(result.error.message).toContain('Invalid or expired session token');
        expect(result.error.status).toBe(401);
      }
      expect(options.validateSessionToken).toHaveBeenCalledWith('badtoken');
    });

    it('should accept and return userId when validateSessionToken returns a userId', async () => {
      const options: AuthOptions = {
        validateSessionToken: vi.fn().mockResolvedValue('user-42'),
      };

      const request = makeRequest({
        Cookie: 'agentpane_session=validtoken',
      });

      const result = await getAuthContext(request, options);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe('user-42');
        expect(result.value.authMethod).toBe('session');
      }
      expect(options.validateSessionToken).toHaveBeenCalledWith('validtoken');
    });
  });

  // ─── validateApiKey option ────────────────────────────────────────

  describe('validateApiKey', () => {
    it('should reject with 401 when validateApiKey returns null', async () => {
      const options: AuthOptions = {
        validateApiKey: vi.fn().mockResolvedValue(null),
      };

      const request = makeRequest({
        Authorization: 'Bearer bad-api-key',
      });

      const result = await getAuthContext(request, options);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
        expect(result.error.message).toContain('Invalid API key');
        expect(result.error.status).toBe(401);
      }
      expect(options.validateApiKey).toHaveBeenCalledWith('bad-api-key');
    });

    it('should accept and return userId when validateApiKey returns a userId', async () => {
      const options: AuthOptions = {
        validateApiKey: vi.fn().mockResolvedValue('user-99'),
      };

      const request = makeRequest({
        Authorization: 'Bearer valid-api-key',
      });

      const result = await getAuthContext(request, options);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe('user-99');
        expect(result.value.authMethod).toBe('api_token');
      }
      expect(options.validateApiKey).toHaveBeenCalledWith('valid-api-key');
    });
  });

  // ─── SKIP_AUTH ────────────────────────────────────────────────────

  describe('SKIP_AUTH', () => {
    it('should use "dev-user" userId when SKIP_AUTH=true in dev mode', async () => {
      process.env.NODE_ENV = 'development';
      process.env.SKIP_AUTH = 'true';

      const request = makeRequest();

      const result = await getAuthContext(request);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe('dev-user');
        expect(result.value.authMethod).toBe('dev');
      }
    });

    it('should not use SKIP_AUTH when not in development mode', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SKIP_AUTH = 'true';

      const request = makeRequest();

      const result = await getAuthContext(request);

      // In production with no credentials, should fail regardless of SKIP_AUTH
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
      }
    });
  });

  // ─── X-Dev-User header ───────────────────────────────────────────

  describe('X-Dev-User header', () => {
    it('should use custom userId from X-Dev-User header when SKIP_AUTH=true in dev mode', async () => {
      process.env.NODE_ENV = 'development';
      process.env.SKIP_AUTH = 'true';

      const request = makeRequest({
        'X-Dev-User': 'custom-test-user',
      });

      const result = await getAuthContext(request);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe('custom-test-user');
        expect(result.value.authMethod).toBe('dev');
      }
    });

    it('should not use X-Dev-User header without SKIP_AUTH=true in dev mode', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.SKIP_AUTH;

      const request = makeRequest({
        'X-Dev-User': 'custom-test-user',
      });

      const result = await getAuthContext(request);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
      }
    });

    it('should not use X-Dev-User header in production mode', async () => {
      process.env.NODE_ENV = 'production';

      const request = makeRequest({
        'X-Dev-User': 'custom-user',
      });

      const result = await getAuthContext(request);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
      }
    });
  });
});

// ─── validateUserIdMatch ──────────────────────────────────────────────

describe('validateUserIdMatch', () => {
  it('should return true when requestUserId is undefined', () => {
    expect(validateUserIdMatch(undefined, 'any-user')).toBe(true);
  });

  it('should return true for dev mode user (dev- prefix)', () => {
    expect(validateUserIdMatch('any-user-id', 'dev-user')).toBe(true);
  });

  it('should not allow local-dev user (no longer a valid auth identity)', () => {
    expect(validateUserIdMatch('any-user-id', 'local-dev')).toBe(false);
  });

  it('should return true when requestUserId exactly matches authUserId', () => {
    expect(validateUserIdMatch('user-42', 'user-42')).toBe(true);
  });

  it('should return true when requestUserId matches the part after the colon in authUserId', () => {
    expect(validateUserIdMatch('abcdefgh', 'session:abcdefgh')).toBe(true);
    expect(validateUserIdMatch('abcdefgh', 'token:abcdefgh')).toBe(true);
  });

  it('should return false when userIds do not match', () => {
    expect(validateUserIdMatch('user-1', 'user-2')).toBe(false);
  });

  it('should return false when requestUserId does not match the extracted part', () => {
    expect(validateUserIdMatch('wronguser', 'session:realuser')).toBe(false);
  });
});
