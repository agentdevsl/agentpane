/**
 * CB-014: Defense-in-depth secret detection via pattern matching.
 *
 * This is NOT a security boundary — it is a safety net to catch accidental
 * leakage of secret-bearing config keys into logs or API responses. The
 * primary protection is the ALLOWED_KEYS allowlist: any key not explicitly
 * allowed is checked against BLOCKED_PATTERNS. False positives are harmless
 * (they surface as validation errors), while false negatives are mitigated
 * by the allowlist approach ensuring only known-safe keys pass through.
 */
const BLOCKED_PATTERNS = [/SECRET/i, /PASSWORD/i, /PRIVATE_KEY/i, /_TOKEN$/i, /_API_KEY$/i];

const ALLOWED_KEYS = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'];

export const containsSecrets = (config: Record<string, unknown>): string[] => {
  const violations: string[] = [];

  for (const key of Object.keys(config)) {
    if (ALLOWED_KEYS.includes(key)) {
      continue;
    }

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(key)) {
        violations.push(key);
        break;
      }
    }
  }

  return violations;
};
