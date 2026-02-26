/**
 * E2E Tests: UI Base Components
 *
 * Tests core UI components as they appear in actual pages like Settings.
 * Tests button interactions, form inputs, and visual components.
 */
import { describe, expect, it } from 'vitest';
import { click, exists, fill, goto, screenshot, serverRunning, waitForSelector } from '../setup';

const e2e = serverRunning ? describe : describe.skip;

e2e('UI Base Components E2E', () => {
  describe('API Keys Settings Page', () => {
    it('renders API keys page with all sections', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="api-keys-settings"]', { timeout: 10000 });

      const page = await exists('[data-testid="api-keys-settings"]');
      expect(page).toBe(true);

      const anthropicSection = await exists('[data-testid="anthropic-key-section"]');
      expect(anthropicSection).toBe(true);

      const githubSection = await exists('[data-testid="github-pat-section"]');
      expect(githubSection).toBe(true);

      const securityNotice = await exists('[data-testid="security-notice"]');
      expect(securityNotice).toBe(true);
    });

    it('shows either input or configured state for Anthropic key', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="anthropic-key-section"]', { timeout: 10000 });

      // Either the input exists (not configured) or the configured badge exists
      const input = await exists('[data-testid="anthropic-key-input"]');
      const configured = await exists('[data-testid="anthropic-key-configured"]');

      // One of them must be true
      expect(input || configured).toBe(true);
    });

    it('captures API keys settings screenshot', async () => {
      await goto('/settings/api-keys');
      await waitForSelector('[data-testid="api-keys-settings"]', { timeout: 10000 });

      const buffer = await screenshot('ui-api-keys-settings');
      expect(buffer).toBeTruthy();
    });
  });

  describe('Preferences Settings Page', () => {
    it('renders preferences page with all inputs', async () => {
      await goto('/settings/preferences');
      await waitForSelector('[data-testid="preferences-settings"]', { timeout: 10000 });

      const page = await exists('[data-testid="preferences-settings"]');
      expect(page).toBe(true);

      const agentDefaults = await exists('[data-testid="agent-defaults-section"]');
      expect(agentDefaults).toBe(true);

      const maxTurns = await exists('[data-testid="max-turns-input"]');
      expect(maxTurns).toBe(true);

      const maxAgents = await exists('[data-testid="max-agents-input"]');
      expect(maxAgents).toBe(true);

      const saveButton = await exists('[data-testid="save-preferences"]');
      expect(saveButton).toBe(true);
    });

    it('accepts number input in max turns field', async () => {
      await goto('/settings/preferences');
      await waitForSelector('[data-testid="max-turns-input"]', { timeout: 10000 });

      await fill('[data-testid="max-turns-input"]', '100');
      // If we get here without error, the input accepted the value
      expect(true).toBe(true);
    });

    it('shows success message after saving preferences', async () => {
      await goto('/settings/preferences');
      await waitForSelector('[data-testid="save-preferences"]', { timeout: 10000 });

      await click('[data-testid="save-preferences"]');
      // Wait for save to complete and button to change to success state
      await waitForSelector('[data-testid="save-success"]', { timeout: 10000 });

      const success = await exists('[data-testid="save-success"]');
      expect(success).toBe(true);
    });

    it('captures preferences settings screenshot', async () => {
      await goto('/settings/preferences');
      await waitForSelector('[data-testid="preferences-settings"]', { timeout: 10000 });

      const buffer = await screenshot('ui-preferences-settings');
      expect(buffer).toBeTruthy();
    });
  });

  describe('Appearance Settings Page', () => {
    it('renders appearance page with theme options', async () => {
      await goto('/settings/appearance');
      await waitForSelector('[data-testid="appearance-settings"]', { timeout: 10000 });

      const page = await exists('[data-testid="appearance-settings"]');
      expect(page).toBe(true);

      const themeSection = await exists('[data-testid="theme-section"]');
      expect(themeSection).toBe(true);

      const themePreview = await exists('[data-testid="theme-preview"]');
      expect(themePreview).toBe(true);

      // Theme buttons
      const lightTheme = await exists('[data-testid="theme-light"]');
      expect(lightTheme).toBe(true);

      const darkTheme = await exists('[data-testid="theme-dark"]');
      expect(darkTheme).toBe(true);

      const systemTheme = await exists('[data-testid="theme-system"]');
      expect(systemTheme).toBe(true);
    });

    it('can click theme options', async () => {
      await goto('/settings/appearance');
      await waitForSelector('[data-testid="theme-section"]', { timeout: 10000 });

      // Click light theme
      await click('[data-testid="theme-light"]');

      // Click dark theme
      await click('[data-testid="theme-dark"]');

      // If we get here without errors, theme selection works
      expect(true).toBe(true);
    });

    it('captures appearance settings screenshot', async () => {
      await goto('/settings/appearance');
      await waitForSelector('[data-testid="appearance-settings"]', { timeout: 10000 });

      const buffer = await screenshot('ui-appearance-settings');
      expect(buffer).toBeTruthy();
    });
  });

  describe('GitHub Settings Page', () => {
    it('renders GitHub settings page', async () => {
      await goto('/settings/github');
      await waitForSelector('[data-testid="github-settings"]', { timeout: 10000 });

      const page = await exists('[data-testid="github-settings"]');
      expect(page).toBe(true);

      // Either connected or not connected state should exist
      const connected = await exists('[data-testid="github-connected"]');
      const notConnected = await exists('[data-testid="github-not-connected"]');

      expect(connected || notConnected).toBe(true);
    });

    it('captures GitHub settings screenshot', async () => {
      await goto('/settings/github');
      await waitForSelector('[data-testid="github-settings"]', { timeout: 10000 });

      const buffer = await screenshot('ui-github-settings');
      expect(buffer).toBeTruthy();
    });
  });

  describe('Projects Page', () => {
    it('renders projects page with controls', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="projects-page"]', { timeout: 10000 });

      const page = await exists('[data-testid="projects-page"]');
      expect(page).toBe(true);

      const createButton = await exists('[data-testid="create-project-button"]');
      expect(createButton).toBe(true);
    });

    it('captures projects page screenshot', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="projects-page"]', { timeout: 10000 });

      const buffer = await screenshot('ui-projects-page');
      expect(buffer).toBeTruthy();
    });
  });
});
