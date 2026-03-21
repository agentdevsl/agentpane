import { useCallback, useState } from 'react';
import { useTimeout } from './use-timeout';

/**
 * Copy text to clipboard with a timed "copied" indicator.
 * `copied` resets to false after 2 seconds automatically.
 */
export function useCopyToClipboard(resetMs = 2000): {
  copied: boolean;
  copy: (text: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);

  useTimeout(() => setCopied(false), copied ? resetMs : null);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
    }
  }, []);

  return { copied, copy };
}
