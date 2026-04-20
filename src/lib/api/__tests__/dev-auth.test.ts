import { describe, expect, it } from 'vitest';
import { isDevAuthAllowed, isStrictDevEnv } from '../dev-auth.js';

// ---------------------------------------------------------------------------
// F06-05: isDevAuthAllowed — single source of truth for dev-mode bypass
// ---------------------------------------------------------------------------

describe('isDevAuthAllowed', () => {
  it('returns FALSE when NODE_ENV=production, regardless of SKIP_AUTH', () => {
    // This is the critical production safety check.
    expect(isDevAuthAllowed({ NODE_ENV: 'production', SKIP_AUTH: 'true' })).toBe(false);
    expect(isDevAuthAllowed({ NODE_ENV: 'production', SKIP_AUTH: 'false' })).toBe(false);
    expect(isDevAuthAllowed({ NODE_ENV: 'production' })).toBe(false);
  });

  it('returns TRUE only when SKIP_AUTH=true AND NODE_ENV !== production', () => {
    expect(isDevAuthAllowed({ NODE_ENV: 'development', SKIP_AUTH: 'true' })).toBe(true);
    expect(isDevAuthAllowed({ NODE_ENV: 'test', SKIP_AUTH: 'true' })).toBe(true);
    expect(isDevAuthAllowed({ NODE_ENV: 'staging', SKIP_AUTH: 'true' })).toBe(true);
    // Also when NODE_ENV is unset.
    expect(isDevAuthAllowed({ SKIP_AUTH: 'true' })).toBe(true);
  });

  it('returns FALSE when SKIP_AUTH is any value except `true`', () => {
    expect(isDevAuthAllowed({ NODE_ENV: 'development', SKIP_AUTH: 'false' })).toBe(false);
    expect(isDevAuthAllowed({ NODE_ENV: 'development', SKIP_AUTH: '1' })).toBe(false);
    expect(isDevAuthAllowed({ NODE_ENV: 'development', SKIP_AUTH: 'True' })).toBe(false);
    expect(isDevAuthAllowed({ NODE_ENV: 'development' })).toBe(false);
    expect(isDevAuthAllowed({})).toBe(false);
  });

  it('F06-05: SKIP_AUTH=true NODE_ENV=production is DENIED', () => {
    // Exact scenario from the remediation plan: setting both in prod
    // must NOT open the bypass. This is the regression we're preventing.
    expect(isDevAuthAllowed({ NODE_ENV: 'production', SKIP_AUTH: 'true' })).toBe(false);
  });

  it('F06-05: SKIP_AUTH=true NODE_ENV=development IS allowed', () => {
    expect(isDevAuthAllowed({ NODE_ENV: 'development', SKIP_AUTH: 'true' })).toBe(true);
  });
});

describe('isStrictDevEnv', () => {
  it('is true only when NODE_ENV === development', () => {
    expect(isStrictDevEnv({ NODE_ENV: 'development' })).toBe(true);
    expect(isStrictDevEnv({ NODE_ENV: 'production' })).toBe(false);
    expect(isStrictDevEnv({ NODE_ENV: 'staging' })).toBe(false);
    expect(isStrictDevEnv({ NODE_ENV: 'test' })).toBe(false);
    expect(isStrictDevEnv({})).toBe(false);
  });
});
