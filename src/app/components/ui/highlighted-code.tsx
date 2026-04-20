/**
 * HighlightedCode — shared wrapper around Shiki-produced HTML (F06-11).
 *
 * Both `MarkdownContent` and `TerraformRightPanel` render Shiki output via
 * `dangerouslySetInnerHTML`. Shiki is considered safe for current versions,
 * but the input code originates from LLM-generated or user-pasted content
 * and the surrounding markdown renderer escapes HTML by default. A single
 * Shiki regression (or grammar-specific escape gap) would affect both
 * panels. Routing through a shared wrapper gives us one place to respond
 * to a future CVE.
 *
 * Defense-in-depth: every HTML string passes through DOMPurify before
 * reaching the DOM, so even if Shiki produces an unsafe token the browser
 * never sees it.
 */

import DOMPurify, { type Config } from 'dompurify';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { cn } from '@/lib/utils/cn';

export interface HighlightedCodeProps {
  /** Shiki-produced HTML string, or null when highlighting hasn't completed. */
  html: string | null;
  /**
   * Fallback rendered when `html` is null. Caller supplies a `<pre>` with
   * the raw code so the layout doesn't jump when Shiki finishes.
   */
  fallback: ReactNode;
  /** Extra className applied to the wrapping div when rendering HTML. */
  className?: string;
}

/**
 * Allow the CSS classes and inline styles Shiki emits, plus the `<pre>`,
 * `<code>`, `<span>` elements in its output. Reject anything else — in
 * particular, DOMPurify strips `<script>`, `<img>`, and all event
 * handlers like `onerror=`/`onclick=` even if a Shiki regression managed
 * to emit them.
 */
const SANITISER_CONFIG: Config = {
  ALLOWED_TAGS: ['pre', 'code', 'span', 'div'],
  ALLOWED_ATTR: ['class', 'style', 'tabindex'],
  // Block event handlers explicitly. DOMPurify drops these by default but
  // we enumerate for clarity.
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus'],
  ALLOW_DATA_ATTR: false,
};

/**
 * Run DOMPurify against a Shiki HTML string. Exported so tests (and
 * future non-React callers) can exercise the sanitiser without rendering.
 */
export function sanitizeShikiHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITISER_CONFIG) as unknown as string;
}

export function HighlightedCode({
  html,
  fallback,
  className,
}: HighlightedCodeProps): React.JSX.Element {
  const sanitised = useMemo(() => (html ? sanitizeShikiHtml(html) : null), [html]);

  if (!sanitised) {
    return <>{fallback}</>;
  }

  return (
    <div
      className={cn('min-w-0', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML passed through DOMPurify (F06-11)
      dangerouslySetInnerHTML={{ __html: sanitised }}
    />
  );
}
