import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from '@/app/components/features/empty-state';

describe('EmptyState', () => {
  it('renders preset content', () => {
    render(<EmptyState preset="no-projects" />);

    expect(screen.getByText('No Projects')).toBeInTheDocument();
    expect(
      screen.getByText('Create a project to start organizing your tasks and agents')
    ).toBeInTheDocument();
  });

  it('renders custom title and subtitle', () => {
    render(<EmptyState title="Custom Title" subtitle="Custom subtitle text" />);

    expect(screen.getByText('Custom Title')).toBeInTheDocument();
    expect(screen.getByText('Custom subtitle text')).toBeInTheDocument();
  });

  it('renders primaryAction button', () => {
    const onClick = vi.fn();
    render(<EmptyState preset="no-tasks" primaryAction={{ label: 'Add Task', onClick }} />);

    expect(screen.getByRole('button', { name: 'Add Task' })).toBeInTheDocument();
  });

  it('calls onClick when primaryAction button clicked', () => {
    const onClick = vi.fn();
    render(<EmptyState preset="no-tasks" primaryAction={{ label: 'Add Task', onClick }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Task' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
