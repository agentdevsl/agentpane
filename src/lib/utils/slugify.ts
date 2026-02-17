/**
 * Slugify a string for use in branch names and identifiers.
 *
 * - Converts to lowercase
 * - Replaces spaces and special chars with hyphens
 * - Removes consecutive hyphens
 * - Truncates to maxLength
 */
export function slugify(str: string, maxLength = 40): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, maxLength)
    .replace(/-+$/, '');
}
