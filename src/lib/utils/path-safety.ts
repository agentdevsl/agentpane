import path from 'node:path';

/**
 * Result of path safety validation
 */
export type PathSafetyResult =
  | { safe: true }
  | { safe: false; reason: string; code: PathSafetyCode };

export type PathSafetyCode =
  | 'DANGEROUS_PATH'
  | 'TOO_SHALLOW'
  | 'INSUFFICIENT_DEPTH'
  | 'NOT_DIRECTORY'
  | 'PATH_NOT_FOUND';

/**
 * System directories that should never be deleted.
 * Includes both exact matches and prefix matching for child paths.
 */
export const DANGEROUS_PREFIXES = [
  '/',
  '/bin',
  '/sbin',
  '/etc',
  '/var',
  '/usr',
  '/lib',
  '/opt',
  '/root',
  '/home',
  '/Users',
  '/System',
  '/Applications',
  '/Library',
] as const;

/**
 * Validates whether a path is safe for recursive deletion.
 *
 * Safety rules:
 * 1. Path must not exactly match any system directory
 * 2. Path must have at least 3 components (e.g., /a/b/c)
 * 3. Paths under system prefixes must have at least 4 components
 *    (e.g., /Users/name/projects/myproject)
 *
 * @param inputPath - The path to validate
 * @returns PathSafetyResult indicating if the path is safe to delete
 */
export function validatePathForDeletion(inputPath: string): PathSafetyResult {
  // Resolve to absolute path and normalize to prevent traversal attacks
  const resolvedPath = path.resolve(inputPath);
  const normalizedPath = path.normalize(resolvedPath);

  const pathComponents = normalizedPath.split(path.sep).filter(Boolean);

  // Check if path exactly matches a dangerous system directory
  const isDangerousExact = DANGEROUS_PREFIXES.includes(
    normalizedPath as (typeof DANGEROUS_PREFIXES)[number]
  );

  // Paths must have at least 3 components (e.g., /home/user/something)
  const isTooShallow = pathComponents.length < 3;

  if (isDangerousExact) {
    return {
      safe: false,
      reason: 'Path matches a protected system directory',
      code: 'DANGEROUS_PATH',
    };
  }

  if (isTooShallow) {
    return {
      safe: false,
      reason: 'Path too shallow - must have at least 3 components',
      code: 'TOO_SHALLOW',
    };
  }

  // Check if path starts with any dangerous prefix
  const startsWithDangerous = DANGEROUS_PREFIXES.some(
    (prefix) => normalizedPath === prefix || normalizedPath.startsWith(prefix + path.sep)
  );

  // Paths under system prefixes must have at least 4 components
  // e.g., /Users/name/projects/myproject (4 components) is OK
  //       /Users/name/projects (3 components) is NOT OK
  if (startsWithDangerous && pathComponents.length < 4) {
    return {
      safe: false,
      reason: 'Path under system directory must have at least 4 components',
      code: 'INSUFFICIENT_DEPTH',
    };
  }

  return { safe: true };
}

/**
 * Get the normalized absolute path for validation purposes.
 * Useful for logging and debugging.
 */
export function getNormalizedPath(inputPath: string): string {
  return path.normalize(path.resolve(inputPath));
}
