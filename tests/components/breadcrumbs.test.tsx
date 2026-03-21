import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type BreadcrumbItem, Breadcrumbs } from '@/app/components/features/breadcrumbs';

// Mock TanStack Router Link component
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
    className?: string;
  }) => (
    <a href={to} data-params={JSON.stringify(params)} className={className}>
      {children}
    </a>
  ),
}));

describe('Breadcrumbs', () => {
  it('renders breadcrumb items', () => {
    const items: BreadcrumbItem[] = [
      { label: 'Home' },
      { label: 'Projects' },
      { label: 'AgentPane' },
    ];

    render(<Breadcrumbs items={items} />);

    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('AgentPane')).toBeInTheDocument();
  });

  it('last item has different styling (text-fg)', () => {
    const items: BreadcrumbItem[] = [{ label: 'Home' }, { label: 'Current Page' }];

    render(<Breadcrumbs items={items} />);

    const lastItem = screen.getByText('Current Page');
    expect(lastItem).toHaveClass('text-fg');
  });

  it('non-last items have muted styling (text-fg-muted)', () => {
    const items: BreadcrumbItem[] = [
      { label: 'Home' },
      { label: 'Projects' },
      { label: 'Current Page' },
    ];

    render(<Breadcrumbs items={items} />);

    const homeItem = screen.getByText('Home');
    const projectsItem = screen.getByText('Projects');
    expect(homeItem).toHaveClass('text-fg-muted');
    expect(projectsItem).toHaveClass('text-fg-muted');
  });

  it('renders links for items with to prop', () => {
    const items: BreadcrumbItem[] = [
      { label: 'Home', to: '/' },
      { label: 'Projects', to: '/codespaces' },
      { label: 'Current Page' },
    ];

    render(<Breadcrumbs items={items} />);

    const homeLink = screen.getByRole('link', { name: 'Home' });
    const projectsLink = screen.getByRole('link', { name: 'Projects' });
    const currentPage = screen.getByText('Current Page');

    expect(homeLink).toHaveAttribute('href', '/');
    expect(projectsLink).toHaveAttribute('href', '/codespaces');
    expect(currentPage.tagName).toBe('SPAN');
  });

  it('renders links with params', () => {
    const items: BreadcrumbItem[] = [
      { label: 'Project', to: '/codespaces/$codespaceId', params: { codespaceId: 'proj-123' } },
    ];

    render(<Breadcrumbs items={items} />);

    const link = screen.getByRole('link', { name: 'Project' });
    expect(link).toHaveAttribute('data-params', JSON.stringify({ codespaceId: 'proj-123' }));
  });
});
