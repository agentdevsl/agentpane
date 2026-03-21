import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentConfigDialog } from '@/app/components/features/agent-config-dialog';
import type { Agent } from '@/db/schema';

const createAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: overrides.id ?? 'agent-1',
  codespaceId: overrides.codespaceId ?? 'project-1',
  name: overrides.name ?? 'Test Agent',
  type: overrides.type ?? 'task',
  status: overrides.status ?? 'idle',
  config: overrides.config ?? {
    allowedTools: ['Read', 'Edit'],
    maxTurns: 50,
    model: 'claude-sonnet-4',
    systemPrompt: 'You are a helpful agent.',
    temperature: 0.2,
  },
  currentTaskId: overrides.currentTaskId ?? null,
  currentSessionId: overrides.currentSessionId ?? null,
  currentTurn: overrides.currentTurn ?? 0,
  createdAt: overrides.createdAt ?? new Date(),
  updatedAt: overrides.updatedAt ?? new Date(),
});

describe('AgentConfigDialog', () => {
  it('renders the dialog with agent name', () => {
    render(
      <AgentConfigDialog
        agent={createAgent({ name: 'Code Assistant' })}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    expect(screen.getByText('Configure Code Assistant')).toBeInTheDocument();
    expect(screen.getByText('Fine tune tools, model, and system prompts.')).toBeInTheDocument();
  });

  it('shows max turns and temperature sliders in Execution tab', () => {
    const agent = createAgent({
      config: {
        allowedTools: [],
        maxTurns: 100,
        temperature: 0.5,
      },
    });

    render(<AgentConfigDialog agent={agent} open onOpenChange={vi.fn()} onSave={vi.fn()} />);

    expect(screen.getByText('Max turns')).toBeInTheDocument();
    expect(screen.getByText('Temperature')).toBeInTheDocument();

    const maxTurnsSlider = screen.getByRole('slider', { name: 'Max turns' });
    expect(maxTurnsSlider).toHaveValue('100');

    const temperatureSlider = screen.getByRole('slider', { name: 'Temperature' });
    expect(temperatureSlider).toHaveValue('50');

    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('0.50')).toBeInTheDocument();
  });

  it('shows tool checkboxes in Tools tab', async () => {
    const user = userEvent.setup();

    render(
      <AgentConfigDialog agent={createAgent()} open onOpenChange={vi.fn()} onSave={vi.fn()} />
    );

    await user.click(screen.getByRole('tab', { name: 'Tools' }));

    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText('Web')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();

    expect(screen.getByRole('checkbox', { name: 'Read' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Write' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Glob' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Grep' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Bash' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'WebFetch' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Task' })).toBeInTheDocument();
  });

  it('allows toggling tools', async () => {
    const user = userEvent.setup();
    const agent = createAgent({
      config: {
        allowedTools: ['Read'],
        maxTurns: 50,
      },
    });

    render(<AgentConfigDialog agent={agent} open onOpenChange={vi.fn()} onSave={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Tools' }));

    const readCheckbox = screen.getByRole('checkbox', { name: 'Read' });
    const editCheckbox = screen.getByRole('checkbox', { name: 'Edit' });

    expect(readCheckbox).toBeChecked();
    expect(editCheckbox).not.toBeChecked();

    await user.click(editCheckbox);
    expect(editCheckbox).toBeChecked();

    await user.click(readCheckbox);
    expect(readCheckbox).not.toBeChecked();
  });

  it('calls onSave with updated configuration', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    const agent = createAgent({
      config: {
        allowedTools: ['Read'],
        maxTurns: 50,
        temperature: 0.2,
      },
    });

    render(<AgentConfigDialog agent={agent} open onOpenChange={onOpenChange} onSave={onSave} />);

    fireEvent.change(screen.getByRole('slider', { name: 'Max turns' }), {
      target: { value: '100' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          maxTurns: 100,
          allowedTools: ['Read'],
        })
      );
    });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('shows system prompt in Prompt tab', async () => {
    const user = userEvent.setup();
    const agent = createAgent({
      config: {
        allowedTools: [],
        maxTurns: 50,
        systemPrompt: 'You are a coding expert.',
      },
    });

    render(<AgentConfigDialog agent={agent} open onOpenChange={vi.fn()} onSave={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Prompt' }));

    expect(screen.getByText('System prompt')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('You are a coding expert.');
  });

  it('closes dialog when Cancel is clicked', () => {
    const onOpenChange = vi.fn();

    render(
      <AgentConfigDialog agent={createAgent()} open onOpenChange={onOpenChange} onSave={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('displays all three tabs', () => {
    render(
      <AgentConfigDialog agent={createAgent()} open onOpenChange={vi.fn()} onSave={vi.fn()} />
    );

    expect(screen.getByRole('tab', { name: 'Execution' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Prompt' })).toBeInTheDocument();
  });

  it('uses default values when agent config is undefined', () => {
    const agent = createAgent({ config: undefined });

    render(<AgentConfigDialog agent={agent} open onOpenChange={vi.fn()} onSave={vi.fn()} />);

    const maxTurnsSlider = screen.getByRole('slider', { name: 'Max turns' });
    expect(maxTurnsSlider).toHaveValue('50');

    const temperatureSlider = screen.getByRole('slider', { name: 'Temperature' });
    expect(temperatureSlider).toHaveValue('20');
  });
});
