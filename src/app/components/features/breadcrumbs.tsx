import { CaretRight } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils/cn';

export type BreadcrumbItem = {
  label: string;
  to?: string;
  params?: Record<string, string>;
};

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  className?: string;
}

export function Breadcrumbs({ items, className }: BreadcrumbsProps): React.JSX.Element {
  return (
    <nav
      className={cn('flex items-center gap-2 text-xs text-fg-muted', className)}
      data-testid="breadcrumbs"
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        const isHomeLink = item.to === '/codespaces';
        const isCodespaceLink = Boolean(item.to?.startsWith('/codespaces/') && !isHomeLink);
        const linkTestId = isHomeLink
          ? 'breadcrumb-home'
          : isCodespaceLink
            ? 'breadcrumb-codespace'
            : undefined;
        return (
          <div key={`${item.label}-${index}`} className="flex items-center gap-2">
            {item.to ? (
              <Link
                to={item.to}
                params={item.params}
                className="text-fg-muted transition hover:text-fg"
                data-testid={linkTestId}
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={cn(isLast ? 'text-fg' : 'text-fg-muted')}
                data-testid={isLast ? 'breadcrumb-current' : undefined}
              >
                {item.label}
              </span>
            )}
            {!isLast && (
              <CaretRight className="h-3 w-3 text-fg-subtle" data-testid="breadcrumb-separator" />
            )}
          </div>
        );
      })}
    </nav>
  );
}
