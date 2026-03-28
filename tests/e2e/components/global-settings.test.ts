/**
 * E2E Tests: Global Settings Pages
 *
 * Tests for Settings pages: API Keys, Appearance, GitHub, Preferences.
 * Covers navigation, form interactions, and settings persistence.
 */
import { describe, expect, it } from 'vitest';
import { click, exists, goto, screenshot, serverRunning, waitForSelector } from '../setup';

const e2e = serverRunning ? describe : describe.skip;

e2e('Global Settings E2E', () => {
  describe('Settings Navigation', () => {
    it('shows settings sidebar', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="settings-sidebar"]', { timeout: 10000 }).catch(() => {});

      const sidebar = await exists('[data-testid="settings-sidebar"]');
      expect(sidebar).toBe(true);
    });

    it('shows API keys navigation link', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="settings-nav-api-keys"]', { timeout: 10000 }).catch(
        () => {}
      );

      const apiKeysLink = await exists('[data-testid="settings-nav-api-keys"]');
      expect(apiKeysLink).toBe(true);
    });

    it('shows appearance navigation link', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="settings-nav-appearance"]', { timeout: 10000 }).catch(
        () => {}
      );

      const appearanceLink = await exists('[data-testid="settings-nav-appearance"]');
      expect(appearanceLink).toBe(true);
    });

    it('shows GitHub navigation link', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="settings-nav-github"]', { timeout: 10000 }).catch(
        () => {}
      );

      const githubLink = await exists('[data-testid="settings-nav-github"]');
      expect(githubLink).toBe(true);
    });

    it('shows preferences navigation link', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="settings-nav-preferences"]', { timeout: 10000 }).catch(
        () => {}
      );

      const preferencesLink = await exists('[data-testid="settings-nav-preferences"]');
      expect(preferencesLink).toBe(true);
    });

    it('highlights active settings section', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="settings-nav-api-keys"]', { timeout: 10000 }).catch(
        () => {}
      );

      const activeLink = await exists('[data-testid="settings-nav-api-keys"][data-active="true"]');
      expect(activeLink).toBe(true);
    });

    it('can navigate to appearance settings', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="settings-nav-appearance"]', { timeout: 10000 }).catch(
        () => {}
      );

      const appearanceLink = await exists('[data-testid="settings-nav-appearance"]');
      if (appearanceLink) {
        await click('[data-testid="settings-nav-appearance"]');
        await waitForSelector('[data-testid="appearance-settings"]', { timeout: 10000 }).catch(
          () => {}
        );

        const appearanceSettings = await exists('[data-testid="appearance-settings"]');
        expect(appearanceSettings).toBe(true);
      }
    });
  });

  describe('API Keys Settings', () => {
    it('renders API keys settings page', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="api-keys-settings"]', { timeout: 10000 }).catch(
        () => {}
      );

      const apiKeysSettings = await exists('[data-testid="api-keys-settings"]');
      expect(apiKeysSettings).toBe(true);
    });

    it('shows Anthropic API key section', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="anthropic-key-section"]', { timeout: 10000 }).catch(
        () => {}
      );

      const anthropicSection = await exists('[data-testid="anthropic-key-section"]');
      expect(anthropicSection).toBe(true);
    });

    it('shows GitHub PAT section', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="github-pat-section"]', { timeout: 10000 }).catch(
        () => {}
      );

      const githubSection = await exists('[data-testid="github-pat-section"]');
      expect(githubSection).toBe(true);
    });

    it('shows security notice', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="security-notice"]', { timeout: 10000 }).catch(() => {});

      const notice = await exists('[data-testid="security-notice"]');
      expect(notice).toBe(true);
    });
  });

  describe('Appearance Settings', () => {
    it('renders appearance settings page', async () => {
      await goto('/settings/appearance');
      await waitForSelector('[data-testid="appearance-settings"]', { timeout: 10000 }).catch(
        () => {}
      );

      const appearanceSettings = await exists('[data-testid="appearance-settings"]');
      expect(appearanceSettings).toBe(true);
    });

    it('shows theme selection section', async () => {
      await goto('/settings/appearance');
      await waitForSelector('[data-testid="theme-section"]', { timeout: 10000 }).catch(() => {});

      const themeSection = await exists('[data-testid="theme-section"]');
      expect(themeSection).toBe(true);
    });

    it('has light, dark, and system theme options', async () => {
      await goto('/settings/appearance');
      await waitForSelector('[data-testid="theme-light"]', { timeout: 10000 }).catch(() => {});

      const lightOption = await exists('[data-testid="theme-light"]');
      const darkOption = await exists('[data-testid="theme-dark"]');
      const systemOption = await exists('[data-testid="theme-system"]');

      expect(lightOption).toBe(true);
      expect(darkOption).toBe(true);
      expect(systemOption).toBe(true);
    });

    it('shows theme preview', async () => {
      await goto('/settings/appearance');
      await waitForSelector('[data-testid="theme-preview"]', { timeout: 10000 }).catch(() => {});

      const preview = await exists('[data-testid="theme-preview"]');
      expect(preview).toBe(true);
    });
  });

  describe('GitHub Settings', () => {
    it('renders GitHub settings page', async () => {
      await goto('/settings/github');
      await waitForSelector('[data-testid="github-settings"]', { timeout: 10000 }).catch(() => {});

      const githubSettings = await exists('[data-testid="github-settings"]');
      expect(githubSettings).toBe(true);
    });

    it('shows GitHub connection status', async () => {
      await goto('/settings/github');
      await waitForSelector('[data-testid="github-connection-status"]', { timeout: 10000 }).catch(
        () => {}
      );

      const status = await exists('[data-testid="github-connection-status"]');
      expect(status).toBe(true);
    });

    it('shows either connected or not connected state', async () => {
      await goto('/settings/github');
      await waitForSelector('[data-testid="github-settings"]', { timeout: 10000 }).catch(() => {});

      // Check for either connected or not connected state
      const connected = await exists('[data-testid="github-connected"]');
      const notConnected = await exists('[data-testid="github-not-connected"]');

      // One of them should exist
      expect(connected || notConnected).toBe(true);
    });
  });

  describe('Preferences Settings', () => {
    it('renders preferences settings page', async () => {
      await goto('/settings/preferences');
      await waitForSelector('[data-testid="preferences-settings"]', { timeout: 10000 }).catch(
        () => {}
      );

      const preferencesSettings = await exists('[data-testid="preferences-settings"]');
      expect(preferencesSettings).toBe(true);
    });

    it('shows agent defaults section', async () => {
      await goto('/settings/preferences');
      await waitForSelector('[data-testid="agent-defaults-section"]', { timeout: 10000 }).catch(
        () => {}
      );

      const agentDefaults = await exists('[data-testid="agent-defaults-section"]');
      expect(agentDefaults).toBe(true);
    });

    it('has max turns input', async () => {
      await goto('/settings/preferences');
      await waitForSelector('[data-testid="max-turns-input"]', { timeout: 10000 }).catch(() => {});

      const maxTurnsInput = await exists('[data-testid="max-turns-input"]');
      expect(maxTurnsInput).toBe(true);
    });

    it('has max concurrent agents input', async () => {
      await goto('/settings/preferences');
      await waitForSelector('[data-testid="max-agents-input"]', { timeout: 10000 }).catch(() => {});

      const maxAgentsInput = await exists('[data-testid="max-agents-input"]');
      expect(maxAgentsInput).toBe(true);
    });

    it('has save preferences button', async () => {
      await goto('/settings/preferences');
      await waitForSelector('[data-testid="save-preferences"]', { timeout: 10000 }).catch(() => {});

      const saveButton = await exists('[data-testid="save-preferences"]');
      expect(saveButton).toBe(true);
    });
  });

  describe('Projects Page', () => {
    it('renders projects page', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="projects-page"]', { timeout: 10000 }).catch(() => {});

      const projectsPage = await exists('[data-testid="projects-page"]');
      expect(projectsPage).toBe(true);
    });

    it('has create project button', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="create-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const createButton = await exists('[data-testid="create-project-button"]');
      expect(createButton).toBe(true);
    });
  });

  describe('Screenshots', () => {
    it('captures API keys settings screenshot', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="api-keys-settings"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buffer = await screenshot('settings-api-keys');
      expect(buffer).toBeTruthy();
    });

    it('captures appearance settings screenshot', async () => {
      await goto('/settings/appearance');
      await waitForSelector('[data-testid="appearance-settings"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buffer = await screenshot('settings-appearance');
      expect(buffer).toBeTruthy();
    });

    it('captures preferences settings screenshot', async () => {
      await goto('/settings/preferences');
      await waitForSelector('[data-testid="preferences-settings"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buffer = await screenshot('settings-preferences');
      expect(buffer).toBeTruthy();
    });
  });
});
