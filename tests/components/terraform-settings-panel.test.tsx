import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerraform } from '../../src/app/components/features/terraform/terraform-context';
import { TerraformSettingsPanel } from '../../src/app/components/features/terraform/terraform-settings-panel';
import { apiClient } from '../../src/lib/api/client';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../../src/lib/api/client', () => ({
  apiClient: {
    settings: {
      update: vi.fn(),
    },
    terraform: {
      createRegistry: vi.fn(),
      updateRegistry: vi.fn(),
      deleteRegistry: vi.fn(),
    },
  },
}));

vi.mock('../../src/app/components/features/terraform/terraform-context', () => ({
  useTerraform: vi.fn(),
}));

describe('TerraformSettingsPanel', () => {
  const refreshModules = vi.fn().mockResolvedValue(undefined);
  const syncRegistry = vi.fn().mockResolvedValue(undefined);
  const clearError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useTerraform).mockReturnValue({
      registries: [
        {
          id: 'reg-1',
          name: 'Acme Registry',
          orgName: 'acme-org',
          hasToken: true,
          status: 'active',
          lastSyncedAt: null,
          syncError: null,
          moduleCount: 6,
          syncIntervalMinutes: 15,
          nextSyncAt: null,
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
        },
      ],
      syncRegistry,
      refreshModules,
      error: null,
      clearError,
    } as never);

    vi.mocked(apiClient.terraform.updateRegistry).mockResolvedValue({
      ok: true,
      data: {
        id: 'reg-1',
        name: 'Acme Registry',
        orgName: 'acme-org',
        hasToken: true,
        status: 'active',
        syncIntervalMinutes: 15,
        updatedAt: '2026-03-16T00:00:00.000Z',
      },
    });
  });

  it('hydrates existing registry fields on first render', async () => {
    render(<TerraformSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Organization Name/i)).toHaveValue('acme-org');
    });

    expect(screen.getByLabelText(/Sync Interval/i)).toHaveValue('15');
  });

  it('saves through the terraform registry API without writing raw token settings directly', async () => {
    const user = userEvent.setup();

    render(<TerraformSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Organization Name/i)).toHaveValue('acme-org');
    });

    await user.click(screen.getByRole('button', { name: /Save Settings/i }));

    await waitFor(() => {
      expect(apiClient.terraform.updateRegistry).toHaveBeenCalledTimes(1);
    });

    const updatePayload = vi.mocked(apiClient.terraform.updateRegistry).mock
      .calls[0]?.[1] as Record<string, unknown>;

    expect(updatePayload.orgName).toBe('acme-org');
    expect(updatePayload.syncIntervalMinutes).toBe(15);
    expect(updatePayload.tokenSettingKey).toBeUndefined();
    expect(apiClient.settings.update).not.toHaveBeenCalled();
    expect(refreshModules).toHaveBeenCalledTimes(1);
  });
});
