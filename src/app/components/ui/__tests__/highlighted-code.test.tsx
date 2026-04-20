/**
 * F06-11: HighlightedCode sanitiser regression tests.
 *
 * Shiki is considered safe for current versions but an upstream CVE or
 * grammar-specific escape gap would affect every dangerously-rendered
 * Shiki HTML in the app. The shared wrapper runs DOMPurify on every
 * HTML string so the browser never sees an unsanitised payload.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HighlightedCode, sanitizeShikiHtml } from '../highlighted-code';

describe('sanitizeShikiHtml', () => {
  it('F06-11: strips <script> tags', () => {
    const hostile = '<pre><code><script>alert(1)</script>x</code></pre>';
    const safe = sanitizeShikiHtml(hostile);
    expect(safe).not.toContain('<script');
    expect(safe).not.toContain('alert(1)');
  });

  it('F06-11: strips onerror= / onclick= event handlers', () => {
    const hostile = '<pre><code><span class="x" onerror="alert(1)">y</span></code></pre>';
    const safe = sanitizeShikiHtml(hostile);
    expect(safe).not.toContain('onerror');
    expect(safe).not.toContain('alert(1)');
    // The structural markup survives.
    expect(safe).toContain('<span');
    expect(safe).toContain('class="x"');
  });

  it('F06-11: strips <img src=x onerror=alert(1)> payload', () => {
    // Exact payload called out in the remediation plan.
    const hostile = '<pre><code><img src=x onerror=alert(1)></code></pre>';
    const safe = sanitizeShikiHtml(hostile);
    expect(safe).not.toContain('<img');
    expect(safe).not.toContain('onerror');
    expect(safe).not.toContain('alert(1)');
  });

  it('preserves Shiki-style <pre>/<code>/<span> markup with class and style', () => {
    const legit =
      '<pre class="shiki" style="background:#0d1117;" tabindex="0"><code><span class="line"><span style="color:#ff7b72">const</span> x</span></code></pre>';
    const safe = sanitizeShikiHtml(legit);
    expect(safe).toContain('<pre');
    expect(safe).toContain('class="shiki"');
    expect(safe).toContain('style="background:#0d1117;"');
    expect(safe).toContain('tabindex="0"');
    expect(safe).toContain('<code>');
    expect(safe).toContain('<span');
  });
});

describe('HighlightedCode', () => {
  it('F06-11: renders sanitised HTML when html is provided', () => {
    const hostile = '<pre><code><img src=x onerror=alert(1)>ok</code></pre>';
    const { container } = render(<HighlightedCode html={hostile} fallback={<pre>FALLBACK</pre>} />);
    // The root div must exist with NO <img> and NO onerror attribute.
    const div = container.querySelector('div');
    expect(div).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    // Check every element's attributes for onerror.
    const elements = container.querySelectorAll('*');
    for (const el of Array.from(elements)) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name).not.toBe('onerror');
      }
    }
  });

  it('renders fallback when html is null', () => {
    const { container } = render(<HighlightedCode html={null} fallback={<pre>FALLBACK</pre>} />);
    expect(container.textContent).toContain('FALLBACK');
  });
});
