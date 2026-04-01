/**
 * Markdown Content Renderer
 *
 * Renders markdown content with proper styling for code blocks,
 * lists, headings, and other formatting.
 */

import { isValidElement, type ReactNode, useState } from 'react';
import Markdown from 'react-markdown';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';

const shikiPromise = import('shiki');

function extractTextContent(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(extractTextContent).join('');
  }

  if (isValidElement(value)) {
    return extractTextContent((value.props as { children?: ReactNode }).children);
  }

  return '';
}

function getLanguage(className?: string): string {
  const match = /language-([\w-]+)/.exec(className ?? '');
  return match?.[1] ?? 'text';
}

function MarkdownCodeBlock({ children }: { children: ReactNode }): React.JSX.Element {
  const child = Array.isArray(children) ? children[0] : children;
  const childProps = isValidElement(child)
    ? (child.props as { children?: ReactNode; className?: string })
    : null;
  const code = extractTextContent(childProps?.children ?? children).replace(/\n$/, '');
  const language = getLanguage(childProps?.className);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useWatchEffect(() => {
    if (!code) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;
    shikiPromise
      .then(({ codeToHtml }) =>
        codeToHtml(code, {
          lang: language,
          themes: {
            light: 'github-light-default',
            dark: 'github-dark-default',
          },
        }).then((result) => {
          if (!cancelled) {
            setHighlightedHtml(result);
          }
        })
      )
      .catch(() => {
        if (!cancelled) {
          setHighlightedHtml(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (highlightedHtml) {
    return (
      <div
        className="overflow-x-auto rounded-md border border-border bg-surface-muted p-3 text-xs leading-relaxed [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_code]:font-mono"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki escapes code input and returns safe HTML
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    );
  }

  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-surface-muted p-3 font-mono text-xs">
      <code>{code}</code>
    </pre>
  );
}

interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: MarkdownContentProps): React.JSX.Element {
  // Convert escaped newlines and tabs to actual characters for proper rendering
  const processedContent = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

  return (
    <div className={cn('min-w-0 break-words text-fg', className)}>
      <Markdown
        components={{
          // Code blocks and inline code
          pre({ children }) {
            return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
          },
          code({ children, className, ...props }) {
            const isInline = !className;
            if (isInline) {
              return (
                <code
                  className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-accent"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className="font-mono text-xs text-fg" {...props}>
                {children}
              </code>
            );
          },
          // Paragraphs
          p({ children, ...props }) {
            return (
              <p className="mb-2 text-fg last:mb-0" {...props}>
                {children}
              </p>
            );
          },
          // Lists
          ul({ children, ...props }) {
            return (
              <ul className="mb-2 list-disc pl-4 last:mb-0" {...props}>
                {children}
              </ul>
            );
          },
          ol({ children, ...props }) {
            return (
              <ol className="mb-2 list-decimal pl-4 last:mb-0" {...props}>
                {children}
              </ol>
            );
          },
          li({ children, ...props }) {
            return (
              <li className="mb-1 text-fg" {...props}>
                {children}
              </li>
            );
          },
          // Headings
          h1({ children, ...props }) {
            return (
              <h1 className="mb-2 text-lg font-semibold text-fg" {...props}>
                {children}
              </h1>
            );
          },
          h2({ children, ...props }) {
            return (
              <h2 className="mb-2 text-base font-semibold text-fg" {...props}>
                {children}
              </h2>
            );
          },
          h3({ children, ...props }) {
            return (
              <h3 className="mb-1 text-sm font-semibold text-fg" {...props}>
                {children}
              </h3>
            );
          },
          // Links
          a({ children, href, ...props }) {
            return (
              <a
                href={href}
                className="text-accent underline hover:text-accent/80"
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            );
          },
          // Blockquotes
          blockquote({ children, ...props }) {
            return (
              <blockquote
                className="border-l-2 border-accent/50 pl-3 italic text-fg-muted"
                {...props}
              >
                {children}
              </blockquote>
            );
          },
          // Horizontal rule
          hr({ ...props }) {
            return <hr className="my-3 border-border" {...props} />;
          },
          // Strong/bold
          strong({ children, ...props }) {
            return (
              <strong className="font-semibold text-fg" {...props}>
                {children}
              </strong>
            );
          },
          // Emphasis/italic
          em({ children, ...props }) {
            return (
              <em className="italic" {...props}>
                {children}
              </em>
            );
          },
        }}
      >
        {processedContent}
      </Markdown>
    </div>
  );
}
