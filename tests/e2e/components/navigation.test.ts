/**
 * E2E Tests: Navigation Components
 *
 * Tests for Sidebar, Breadcrumbs, and LayoutShell.
 * Covers navigation elements, responsive behavior, and active states.
 *
 * NOTE: Click-based navigation tests are skipped when running in parallel
 * due to browser context sharing. Use --sequence.concurrent=false for full tests.
 */
import { describe, expect, it } from 'vitest';
import { exists, goto, screenshot, serverRunning, waitForSelector } from '../setup';

const e2e = serverRunning ? describe : describe.skip;

e2e('Navigation Components E2E', () => {
  describe('Sidebar', () => {
    it('renders sidebar with navigation links', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

      const sidebar = await exists('[data-testid="sidebar"]');
      expect(sidebar).toBe(true);
    });

    it('shows projects link', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-projects"]', { timeout: 15000 });

      const projectsLink = await exists('[data-testid="nav-projects"]');
      expect(projectsLink).toBe(true);
    });

    it('shows settings link', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-settings"]', { timeout: 15000 });

      const settingsLink = await exists('[data-testid="nav-settings"]');
      expect(settingsLink).toBe(true);
    });

    it('highlights active navigation item on projects page', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-projects"]', { timeout: 15000 });

      // The active link should have the data-active attribute
      const activeLink = await exists('[data-testid="nav-projects"][data-active="true"]');
      expect(activeLink).toBe(true);
    });
  });

  describe('Breadcrumbs', () => {
    it('shows breadcrumbs on projects page', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="breadcrumbs"]', { timeout: 15000 });

      const breadcrumbs = await exists('[data-testid="breadcrumbs"]');
      expect(breadcrumbs).toBe(true);
    });
  });

  describe('LayoutShell', () => {
    it('renders header section on projects page', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="layout-header"]', { timeout: 15000 });

      const header = await exists('[data-testid="layout-header"]');
      expect(header).toBe(true);
    });

    it('renders main content area on projects page', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="layout-main"]', { timeout: 15000 });

      const main = await exists('[data-testid="layout-main"]');
      expect(main).toBe(true);
    });

    it('shows header actions on projects page', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="header-actions"]', { timeout: 15000 });

      const actions = await exists('[data-testid="header-actions"]');
      expect(actions).toBe(true);
    });
  });

  describe('Settings Sidebar', () => {
    it('renders settings sidebar on settings page', async () => {
      await goto('/settings');
      await waitForSelector('[data-testid="settings-sidebar"]', { timeout: 15000 });

      const sidebar = await exists('[data-testid="settings-sidebar"]');
      expect(sidebar).toBe(true);
    });

    it('shows API Keys nav link in settings', async () => {
      await goto('/settings');
      await waitForSelector('[data-testid="settings-nav-api-keys"]', { timeout: 15000 });

      const apiKeysLink = await exists('[data-testid="settings-nav-api-keys"]');
      expect(apiKeysLink).toBe(true);
    });

    it('shows GitHub nav link in settings', async () => {
      await goto('/settings');
      await waitForSelector('[data-testid="settings-nav-github"]', { timeout: 15000 });

      const githubLink = await exists('[data-testid="settings-nav-github"]');
      expect(githubLink).toBe(true);
    });
  });

  describe('Screenshots', () => {
    it('captures sidebar screenshot', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

      const buffer = await screenshot('sidebar');
      expect(buffer).toBeTruthy();
    });

    it('captures projects page screenshot', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="layout-header"]', { timeout: 15000 });

      const buffer = await screenshot('projects-page');
      expect(buffer).toBeTruthy();
    });
  });
});
