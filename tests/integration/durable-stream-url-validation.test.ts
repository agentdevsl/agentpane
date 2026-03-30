import { describe, expect, it } from 'vitest';

/**
 * Validates that all client-side durable stream URLs are constructed as absolute URLs.
 *
 * The @durable-streams/client `stream()` function uses `new URL(url)` which
 * requires an absolute URL in the browser. Relative URLs like `/v1/stream/...`
 * cause `TypeError: Failed to construct 'URL': Invalid URL`.
 *
 * This test statically analyses the source files to catch regressions.
 */
describe('Durable stream URL validation', () => {
  const CLIENT_STREAM_FILES = [
    'src/app/components/features/terraform/terraform-context.tsx',
    'src/app/components/features/plan-session-view/use-plan-session.ts',
    'src/lib/streams/client.ts',
  ];

  it.each(
    CLIENT_STREAM_FILES
  )('%s: durableStream() calls must use absolute URLs', async (filePath) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const fullPath = path.resolve(filePath);
    const content = await fs.readFile(fullPath, 'utf-8');

    // Find all direct durableStream({ url: ... }) calls (not class constructors)
    const streamCallRegex = /durableStream\(\{\s*\n?\s*url:\s*([^,\n}]+)/g;
    let match: RegExpExecArray | null = null;
    const urlExpressions: string[] = [];

    // biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop
    while ((match = streamCallRegex.exec(content)) !== null) {
      urlExpressions.push(match[1].trim());
    }

    // Each URL expression must NOT be a bare relative path (starting with ` or ')
    for (const expr of urlExpressions) {
      // A relative path would look like: `/v1/stream/...` or `'/v1/stream/...'`
      const isRelativeLiteral = /^[`'"]\//.test(expr);
      expect(
        isRelativeLiteral,
        `Found relative URL in durableStream() call: ${expr}\n` +
          `File: ${filePath}\n` +
          `durableStream() requires absolute URLs (new URL() fails on relative paths in browsers).\n` +
          `Fix: prefix with window.location.origin, e.g. \`\${window.location.origin}/v1/stream/...\``
      ).toBe(false);
    }

    // Verify we actually found stream calls in the expected files
    if (filePath.includes('terraform-context') || filePath.includes('use-plan-session')) {
      expect(
        urlExpressions.length,
        `Expected to find durableStream() calls in ${filePath}`
      ).toBeGreaterThan(0);
    }
  });
});
